import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadWalletKeypair } from "./wallet.js";
import { JupiterClient, priceImpactPercent } from "./jupiter.js";
import { getConnection, getMintDecimals, getSolBalanceSol, getTokenBalanceUi, SolPriceTracker } from "./chain.js";
import { estimateRoundTripCostPercent, netProfitPercent } from "./costModel.js";
import {
  afterBuy,
  afterSell,
  grossMovePercent,
  isBreakoutBuySignal,
  isBuySignal,
  isReinforcementBuySignal,
  isSellSignal,
  isStopLossTriggered,
  isTrailingStopTriggered,
  sellTargetPrice,
  updateBreakoutPeak,
  updatePeakPrice,
  type FlipState,
} from "./strategy.js";
import { appendTrade, loadState, saveState, type PersistedState } from "./ledger.js";
import { executeLeg, priceLeg } from "./trader.js";
import { computeFixedSlotTradeUsd } from "./sizing.js";
import { computeAdaptiveTargetPercent, trimOldSamples, windowStats, type PriceSample } from "./volatility.js";
import { renderDashboard, type DashboardState, type SlotDashboardState } from "./cli/dashboard.js";
import { startCommandLoop, type SlotKey } from "./cli/commands.js";

/** Per-slot numbers shown on the dashboard that only make sense "as of the last check". */
interface SlotLive {
  buyImpactPercent: number | undefined;
  sellImpactPercent: number | undefined;
  roundTripCostPercent: number | undefined;
  netIfSoldNowPercent: number | undefined;
  netIfSoldNowUsd: number | undefined;
}

function freshSlotLive(): SlotLive {
  return {
    buyImpactPercent: undefined,
    sellImpactPercent: undefined,
    roundTripCostPercent: undefined,
    netIfSoldNowPercent: undefined,
    netIfSoldNowUsd: undefined,
  };
}

/** Last few fills, newest first - just enough to show "what happened recently" without digging into trades.csv. */
const MAX_RECENT_TRADES = 8;
interface RecentTrade {
  atMs: number;
  slot: SlotKey;
  side: "BUY" | "SELL";
  tokenAmount: number;
  priceUsd: number;
  usdValue: number;
  netProfitPercent: number | undefined;
  netProfitUsd: number | undefined;
}

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
  // Each slot's buy size is a fixed % of THIS value (see sizing.ts), not of
  // whatever the balance happens to be later. Paper mode's reference is the
  // configured starting balance; live mode's is whatever the wallet
  // actually holds the very first time the bot runs - captured once, then
  // persisted and never silently recomputed.
  const defaultInitialPortfolioUsd =
    config.mode === "live" && owner
      ? (await getSolBalanceSol(connection, owner)) * initialSolUsd
      : config.paper.startingBalanceUsd;
  let s: PersistedState = loadState(
    config,
    config.paper.startingBalanceUsd / initialSolUsd,
    defaultInitialPortfolioUsd,
  );

  // --- live display state, rebuilt every tick / trade ---------------------
  let latestPriceUsd: number | undefined;
  let latestSpreadPercent: number | undefined;
  let lastEvent: { message: string; atMs: number } | undefined;
  let lastErrorMessage: string | undefined;
  let latestSolBalance = 0;
  let latestTokenBalance = 0;
  let latestSolUsd: number | undefined;
  const live: Record<SlotKey, SlotLive> = { A: freshSlotLive(), B: freshSlotLive() };
  // Rolling in-memory price history driving the adaptive target/trigger -
  // not persisted, so it starts empty on every restart (falls back to
  // static/conservative defaults until enough of it has been rebuilt).
  let priceHistory: PriceSample[] = [];
  let recentTrades: RecentTrade[] = [];
  // When did the trailing-stop pullback condition start holding true,
  // continuously, for each slot? Reset to null the moment it stops holding
  // (even for one tick) or the position closes - TRAILING_STOP_CONFIRMATION_MS
  // requires it to survive multiple consecutive ticks before actually firing.
  const trailingStopPendingSinceMs: Record<SlotKey, number | null> = { A: null, B: null };
  // Same confirmation pattern, for the opt-in breakout buy - Slot A only.
  let breakoutBuyPendingSinceMs: number | null = null;

  const setEvent = (message: string) => {
    lastEvent = { message, atMs: Date.now() };
  };

  function recordTrade(trade: RecentTrade): void {
    recentTrades = [trade, ...recentTrades].slice(0, MAX_RECENT_TRADES);
  }

  // --- small per-slot helpers ------------------------------------------

  function getFlip(slot: SlotKey): FlipState {
    return slot === "A" ? s.slotA : s.slotB;
  }
  function setFlip(slot: SlotKey, next: FlipState): void {
    if (slot === "A") s.slotA = next;
    else s.slotB = next;
  }
  function sizePercentFor(slot: SlotKey): number {
    return slot === "A" ? config.trade.slotASizePercent : config.trade.slotBSizePercent;
  }

  log.info("bocik flip-bot starting", {
    mode: config.mode,
    token: config.token.symbol,
    targetGainPercent: config.strategy.targetGainPercent,
    adaptiveTargetEnabled: config.strategy.adaptiveTargetEnabled,
    dualSlotEnabled: config.strategy.dualSlotEnabled,
    slotASizePercent: config.trade.slotASizePercent,
    slotBSizePercent: config.trade.slotBSizePercent,
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
    manualBuy: (usdAmount, slot) => executeBuy(slot, usdAmount, { requireCostGate: false, tag: "MANUAL" }),
    manualSell: (percent, slot) => executeSell(slot, percent, { requireProfitGate: false, tag: "MANUAL" }),
    panic: (slot) =>
      slot
        ? executeSell(slot, 100, { requireProfitGate: false, tag: "PANIC" })
        : Promise.all([
            executeSell("A", 100, { requireProfitGate: false, tag: "PANIC" }),
            executeSell("B", 100, { requireProfitGate: false, tag: "PANIC" }),
          ]).then(() => undefined),
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

    await evaluateSlotA(currentPriceUsd, solUsd);
    await evaluateSlotB(currentPriceUsd, solUsd);
  }

  async function evaluateSlotA(currentPriceUsd: number, solUsd: number): Promise<void> {
    if (s.slotA.phase === "AWAITING_SELL" && s.slotA.buyPrice !== null) {
      await evaluatePosition("A", currentPriceUsd, solUsd);
      return;
    }
    if (s.slotA.phase !== "AWAITING_BUY") return;

    // The spread gate itself lives in executeBuy (it applies to manual buys
    // too) - this just decides whether it's worth checking this tick at all.
    if (isBuySignal(s.slotA, currentPriceUsd, config.strategy.rebuyDropPercent, config.strategy.slotARequireManualFirstBuy)) {
      await executeBuy("A", undefined, { requireCostGate: true, tag: "AUTO" });
      return;
    }

    // Opt-in: buy into a confirmed pullback within a breakout above
    // lastSellPrice, instead of only ever waiting for price to fall all
    // the way back to it (which may never happen on a strong run-up).
    if (config.strategy.breakoutBuyEnabled) {
      setFlip("A", updateBreakoutPeak(s.slotA, currentPriceUsd));
      if (checkBreakoutBuyWithConfirmation(s.slotA, currentPriceUsd)) {
        await executeBuy("A", undefined, { requireCostGate: true, tag: "AUTO" });
      }
    }
  }

  /** Slot B never decides to buy on its own - only ever reacts to Slot A being underwater. */
  async function evaluateSlotB(currentPriceUsd: number, solUsd: number): Promise<void> {
    const flip = s.slotB;
    if (flip.phase === "AWAITING_SELL" && flip.buyPrice !== null) {
      await evaluatePosition("B", currentPriceUsd, solUsd);
      return;
    }
    if (flip.phase !== "AWAITING_BUY" || !config.strategy.dualSlotEnabled) return;

    const triggerDropPercent = computeCurrentTriggerDropPercent();
    if (isReinforcementBuySignal(s.slotA, s.slotB, currentPriceUsd, triggerDropPercent)) {
      await executeBuy("B", undefined, { requireCostGate: true, tag: "AUTO" });
    }
  }

  /** Live-quotes the sell leg every tick while in position - drives both the
   *  dashboard's live PnL and the actual sell decision, off the same quote. */
  async function evaluatePosition(slotKey: SlotKey, currentPriceUsd: number, solUsd: number): Promise<void> {
    // Keep the recorded peak current before anything else checks it.
    setFlip(slotKey, updatePeakPrice(getFlip(slotKey), currentPriceUsd));
    const flip = getFlip(slotKey);
    if (flip.buyPrice === null || flip.entryCost === null) return;

    // Our own bookkeeping is authoritative for how much THIS slot holds -
    // both slots trade the same token mint, so the chain has no notion of
    // "Slot A's tokens" vs "Slot B's tokens" to query separately.
    const tokenAmount = flip.tokenAmount ?? 0;
    if (tokenAmount <= 0) {
      log.warn(`Slot ${slotKey}: in AWAITING_SELL but no token balance - resetting to AWAITING_BUY`);
      setFlip(slotKey, afterSell(flip, currentPriceUsd));
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

    live[slotKey].sellImpactPercent = sellImpact;
    live[slotKey].roundTripCostPercent = cost.totalPercent;
    live[slotKey].netIfSoldNowPercent = net;
    live[slotKey].netIfSoldNowUsd = flip.entryCost.costUsd * (net / 100);

    const stopLoss = isStopLossTriggered(flip.buyPrice, currentPriceUsd, config.strategy.stopLossPercent);
    if (stopLoss) {
      log.warn(`Slot ${slotKey}: stop loss triggered - exiting position regardless of target`, {
        buyPrice: flip.buyPrice,
        currentPriceUsd,
      });
      await fillSell(slotKey, sell, tokenAmount, solUsd, gross, cost.totalPercent, net, "STOP_LOSS");
      return;
    }

    // Frozen at buy time (adaptive or static) - never recomputed mid-trade.
    const targetGainPercent = flip.targetGainPercent ?? config.strategy.targetGainPercent;
    const targetHit = isSellSignal(flip, currentPriceUsd, targetGainPercent);
    // A ranging market may never reach the full target - locks in gains on a
    // confirmed pullback from a real peak instead of waiting forever. Still
    // has to clear MIN_NET_PROFIT_PERCENT below, same as a normal target hit.
    const trailingStopHit = checkTrailingStopWithConfirmation(slotKey, flip, currentPriceUsd);

    if (!targetHit && !trailingStopHit) return;

    if (net < config.strategy.minNetProfitPercent) {
      if (config.log.logSkips) {
        log.info(`Slot ${slotKey}: sell considered but net profit after costs is too thin - holding for a better fill`, {
          reason: targetHit ? "target hit" : "trailing stop pullback",
          grossMovePercent: round2(gross),
          estimatedRoundTripCostPercent: round2(cost.totalPercent),
          netProfitPercent: round2(net),
          required: config.strategy.minNetProfitPercent,
        });
      }
      return;
    }

    await fillSell(slotKey, sell, tokenAmount, solUsd, gross, cost.totalPercent, net, targetHit ? "AUTO" : "TRAILING_STOP");
  }

  /**
   * The raw pullback-from-peak condition can flip true on a single noisy
   * tick (the peak itself is just whatever one tick happened to see) and
   * flip false again just as fast. When TRAILING_STOP_CONFIRMATION_MS > 0,
   * this requires the condition to hold continuously across ticks for that
   * long before actually reporting it as triggered.
   */
  function checkTrailingStopWithConfirmation(slotKey: SlotKey, flip: FlipState, currentPriceUsd: number): boolean {
    const rawHit =
      config.strategy.trailingStopEnabled &&
      isTrailingStopTriggered(flip, currentPriceUsd, config.strategy.trailingStopArmPercent, config.strategy.trailingStopPercent);

    if (!rawHit) {
      trailingStopPendingSinceMs[slotKey] = null;
      return false;
    }

    const confirmationMs = config.strategy.trailingStopConfirmationMs;
    if (confirmationMs <= 0) return true;

    const pendingSince = trailingStopPendingSinceMs[slotKey] ?? Date.now();
    trailingStopPendingSinceMs[slotKey] = pendingSince;
    const heldForMs = Date.now() - pendingSince;
    if (heldForMs < confirmationMs) {
      if (config.log.logSkips) {
        log.info(`Slot ${slotKey}: trailing stop pullback detected, confirming...`, {
          heldForMs,
          confirmationMs,
        });
      }
      return false;
    }
    return true;
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
   * is off, or there isn't yet enough in-memory history to trust. Shared by
   * both slots - each buy (whichever slot) gets its own fresh snapshot.
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

  /**
   * How far underwater Slot A must be before Slot B reinforces it, right
   * now. Same math as the adaptive target, different config knobs. With no
   * history yet, falls back to the MAX (hardest to reach) rather than the
   * min - safer to require a bigger confirmed drop than to reinforce on a
   * guess before we've actually measured anything.
   */
  function computeCurrentTriggerDropPercent(): number {
    const stat = windowStats(priceHistory, config.strategy.volatilityLookbackMs);
    if (stat.count === 0) return config.strategy.dualTriggerMaxPercent;
    return computeAdaptiveTargetPercent(
      stat.medianAbsPercent,
      config.strategy.dualTriggerMultiplier,
      config.strategy.dualTriggerMinPercent,
      config.strategy.dualTriggerMaxPercent,
    );
  }

  /** How far Slot A must pull back from a breakout peak before buying into it, right now. */
  function computeCurrentBreakoutPullbackPercent(): number {
    const stat = windowStats(priceHistory, config.strategy.volatilityLookbackMs);
    if (stat.count === 0) return config.strategy.breakoutBuyMaxPercent;
    return computeAdaptiveTargetPercent(
      stat.medianAbsPercent,
      config.strategy.breakoutBuyMultiplier,
      config.strategy.breakoutBuyMinPercent,
      config.strategy.breakoutBuyMaxPercent,
    );
  }

  /** Same noise-filtering shape as checkTrailingStopWithConfirmation, for the breakout buy. */
  function checkBreakoutBuyWithConfirmation(flip: FlipState, currentPriceUsd: number): boolean {
    const rawHit = isBreakoutBuySignal(flip, currentPriceUsd, computeCurrentBreakoutPullbackPercent());
    if (!rawHit) {
      breakoutBuyPendingSinceMs = null;
      return false;
    }

    const confirmationMs = config.strategy.breakoutBuyConfirmationMs;
    if (confirmationMs <= 0) return true;

    const pendingSince = breakoutBuyPendingSinceMs ?? Date.now();
    breakoutBuyPendingSinceMs = pendingSince;
    const heldForMs = Date.now() - pendingSince;
    if (heldForMs < confirmationMs) {
      if (config.log.logSkips) {
        log.info("Slot A: breakout pullback detected, confirming...", { heldForMs, confirmationMs });
      }
      return false;
    }
    return true;
  }

  // --- buy/sell execution, shared by the automatic loop and manual commands

  async function executeBuy(
    slotKey: SlotKey,
    usdAmountOverride: number | undefined,
    opts: { requireCostGate: boolean; tag: "AUTO" | "MANUAL" },
  ): Promise<void> {
    const flip = getFlip(slotKey);
    if (flip.phase !== "AWAITING_BUY") {
      if (opts.tag === "MANUAL") console.log(`buy: Slot ${slotKey} already in a position - sell first.`);
      return;
    }

    const solUsd = await solPrice.getPrice();
    const solBalance = config.mode === "live" && owner ? await getSolBalanceSol(connection, owner) : s.paperSolBalance;

    // A manual "buy <usd>" forces an exact amount; the automatic strategy
    // sizes every buy as this slot's SIZE_PERCENT of the STARTING portfolio
    // value (fixed, does not compound with the account) - see sizing.ts.
    const usdAmount = usdAmountOverride ?? computeFixedSlotTradeUsd(s.initialPortfolioUsd, sizePercentFor(slotKey));
    if (usdAmount <= 0) {
      const msg = `skipping buy (Slot ${slotKey}) - computed trade size is $0 (check SLOT_${slotKey}_SIZE_PERCENT)`;
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }
    const solIn = usdAmount / solUsd;
    const amountLamports = Math.round(solIn * 10 ** solDecimals);

    if (solBalance - solIn < config.trade.minSolReserve) {
      const msg = `skipping buy (Slot ${slotKey}) - would breach MIN_SOL_RESERVE (balance ${solBalance.toFixed(4)}, need ${solIn.toFixed(4)})`;
      log.warn(msg);
      if (opts.tag === "MANUAL") console.log(msg);
      return;
    }

    const spreadPercent = await getPoolSpreadPercent();
    latestSpreadPercent = spreadPercent;
    if (spreadPercent > config.strategy.maxSpreadPercent) {
      const msg = `skipping buy (Slot ${slotKey}) - pool spread too wide (${spreadPercent.toFixed(2)}% > max ${config.strategy.maxSpreadPercent}%)`;
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
    live[slotKey].buyImpactPercent = buyImpact;
    if (buyImpact > config.execution.maxPriceImpactBps / 100) {
      const msg = `skipping buy (Slot ${slotKey}) - price impact too high (${buyImpact.toFixed(2)}%)`;
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
    live[slotKey].sellImpactPercent = sellImpact;

    const cost = estimateRoundTripCostPercent({
      buyPriceImpactPercent: buyImpact,
      sellPriceImpactPercent: sellImpact,
      networkFeeLamportsBothLegs: buy.networkFeeLamports + hypotheticalSell.networkFeeLamports,
      solPriceUsd: solUsd,
      tradeSizeUsd: usdAmount,
    });
    live[slotKey].roundTripCostPercent = cost.totalPercent;

    if (opts.requireCostGate && cost.totalPercent > config.strategy.maxRoundTripCostPercent) {
      if (config.log.logSkips) {
        log.info(`skipping buy (Slot ${slotKey}) - estimated round-trip cost too high right now`, {
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
    setFlip(
      slotKey,
      afterBuy(
        flip,
        fillPriceUsd,
        fill.outputAmountUi,
        {
          buyLegPercent: buyImpact,
          buyNetworkFeeLamports: buy.networkFeeLamports,
          costUsd: usdAmount,
        },
        targetGainPercent,
      ),
    );
    if (slotKey === "A") breakoutBuyPendingSinceMs = null;
    saveState(config, s);

    const msg = `BUY [Slot ${slotKey}] ${fill.outputAmountUi.toFixed(4)} ${config.token.symbol} @ ${fillPriceUsd.toFixed(8)} (~$${usdAmount.toFixed(2)})`;
    setEvent(msg);
    log.info(msg, {
      slot: slotKey,
      estimatedRoundTripCostPercent: round2(cost.totalPercent),
      targetGainPercent: round2(targetGainPercent),
      targetSellPrice: round8(sellTargetPrice(fillPriceUsd, targetGainPercent)),
      tag: opts.tag,
      tx: fill.txSignature,
    });

    recordTrade({
      atMs: Date.now(),
      slot: slotKey,
      side: "BUY",
      tokenAmount: fill.outputAmountUi,
      priceUsd: fillPriceUsd,
      usdValue: usdAmount,
      netProfitPercent: undefined,
      netProfitUsd: undefined,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      slot: slotKey,
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
    slotKey: SlotKey,
    percentOfPosition: number,
    opts: { requireProfitGate: boolean; tag: "MANUAL" | "PANIC" },
  ): Promise<void> {
    const flip = getFlip(slotKey);
    if (flip.phase !== "AWAITING_SELL" || flip.buyPrice === null || flip.entryCost === null) {
      console.log(`sell: Slot ${slotKey} has no position to sell.`);
      return;
    }

    const solUsd = await solPrice.getPrice();
    const currentPriceUsd = await getReferenceTokenPriceUsd(solUsd);
    const heldAmount = flip.tokenAmount ?? 0;
    const sellAmount = heldAmount * (percentOfPosition / 100);
    if (sellAmount <= 0) {
      console.log(`sell: Slot ${slotKey} has no position to sell.`);
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
      const msg = `sell: Slot ${slotKey} net profit too thin right now (${net.toFixed(2)}% < required ${config.strategy.minNetProfitPercent}%)`;
      console.log(msg);
      return;
    }

    await fillSell(slotKey, sell, sellAmount, solUsd, gross, cost.totalPercent, net, opts.tag, percentOfPosition);
  }

  /** Shared fill path once a sell has been decided (by tick or a command). */
  async function fillSell(
    slotKey: SlotKey,
    sell: Awaited<ReturnType<typeof priceLeg>>,
    tokenAmount: number,
    solUsd: number,
    gross: number,
    roundTripCostPercent: number,
    net: number,
    tag: "AUTO" | "MANUAL" | "PANIC" | "STOP_LOSS" | "TRAILING_STOP",
    percentOfPosition = 100,
  ): Promise<void> {
    const flip = getFlip(slotKey);
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
      setFlip(slotKey, afterSell(flip, fillPriceUsd));
      trailingStopPendingSinceMs[slotKey] = null;
    } else {
      setFlip(slotKey, { ...flip, tokenAmount: (flip.tokenAmount ?? tokenAmount) - tokenAmount });
    }
    saveState(config, s);

    live[slotKey].sellImpactPercent = priceImpactPercent(sell.quote);
    live[slotKey].roundTripCostPercent = roundTripCostPercent;
    live[slotKey].netIfSoldNowPercent = closingPosition ? undefined : net;
    live[slotKey].netIfSoldNowUsd = closingPosition ? undefined : realizedThisTrade;

    const label =
      tag === "STOP_LOSS"
        ? "SELL (stop loss)"
        : tag === "TRAILING_STOP"
          ? "SELL (trailing stop)"
          : tag === "PANIC"
            ? "SELL (panic)"
            : "SELL";
    const msg = `${label} [Slot ${slotKey}] ${tokenAmount.toFixed(4)} ${config.token.symbol} @ ${fillPriceUsd.toFixed(8)} (net ${net.toFixed(2)}% / ${usdSigned(realizedThisTrade)})`;
    setEvent(msg);
    log.info(msg, {
      slot: slotKey,
      grossMovePercent: round2(gross),
      estimatedRoundTripCostPercent: round2(roundTripCostPercent),
      netProfitPercent: round2(net),
      realizedThisTradeUsd: round2(realizedThisTrade),
      completedFlips: getFlip(slotKey).completedFlips,
      tag,
      tx: fill.txSignature,
    });

    recordTrade({
      atMs: Date.now(),
      slot: slotKey,
      side: "SELL",
      tokenAmount,
      priceUsd: fillPriceUsd,
      usdValue: proceedsUsd,
      netProfitPercent: net,
      netProfitUsd: realizedThisTrade,
    });

    appendTrade(config, {
      timestampIso: new Date().toISOString(),
      mode: config.mode,
      slot: slotKey,
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
          slotA: freshFlipKeepingLastSell(s.slotA),
          slotB: freshFlipKeepingLastSell(s.slotB),
          paperSolBalance: config.paper.startingBalanceUsd / solUsd,
          paperTokenBalance: 0,
          realizedPnlUsd: 0,
          initialPortfolioUsd: config.paper.startingBalanceUsd,
        };
        live.A = freshSlotLive();
        live.B = freshSlotLive();
        recentTrades = [];
        trailingStopPendingSinceMs.A = null;
        trailingStopPendingSinceMs.B = null;
        breakoutBuyPendingSinceMs = null;
        saveState(config, s);
        const msg = `PAPER session reset (oba sloty) - fresh balance $${config.paper.startingBalanceUsd.toFixed(2)}`;
        setEvent(msg);
        log.info(msg);
      })
      .catch((err) => log.error("reset failed", { error: String(err) }));
  }

  function freshFlipKeepingLastSell(flip: FlipState): FlipState {
    return {
      ...flip,
      phase: "AWAITING_BUY",
      buyPrice: null,
      tokenAmount: null,
      entryCost: null,
      targetGainPercent: null,
      peakPriceUsd: null,
      breakoutPeakUsd: null,
    };
  }

  // --- dashboard ------------------------------------------------------

  function buildSlotSnapshot(slotKey: SlotKey): SlotDashboardState {
    const flip = getFlip(slotKey);
    const activeTargetGainPercent = flip.targetGainPercent ?? config.strategy.targetGainPercent;
    const position =
      flip.phase === "AWAITING_SELL" && flip.buyPrice !== null && flip.entryCost !== null
        ? {
            tokenAmount: flip.tokenAmount ?? 0,
            buyPriceUsd: flip.buyPrice,
            positionValueUsd:
              latestPriceUsd !== undefined && flip.tokenAmount !== null ? flip.tokenAmount * latestPriceUsd : undefined,
            unrealizedPercent:
              latestPriceUsd !== undefined ? grossMovePercent(flip.buyPrice, latestPriceUsd) : undefined,
            unrealizedUsd:
              latestPriceUsd !== undefined && flip.tokenAmount !== null
                ? flip.tokenAmount * (latestPriceUsd - flip.buyPrice)
                : undefined,
            netIfSoldNowPercent: live[slotKey].netIfSoldNowPercent,
            netIfSoldNowUsd: live[slotKey].netIfSoldNowUsd,
            sellTargetUsd: sellTargetPrice(flip.buyPrice, activeTargetGainPercent),
            targetGainPercent: activeTargetGainPercent,
            stopLossPriceUsd:
              config.strategy.stopLossPercent > 0 ? flip.buyPrice * (1 - config.strategy.stopLossPercent / 100) : undefined,
            stopLossPercent: config.strategy.stopLossPercent > 0 ? config.strategy.stopLossPercent : undefined,
            trailingStop: config.strategy.trailingStopEnabled
              ? {
                  peakPriceUsd: flip.peakPriceUsd ?? flip.buyPrice,
                  armed:
                    flip.peakPriceUsd !== null &&
                    grossMovePercent(flip.buyPrice, flip.peakPriceUsd) >= config.strategy.trailingStopArmPercent,
                  triggerPriceUsd:
                    flip.peakPriceUsd !== null
                      ? flip.peakPriceUsd * (1 - config.strategy.trailingStopPercent / 100)
                      : undefined,
                }
              : undefined,
          }
        : undefined;

    const reinforcement =
      slotKey === "B"
        ? {
            enabled: config.strategy.dualSlotEnabled,
            triggerDropPercent: computeCurrentTriggerDropPercent(),
            slotADrawdownPercent:
              s.slotA.phase === "AWAITING_SELL" && s.slotA.buyPrice !== null && latestPriceUsd !== undefined
                ? grossMovePercent(s.slotA.buyPrice, latestPriceUsd)
                : undefined,
          }
        : undefined;

    const breakoutBuy =
      slotKey === "A" && config.strategy.breakoutBuyEnabled
        ? {
            peakUsd: flip.breakoutPeakUsd ?? undefined,
            pullbackPercent: computeCurrentBreakoutPullbackPercent(),
            triggerPriceUsd:
              flip.breakoutPeakUsd !== null
                ? flip.breakoutPeakUsd * (1 - computeCurrentBreakoutPullbackPercent() / 100)
                : undefined,
          }
        : undefined;

    return {
      label: slotKey,
      sizePercent: sizePercentFor(slotKey),
      position,
      rebuyTriggerUsd:
        slotKey === "A" && flip.phase === "AWAITING_BUY" && flip.lastSellPrice !== null
          ? flip.lastSellPrice * (1 - config.strategy.rebuyDropPercent / 100)
          : undefined,
      lastSellPriceUsd: flip.lastSellPrice ?? undefined,
      completedFlips: flip.completedFlips,
      adaptiveTargetEnabled: config.strategy.adaptiveTargetEnabled,
      nextTargetGainPercent: flip.phase === "AWAITING_BUY" ? computeCurrentTargetGainPercent() : undefined,
      staticTargetGainPercent: config.strategy.targetGainPercent,
      nextBuyUsdEstimate:
        flip.phase === "AWAITING_BUY" ? computeFixedSlotTradeUsd(s.initialPortfolioUsd, sizePercentFor(slotKey)) : undefined,
      buyImpactPercent: live[slotKey].buyImpactPercent,
      sellImpactPercent: live[slotKey].sellImpactPercent,
      roundTripCostPercent: live[slotKey].roundTripCostPercent,
      maxRoundTripCostPercent: config.strategy.maxRoundTripCostPercent,
      minNetProfitPercent: config.strategy.minNetProfitPercent,
      reinforcement,
      breakoutBuy,
    };
  }

  function buildSnapshot(): DashboardState {
    const slotA = buildSlotSnapshot("A");
    const slotB = buildSlotSnapshot("B");
    const investedUsd = (slotA.position?.positionValueUsd ?? 0) + (slotB.position?.positionValueUsd ?? 0);
    const equityUsd =
      latestSolUsd !== undefined ? latestSolBalance * latestSolUsd + investedUsd : undefined;

    return {
      tokenSymbol: config.token.symbol,
      mode: config.mode === "live" ? "LIVE" : "PAPER",
      priceUsd: latestPriceUsd,
      slotA,
      slotB,
      realizedPnlUsd: s.realizedPnlUsd,
      solBalance: latestSolBalance,
      tokenBalance: latestTokenBalance,
      // How much is actually deployed in the market right now (both slots'
      // open positions, marked at the current price) vs. sitting idle as SOL.
      investedUsd,
      investedPercentOfEquity: equityUsd !== undefined && equityUsd > 0 ? (investedUsd / equityUsd) * 100 : undefined,
      // Paper mode's total portfolio value (SOL + any open positions), not just cash on hand.
      paperUsdBalance: config.mode === "paper" ? equityUsd : undefined,
      spreadPercent: latestSpreadPercent,
      maxSpreadPercent: config.strategy.maxSpreadPercent,
      recentTrades: recentTrades.map((t) => ({
        ageMs: Date.now() - t.atMs,
        slot: t.slot,
        side: t.side,
        tokenAmount: t.tokenAmount,
        priceUsd: t.priceUsd,
        usdValue: t.usdValue,
        netProfitPercent: t.netProfitPercent,
        netProfitUsd: t.netProfitUsd,
      })),
      lastEvent: lastEvent ? { message: lastEvent.message, ageMs: Date.now() - lastEvent.atMs } : undefined,
      lastErrorMessage,
    };
  }
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}
function usdSigned(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
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
