import { describe, expect, it } from "vitest";
import {
  afterBuy,
  afterSell,
  grossMovePercent,
  initialFlipState,
  isBuySignal,
  isSellSignal,
  isStopLossTriggered,
  rebuyTriggerPrice,
  sellTargetPrice,
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
    });
    expect(isBuySignal(state, 0.5, 0)).toBe(false);
  });

  it("rebuys only once price falls back below the last sell price", () => {
    let state = afterBuy(initialFlipState(), 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    });
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

  it("sell signal fires only at or above the gross target", () => {
    const state = afterBuy(initialFlipState(), 1.0, 100, {
      buyLegPercent: 0.3,
      buyNetworkFeeLamports: 10_000,
      costUsd: 50,
    });
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
    });
    state = afterSell(state, 1.06);
    expect(state.completedFlips).toBe(1);
    expect(state.phase).toBe("AWAITING_BUY");
    expect(state.buyPrice).toBeNull();
    expect(state.tokenAmount).toBeNull();
    expect(state.entryCost).toBeNull();
    expect(state.lastSellPrice).toBe(1.06);
  });
});
