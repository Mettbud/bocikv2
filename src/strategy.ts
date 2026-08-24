/**
 * The whole strategy, in one sentence: buy low, sell high, and once we've
 * sold, wait for price to fall back below where we sold before buying
 * again. No averaging within a single position, no cascading partial
 * exits - each slot holds one position at a time.
 *
 * The bot runs TWO independent slots of this exact state machine (Slot A,
 * Slot B - see index.ts), each with its own buy/sell price, target, and
 * cost basis. Slot A follows the rule above on its own. Slot B never
 * decides to buy by itself - it only ever "reinforces" while Slot A is
 * open and underwater (see `isReinforcementBuySignal`), then sells
 * independently at its own target like any other position.
 *
 * All functions here are pure (no I/O, no clock reads beyond the price
 * passed in) so the state machine is fully unit-testable independent of
 * Jupiter, the wallet, or the network.
 */

export type Phase = "AWAITING_BUY" | "AWAITING_SELL";

export interface EntryCost {
  /** Buy-leg price impact %, captured live at buy time. */
  buyLegPercent: number;
  /** Priority + network fee lamports paid on the buy leg. */
  buyNetworkFeeLamports: number;
  /** Actual USD spent on the buy - both the round-trip cost-% denominator and the realized-PnL basis. */
  costUsd: number;
}

export interface FlipState {
  phase: Phase;
  /** Price we bought at, set while AWAITING_SELL. */
  buyPrice: number | null;
  /** Price we last sold at - the rebuy reference. null until first sell. */
  lastSellPrice: number | null;
  /** Token units currently held, set while AWAITING_SELL. */
  tokenAmount: number | null;
  /** Buy-leg cost info, carried forward so a sell can compute the true round-trip cost. */
  entryCost: EntryCost | null;
  /**
   * The gross target % this specific position sells at - fixed at buy time
   * (static TARGET_GAIN_PERCENT, or a freshly-computed adaptive value) and
   * never changed while the position is open, so we're not chasing a
   * moving goalpost mid-trade. The next buy computes its own.
   */
  targetGainPercent: number | null;
  /** Highest price seen since entry, set while AWAITING_SELL - drives the trailing stop. */
  peakPriceUsd: number | null;
  /**
   * Highest price seen while AWAITING_BUY and above lastSellPrice - drives
   * the (opt-in) breakout buy. Only tracked once price has actually broken
   * above the normal rebuy reference; resets whenever price drops back to
   * or below lastSellPrice (the normal dip-buy path takes over instead).
   */
  breakoutPeakUsd: number | null;
  completedFlips: number;
  /**
   * For Slot A, a MANUAL sell/panic means "I wanted OUT", so automatic buy
   * paths stay blocked until a manual "buy" opens the next position. The
   * caller never sets this for reinforcement Slots B/C: they return to
   * their automatic drawdown signals after any exit.
   */
  requireManualNextBuy: boolean;
}

/** Only the primary Slot A stays manual after a user-forced full exit. */
export function shouldRequireManualNextBuy(
  slotKey: "A" | "B" | "C",
  sellTag: "AUTO" | "MANUAL" | "PANIC" | "STOP_LOSS" | "TRAILING_STOP" | "STAGNATION",
): boolean {
  return slotKey === "A" && (sellTag === "MANUAL" || sellTag === "PANIC");
}

export function initialFlipState(): FlipState {
  return {
    phase: "AWAITING_BUY",
    buyPrice: null,
    lastSellPrice: null,
    tokenAmount: null,
    entryCost: null,
    targetGainPercent: null,
    peakPriceUsd: null,
    breakoutPeakUsd: null,
    completedFlips: 0,
    requireManualNextBuy: false,
  };
}

/** The price we need to reach before this position is even considered for sale. */
export function sellTargetPrice(buyPrice: number, targetGainPercent: number): number {
  return buyPrice * (1 + targetGainPercent / 100);
}

/** The price we need to fall back below before we buy back in. */
export function rebuyTriggerPrice(
  lastSellPrice: number,
  rebuyDropPercent: number,
): number {
  return lastSellPrice * (1 - rebuyDropPercent / 100);
}

/**
 * Is it time to *look at* buying? This does not check cost/profitability -
 * that's a live decision made against a fresh quote, see costModel.ts. This
 * only answers "has price behaved the way our rule requires".
 *
 * `requireManualFirstEntry`: when true, the very first-ever entry (no prior
 * sell yet) is never taken automatically - only a manual "buy" command can
 * open it. Every rebuy after that first position closes is unaffected and
 * still fires automatically off `lastSellPrice`, same as always.
 */
export function isBuySignal(
  state: FlipState,
  currentPrice: number,
  rebuyDropPercent: number,
  requireManualFirstEntry = false,
): boolean {
  if (state.phase !== "AWAITING_BUY") return false;
  if (state.requireManualNextBuy) return false;
  // No prior sell yet: this is the very first entry into the strategy.
  if (state.lastSellPrice === null) return !requireManualFirstEntry;
  return currentPrice <= rebuyTriggerPrice(state.lastSellPrice, rebuyDropPercent);
}

/** Is price at or above the gross target that makes a sale worth evaluating? */
export function isSellSignal(
  state: FlipState,
  currentPrice: number,
  targetGainPercent: number,
): boolean {
  if (state.phase !== "AWAITING_SELL" || state.buyPrice === null) return false;
  return currentPrice >= sellTargetPrice(state.buyPrice, targetGainPercent);
}

export function grossMovePercent(buyPrice: number, currentPrice: number): number {
  return ((currentPrice - buyPrice) / buyPrice) * 100;
}

/**
 * Slot B's only entry condition: Slot A must currently hold a position
 * that's underwater by at least `triggerDropPercent`, and Slot B itself
 * must be flat. Slot B never rebuys on its own schedule - every buy it
 * ever makes is a reaction to Slot A being in a drawdown.
 */
export function isReinforcementBuySignal(
  slotA: FlipState,
  slotB: FlipState,
  currentPrice: number,
  triggerDropPercent: number,
): boolean {
  if (slotB.phase !== "AWAITING_BUY") return false;
  if (slotB.requireManualNextBuy) return false;
  if (slotA.phase !== "AWAITING_SELL" || slotA.buyPrice === null) return false;
  return grossMovePercent(slotA.buyPrice, currentPrice) <= -triggerDropPercent;
}

/**
 * Slot C scalper entry: A must remain inside the configured drawdown zone.
 * The first C entry can happen anywhere inside it; every later entry must
 * additionally be below C's own last sell and past the persisted cooldown.
 */
export function isZoneScalperBuySignal(
  slotA: FlipState,
  slotC: FlipState,
  currentPrice: number,
  zoneMinDrawdownPercent: number,
  zoneMaxDrawdownPercent: number,
  rebuyDropPercent: number,
  nowMs: number,
  lastSellAtMs: number,
  cooldownMs: number,
): boolean {
  if (slotC.phase !== "AWAITING_BUY" || slotC.requireManualNextBuy) return false;
  if (slotA.phase !== "AWAITING_SELL" || slotA.buyPrice === null) return false;
  const drawdown = -grossMovePercent(slotA.buyPrice, currentPrice);
  if (drawdown < zoneMinDrawdownPercent || drawdown > zoneMaxDrawdownPercent) return false;
  if (slotC.lastSellPrice === null) return true;
  if (nowMs - lastSellAtMs < cooldownMs) return false;
  return currentPrice <= rebuyTriggerPrice(slotC.lastSellPrice, rebuyDropPercent);
}

/** Optional safety net, independent of the flip logic - not the profit strategy. */
export function isStopLossTriggered(
  buyPrice: number,
  currentPrice: number,
  stopLossPercent: number,
): boolean {
  if (stopLossPercent <= 0) return false;
  return currentPrice <= buyPrice * (1 - stopLossPercent / 100);
}

/**
 * Call every tick while a position is open, before checking anything else -
 * keeps `peakPriceUsd` current so the trailing stop below has something
 * real to compare against. A no-op once the price stops making new highs.
 */
export function updatePeakPrice(state: FlipState, currentPrice: number): FlipState {
  if (state.phase !== "AWAITING_SELL" || state.buyPrice === null) return state;
  const peak = Math.max(state.peakPriceUsd ?? state.buyPrice, currentPrice);
  if (peak === state.peakPriceUsd) return state;
  return { ...state, peakPriceUsd: peak };
}

/**
 * Locks in gains on a position that got meaningfully into profit and then
 * pulled back, instead of only ever exiting at the full original target
 * (which a ranging/choppy market may never reach) or riding all the way
 * back down. Two stages:
 *   1. "Armed" only once the peak since entry reached at least `armPercent`
 *      gain - a position that never got that far into profit doesn't have
 *      real gains to protect yet.
 *   2. Once armed, triggers as soon as price falls `trailPercent` below
 *      that peak - selling with whatever gain is left then, not at the
 *      peak itself (nothing here predicts the top).
 *
 * This only decides WHEN to consider exiting early - like a normal target
 * hit, the actual sell still has to clear MIN_NET_PROFIT_PERCENT against a
 * live quote before it fires (see index.ts).
 */
export function isTrailingStopTriggered(
  state: FlipState,
  currentPrice: number,
  armPercent: number,
  trailPercent: number,
): boolean {
  if (state.phase !== "AWAITING_SELL" || state.buyPrice === null || state.peakPriceUsd === null) return false;
  const peakGainPercent = grossMovePercent(state.buyPrice, state.peakPriceUsd);
  if (peakGainPercent < armPercent) return false;
  const dropFromPeakPercent = grossMovePercent(state.peakPriceUsd, currentPrice);
  return dropFromPeakPercent <= -trailPercent;
}

/**
 * Opt-in (BREAKOUT_BUY_ENABLED, default off): while flat, if price runs up
 * well above the normal rebuy reference instead of ever dipping back to it,
 * the bot would otherwise wait forever. This tracks the peak of that
 * run-up so a pullback-from-breakout buy (see `isBreakoutBuySignal`) has
 * something to compare against - same shape as the trailing stop, just for
 * buying instead of selling. A no-op whenever price is at or below
 * lastSellPrice (the ordinary dip-buy path covers that case already).
 */
export function updateBreakoutPeak(state: FlipState, currentPrice: number): FlipState {
  if (state.phase !== "AWAITING_BUY" || state.lastSellPrice === null) return state;
  if (currentPrice <= state.lastSellPrice) {
    return state.breakoutPeakUsd === null ? state : { ...state, breakoutPeakUsd: null };
  }
  const peak = Math.max(state.breakoutPeakUsd ?? currentPrice, currentPrice);
  if (peak === state.breakoutPeakUsd) return state;
  return { ...state, breakoutPeakUsd: peak };
}

/**
 * Buys into a confirmed pullback within an up-move, instead of only ever
 * buying back at (or below) the old lastSellPrice. Requires a real
 * breakout peak above lastSellPrice to exist first (set by
 * `updateBreakoutPeak`), then triggers once price falls `pullbackPercent`
 * below that peak - same "don't guess the top, react to a real pullback"
 * shape as the trailing stop.
 */
export function isBreakoutBuySignal(
  state: FlipState,
  currentPrice: number,
  pullbackPercent: number,
): boolean {
  if (state.phase !== "AWAITING_BUY" || state.lastSellPrice === null || state.breakoutPeakUsd === null) return false;
  if (state.requireManualNextBuy) return false;
  if (state.breakoutPeakUsd <= state.lastSellPrice) return false;
  const dropFromPeakPercent = grossMovePercent(state.breakoutPeakUsd, currentPrice);
  return dropFromPeakPercent <= -pullbackPercent;
}

/**
 * Same threshold-crossing shape as `isTrailingStopTriggered`, but against a
 * *looser* trailPercent (trailPercent - tolerancePercent). Used only to
 * decide whether a confirmation timer should keep counting through a single
 * noisy tick that bounced slightly back above the real trigger, instead of
 * resetting to zero - the actual sell still requires
 * `isTrailingStopTriggered` (the real, un-loosened threshold) to be true.
 */
export function isWithinTrailingStopBand(
  state: FlipState,
  currentPrice: number,
  armPercent: number,
  trailPercent: number,
  tolerancePercent: number,
): boolean {
  return isTrailingStopTriggered(state, currentPrice, armPercent, Math.max(0, trailPercent - tolerancePercent));
}

/** Same idea as `isWithinTrailingStopBand`, for the breakout-buy pullback. */
export function isWithinBreakoutBuyBand(
  state: FlipState,
  currentPrice: number,
  pullbackPercent: number,
  tolerancePercent: number,
): boolean {
  return isBreakoutBuySignal(state, currentPrice, Math.max(0, pullbackPercent - tolerancePercent));
}

export function afterBuy(
  state: FlipState,
  fillPrice: number,
  tokenAmount: number,
  entryCost: EntryCost,
  targetGainPercent: number,
): FlipState {
  return {
    ...state,
    phase: "AWAITING_SELL",
    buyPrice: fillPrice,
    tokenAmount,
    entryCost,
    targetGainPercent,
    peakPriceUsd: fillPrice,
    breakoutPeakUsd: null,
    // Whatever we were waiting on manual confirmation for, we just got it.
    requireManualNextBuy: false,
  };
}

/**
 * `requireManualNextBuy`: true for a MANUAL/PANIC sell - "I wanted OUT"
 * shouldn't be immediately followed by the bot buying back in on its own.
 * false (default) for an automatic sell (target/stop-loss/trailing stop/
 * stagnation) - that's the strategy working as intended, so the normal
 * automatic rebuy stays enabled.
 */
export function afterSell(state: FlipState, fillPrice: number, requireManualNextBuy = false): FlipState {
  return {
    ...state,
    phase: "AWAITING_BUY",
    buyPrice: null,
    tokenAmount: null,
    entryCost: null,
    targetGainPercent: null,
    peakPriceUsd: null,
    breakoutPeakUsd: null,
    lastSellPrice: fillPrice,
    completedFlips: state.completedFlips + 1,
    requireManualNextBuy,
  };
}
