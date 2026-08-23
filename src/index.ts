import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { loadConfig, type BotConfig } from "./config.js";
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
import { computePortfolioTradeUsd } from "./sizing.js";
import { computeAdaptiveTargetPercent, trimOldSamples, windowStats, type PriceSample } from "./volatility.js";
import { renderDashboard, type DashboardState } from "./cli/dashboard.js";
import { startCommandLoop } from "./cli/commands.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  const client = new JupiterClient(config);
  const connection = getConnection(config);
  const solPrice = new SolPriceTracker(client, config);

  const keypair = config.mode === "live" ? loadWalletKeypair(config) : undefined;
  const owner = keypair?.publicKey;
  const userPublicKeyStr = keypair ? keypair.publicKey.toBase58() : PublicKey.default.toBase58();

  const tokenMint = new PublicKey(config.token.mint);
  const solDecimals = 9;
  const tokenDecimals = await getMintDecimals(connection, tokenMint);

  const initialSolUsd = await solPrice.getPrice();
  let s: PersistedState = loadState(config, config.paper.startingBalanceUsd / initialSolUsd);

  // --- live display state, rebuilt every tick / trade ---------------------
  let latestPriceUsd: number | undefined;
  let latestBuyImpactPercent: number | undefined;
  let latestSellImpactPercent: number | undefined;
  let latestRoundTripCostPercent: number | undefined;
  let latestNetIfSoldNowPercent: number | undefined;
  let lastEvent: { message: string; atMs: number } | undefined;
  let lastErrorMessage: string | undefined;
  let latestSolBalance = 0;
  let latestTokenBalance = 0;
  let latestSolUsd: number | undefined;
  let latestSpreadPercent: number | undefined;
  // Rolling in-memory price history driving the adaptive target - not
  // persisted, so it starts empty on every restart (falls back to the
  // static TARGET_GAIN_PERCENT until enough of it has been rebuilt).
  let priceHistory: PriceSample[] = [];

  const setEvent = (message: string) => {
    lastEvent = { message, atMs: Date.now() };
  };

  log.info("bocik flip-bot starting", {
    mode: config.mode,
    token: config.token.symbol,
    targetGainPercent: config.strategy.targetGainPercent,
    adaptiveTargetEnabled: config.strategy.adaptiveTargetEnabled,
    minNetProfitPercent: config.strategy.minNetProfitPercent,
    maxRoundTripCostPercent: config.strategy.maxRoundTripCostPercent,
  });

  let running = true;
  const stop = () => {
    if (!running) return;
    running = false;
    log.info("shutting down");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  startCommandLoop({
    logger: log,
    mode: config.mode,
    manualBuy: (usdAmount) => executeBuy(usdAmount, { requireCostGate: false, tag: "MANUAL" }),
    manualSell: (percent) => executeSell(percent, { requireProfitGate: false, tag: "MANUAL" }),
    panic: () => executeSell(100, { requireProfitGate: false, tag: "PANIC" }),
    reset: resetPaperSession,
    onExit: stop,
  });

  const tickLoop = (async () => {
    while (running) {
      try {
        await tick();
      } catch (err) {
        lastErrorMessage = String((err as Error).message ?? err);
        log.error("tick failed", { error: lastErrorMessage });
      }
      await sleep(config.pricePollIntervalMs);
    }
  })();

  const dashboardLoop = (async () => {
    while (running) {
      renderDashboard(buildSnapshot());
      await sleep(config.dashboardRefreshMs);
    }
  })();

  await Promise.race([tickLoop, dashboardLoop]);
  saveState(config, s);
  log.info("stopped, state saved");
  process.exit(0);

  // --- tick: the automatic strategy loop -----------------------------

  async function tick(): Promise<void> {
    const solUsd = await solPrice.getPrice();
    const currentPriceUsd = await getReferenceTokenPriceUsd(solUsd);
    latestPriceUsd = currentPriceUsd;
    latestSolUsd = solUsd;
    const now = Date.now();
    priceHistory.push({ tMs: now, priceUsd: currentPriceUsd });
    // Keep a bit more than the lookback window so a fresh buy right after a
    // restart still has full context, without the buffer growing forever.
    priceHistory = trimOldSamples(priceHistory, now, config.strategy.volatilityLookbackMs * 2);
    await refreshBalances();

    if (s.flip.phase === "AWAITING_SELL" && s.flip.buyPrice !== null) {
      await evaluatePosition(currentPriceUsd, solUsd);
      return;
    }

    // The spread gate itself lives in executeBuy (it applies to manual buys
    // too) - this just decides whether it's worth checking this tick at all.
    if (s.flip.phase === "AWAITING_BUY" && isBuySignal(s.flip, currentPriceUsd, config.strategy.rebuyDropPercent)) {
      await executeBuy(undefined, { requireCostGate: true, tag: "AUTO" });
    }
  }

  /** Live-quotes the sell leg every tick while in position - drives both the
   *  dashboard's live PnL and the actual sell decision, off the same quote. */
  async function evaluatePosition(currentPriceUsd: number, solUsd: number): Promise<void> {
    const flip = s.flip;
    if (flip.buyPrice === null || flip.entryCost === null) return;

    const tokenAmount =
      config.mode === "live" && owner
        ? await getTokenBalanceUi(connection, owner, tokenMint)
        : (flip.tokenAmount ?? s.paperTokenBalance);
    if (tokenAmount <= 0) {
      log.warn("in AWAITING_SELL but no token balance - resetting to AWAITING_BUY");
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
      buyPriceImpactPercent: flip.entryCost.buyLegPercent,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: flip.entryCost.buyNetworkFeeLamports + sell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd: flip.entryCost.costUsd,
    });
    const gross = grossMovePercent(flip.buyPrice, currentPriceUsd);
    const net = netProfitPercent(gross, cost.totalPercent);

    latestSellImpactPercent = sellImpact;
    latestRoundTripCostPercent = cost.totalPercent;
    latestNetIfSoldNowPercent = net;

    const stopLoss = isStopLossTriggered(flip.buyPrice, currentPriceUsd, config.strategy.stopLossPercent);
    if (stopLoss) {
      log.warn("stop loss triggered - exiting position regardless of target", {
        buyPrice: flip.buyPrice,
        currentPriceUsd,
      });
      await fillSell(sell, tokenAmount, solUsd, gross, cost.totalPercent, net, "STOP_LOSS");
      return;
    }

    // Frozen at buy time (adaptive or static) - never recomputed mid-trade.
    const targetGainPercent = flip.targetGainPercent ?? config.strategy.targetGainPercent;
    if (!isSellSignal(flip, currentPriceUsd, targetGainPercent)) return;

    if (net < config.strategy.minNetProfitPercent) {
      if (config.log.logSkips) {
        log.info("target hit but net profit after costs is too thin - holding for a better fill", {
          grossMovePercent: round2(gross),
          estimatedRoundTripCostPercent: round2(cost.totalPercent),
          netProfitPercent: round2(net),
          required: config.strategy.minNetProfitPercent,
        });
      }
      return;
    }

    await fillSell(sell, tokenAmount, solUsd, gross, cost.totalPercent, net, "AUTO");
  }

  async function refreshBalances(): Promise<void> {
    if (config.mode === "paper") {
      latestSolBalance = s.paperSolBalance;
      latestTokenBalance = s.paperTokenBalance;
      return;
    }
    if (!owner) return;
    const [sol, token] = await Promise.all([
      getSolBalanceSol(connection, owner),
      getTokenBalanceUi(connection, owner, tokenMint),
    ]);
    latestSolBalance = sol;
    latestTokenBalance = token;
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

  /**
   * The pool's baseline spread: round-trip a small, fixed reference amount
   * (PRICE_REFERENCE_SOL_AMOUNT) both ways and see how much of it comes
   * back. Unlike the buy/sell price impact figures (which scale with OUR
   * trade size), this is a size-independent read on how thin/wide the pool
   * is right now - the same signal MAX_SPREAD_BPS used in the original bot.
   * A wide spread here means "don't trade this pool right now" regardless
   * of how big or small the order is.
   */
  async function getPoolSpreadPercent(): Promise<number> {
    const solIn = config.priceReferenceSolAmount;
    const amountLamports = Math.round(solIn * 10 ** solDecimals);
    const out = await client.getQuote({
      inputMint: config.token.solMint,
      outputMint: config.token.mint,
      amount: String(amountLamports),
      slippageBps: config.execution.maxSlippageBps,
    });
    const back = await client.getQuote({
      inputMint: config.token.mint,
      outputMint: config.token.solMint,
      amount: out.outAmount,
      slippageBps: config.execution.maxSlippageBps,
    });
    const solBack = Number(back.outAmount) / 10 ** solDecimals;
    return Math.max(0, ((solIn - solBack) / solIn) * 100);
  }

  /**
   * The sell target a NEW buy would use right now: a multiple of how much
   * the token has actually been moving over VOLATILITY_LOOKBACK_MS,
   * clamped to [ADAPTIVE_TARGET_MIN_PERCENT, ADAPTIVE_TARGET_MAX_PERCENT].
   * Falls back to the static TARGET_GAIN_PERCENT when adaptive targeting
   * is off, or there isn't yet enough in-memory history to trust.
   *
   * This only decides WHEN a sale is even considered - MIN_NET_PROFIT_PERCENT
   * and MAX_ROUND_TRIP_COST_PERCENT (real, live-quoted costs) still gate
   * every actual trade regardless of what this returns.
   */
  function computeCurrentTargetGainPercent(): number {
    if (!config.strategy.adaptiveTargetEnabled) return config.strategy.targetGainPercent;
    const stat = windowStats(priceHistory, config.strategy.volatilityLookbackMs);
    if (stat.count === 0) return config.strategy.targetGainPercent;
    return computeAdaptiveTargetPercent(
      stat.medianAbsPercent,
      config.strategy.adaptiveTargetMultiplier,
      config.strategy.adaptiveTargetMinPercent,
      config.strategy.adaptiveTargetMaxPercent,
    );
  }

  // --- buy/sell execution, shared by the automatic loop and manual commands

  async function executeBuy(
    usdAmountOverride: number | undefined,
    opts: { requireCostGate: boolean; tag: "AUTO" | "MANUAL" },
  ): Promise<void> {
    if (s.flip.phase !== "AWAITING_BUY") {
      if (opts.tag === "MANUAL") console.log("buy: already in a position - sell first.");
      return;
    }

    const solUsd = await solPrice.getPrice();
    const solBalance = config.mode === "live" && owner ? await getSolBalanceSol(connection, owner) : s.paperSolBalance;

    // A manual "buy <usd>" forces an exact amount; the automatic strategy
    // sizes every buy as TRADE_SIZE_PERCENT of the spendable balance, so the
    // position compounds with the account instead of staying pinned to a
    // fixed dollar figure.
    const usdAmount =
      usdAmountOverride ?? computePortfolioTradeUsd(solBalance, config.trade.minSolReserve, solUsd, config.trade.sizePercent);
    if (usdAmount <= 0) {
      const msg = "skipping buy - nothing spendable above MIN_SOL_RESERVE";
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }
    const solIn = usdAmount / solUsd;
    const amountLamports = Math.round(solIn * 10 ** solDecimals);

    if (solBalance - solIn < config.trade.minSolReserve) {
      const msg = `skipping buy - would breach MIN_SOL_RESERVE (balance ${solBalance.toFixed(4)}, need ${solIn.toFixed(4)})`;
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }

    const spreadPercent = await getPoolSpreadPercent();
    latestSpreadPercent = spreadPercent;
    if (spreadPercent > config.strategy.maxSpreadPercent) {
      const msg = `skipping buy - pool spread too wide (${spreadPercent.toFixed(2)}% > max ${config.strategy.maxSpreadPercent}%)`;
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }

    const buy = await priceLeg(
      client,
      config,
      { inputMint: config.token.solMint, outputMint: config.token.mint, amount: String(amountLamports) },
      userPublicKeyStr,
    );
    const buyImpact = priceImpactPercent(buy.quote);
    latestBuyImpactPercent = buyImpact;
    if (buyImpact > config.execution.maxPriceImpactBps / 100) {
      const msg = `skipping buy - price impact too high (${buyImpact.toFixed(2)}%)`;
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }

    const hypotheticalSell = await priceLeg(
      client,
      config,
      { inputMint: config.token.mint, outputMint: config.token.solMint, amount: buy.quote.outAmount },
      userPublicKeyStr,
    );
    const sellImpact = priceImpactPercent(hypotheticalSell.quote);
    latestSellImpactPercent = sellImpact;

    const cost = estimateRoundTripCostPercent({
      buyPriceImpactPercent: buyImpact,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: buy.networkFeeLamports + hypotheticalSell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd: usdAmount,
    });
    latestRoundTripCostPercent = cost.totalPercent;

    if (opts.requireCostGate && cost.totalPercent > config.strategy.maxRoundTripCostPercent) {
      if (config.log.logSkips) {
        log.info("skipping buy - estimated round-trip cost too high right now", {
          estimatedRoundTripCostPercent: round2(cost.totalPercent),
          maxAllowed: config.strategy.maxRoundTripCostPercent,
        });
      }
      return;
    }

    const fill = await executeLeg(connection, config, keypair, buy.quote, buy.swap, tokenDecimals);

    if (config.mode === "paper") {
      s.paperSolBalance -= solIn;
      s.paperTokenBalance += fill.outputAmountUi;
    }

    const targetGainPercent = computeCurrentTargetGainPercent();
    const fillPriceUsd = (solIn * solUsd) / fill.outputAmountUi;
    s.flip = afterBuy(
      s.flip,
      fillPriceUsd,
      fill.outputAmountUi,
      {
        buyLegPercent: buyImpact,
        buyNetworkFeeLamports: buy.networkFeeLamports,
        costUsd: usdAmount,
      },
      targetGainPercent,
    );
    saveState(config, s);

    const msg = `BUY ${fill.outputAmountUi.toFixed(4)} ${config.token.symbol} @ ${fillPriceUsd.toFixed(8)} (~$${usdAmount.toFixed(2)})`;
    setEvent(msg);
    log.info(msg, {
      estimatedRoundTripCostPercent: round2(cost.totalPercent),
      targetGainPercent: round2(targetGainPercent),
      targetSellPrice: round8(sellTargetPrice(fillPriceUsd, targetGainPercent)),
      tag: opts.tag,
      tx: fill.txSignature,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      side: "BUY",
      price: fillPriceUsd,
      tokenAmount: fill.outputAmountUi,
      solAmount: solIn,
      usdValue: usdAmount,
      roundTripCostPercent: cost.totalPercent,
      txSignature: fill.txSignature,
    });
  }

  /** percentOfPosition: 100 closes the position and resumes the flip cycle;
   *  less than 100 trims it and stays in AWAITING_SELL. */
  async function executeSell(
    percentOfPosition: number,
    opts: { requireProfitGate: boolean; tag: "MANUAL" | "PANIC" },
  ): Promise<void> {
    const flip = s.flip;
    if (flip.phase !== "AWAITING_SELL" || flip.buyPrice === null || flip.entryCost === null) {
      if (opts.tag === "MANUAL" || opts.tag === "PANIC") console.log("sell: no position to sell.");
      return;
    }

    const solUsd = await solPrice.getPrice();
    const currentPriceUsd = await getReferenceTokenPriceUsd(solUsd);
    const heldAmount =
      config.mode === "live" && owner
        ? await getTokenBalanceUi(connection, owner, tokenMint)
        : (flip.tokenAmount ?? s.paperTokenBalance);
    const sellAmount = heldAmount * (percentOfPosition / 100);
    if (sellAmount <= 0) {
      if (opts.tag === "MANUAL" || opts.tag === "PANIC") console.log("sell: no position to sell.");
      return;
    }

    const amountRaw = BigInt(Math.round(sellAmount * 10 ** tokenDecimals));
    const sell = await priceLeg(
      client,
      config,
      { inputMint: config.token.mint, outputMint: config.token.solMint, amount: amountRaw.toString() },
      userPublicKeyStr,
    );
    const sellImpact = priceImpactPercent(sell.quote);
    const cost = estimateRoundTripCostPercent({
      buyPriceImpactPercent: flip.entryCost.buyLegPercent,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: flip.entryCost.buyNetworkFeeLamports + sell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd: flip.entryCost.costUsd,
    });
    const gross = grossMovePercent(flip.buyPrice, currentPriceUsd);
    const net = netProfitPercent(gross, cost.totalPercent);

    if (opts.requireProfitGate && net < config.strategy.minNetProfitPercent) {
      const msg = `sell: net profit too thin right now (${net.toFixed(2)}% < required ${config.strategy.minNetProfitPercent}%)`;
      console.log(msg);
      return;
    }

    await fillSell(sell, sellAmount, solUsd, gross, cost.totalPercent, net, opts.tag, percentOfPosition);
  }

  /** Shared fill path once a sell has been decided (by tick or a command). */
  async function fillSell(
    sell: Awaited<ReturnType<typeof priceLeg>>,
    tokenAmount: number,
    solUsd: number,
    gross: number,
    roundTripCostPercent: number,
    net: number,
    tag: "AUTO" | "MANUAL" | "PANIC" | "STOP_LOSS",
    percentOfPosition = 100,
  ): Promise<void> {
    const flip = s.flip;
    if (flip.buyPrice === null || flip.entryCost === null) return;

    const fill = await executeLeg(connection, config, keypair, sell.quote, sell.swap, solDecimals);
    const solOut = fill.outputAmountUi;
    const proceedsUsd = solOut * solUsd;
    const costBasisUsd = flip.entryCost.costUsd * (percentOfPosition / 100);
    const realizedThisTrade = proceedsUsd - costBasisUsd;

    if (config.mode === "paper") {
      s.paperTokenBalance -= tokenAmount;
      s.paperSolBalance += solOut;
    }
    s.realizedPnlUsd += realizedThisTrade;

    const fillPriceUsd = proceedsUsd / tokenAmount;
    const closingPosition = percentOfPosition >= 100;
    if (closingPosition) {
      s.flip = afterSell(s.flip, fillPriceUsd);
    } else {
      s.flip = { ...s.flip, tokenAmount: (flip.tokenAmount ?? tokenAmount) - tokenAmount };
    }
    saveState(config, s);

    latestSellImpactPercent = sell.quote ? priceImpactPercent(sell.quote) : latestSellImpactPercent;
    latestRoundTripCostPercent = roundTripCostPercent;
    latestNetIfSoldNowPercent = closingPosition ? undefined : net;

    const label = tag === "STOP_LOSS" ? "SELL (stop loss)" : tag === "PANIC" ? "SELL (panic)" : "SELL";
    const msg = `${label} ${tokenAmount.toFixed(4)} ${config.token.symbol} @ ${fillPriceUsd.toFixed(8)} (net ${net.toFixed(2)}%)`;
    setEvent(msg);
    log.info(msg, {
      grossMovePercent: round2(gross),
      estimatedRoundTripCostPercent: round2(roundTripCostPercent),
      netProfitPercent: round2(net),
      realizedThisTradeUsd: round2(realizedThisTrade),
      completedFlips: s.flip.completedFlips,
      tag,
      tx: fill.txSignature,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      side: "SELL",
      price: fillPriceUsd,
      tokenAmount,
      solAmount: solOut,
      usdValue: proceedsUsd,
      roundTripCostPercent,
      netProfitPercent: net,
      txSignature: fill.txSignature,
    });
  }

  function resetPaperSession(): void {
    solPrice
      .getPrice()
      .then((solUsd) => {
        s = {
          flip: {
            ...s.flip,
            phase: "AWAITING_BUY",
            buyPrice: null,
            tokenAmount: null,
            entryCost: null,
            targetGainPercent: null,
          },
          paperSolBalance: config.paper.startingBalanceUsd / solUsd,
          paperTokenBalance: 0,
          realizedPnlUsd: 0,
        };
        latestNetIfSoldNowPercent = undefined;
        saveState(config, s);
        const msg = `PAPER session reset - fresh balance $${config.paper.startingBalanceUsd.toFixed(2)}`;
        setEvent(msg);
        log.info(msg);
      })
      .catch((err) => log.error("reset failed", { error: String(err) }));
  }

  // --- dashboard ------------------------------------------------------

  function buildSnapshot(): DashboardState {
    const flip = s.flip;
    const activeTargetGainPercent = flip.targetGainPercent ?? config.strategy.targetGainPercent;
    const position =
      flip.phase === "AWAITING_SELL" && flip.buyPrice !== null && flip.entryCost !== null
        ? {
            tokenAmount: flip.tokenAmount ?? 0,
            buyPriceUsd: flip.buyPrice,
            positionValueUsd:
              latestPriceUsd !== undefined && flip.tokenAmount !== null
                ? flip.tokenAmount * latestPriceUsd
                : undefined,
            unrealizedPercent:
              latestPriceUsd !== undefined ? grossMovePercent(flip.buyPrice, latestPriceUsd) : undefined,
            unrealizedUsd:
              latestPriceUsd !== undefined && flip.tokenAmount !== null
                ? flip.tokenAmount * (latestPriceUsd - flip.buyPrice)
                : undefined,
            netIfSoldNowPercent: latestNetIfSoldNowPercent,
            sellTargetUsd: sellTargetPrice(flip.buyPrice, activeTargetGainPercent),
            targetGainPercent: activeTargetGainPercent,
            stopLossPriceUsd:
              config.strategy.stopLossPercent > 0
                ? flip.buyPrice * (1 - config.strategy.stopLossPercent / 100)
                : undefined,
          }
        : undefined;

    return {
      tokenSymbol: config.token.symbol,
      mode: config.mode === "live" ? "LIVE" : "PAPER",
      priceUsd: latestPriceUsd,
      position,
      rebuyTriggerUsd:
        flip.phase === "AWAITING_BUY" && flip.lastSellPrice !== null
          ? flip.lastSellPrice * (1 - config.strategy.rebuyDropPercent / 100)
          : undefined,
      lastSellPriceUsd: flip.lastSellPrice ?? undefined,
      completedFlips: flip.completedFlips,
      realizedPnlUsd: s.realizedPnlUsd,
      solBalance: latestSolBalance,
      tokenBalance: latestTokenBalance,
      // Paper mode's total portfolio value (SOL + any open position), not just cash on hand.
      paperUsdBalance:
        config.mode === "paper" && latestSolUsd !== undefined
          ? latestSolBalance * latestSolUsd + latestTokenBalance * (latestPriceUsd ?? 0)
          : undefined,
      buyImpactPercent: latestBuyImpactPercent,
      sellImpactPercent: latestSellImpactPercent,
      roundTripCostPercent: latestRoundTripCostPercent,
      spreadPercent: latestSpreadPercent,
      maxSpreadPercent: config.strategy.maxSpreadPercent,
      minNetProfitPercent: config.strategy.minNetProfitPercent,
      maxRoundTripCostPercent: config.strategy.maxRoundTripCostPercent,
      adaptiveTargetEnabled: config.strategy.adaptiveTargetEnabled,
      nextTargetGainPercent: flip.phase === "AWAITING_BUY" ? computeCurrentTargetGainPercent() : undefined,
      staticTargetGainPercent: config.strategy.targetGainPercent,
      tradeSizePercent: config.trade.sizePercent,
      nextBuyUsdEstimate:
        flip.phase === "AWAITING_BUY" && latestSolUsd !== undefined
          ? computePortfolioTradeUsd(latestSolBalance, config.trade.minSolReserve, latestSolUsd, config.trade.sizePercent)
          : undefined,
      lastEvent: lastEvent ? { message: lastEvent.message, ageMs: Date.now() - lastEvent.atMs } : undefined,
      lastErrorMessage,
    };
  }
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}
function round8(n: number): number {
  return Number(n.toFixed(8));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal error:", err);
  process.exit(1);
});
