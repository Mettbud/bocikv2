import { describe, expect, it } from "vitest";
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
  rebuyTriggerPrice,
  sellTargetPrice,
  updateBreakoutPeak,
  updatePeakPrice,
} from "../src/strategy.js";

describe("flip strategy state machine", () => {
  it("buys immediately on the very first tick (no prior sell)", () => {
    const state = initialFlipState();
    expect(isBuySignal(state, 1.0, 0)).toBe(true);
  });

  it("does not buy while awaiting a sell", () => {
    const state = afterBuy(initialFlipState(), 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    }, 6);
    expect(isBuySignal(state, 0.5, 0)).toBe(false);
  });

  it("rebuys only once price falls back below the last sell price", () => {
    let state = afterBuy(initialFlipState(), 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    }, 6);
    state = afterSell(state, 1.1);
    expect(state.lastSellPrice).toBe(1.1);

    expect(isBuySignal(state, 1.15, 0)).toBe(false); // still above last sell
    expect(isBuySignal(state, 1.1, 0)).toBe(true); // at or below last sell
    expect(isBuySignal(state, 1.05, 0)).toBe(true);
  });

  it("rebuyDropPercent requires an extra cushion below the last sell", () => {
    const trigger = rebuyTriggerPrice(1.1, 5);
    expect(trigger).toBeCloseTo(1.045, 5);
  });

  it("requireManualFirstEntry suppresses only the very first auto-buy, not later rebuys", () => {
    const fresh = initialFlipState();
    expect(isBuySignal(fresh, 1.0, 0, true)).toBe(false); // first entry blocked
    expect(isBuySignal(fresh, 1.0, 0, false)).toBe(true); // default behavior unaffected

    let state = afterBuy(fresh, 1.0, 100, { buyLegPercent: 0.3, buyNetworkFeeLamports: 10_000, costUsd: 50 }, 6);
    state = afterSell(state, 1.1);
    // Once there's been a first sell, rebuys work normally even with the flag on.
    expect(isBuySignal(state, 1.05, 0, true)).toBe(true);
  });

  it("sell signal fires only at or above the gross target", () => {
    const state = afterBuy(initialFlipState(), 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    }, 6);
    const target = sellTargetPrice(1.0, 6);
    expect(target).toBeCloseTo(1.06, 5);
    expect(isSellSignal(state, 1.05, 6)).toBe(false);
    expect(isSellSignal(state, 1.06, 6)).toBe(true);
    expect(isSellSignal(state, 1.2, 6)).toBe(true);
  });

  it("computes gross move percent", () => {
    expect(grossMovePercent(1.0, 1.06)).toBeCloseTo(6, 5);
    expect(grossMovePercent(2.0, 1.9)).toBeCloseTo(-5, 5);
  });

  it("stop loss triggers below the threshold and is disabled at 0", () => {
    expect(isStopLossTriggered(1.0, 0.74, 25)).toBe(true);
    expect(isStopLossTriggered(1.0, 0.76, 25)).toBe(false);
    expect(isStopLossTriggered(1.0, 0.5, 0)).toBe(false);
  });

  it("a full flip cycle increments completedFlips and clears position fields", () => {
    let state = initialFlipState();
    state = afterBuy(state, 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    }, 6);
    expect(state.targetGainPercent).toBe(6);
    state = afterSell(state, 1.06);
    expect(state.completedFlips).toBe(1);
    expect(state.phase).toBe("AWAITING_BUY");
    expect(state.buyPrice).toBeNull();
    expect(state.tokenAmount).toBeNull();
    expect(state.entryCost).toBeNull();
    expect(state.targetGainPercent).toBeNull();
    expect(state.lastSellPrice).toBe(1.06);
  });
});

describe("Slot B reinforcement trigger", () => {
  const openSlotA = afterBuy(initialFlipState(), 1.0, 100, {
    buyLegPercent: 0.3,
    buyNetworkFeeLamports: 10_000,
    costUsd: 30,
  }, 6);

  it("does not trigger while Slot A is flat", () => {
    expect(isReinforcementBuySignal(initialFlipState(), initialFlipState(), 0.9, 8)).toBe(false);
  });

  it("does not trigger until Slot A's drawdown reaches the threshold", () => {
    expect(isReinforcementBuySignal(openSlotA, initialFlipState(), 0.95, 8)).toBe(false); // -5%, below 8% trigger
    expect(isReinforcementBuySignal(openSlotA, initialFlipState(), 0.91, 8)).toBe(true); // -9%, past trigger
    expect(isReinforcementBuySignal(openSlotA, initialFlipState(), 0.85, 8)).toBe(true); // -15%, well past trigger
  });

  it("does not trigger if Slot B already holds a position", () => {
    const openSlotB = afterBuy(initialFlipState(), 0.9, 50, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 30,
    }, 6);
    expect(isReinforcementBuySignal(openSlotA, openSlotB, 0.8, 8)).toBe(false);
  });
});

describe("trailing stop", () => {
  const entryPrice = 1.0;
  const opened = afterBuy(
    initialFlipState(),
    entryPrice,
    100,
    { buyLegPercent: 0.3, buyNetworkFeeLamports: 10_000, costUsd: 50 },
    6,
  );

  it("starts the peak at the entry price", () => {
    expect(opened.peakPriceUsd).toBe(1.0);
  });

  it("updatePeakPrice only ever moves the peak up", () => {
    let state = updatePeakPrice(opened, 1.05);
    expect(state.peakPriceUsd).toBe(1.05);
    state = updatePeakPrice(state, 1.02); // a dip doesn't lower the recorded peak
    expect(state.peakPriceUsd).toBe(1.05);
    state = updatePeakPrice(state, 1.08); // a new high does
    expect(state.peakPriceUsd).toBe(1.08);
  });

  it("does not arm until the peak reaches armPercent gain from entry", () => {
    const state = updatePeakPrice(opened, 1.02); // peak +2%, arm requires +4%
    expect(isTrailingStopTriggered(state, 0.99, 4, 2)).toBe(false);
  });

  it("triggers once price falls trailPercent below an armed peak", () => {
    // Peak reaches +5% (armed at 4%), then pulls back.
    const state = updatePeakPrice(opened, 1.05);
    expect(isTrailingStopTriggered(state, 1.04, 4, 2)).toBe(false); // -0.95% from peak, not enough
    expect(isTrailingStopTriggered(state, 1.029, 4, 2)).toBe(true); // -2% from peak, triggers
  });

  it("a triggered exit can still be a real gain, just not the full target", () => {
    const state = updatePeakPrice(opened, 1.05);
    const exitPrice = 1.029;
    expect(isTrailingStopTriggered(state, exitPrice, 4, 2)).toBe(true);
    expect(grossMovePercent(entryPrice, exitPrice)).toBeGreaterThan(0); // still above entry
  });

  it("does nothing while flat", () => {
    expect(isTrailingStopTriggered(initialFlipState(), 1.0, 4, 2)).toBe(false);
  });
});

describe("breakout buy (opt-in)", () => {
  // Slot A sold at 1.10 and never came back down.
  const afterASale = afterSell(
    afterBuy(initialFlipState(), 1.0, 100, { buyLegPercent: 0.3, buyNetworkFeeLamports: 10_000, costUsd: 30 }, 6),
    1.1,
  );

  it("does not track a peak while price is at or below lastSellPrice", () => {
    const state = updateBreakoutPeak(afterASale, 1.05);
    expect(state.breakoutPeakUsd).toBeNull();
  });

  it("tracks the peak once price breaks above lastSellPrice", () => {
    let state = updateBreakoutPeak(afterASale, 1.15);
    expect(state.breakoutPeakUsd).toBe(1.15);
    state = updateBreakoutPeak(state, 1.12); // a dip doesn't lower the recorded peak
    expect(state.breakoutPeakUsd).toBe(1.15);
    state = updateBreakoutPeak(state, 1.2); // a new high does
    expect(state.breakoutPeakUsd).toBe(1.2);
  });

  it("resets breakout tracking if price falls back to/below lastSellPrice", () => {
    let state = updateBreakoutPeak(afterASale, 1.15);
    expect(state.breakoutPeakUsd).toBe(1.15);
    state = updateBreakoutPeak(state, 1.1); // back at lastSellPrice - ordinary dip-buy path takes over
    expect(state.breakoutPeakUsd).toBeNull();
  });

  it("does not signal without a real breakout peak above lastSellPrice", () => {
    expect(isBreakoutBuySignal(afterASale, 1.05, 3)).toBe(false); // no peak tracked yet
  });

  it("signals once price falls pullbackPercent below the breakout peak", () => {
    const state = updateBreakoutPeak(afterASale, 1.15);
    expect(isBreakoutBuySignal(state, 1.14, 3)).toBe(false); // -0.87%, not enough
    expect(isBreakoutBuySignal(state, 1.115, 3)).toBe(true); // -3.04%, past the pullback
  });

  it("does nothing while holding a position", () => {
    const held = afterBuy(afterASale, 1.15, 50, { buyLegPercent: 0.3, buyNetworkFeeLamports: 10_000, costUsd: 30 }, 6);
    expect(updateBreakoutPeak(held, 1.2)).toBe(held);
    expect(isBreakoutBuySignal(held, 1.1, 3)).toBe(false);
  });
});
