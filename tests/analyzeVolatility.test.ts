import { describe, expect, it } from "vitest";
import { volatilityPerSqrtSecond, windowStats } from "../scripts/analyzeVolatility.js";

describe("windowStats", () => {
  it("measures the % move over a fixed time window", () => {
    // Price steps every 5s: 1.00, 1.02, 1.01, 1.05 - look at 10s windows.
    const samples = [
      { tMs: 0, priceUsd: 1.0 },
      { tMs: 5_000, priceUsd: 1.02 },
      { tMs: 10_000, priceUsd: 1.01 },
      { tMs: 15_000, priceUsd: 1.05 },
    ];
    const stat = windowStats(samples, 10_000, "10s");
    // Compares each sample to the earliest one still within the 10s window:
    // 5s->0s (+2%), 10s->0s (+1%), 15s->5s (+2.94%).
    expect(stat.count).toBe(3);
    expect(stat.maxUpPercent).toBeCloseTo(2.941, 2);
  });

  it("returns no changes when there isn't enough history for the window yet", () => {
    const samples = [{ tMs: 0, priceUsd: 1.0 }];
    const stat = windowStats(samples, 60_000, "1min");
    expect(stat.count).toBe(0);
    expect(stat.meanAbsPercent).toBe(0);
  });
});

describe("volatilityPerSqrtSecond", () => {
  it("is zero for a flat price series", () => {
    const samples = [
      { tMs: 0, priceUsd: 1.0 },
      { tMs: 5_000, priceUsd: 1.0 },
      { tMs: 10_000, priceUsd: 1.0 },
    ];
    expect(volatilityPerSqrtSecond(samples)).toBe(0);
  });

  it("is positive when the price actually moves around", () => {
    const samples = [
      { tMs: 0, priceUsd: 1.0 },
      { tMs: 5_000, priceUsd: 1.05 },
      { tMs: 10_000, priceUsd: 0.98 },
      { tMs: 15_000, priceUsd: 1.03 },
    ];
    expect(volatilityPerSqrtSecond(samples)).toBeGreaterThan(0);
  });
});
