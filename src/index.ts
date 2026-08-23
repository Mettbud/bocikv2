import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadWalletKeypair } from "./wallet.js";
import { JupiterClient, priceImpactPercent } from "./jupiter.js";
import {
  getConnection,
  getMintDecimals,
  getSolBalanceSol,
  getTokenBalanceUi,
  SolPriceTracker,
} from "./chain.js";
import { estimateRoundTripCostPercent, netProfitPercent } from "./costModel.js";
import {
  afterBuy,
  afterSell,
  grossMovePercent,
  isBuySignal,
  isSellSignal,
  isStopLossTriggered,
  sellTargetPrice,
} from "./strategy.js";
import { appendTrade, loadState, saveState, type PersistedState } from "./ledger.js";
import { executeLeg, priceLeg } from "./trader.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  const client = new JupiterClient(config);
  const connection = getConnection(config);
  const solPrice = new SolPriceTracker(client, config);

  const keypair = config.mode === "live" ? loadWalletKeypair(config) : undefined;
  const owner = keypair ? keypair.publicKey : new PublicKey(config.token.solMint); // unused placeholder in paper mode
  const userPublicKeyStr = keypair ? keypair.publicKey.toBase58() : PublicKey.default.toBase58();

  const tokenMint = new PublicKey(config.token.mint);
  const solMint = new PublicKey(config.token.solMint);
  const tokenDecimals = await getMintDecimals(connection, tokenMint);
  const solDecimals = 9;

  const initialSolUsd = await solPrice.getPrice();
  const state = loadState(config, config.paper.startingBalanceUsd / initialSolUsd);

  log.info("bocik flip-bot starting", {
    mode: config.mode,
    token: config.token.symbol,
    targetGainPercent: config.strategy.targetGainPercent,
    minNetProfitPercent: config.strategy.minNetProfitPercent,
    maxRoundTripCostPercent: config.strategy.maxRoundTripCostPercent,
  });

  let running = true;
  process.on("SIGINT", () => {
    log.info("shutting down (SIGINT)");
    running = false;
  });
  process.on("SIGTERM", () => {
    log.info("shutting down (SIGTERM)");
    running = false;
  });

  while (running) {
    try {
      await tick(state);
    } catch (err) {
      log.error("tick failed", { error: String(err) });
    }
    await sleep(config.pricePollIntervalMs);
  }

  saveState(config, state);
  log.info("stopped, state saved");

  // --- tick logic -----------------------------------------------------

  async function tick(s: PersistedState): Promise<void> {
    const solUsd = await solPrice.getPrice();
    const currentPriceUsd = await getReferenceTokenPriceUsd(solUsd);

    if (s.flip.phase === "AWAITING_BUY") {
      if (!isBuySignal(s.flip, currentPriceUsd, config.strategy.rebuyDropPercent)) return;
      await tryBuy(s, currentPriceUsd, solUsd);
      return;
    }

    // AWAITING_SELL
    if (s.flip.buyPrice === null) return;
    const stopLoss = isStopLossTriggered(
      s.flip.buyPrice,
      currentPriceUsd,
      config.strategy.stopLossPercent,
    );
    if (stopLoss) {
      log.warn("stop loss triggered - exiting position regardless of target", {
        buyPrice: s.flip.buyPrice,
        currentPriceUsd,
      });
      await trySell(s, currentPriceUsd, solUsd, true);
      return;
    }

    if (!isSellSignal(s.flip, currentPriceUsd, config.strategy.targetGainPercent)) return;
    await trySell(s, currentPriceUsd, solUsd, false);
  }

  async function getReferenceTokenPriceUsd(solUsd: number): Promise<number> {
    const amountLamports = Math.round(config.priceReferenceSolAmount * 10 ** solDecimals);
    const quote = await client.getQuote({
      inputMint: config.token.solMint,
      outputMint: config.token.mint,
      amount: String(amountLamports),
      slippageBps: config.execution.maxSlippageBps,
    });
    const tokenOut = Number(quote.outAmount) / 10 ** tokenDecimals;
    const solPerToken = config.priceReferenceSolAmount / tokenOut;
    return solPerToken * solUsd;
  }

  async function tryBuy(s: PersistedState, currentPriceUsd: number, solUsd: number) {
    const tradeSizeUsd = config.trade.usd;
    const solIn = tradeSizeUsd / solUsd;
    const amountLamports = Math.round(solIn * 10 ** solDecimals);

    if (config.mode === "live") {
      const solBalance = await getSolBalanceSol(connection, owner);
      if (solBalance - solIn < config.trade.minSolReserve) {
        log.warn("skipping buy - would breach MIN_SOL_RESERVE", { solBalance, solIn });
        return;
      }
    } else if (s.paperSolBalance < solIn) {
      log.warn("skipping buy - insufficient paper SOL balance", {
        paperSolBalance: s.paperSolBalance,
        solIn,
      });
      return;
    }

    const buy = await priceLeg(
      client,
      config,
      { inputMint: config.token.solMint, outputMint: config.token.mint, amount: String(amountLamports) },
      userPublicKeyStr,
    );
    const buyImpact = priceImpactPercent(buy.quote);
    if (buyImpact > config.execution.maxPriceImpactBps / 100) {
      log.warn("skipping buy - price impact too high", { buyImpactPercent: buyImpact });
      return;
    }

    // Hypothetical reverse leg, priced live, to estimate what selling this
    // exact position back would cost right now - the other half of the
    // round trip we're about to commit capital to.
    const hypotheticalSell = await priceLeg(
      client,
      config,
      {
        inputMint: config.token.mint,
        outputMint: config.token.solMint,
        amount: buy.quote.outAmount,
      },
      userPublicKeyStr,
    );
    const sellImpact = priceImpactPercent(hypotheticalSell.quote);

    const cost = estimateRoundTripCostPercent({
      buyPriceImpactPercent: buyImpact,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: buy.networkFeeLamports + hypotheticalSell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd,
    });

    if (cost.totalPercent > config.strategy.maxRoundTripCostPercent) {
      if (config.log.logSkips) {
        log.info("skipping buy - estimated round-trip cost too high right now", {
          estimatedRoundTripCostPercent: Number(cost.totalPercent.toFixed(2)),
          maxAllowed: config.strategy.maxRoundTripCostPercent,
        });
      }
      return;
    }

    const fill = await executeLeg(
      connection,
      config,
      keypair,
      buy.quote,
      buy.swap,
      tokenDecimals,
    );

    if (config.mode === "paper") {
      s.paperSolBalance -= solIn;
      s.paperTokenBalance += fill.outputAmountUi;
    }

    const fillPriceUsd = (solIn * solUsd) / fill.outputAmountUi;
    s.flip = afterBuy(s.flip, fillPriceUsd, fill.outputAmountUi, {
      buyLegPercent: buyImpact,
      buyNetworkFeeLamports: buy.networkFeeLamports,
      tradeSizeUsd,
    });
    saveState(config, s);

    log.info("BUY filled", {
      priceUsd: Number(fillPriceUsd.toFixed(8)),
      tokenAmount: fill.outputAmountUi,
      solSpent: solIn,
      estimatedRoundTripCostPercent: Number(cost.totalPercent.toFixed(2)),
      targetSellPrice: Number(sellTargetPrice(fillPriceUsd, config.strategy.targetGainPercent).toFixed(8)),
      tx: fill.txSignature,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      side: "BUY",
      price: fillPriceUsd,
      tokenAmount: fill.outputAmountUi,
      solAmount: solIn,
      usdValue: tradeSizeUsd,
      roundTripCostPercent: cost.totalPercent,
      txSignature: fill.txSignature,
    });
  }

  async function trySell(
    s: PersistedState,
    currentPriceUsd: number,
    solUsd: number,
    stopLossExit: boolean,
  ) {
    if (s.flip.buyPrice === null || s.flip.entryCost === null) return;

    const tokenAmount =
      config.mode === "live"
        ? await getTokenBalanceUi(connection, owner, tokenMint)
        : (s.flip.tokenAmount ?? s.paperTokenBalance);
    if (tokenAmount <= 0) {
      log.warn("sell signal but no token balance to sell - resetting to AWAITING_BUY");
      s.flip = afterSell(s.flip, currentPriceUsd);
      saveState(config, s);
      return;
    }

    const amountRaw = BigInt(Math.round(tokenAmount * 10 ** tokenDecimals));
    const sell = await priceLeg(
      client,
      config,
      { inputMint: config.token.mint, outputMint: config.token.solMint, amount: amountRaw.toString() },
      userPublicKeyStr,
    );
    const sellImpact = priceImpactPercent(sell.quote);

    const cost = estimateRoundTripCostPercent({
      buyPriceImpactPercent: s.flip.entryCost.buyLegPercent,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: s.flip.entryCost.buyNetworkFeeLamports + sell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd: s.flip.entryCost.tradeSizeUsd,
    });

    const gross = grossMovePercent(s.flip.buyPrice, currentPriceUsd);
    const net = netProfitPercent(gross, cost.totalPercent);

    if (!stopLossExit && net < config.strategy.minNetProfitPercent) {
      if (config.log.logSkips) {
        log.info("target hit but net profit after costs is too thin - holding for a better fill", {
          grossMovePercent: Number(gross.toFixed(2)),
          estimatedRoundTripCostPercent: Number(cost.totalPercent.toFixed(2)),
          netProfitPercent: Number(net.toFixed(2)),
          required: config.strategy.minNetProfitPercent,
        });
      }
      return;
    }

    const fill = await executeLeg(
      connection,
      config,
      keypair,
      sell.quote,
      sell.swap,
      solDecimals,
    );

    const solOut = fill.outputAmountUi;
    if (config.mode === "paper") {
      s.paperTokenBalance -= tokenAmount;
      s.paperSolBalance += solOut;
    }

    const fillPriceUsd = (solOut * solUsd) / tokenAmount;
    s.flip = afterSell(s.flip, fillPriceUsd);
    saveState(config, s);

    log.info(stopLossExit ? "SELL filled (stop loss)" : "SELL filled", {
      priceUsd: Number(fillPriceUsd.toFixed(8)),
      tokenAmount,
      solReceived: solOut,
      grossMovePercent: Number(gross.toFixed(2)),
      estimatedRoundTripCostPercent: Number(cost.totalPercent.toFixed(2)),
      netProfitPercent: Number(net.toFixed(2)),
      completedFlips: s.flip.completedFlips,
      tx: fill.txSignature,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      side: "SELL",
      price: fillPriceUsd,
      tokenAmount,
      solAmount: solOut,
      usdValue: solOut * solUsd,
      roundTripCostPercent: cost.totalPercent,
      netProfitPercent: net,
      txSignature: fill.txSignature,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal error:", err);
  process.exit(1);
});
