import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadWalletKeypair } from "./wallet.js";
import { JupiterClient, priceImpactPercent } from "./jupiter.js";
import { getConnection, getMintDecimals, getSolBalanceSol, getTokenBalanceUi, SolPriceTracker } from "./chain.js";
import { estimateRoundTripCostPercent, netProfitPercent } from "./costModel.js";
import { fetchDexScreenerSnapshot } from "./dexscreener.js";
import {
  afterBuy,
  afterSell,
  grossMovePercent,
  initialFlipState,
  isBreakoutBuySignal,
  isBuySignal,
  isReinforcementBuySignal,
  isSellSignal,
  isStopLossTriggered,
  isTrailingStopTriggered,
  isWithinBreakoutBuyBand,
  isWithinTrailingStopBand,
  isZoneScalperBuySignal,
  shouldRequireManualNextBuy,
  sellTargetPrice,
  updateBreakoutPeak,
  updatePeakPrice,
  type FlipState,
} from "./strategy.js";
import { appendTrade, loadState, saveState, type PersistedState } from "./ledger.js";
import { executeLeg, priceLeg } from "./trader.js";
import { computeFixedSlotTradeUsd } from "./sizing.js";
import { computeAdaptiveCooldownMs, computeAdaptiveTargetPercent, trimOldSamples, windowStats, type PriceSample } from "./volatility.js";
import { renderDashboard, type DashboardState, type SlotDashboardState } from "./cli/dashboard.js";
import { startCommandLoop, type CommandDeps, type SlotKey } from "./cli/commands.js";
import { startReadOnlyWebDashboard, startWebDashboard } from "./cli/webDashboard.js";

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
  // B/C are automatic reinforcement slots. Older versions could persist a
  // manual-exit lock for them; clear it on startup. Slot A deliberately
  // keeps that lock until its next manual buy.
  s = {
    ...s,
    slotB: { ...s.slotB, requireManualNextBuy: false },
    slotC: { ...s.slotC, requireManualNextBuy: false },
  };

  // Jupiter has no historical endpoint - live price history starts empty
  // on every restart, so without this every adaptive calculation (sell
  // target, dual-trigger, breakout pullback) would fall back to the same
  // flat static default for the first VOLATILITY_LOOKBACK_MS, identical
  // across every restart regardless of how the market is actually moving
  // right now. One best-effort DexScreener snapshot at startup gives a
  // real, currently-measured 5-minute move instead - see
  // currentTypicalMovePercent() below. If this fails (network hiccup,
  // token not indexed yet), everything just falls back to the old static
  // defaults exactly as before this existed.
  let startupTypicalMovePercent: number | undefined;
  try {
    const snapshot = await fetchDexScreenerSnapshot(config.token.mint);
    if (snapshot?.priceChangePercent.m5 !== undefined) {
      startupTypicalMovePercent = Math.abs(snapshot.priceChangePercent.m5);
      log.info("seeded startup volatility estimate from DexScreener", {
        m5PriceChangePercent: snapshot.priceChangePercent.m5,
      });
    }
  } catch (err) {
    log.warn("could not fetch DexScreener snapshot for startup volatility seed - using static fallback", {
      error: String((err as Error).message ?? err),
    });
  }

  // --- live display state, rebuilt every tick / trade ---------------------
  let latestPriceUsd: number | undefined;
  let latestSpreadPercent: number | undefined;
  let lastEvent: { message: string; atMs: number } | undefined;
  let lastErrorMessage: string | undefined;
  let latestSolBalance = 0;
  let latestTokenBalance = 0;
  let latestSolUsd: number | undefined;
  const live: Record<SlotKey, SlotLive> = { A: freshSlotLive(), B: freshSlotLive(), C: freshSlotLive() };
  // Guards against a double buy/sell on the same slot: the automatic tick
  // loop and manual commands (or the pending-limit-buy checker) run as
  // independent async flows, and executeBuy/fillSell each await several
  // network calls (price, quote, on-chain execution) between checking the
  // slot's phase and actually updating it - without this, two calls
  // starting close together could both pass that check before either
  // finishes and both really execute. The check-and-set here happens
  // synchronously (no await in between), so it can't itself race.
  const slotLocks: Record<SlotKey, boolean> = { A: false, B: false, C: false };
  // Circuit breaker for AUTOMATIC buys only (never sells - a struggling
  // sell should keep retrying, since leaving a position unmanaged is the
  // worse outcome). A token that's structurally incompatible with a plain
  // quote/swap (e.g. an unusual transfer mechanism) can fail identically on
  // every single attempt - without this, the bot would hammer the same
  // doomed buy every tick forever, burning RPC/Jupiter calls for nothing.
  // Escalates (doubles, capped) each time it re-triggers without an
  // intervening successful buy - a persistent problem gets backed off
  // harder over time instead of retrying on the same fixed interval
  // forever. Resets fully (failures, cooldown, escalation) on any
  // successful buy (auto or manual) for that slot.
  const AUTO_BUY_FAILURE_LIMIT = config.strategy.autoBuyFailureLimit;
  const AUTO_BUY_BASE_COOLDOWN_MS = config.strategy.autoBuyCooldownMs;
  const AUTO_BUY_MAX_COOLDOWN_MS = config.strategy.autoBuyMaxCooldownMs;
  const autoBuyFailures: Record<SlotKey, number> = { A: 0, B: 0, C: 0 };
  const autoBuyPausedUntilMs: Record<SlotKey, number | null> = { A: null, B: null, C: null };
  // How many pause cycles in a row without a successful buy in between -
  // drives the doubling. NOT reset just because a cooldown window expired
  // and a retry is due; only a real success resets it.
  const autoBuyEscalation: Record<SlotKey, number> = { A: 0, B: 0, C: 0 };

  // Consecutive tick failures per slot, purely for log noise control (NOT
  // gating retries - a failing sell must always keep retrying). The first
  // failure in a streak logs the full error (so it's diagnosable); repeats
  // of the *same* error collapse to a one-liner instead of dumping the
  // full raw simulation log block again every ~15-25s. Must be declared
  // before tickLoop starts running below (not after) - tickLoop's async
  // IIFE starts calling into tick() -> evaluateSlotSafely immediately, so a
  // `const` declared later in this function is still in the temporal dead
  // zone the first time evaluateSlotSafely's catch block tries to read it.
  const tickFailureStreak: Record<SlotKey, { count: number; message: string }> = {
    A: { count: 0, message: "" },
    B: { count: 0, message: "" },
    C: { count: 0, message: "" },
  };

  function isAutoBuyPaused(slotKey: SlotKey): boolean {
    const until = autoBuyPausedUntilMs[slotKey];
    if (until === null) return false;
    if (Date.now() >= until) {
      autoBuyPausedUntilMs[slotKey] = null;
      autoBuyFailures[slotKey] = 0;
      return false;
    }
    return true;
  }

  function registerAutoBuyFailure(slotKey: SlotKey, err: unknown): void {
    autoBuyFailures[slotKey] += 1;
    log.error(`Slot ${slotKey}: auto-buy failed (${autoBuyFailures[slotKey]}/${AUTO_BUY_FAILURE_LIMIT} in a row)`, {
      error: String((err as Error).message ?? err),
    });
    if (autoBuyFailures[slotKey] >= AUTO_BUY_FAILURE_LIMIT) {
      autoBuyEscalation[slotKey] += 1;
      const cooldownMs = Math.min(AUTO_BUY_BASE_COOLDOWN_MS * 2 ** (autoBuyEscalation[slotKey] - 1), AUTO_BUY_MAX_COOLDOWN_MS);
      autoBuyPausedUntilMs[slotKey] = Date.now() + cooldownMs;
      const msg = `Slot ${slotKey}: auto-buy WSTRZYMANE na ${Math.round(cooldownMs / 60000)} min po ${AUTO_BUY_FAILURE_LIMIT} nieudanych próbach z rzędu (${autoBuyEscalation[slotKey] > 1 ? `eskalacja x${autoBuyEscalation[slotKey]}, ` : ""}prawdopodobnie problem strukturalny, nie zwykły poślizg) - ręczne "buy" nadal działa`;
      setEvent(msg);
      log.warn(msg);
    }
  }
  // Rolling in-memory price history driving the adaptive target/trigger -
  // not persisted, so it starts empty on every restart (falls back to
  // static/conservative defaults until enough of it has been rebuilt).
  let priceHistory: PriceSample[] = [];
  let recentTrades: RecentTrade[] = [];
  // A manual "buy ... @maxPrice" waiting for the price to come down to it -
  // checked every tick while the slot stays flat. Not persisted (a restart
  // just drops it, same as the other transient trackers here) - reissue the
  // command after restarting if you still want it. Cleared as soon as the
  // buy actually fills (see executeBuy) or via the "cancel" command.
  interface PendingManualBuy {
    usdAmount: number | undefined;
    maxPriceUsd: number;
  }
  const pendingManualBuy: Record<SlotKey, PendingManualBuy | null> = { A: null, B: null, C: null };
  // When did the trailing-stop pullback condition start holding true,
  // continuously, for each slot? Reset to null the moment it stops holding
  // (even for one tick) or the position closes - TRAILING_STOP_CONFIRMATION_MS
  // requires it to survive multiple consecutive ticks before actually firing.
  const trailingStopPendingSinceMs: Record<SlotKey, number | null> = { A: null, B: null, C: null };
  // Same confirmation pattern, for the opt-in breakout buy - Slot A only.
  let breakoutBuyPendingSinceMs: number | null = null;
  // When did peakPriceUsd last actually make a new high, for each slot?
  // Drives TRAILING_STOP_STAGNATION_MS - null while flat. Not persisted
  // (like the pending timers above), so a restart just starts the clock
  // over rather than misfiring on stale data.
  const peakUpdatedAtMs: Record<SlotKey, number | null> = { A: null, B: null, C: null };

  const setEvent = (message: string) => {
    lastEvent = { message, atMs: Date.now() };
  };
  /**
   * Plain console.log alone isn't enough for anything meant for a human to
   * actually read: the dashboard clears the screen every DASHBOARD_REFRESH_MS
   * (default 1s), so a bare console.log flashes and is gone before it can be
   * read. Routing status/feedback messages through setEvent too keeps them
   * visible (with an age) across redraws until the next real event replaces
   * them - use this instead of a bare console.log for anything the user is
   * meant to see, not just background logging.
   */
  const notify = (message: string): void => {
    console.log(message);
    setEvent(message);
  };

  function recordTrade(trade: RecentTrade): void {
    recentTrades = [trade, ...recentTrades].slice(0, MAX_RECENT_TRADES);
  }

  // --- small per-slot helpers ------------------------------------------

  function getFlip(slot: SlotKey): FlipState {
    if (slot === "A") return s.slotA;
    if (slot === "B") return s.slotB;
    return s.slotC;
  }
  function setFlip(slot: SlotKey, next: FlipState): void {
    if (slot === "A") s.slotA = next;
    else if (slot === "B") s.slotB = next;
    else s.slotC = next;
  }
  function sizePercentFor(slot: SlotKey): number {
    if (slot === "A") return config.trade.slotASizePercent;
    if (slot === "B") return config.trade.slotBSizePercent;
    return config.trade.slotCSizePercent;
  }
  /** Slot B/C can arm/trail at smaller moves than Slot A - see SLOT_B/C_TRAILING_STOP_* in config.ts. */
  function trailingStopParamsFor(slot: SlotKey): { armPercent: number; trailPercent: number } {
    if (slot === "A") return { armPercent: config.strategy.trailingStopArmPercent, trailPercent: config.strategy.trailingStopPercent };
    if (slot === "B")
      return { armPercent: config.strategy.slotBTrailingStopArmPercent, trailPercent: config.strategy.slotBTrailingStopPercent };
    return { armPercent: config.strategy.slotCTrailingStopArmPercent, trailPercent: config.strategy.slotCTrailingStopPercent };
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
  let webDashboard: { close: () => void } | undefined;
  let readOnlyWebDashboard: { close: () => void } | undefined;
  const stop = () => {
    if (!running) return;
    running = false;
    webDashboard?.close();
    readOnlyWebDashboard?.close();
    log.info("shutting down");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const commandDeps: CommandDeps = {
    logger: log,
    mode: config.mode,
    manualBuy: (usdAmount, slot, maxPriceUsd) => {
      if (maxPriceUsd === undefined) {
        pendingManualBuy[slot] = null;
        return executeBuy(slot, usdAmount, { requireCostGate: false, tag: "MANUAL" });
      }
      const flip = getFlip(slot);
      if (flip.phase !== "AWAITING_BUY") {
        notify(`buy: Slot ${slot} already in a position - sell first.`);
        return Promise.resolve();
      }
      pendingManualBuy[slot] = { usdAmount, maxPriceUsd };
      notify(`Slot ${slot}: czeka na cenę <= $${maxPriceUsd.toFixed(8)}, wtedy kupi (odwołaj: "cancel ${slot.toLowerCase()}")`);
      return Promise.resolve();
    },
    cancelManualBuy: (slot) => {
      if (!pendingManualBuy[slot]) {
        notify(`cancel: Slot ${slot} nie ma oczekującego zlecenia.`);
        return;
      }
      pendingManualBuy[slot] = null;
      notify(`Slot ${slot}: odwołano oczekujące zlecenie kupna.`);
    },
    manualSell: (percent, slot) => executeSell(slot, percent, { requireProfitGate: false, tag: "MANUAL" }),
    panic: (slot) =>
      slot
        ? executeSell(slot, 100, { requireProfitGate: false, tag: "PANIC" })
        : Promise.all([
            executeSell("A", 100, { requireProfitGate: false, tag: "PANIC" }),
            executeSell("B", 100, { requireProfitGate: false, tag: "PANIC" }),
            executeSell("C", 100, { requireProfitGate: false, tag: "PANIC" }),
          ]).then(() => undefined),
    reset: resetPaperSession,
    rebase: rebaseInitialPortfolio,
    onExit: stop,
  };
  const commandRl = startCommandLoop(commandDeps);

  if (config.dashboardWeb.enabled) {
    webDashboard = startWebDashboard(buildSnapshot, commandDeps, config.dashboardWeb.port, log);
  }
  if (config.dashboardReadOnlyWeb.enabled) {
    readOnlyWebDashboard = startReadOnlyWebDashboard(
      buildSnapshot,
      config.dashboardReadOnlyWeb.port,
      log,
      {
        username: config.dashboardReadOnlyWeb.authUsername,
        password: config.dashboardReadOnlyWeb.authPassword,
      },
    );
  }

  let tickFailureCount = 0;
  let lastTickFailureMessage = "";
  const tickLoop = (async () => {
    while (running) {
      try {
        await tick();
        tickFailureCount = 0;
        lastTickFailureMessage = "";
      } catch (err) {
        lastErrorMessage = String((err as Error).message ?? err);
        const signature = errorSignature(lastErrorMessage);
        if (tickFailureCount > 0 && lastTickFailureMessage === signature) {
          tickFailureCount += 1;
          log.error(`tick failed (${tickFailureCount}x in a row, same error as before)`);
        } else {
          tickFailureCount = 1;
          lastTickFailureMessage = signature;
          log.error("tick failed", { error: lastErrorMessage });
        }
      }
      await sleep(config.pricePollIntervalMs);
    }
  })();

  const dashboardLoop = (async () => {
    while (running) {
      // Skip the redraw while a command is partway typed - it clears the
      // WHOLE terminal, so refreshing mid-keystroke wipes out what you were
      // typing before you can finish/submit it. Resumes as soon as the line
      // is empty again (submitted or cleared).
      if (commandRl.line.length === 0) {
        renderDashboard(buildSnapshot());
      }
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

    // Manual "buy ... @maxPrice" limit orders fire before anything else -
    // works regardless of DUAL_SLOT_ENABLED/SLOT_C_ENABLED (those only gate
    // Slot B/C's own automatic reinforcement logic, not an explicit manual
    // override) and independent of the normal buy signal. Wrapped the same
    // as the slots below - a pending order that keeps throwing (e.g.
    // 0x1788 on every attempt) must never abort the rest of the tick, which
    // would otherwise skip B/C's pending orders AND all three slots'
    // normal evaluation below, silently, for as long as it kept failing.
    await evaluateSlotSafely("A", () => checkPendingManualBuy("A", currentPriceUsd));
    await evaluateSlotSafely("B", () => checkPendingManualBuy("B", currentPriceUsd));
    await evaluateSlotSafely("C", () => checkPendingManualBuy("C", currentPriceUsd));

    // Each slot isolated: one slot repeatedly failing (e.g. every automatic
    // buy attempt rejected on-chain) must never stop the OTHER slots from
    // being evaluated that tick - previously a thrown error from Slot B
    // skipped Slot C entirely (and any slot after it) for that whole tick,
    // silently, for as long as B kept failing.
    await evaluateSlotSafely("A", () => evaluateSlotA(currentPriceUsd, solUsd));
    await evaluateSlotSafely("B", () => evaluateSlotB(currentPriceUsd, solUsd));
    await evaluateSlotSafely("C", () => evaluateSlotC(currentPriceUsd, solUsd));
  }

  async function evaluateSlotSafely(slotKey: SlotKey, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      tickFailureStreak[slotKey] = { count: 0, message: "" };
    } catch (err) {
      lastErrorMessage = String((err as Error).message ?? err);
      const signature = errorSignature(lastErrorMessage);
      const streak = tickFailureStreak[slotKey];
      if (streak.count > 0 && streak.message === signature) {
        streak.count += 1;
        log.error(`Slot ${slotKey}: tick evaluation still failing (${streak.count}x in a row, same error as before)`);
      } else {
        tickFailureStreak[slotKey] = { count: 1, message: signature };
        log.error(`Slot ${slotKey}: tick evaluation failed`, { error: lastErrorMessage });
      }
    }
  }

  async function checkPendingManualBuy(slotKey: SlotKey, currentPriceUsd: number): Promise<void> {
    const pending = pendingManualBuy[slotKey];
    if (!pending) return;
    if (getFlip(slotKey).phase !== "AWAITING_BUY") {
      // Slot opened a position some other way (auto rebuy, breakout buy) -
      // this limit order no longer makes sense against an open position.
      pendingManualBuy[slotKey] = null;
      return;
    }
    // Cheap pre-filter only - currentPriceUsd is a thin reference quote
    // (PRICE_REFERENCE_SOL_AMOUNT), not what this order would actually pay.
    // Skips fetching a real quote on every tick while price is nowhere
    // close, without being the thing that actually decides whether to buy -
    // see maxPriceUsd passed into executeBuy below for that.
    if (currentPriceUsd > pending.maxPriceUsd) return;
    // isPendingRetry=true: this is a background retry loop (fires every
    // tick once price looks close), not a one-shot user command - it needs
    // the same failure-streak circuit breaker as automatic buys, or a
    // persistently-failing order (e.g. 0x1788) hammers on-chain forever and
    // floods the log with the full raw simulation dump every single tick.
    await executeBuy(slotKey, pending.usdAmount, { requireCostGate: false, tag: "MANUAL" }, pending.maxPriceUsd, true);
  }

  async function evaluateSlotA(currentPriceUsd: number, solUsd: number): Promise<void> {
    if (s.slotA.phase === "AWAITING_SELL" && s.slotA.buyPrice !== null) {
      await evaluatePosition("A", currentPriceUsd, solUsd);
      return;
    }
    if (s.slotA.phase !== "AWAITING_BUY") return;
    // AUTO_BUY_ENABLED=false: no slot ever buys on its own - manual "buy"/
    // "buy ... @price" commands still work (they call executeBuy directly,
    // not through here), only the automatic paths below are gated.
    if (!config.strategy.autoBuyEnabled) return;

    // The spread gate itself lives in executeBuy (it applies to manual buys
    // too) - this just decides whether it's worth checking this tick at all.
    if (isBuySignal(s.slotA, currentPriceUsd, computeCurrentRebuyDropPercent(), config.strategy.slotARequireManualFirstBuy)) {
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
    if (flip.phase !== "AWAITING_BUY" || !config.strategy.dualSlotEnabled || !config.strategy.autoBuyEnabled) return;

    const triggerDropPercent = computeCurrentTriggerDropPercent();
    if (isReinforcementBuySignal(s.slotA, s.slotB, currentPriceUsd, triggerDropPercent)) {
      await executeBuy("B", undefined, { requireCostGate: true, tag: "AUTO" });
    }
  }

  /**
   * Opt-in (SLOT_C_ENABLED, default off) - a deeper DCA-style tier below
   * Slot B. Same reinforcement mechanism as Slot B (reacts to Slot A's
   * drawdown, never decides to buy on its own), just against a deeper
   * trigger - and independent of whatever Slot B is doing right now (Slot B
   * keeps cycling on its own schedule; gating C on B's transient phase
   * would make C unreliable).
   */
  async function evaluateSlotC(currentPriceUsd: number, solUsd: number): Promise<void> {
    const flip = s.slotC;
    if (flip.phase === "AWAITING_SELL" && flip.buyPrice !== null) {
      await evaluatePosition("C", currentPriceUsd, solUsd);
      return;
    }
    if (flip.phase !== "AWAITING_BUY" || !config.strategy.slotCEnabled || !config.strategy.autoBuyEnabled) return;

    const shouldBuy = config.strategy.slotCScalperEnabled
      ? isZoneScalperBuySignal(
          s.slotA,
          s.slotC,
          currentPriceUsd,
          config.strategy.slotCScalperZoneMinPercent,
          config.strategy.slotCScalperZoneMaxPercent,
          computeCurrentSlotCScalperRebuyPercent(),
          Date.now(),
          s.slotLastSellAtMs.C,
          s.slotReentryCooldownMs.C,
        )
      : isReinforcementBuySignal(
          s.slotA,
          s.slotC,
          currentPriceUsd,
          computeCurrentSlotCTriggerDropPercent(),
        );
    if (shouldBuy) {
      await executeBuy("C", undefined, { requireCostGate: true, tag: "AUTO" });
    }
  }

  /** Live-quotes the sell leg every tick while in position - drives both the
   *  dashboard's live PnL and the actual sell decision, off the same quote. */
  async function evaluatePosition(slotKey: SlotKey, currentPriceUsd: number, solUsd: number): Promise<void> {
    // Keep the recorded peak current before anything else checks it, and
    // note WHEN it last actually moved - drives TRAILING_STOP_STAGNATION_MS.
    const peakBefore = getFlip(slotKey).peakPriceUsd;
    setFlip(slotKey, updatePeakPrice(getFlip(slotKey), currentPriceUsd));
    const flip = getFlip(slotKey);
    if (flip.peakPriceUsd !== peakBefore) peakUpdatedAtMs[slotKey] = Date.now();
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
    // Armed but chopping sideways forever - never a new high (trailing stop
    // keeps waiting) and never a real pullback either (it never fires).
    // Opt-in (TRAILING_STOP_STAGNATION_MS): sell at the current price
    // instead of circling in place, still gated by MIN_NET_PROFIT_PERCENT.
    const stagnationHit = checkTrailingStopStagnation(slotKey, flip);

    if (!targetHit && !trailingStopHit && !stagnationHit) return;

    if (net < config.strategy.minNetProfitPercent) {
      if (config.log.logSkips) {
        log.info(`Slot ${slotKey}: sell considered but net profit after costs is too thin - holding for a better fill`, {
          reason: targetHit ? "target hit" : trailingStopHit ? "trailing stop pullback" : "trailing stop stagnation",
          grossMovePercent: round2(gross),
          estimatedRoundTripCostPercent: round2(cost.totalPercent),
          netProfitPercent: round2(net),
          required: config.strategy.minNetProfitPercent,
        });
      }
      return;
    }

    await fillSell(
      slotKey,
      sell,
      tokenAmount,
      solUsd,
      gross,
      cost.totalPercent,
      net,
      targetHit ? "AUTO" : trailingStopHit ? "TRAILING_STOP" : "STAGNATION",
    );
  }

  /**
   * TRAILING_STOP_STAGNATION_MS (0 = disabled): once armed, if the peak
   * hasn't made a new high for this long, stop waiting for either a full
   * target or a real trailing-stop pullback and just sell at the current
   * price - it's already a real gain (ARM_PERCENT), just not moving.
   */
  function checkTrailingStopStagnation(slotKey: SlotKey, flip: FlipState): boolean {
    if (!config.strategy.trailingStopEnabled || config.strategy.trailingStopStagnationMs <= 0) return false;
    if (flip.buyPrice === null || flip.peakPriceUsd === null) return false;
    const { armPercent } = trailingStopParamsFor(slotKey);
    if (grossMovePercent(flip.buyPrice, flip.peakPriceUsd) < armPercent) return false;
    const updatedAt = peakUpdatedAtMs[slotKey];
    if (updatedAt === null) return false;
    return Date.now() - updatedAt >= config.strategy.trailingStopStagnationMs;
  }

  /**
   * The raw pullback-from-peak condition can flip true on a single noisy
   * tick (the peak itself is just whatever one tick happened to see) and
   * flip false again just as fast. When TRAILING_STOP_CONFIRMATION_MS > 0,
   * this requires the condition to hold continuously across ticks for that
   * long before actually reporting it as triggered.
   */
  function checkTrailingStopWithConfirmation(slotKey: SlotKey, flip: FlipState, currentPriceUsd: number): boolean {
    if (!config.strategy.trailingStopEnabled) {
      trailingStopPendingSinceMs[slotKey] = null;
      return false;
    }

    // The real trigger decides whether we're allowed to fire at all. The
    // (looser) band decides whether the confirmation timer keeps running -
    // a tick that bounces back a fraction of a percent within the band
    // doesn't reset the whole countdown to zero, only a real move back out
    // of it does. Slot B may arm/trail at smaller moves than Slot A.
    const { armPercent, trailPercent } = trailingStopParamsFor(slotKey);
    const trulyTriggered = isTrailingStopTriggered(flip, currentPriceUsd, armPercent, trailPercent);
    const withinBand = isWithinTrailingStopBand(
      flip,
      currentPriceUsd,
      armPercent,
      trailPercent,
      config.strategy.trailingStopConfirmationTolerancePercent,
    );

    if (!withinBand) {
      trailingStopPendingSinceMs[slotKey] = null;
      return false;
    }

    const confirmationMs = config.strategy.trailingStopConfirmationMs;
    const pendingSince = trailingStopPendingSinceMs[slotKey] ?? Date.now();
    trailingStopPendingSinceMs[slotKey] = pendingSince;

    if (!trulyTriggered) {
      // Still just inside the tolerance band (a small bounce) - keep the
      // timer alive but don't fire yet.
      return false;
    }
    if (confirmationMs <= 0) return true;

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
  /**
   * The typical-move input shared by every adaptive calculation below:
   * live in-memory price history once there's enough of it, otherwise the
   * one-time DexScreener snapshot fetched at startup (see main()) - a
   * real, currently-measured estimate instead of always falling back to a
   * flat static default for the first VOLATILITY_LOOKBACK_MS after every
   * restart. Undefined only when BOTH are unavailable (DexScreener didn't
   * have this token, or the fetch failed) - callers fall back to their own
   * static default in that case, exactly as before this existed.
   */
  function currentTypicalMovePercent(): number | undefined {
    const stat = windowStats(priceHistory, config.strategy.volatilityLookbackMs);
    if (stat.count > 0) return stat.medianAbsPercent;
    return startupTypicalMovePercent;
  }

  function computeCurrentTargetGainPercent(): number {
    if (!config.strategy.adaptiveTargetEnabled) return config.strategy.targetGainPercent;
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.targetGainPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.adaptiveTargetMultiplier,
      config.strategy.adaptiveTargetMinPercent,
      config.strategy.adaptiveTargetMaxPercent,
    );
  }

  function computeTargetGainPercentFor(slotKey: SlotKey): number {
    if (slotKey !== "C" || !config.strategy.slotCScalperEnabled) return computeCurrentTargetGainPercent();
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.slotCScalperTargetMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.slotCScalperTargetMultiplier,
      config.strategy.slotCScalperTargetMinPercent,
      config.strategy.slotCScalperTargetMaxPercent,
    );
  }

  function computeCurrentSlotCScalperRebuyPercent(): number {
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.slotCScalperRebuyMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.slotCScalperRebuyMultiplier,
      config.strategy.slotCScalperRebuyMinPercent,
      config.strategy.slotCScalperRebuyMaxPercent,
    );
  }

  function computeCurrentReentryCooldownMs(): number {
    if (!config.strategy.adaptiveReentryCooldownEnabled) {
      return config.strategy.adaptiveReentryCooldownMaxMs;
    }
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.adaptiveReentryCooldownMaxMs;
    return computeAdaptiveCooldownMs(
      typicalMove,
      config.strategy.adaptiveReentryCooldownMinMs,
      config.strategy.adaptiveReentryCooldownMaxMs,
      config.strategy.adaptiveReentryCooldownFullAtVolatilityPercent,
    );
  }

  /** Ordinary adaptive rebuy distance below Slot A's last sell. */
  function computeCurrentRebuyDropPercent(): number {
    if (!config.strategy.adaptiveRebuyEnabled) return config.strategy.rebuyDropPercent;
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.adaptiveRebuyMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.adaptiveRebuyMultiplier,
      config.strategy.adaptiveRebuyMinPercent,
      config.strategy.adaptiveRebuyMaxPercent,
    );
  }

  /**
   * How far underwater Slot A must be before Slot B reinforces it, right
   * now. Same math as the adaptive target, different config knobs. With no
   * estimate at all (no live history AND no startup snapshot), falls back
   * to the MAX (hardest to reach) rather than the min - safer to require a
   * bigger confirmed drop than to reinforce on a guess before we've
   * actually measured anything.
   */
  function computeCurrentTriggerDropPercent(): number {
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.dualTriggerMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.dualTriggerMultiplier,
      config.strategy.dualTriggerMinPercent,
      config.strategy.dualTriggerMaxPercent,
    );
  }

  /** Same idea as computeCurrentTriggerDropPercent, for Slot C's deeper tier. */
  function computeCurrentSlotCTriggerDropPercent(): number {
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.slotCTriggerMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.slotCTriggerMultiplier,
      config.strategy.slotCTriggerMinPercent,
      config.strategy.slotCTriggerMaxPercent,
    );
  }

  /** How far Slot A must pull back from a breakout peak before buying into it, right now. */
  function computeCurrentBreakoutPullbackPercent(): number {
    const typicalMove = currentTypicalMovePercent();
    if (typicalMove === undefined) return config.strategy.breakoutBuyMaxPercent;
    return computeAdaptiveTargetPercent(
      typicalMove,
      config.strategy.breakoutBuyMultiplier,
      config.strategy.breakoutBuyMinPercent,
      config.strategy.breakoutBuyMaxPercent,
    );
  }

  /** Same noise-filtering shape as checkTrailingStopWithConfirmation, for the breakout buy. */
  function checkBreakoutBuyWithConfirmation(flip: FlipState, currentPriceUsd: number): boolean {
    const pullbackPercent = computeCurrentBreakoutPullbackPercent();
    const trulyTriggered = isBreakoutBuySignal(flip, currentPriceUsd, pullbackPercent);
    const withinBand = isWithinBreakoutBuyBand(
      flip,
      currentPriceUsd,
      pullbackPercent,
      config.strategy.breakoutBuyConfirmationTolerancePercent,
    );

    if (!withinBand) {
      breakoutBuyPendingSinceMs = null;
      return false;
    }

    const confirmationMs = config.strategy.breakoutBuyConfirmationMs;
    const pendingSince = breakoutBuyPendingSinceMs ?? Date.now();
    breakoutBuyPendingSinceMs = pendingSince;

    if (!trulyTriggered) return false;
    if (confirmationMs <= 0) return true;

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
    maxPriceUsd?: number,
    // true only for the background "buy ... @maxPrice" retry loop
    // (checkPendingManualBuy) - it fires every tick on its own, same as an
    // automatic buy, so it gets the same failure-streak circuit breaker.
    // A one-shot typed "buy" command is never throttled by this.
    isPendingRetry = false,
  ): Promise<void> {
    const flip = getFlip(slotKey);
    if (flip.phase !== "AWAITING_BUY") {
      if (opts.tag === "MANUAL") notify(`buy: Slot ${slotKey} already in a position - sell first.`);
      return;
    }
    const cooldownRemainingMs = Math.max(
      0,
      s.slotReentryCooldownMs[slotKey] - (Date.now() - s.slotLastSellAtMs[slotKey]),
    );
    if (cooldownRemainingMs > 0) {
      const msg = `Slot ${slotKey}: re-entry cooldown - next buy allowed in ${Math.ceil(cooldownRemainingMs / 1000)}s`;
      if (opts.tag === "MANUAL") notify(msg);
      else if (config.log.logSkips) log.info(msg);
      return;
    }
    const throttled = opts.tag === "AUTO" || isPendingRetry;
    if (throttled && isAutoBuyPaused(slotKey)) {
      if (config.log.logSkips) {
        const msRemaining = (autoBuyPausedUntilMs[slotKey] ?? Date.now()) - Date.now();
        log.info(`Slot ${slotKey}: auto-buy paused (${Math.ceil(msRemaining / 1000)}s remaining) - skipping`);
      }
      return;
    }
    if (slotLocks[slotKey]) {
      if (opts.tag === "MANUAL") notify(`buy: Slot ${slotKey} is mid-transaction - try again in a moment.`);
      return;
    }
    slotLocks[slotKey] = true;
    try {
      await executeBuyLocked(slotKey, flip, usdAmountOverride, opts, maxPriceUsd);
      // Reached without throwing - whether it actually filled or just
      // skipped on a normal gate (cost/spread/impact too high right now),
      // the pipeline itself is working, so clear any past-failure streak.
      autoBuyFailures[slotKey] = 0;
      autoBuyPausedUntilMs[slotKey] = null;
      autoBuyEscalation[slotKey] = 0;
    } catch (err) {
      if (throttled) registerAutoBuyFailure(slotKey, err);
      throw err;
    } finally {
      slotLocks[slotKey] = false;
    }
  }

  async function executeBuyLocked(
    slotKey: SlotKey,
    flip: FlipState,
    usdAmountOverride: number | undefined,
    opts: { requireCostGate: boolean; tag: "AUTO" | "MANUAL" },
    maxPriceUsd?: number,
  ): Promise<void> {
    const solUsd = await solPrice.getPrice();
    const solBalance = config.mode === "live" && owner ? await getSolBalanceSol(connection, owner) : s.paperSolBalance;

    // A manual "buy <usd>" forces an exact amount; the automatic strategy
    // sizes every buy as this slot's SIZE_PERCENT of the STARTING portfolio
    // value (fixed, does not compound with the account) - see sizing.ts.
    const usdAmount = usdAmountOverride ?? computeFixedSlotTradeUsd(s.initialPortfolioUsd, sizePercentFor(slotKey));
    if (usdAmount <= 0) {
      const msg = `skipping buy (Slot ${slotKey}) - computed trade size is $0 (check SLOT_${slotKey}_SIZE_PERCENT)`;
      log.warn(msg);
      if (opts.tag === "MANUAL") notify(msg);
      return;
    }
    const solIn = usdAmount / solUsd;
    const amountLamports = Math.round(solIn * 10 ** solDecimals);

    if (solBalance - solIn < config.trade.minSolReserve) {
      const msg = `skipping buy (Slot ${slotKey}) - would breach MIN_SOL_RESERVE (balance ${solBalance.toFixed(4)}, need ${solIn.toFixed(4)})`;
      log.warn(msg);
      if (opts.tag === "MANUAL") notify(msg);
      return;
    }

    const spreadPercent = await getPoolSpreadPercent();
    latestSpreadPercent = spreadPercent;
    if (spreadPercent > config.strategy.maxSpreadPercent) {
      const msg = `skipping buy (Slot ${slotKey}) - pool spread too wide (${spreadPercent.toFixed(2)}% > max ${config.strategy.maxSpreadPercent}%)`;
      log.warn(msg);
      if (opts.tag === "MANUAL") notify(msg);
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
      if (opts.tag === "MANUAL") notify(msg);
      return;
    }

    // The authoritative check for "buy ... @maxPrice" limit orders: the
    // pre-filter in checkPendingManualBuy only looks at a thin reference
    // quote, not what THIS order (its real size) would actually pay - a
    // bigger order has more price impact than the reference amount, so its
    // real average fill price can end up above the limit even when the
    // reference price looked fine. This is what actually decides whether to
    // buy. Doesn't clear the pending order - it stays queued and retries
    // next tick, same as if the reference pre-filter hadn't passed yet.
    if (maxPriceUsd !== undefined) {
      const projectedFillPriceUsd = solIn * solUsd / (Number(buy.quote.outAmount) / 10 ** tokenDecimals);
      if (projectedFillPriceUsd > maxPriceUsd) {
        const msg = `Slot ${slotKey}: limit buy waiting - projected fill $${projectedFillPriceUsd.toFixed(8)} > limit $${maxPriceUsd.toFixed(8)} (this order's own size has more impact than the reference quote)`;
        if (config.log.logSkips) log.info(msg);
        if (opts.tag === "MANUAL") notify(msg);
        return;
      }
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

    const targetGainPercent = computeTargetGainPercentFor(slotKey);
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
    // A limit-style "buy ... @price" that was waiting is now satisfied.
    pendingManualBuy[slotKey] = null;
    // Peak starts at the fill price (see afterBuy) - count that as its first "update".
    peakUpdatedAtMs[slotKey] = Date.now();
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
      notify(`sell: Slot ${slotKey} has no position to sell.`);
      return;
    }

    const solUsd = await solPrice.getPrice();
    const currentPriceUsd = await getReferenceTokenPriceUsd(solUsd);
    const heldAmount = flip.tokenAmount ?? 0;
    const sellAmount = heldAmount * (percentOfPosition / 100);
    if (sellAmount <= 0) {
      notify(`sell: Slot ${slotKey} has no position to sell.`);
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
      notify(msg);
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
    tag: "AUTO" | "MANUAL" | "PANIC" | "STOP_LOSS" | "TRAILING_STOP" | "STAGNATION",
    percentOfPosition = 100,
  ): Promise<void> {
    const flip = getFlip(slotKey);
    if (flip.buyPrice === null || flip.entryCost === null) return;
    if (slotLocks[slotKey]) {
      notify(`sell: Slot ${slotKey} is mid-transaction - try again in a moment.`);
      return;
    }
    slotLocks[slotKey] = true;
    try {
      await fillSellLocked(slotKey, flip, sell, tokenAmount, solUsd, gross, roundTripCostPercent, net, tag, percentOfPosition);
    } finally {
      slotLocks[slotKey] = false;
    }
  }

  async function fillSellLocked(
    slotKey: SlotKey,
    flip: FlipState,
    sell: Awaited<ReturnType<typeof priceLeg>>,
    tokenAmount: number,
    solUsd: number,
    gross: number,
    roundTripCostPercent: number,
    net: number,
    tag: "AUTO" | "MANUAL" | "PANIC" | "STOP_LOSS" | "TRAILING_STOP" | "STAGNATION",
    percentOfPosition: number,
  ): Promise<void> {
    if (flip.entryCost === null) return; // already validated by the caller - narrows the type below
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
      setFlip(slotKey, afterSell(flip, fillPriceUsd, shouldRequireManualNextBuy(slotKey, tag)));
      s.slotLastSellAtMs[slotKey] = Date.now();
      s.slotReentryCooldownMs[slotKey] = computeCurrentReentryCooldownMs();
      trailingStopPendingSinceMs[slotKey] = null;
      peakUpdatedAtMs[slotKey] = null;
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
          : tag === "STAGNATION"
            ? "SELL (stagnant - locking in profit)"
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

  /**
   * "rebase" - recomputes initialPortfolioUsd (the fixed base every slot's
   * SIZE_PERCENT is a % of - see sizing.ts) from the wallet's ACTUAL current
   * value, instead of whatever it was worth the first time the bot ever
   * ran. Use this after depositing/withdrawing so future buy sizes reflect
   * the new balance - without it, adding funds updates the balance shown
   * on the dashboard but SLOT_A/B/C_SIZE_PERCENT keeps computing off the
   * old, stale base forever (by design, so PnL doesn't silently inflate
   * trade size - see the comment on initialPortfolioUsd in ledger.ts).
   * Unlike reset, this never touches open positions, trade history, or
   * PnL, and works in both paper and live mode.
   */
  async function rebaseInitialPortfolio(): Promise<void> {
    if (latestSolUsd === undefined || latestPriceUsd === undefined) {
      notify("rebase: brak jeszcze danych cenowych - poczekaj na pierwszy tick i spróbuj ponownie.");
      return;
    }
    const solBalance = config.mode === "live" && owner ? await getSolBalanceSol(connection, owner) : s.paperSolBalance;
    const slotKeys: SlotKey[] = ["A", "B", "C"];
    const investedUsd = slotKeys.reduce((sum, slotKey) => {
      const flip = getFlip(slotKey);
      if (flip.phase === "AWAITING_SELL" && flip.tokenAmount !== null && latestPriceUsd !== undefined) {
        return sum + flip.tokenAmount * latestPriceUsd;
      }
      return sum;
    }, 0);
    const oldBase = s.initialPortfolioUsd;
    const newBase = solBalance * latestSolUsd + investedUsd;
    s.initialPortfolioUsd = newBase;
    saveState(config, s);
    notify(
      `rebase: baza wielkości pozycji $${oldBase.toFixed(2)} -> $${newBase.toFixed(2)} (${usdSigned(newBase - oldBase)}) - SLOT_A/B/C_SIZE_PERCENT liczą się teraz od tej nowej wartości`,
    );
    log.info("rebased initialPortfolioUsd", { oldBase: round2(oldBase), newBase: round2(newBase) });
  }

  function resetPaperSession(): void {
    solPrice
      .getPrice()
      .then((solUsd) => {
        s = {
          // A genuinely fresh start, not just "close the open position" -
          // lastSellPrice and completedFlips are wiped too, so a reset
          // really does put every slot back to "never traded", including
          // re-arming SLOT_A_REQUIRE_MANUAL_FIRST_BUY for the next entry.
          slotA: initialFlipState(),
          slotB: initialFlipState(),
          slotC: initialFlipState(),
          slotLastSellAtMs: { A: 0, B: 0, C: 0 },
          slotReentryCooldownMs: { A: 0, B: 0, C: 0 },
          paperSolBalance: config.paper.startingBalanceUsd / solUsd,
          paperTokenBalance: 0,
          realizedPnlUsd: 0,
          initialPortfolioUsd: config.paper.startingBalanceUsd,
          mode: config.mode,
        };
        live.A = freshSlotLive();
        live.B = freshSlotLive();
        live.C = freshSlotLive();
        recentTrades = [];
        trailingStopPendingSinceMs.A = null;
        trailingStopPendingSinceMs.B = null;
        trailingStopPendingSinceMs.C = null;
        peakUpdatedAtMs.A = null;
        peakUpdatedAtMs.B = null;
        peakUpdatedAtMs.C = null;
        breakoutBuyPendingSinceMs = null;
        saveState(config, s);
        const msg = `PAPER session reset (wszystkie sloty, od zera) - fresh balance $${config.paper.startingBalanceUsd.toFixed(2)}`;
        setEvent(msg);
        log.info(msg);
      })
      .catch((err) => log.error("reset failed", { error: String(err) }));
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
                    grossMovePercent(flip.buyPrice, flip.peakPriceUsd) >= trailingStopParamsFor(slotKey).armPercent,
                  triggerPriceUsd:
                    flip.peakPriceUsd !== null
                      ? flip.peakPriceUsd * (1 - trailingStopParamsFor(slotKey).trailPercent / 100)
                      : undefined,
                }
              : undefined,
          }
        : undefined;

    const slotADrawdownPercent =
      s.slotA.phase === "AWAITING_SELL" && s.slotA.buyPrice !== null && latestPriceUsd !== undefined
        ? grossMovePercent(s.slotA.buyPrice, latestPriceUsd)
        : undefined;
    const cScalperRebuyDropPercent = computeCurrentSlotCScalperRebuyPercent();
    const reinforcement =
      slotKey === "B"
        ? { enabled: config.strategy.dualSlotEnabled, triggerDropPercent: computeCurrentTriggerDropPercent(), slotADrawdownPercent }
        : slotKey === "C"
          ? {
              enabled: config.strategy.slotCEnabled,
              triggerDropPercent: config.strategy.slotCScalperEnabled
                ? config.strategy.slotCScalperZoneMinPercent
                : computeCurrentSlotCTriggerDropPercent(),
              slotADrawdownPercent,
              zoneMaxDrawdownPercent: config.strategy.slotCScalperEnabled
                ? config.strategy.slotCScalperZoneMaxPercent
                : undefined,
              rebuyDropPercent: config.strategy.slotCScalperEnabled ? cScalperRebuyDropPercent : undefined,
              rebuyTriggerUsd:
                config.strategy.slotCScalperEnabled && flip.lastSellPrice !== null
                  ? flip.lastSellPrice * (1 - cScalperRebuyDropPercent / 100)
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

    const rebuyDropPercent = computeCurrentRebuyDropPercent();

    return {
      label: slotKey,
      sizePercent: sizePercentFor(slotKey),
      position,
      rebuyTriggerUsd:
        slotKey === "A" && flip.phase === "AWAITING_BUY" && flip.lastSellPrice !== null
          ? flip.lastSellPrice * (1 - rebuyDropPercent / 100)
          : undefined,
      rebuyDropPercent: slotKey === "A" ? rebuyDropPercent : undefined,
      lastSellPriceUsd: flip.lastSellPrice ?? undefined,
      requireManualNextBuy: flip.requireManualNextBuy,
      completedFlips: flip.completedFlips,
      adaptiveTargetEnabled: config.strategy.adaptiveTargetEnabled,
      nextTargetGainPercent: flip.phase === "AWAITING_BUY" ? computeTargetGainPercentFor(slotKey) : undefined,
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
      pendingManualBuy: pendingManualBuy[slotKey] ?? undefined,
      autoBuyPausedSecondsLeft: isAutoBuyPaused(slotKey)
        ? Math.max(0, Math.ceil(((autoBuyPausedUntilMs[slotKey] ?? Date.now()) - Date.now()) / 1000))
        : undefined,
      reentryCooldownSecondsLeft:
        flip.phase === "AWAITING_BUY" && Date.now() - s.slotLastSellAtMs[slotKey] < s.slotReentryCooldownMs[slotKey]
          ? Math.ceil((s.slotReentryCooldownMs[slotKey] - (Date.now() - s.slotLastSellAtMs[slotKey])) / 1000)
          : undefined,
    };
  }

  function buildSnapshot(): DashboardState {
    const slotA = buildSlotSnapshot("A");
    const slotB = buildSlotSnapshot("B");
    // Slot C is opt-in - only shown on the dashboard once SLOT_C_ENABLED, so
    // the layout for everyone else is unchanged.
    const slotC = config.strategy.slotCEnabled ? buildSlotSnapshot("C") : undefined;
    const investedUsd =
      (slotA.position?.positionValueUsd ?? 0) + (slotB.position?.positionValueUsd ?? 0) + (slotC?.position?.positionValueUsd ?? 0);
    const equityUsd =
      latestSolUsd !== undefined ? latestSolBalance * latestSolUsd + investedUsd : undefined;

    return {
      tokenSymbol: config.token.symbol,
      mode: config.mode === "live" ? "LIVE" : "PAPER",
      autoBuyEnabled: config.strategy.autoBuyEnabled,
      priceUsd: latestPriceUsd,
      slotA,
      slotB,
      slotC,
      realizedPnlUsd: s.realizedPnlUsd,
      solBalance: latestSolBalance,
      solValueUsd: latestSolUsd !== undefined ? latestSolBalance * latestSolUsd : undefined,
      minSolReserve: config.trade.minSolReserve,
      availableSolForBuys: Math.max(0, latestSolBalance - config.trade.minSolReserve),
      availableUsdForBuys:
        latestSolUsd !== undefined ? Math.max(0, latestSolBalance - config.trade.minSolReserve) * latestSolUsd : undefined,
      initialPortfolioUsd: s.initialPortfolioUsd,
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

/**
 * Collapses an error message down to a stable "is this the same underlying
 * failure recurring" signature, for the repeat-failure log quieting above.
 * A raw simulation failure's message embeds things that legitimately change
 * between otherwise-identical attempts (e.g. "consumed 1013 of 1386287
 * compute units" - the exact figure isn't identical every retry even when
 * the actual failure, like a fixed 0x1788 program error, is), so comparing
 * full message strings for equality would almost never match and defeat
 * the quieting entirely. Falls back to the full message when there's no
 * program error code to key off of.
 */
function errorSignature(message: string): string {
  const match = message.match(/custom program error: (0x[0-9a-fA-F]+)/);
  return match?.[1] ?? message;
}

main().catch((err) => {
  // Node's console.error(err) inspects the whole object graph, which can
  // itself throw on certain error shapes (e.g. undici/fetch errors with an
  // unusual `cause`) and mask the real error. Print plain strings instead.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const cause = err instanceof Error && err.cause !== undefined ? String(err.cause) : undefined;
  // eslint-disable-next-line no-console
  console.error("fatal error:", message);
  if (cause) {
    // eslint-disable-next-line no-console
    console.error("cause:", cause);
  }
  if (stack) {
    // eslint-disable-next-line no-console
    console.error(stack);
  }
  process.exit(1);
});
