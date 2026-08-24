import { describe, expect, it } from "vitest";
import {
  computeAdaptiveTargetPercent,
  computeAdaptiveCooldownMs,
  trimOldSamples,
  volatilityPerSqrtSecond,
  windowStats,
} from "../src/volatility.js";

describe("windowStats", () => {
  it("measures the % move over a fixed time window", () => {
    // Price steps every 5s: 1.00, 1.02, 1.01, 1.05 - look at 10s windows.
    const samples = [
      { tMs: 0, priceUsd: 1.0 },
      { tMs: 5_000, priceUsd: 1.02 },
      { tMs: 10_000, priceUsd: 1.01 },
      { tMs: 15_000, priceUsd: 1.05 },
    ];
    const stat = windowStats(samples, 10_000);
    // Compares each sample to the earliest one still within the 10s window:
    // 5s->0s (+2%), 10s->0s (+1%), 15s->5s (+2.94%).
    expect(stat.count).toBe(3);
    expect(stat.maxUpPercent).toBeCloseTo(2.941, 2);
  });

  it("returns no changes when there isn't enough history for the window yet", () => {
    const samples = [{ tMs: 0, priceUsd: 1.0 }];
    const stat = windowStats(samples, 60_000);
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

describe("computeAdaptiveTargetPercent", () => {
  it("scales the target by the typical move, clamped to [min, max]", () => {
    expect(computeAdaptiveTargetPercent(2, 1.5, 3, 15)).toBe(3); // 3 floored up
    expect(computeAdaptiveTargetPercent(5, 1.5, 3, 15)).toBeCloseTo(7.5, 5);
    expect(computeAdaptiveTargetPercent(20, 1.5, 3, 15)).toBe(15); // capped
  });
});

describe("computeAdaptiveCooldownMs", () => {
  it("scales linearly and clamps to the configured 2-5 minute range", () => {
    expect(computeAdaptiveCooldownMs(0, 120_000, 300_000, 10)).toBe(120_000);
    expect(computeAdaptiveCooldownMs(5, 120_000, 300_000, 10)).toBe(210_000);
    expect(computeAdaptiveCooldownMs(10, 120_000, 300_000, 10)).toBe(300_000);
    expect(computeAdaptiveCooldownMs(50, 120_000, 300_000, 10)).toBe(300_000);
  });
});

describe("trimOldSamples", () => {
  it("drops samples older than maxAgeMs", () => {
    const samples = [
      { tMs: 0, priceUsd: 1.0 },
      { tMs: 100_000, priceUsd: 1.01 },
      { tMs: 200_000, priceUsd: 1.02 },
    ];
    const trimmed = trimOldSamples(samples, 200_000, 100_000);
    expect(trimmed).toEqual([
      { tMs: 100_000, priceUsd: 1.01 },
      { tMs: 200_000, priceUsd: 1.02 },
    ]);
  });

  it("keeps everything when nothing is old enough to drop", () => {
    const samples = [{ tMs: 0, priceUsd: 1.0 }];
    expect(trimOldSamples(samples, 1_000, 100_000)).toBe(samples);
  });
});
