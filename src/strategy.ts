/**
 * The whole strategy, in one sentence: buy low, sell high, and once we've
 * sold, wait for price to fall back below where we sold before buying
 * again. Two states, one flip at a time - no averaging in, no pyramiding,
 * no cascading partial exits.
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
  completedFlips: number;
}

export function initialFlipState(): FlipState {
  return {
    phase: "AWAITING_BUY",
    buyPrice: null,
    lastSellPrice: null,
    tokenAmount: null,
    entryCost: null,
    completedFlips: 0,
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
 */
export function isBuySignal(
  state: FlipState,
  currentPrice: number,
  rebuyDropPercent: number,
): boolean {
  if (state.phase !== "AWAITING_BUY") return false;
  // No prior sell yet: this is the very first entry into the strategy.
  if (state.lastSellPrice === null) return true;
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

/** Optional safety net, independent of the flip logic - not the profit strategy. */
export function isStopLossTriggered(
  buyPrice: number,
  currentPrice: number,
  stopLossPercent: number,
): boolean {
  if (stopLossPercent <= 0) return false;
  return currentPrice <= buyPrice * (1 - stopLossPercent / 100);
}

export function afterBuy(
  state: FlipState,
  fillPrice: number,
  tokenAmount: number,
  entryCost: EntryCost,
): FlipState {
  return {
    ...state,
    phase: "AWAITING_SELL",
    buyPrice: fillPrice,
    tokenAmount,
    entryCost,
  };
}

export function afterSell(state: FlipState, fillPrice: number): FlipState {
  return {
    ...state,
    phase: "AWAITING_BUY",
    buyPrice: null,
    tokenAmount: null,
    entryCost: null,
    lastSellPrice: fillPrice,
    completedFlips: state.completedFlips + 1,
  };
}
