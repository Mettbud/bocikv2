import { describe, expect, it } from "vitest";
import { computePortfolioTradeUsd } from "../src/sizing.js";

describe("computePortfolioTradeUsd", () => {
  it("spends sizePercent of the balance above the reserve", () => {
    // 1 SOL balance, 0.05 reserved, $150/SOL, 50% size -> 0.475 SOL * $150 * 0.5
    const usd = computePortfolioTradeUsd(1, 0.05, 150, 50);
    expect(usd).toBeCloseTo(0.95 * 150 * 0.5, 6);
  });

  it("never goes negative when the balance is below the reserve", () => {
    expect(computePortfolioTradeUsd(0.02, 0.05, 150, 50)).toBe(0);
  });

  it("compounds up as the balance grows", () => {
    const before = computePortfolioTradeUsd(1, 0.05, 150, 50);
    const after = computePortfolioTradeUsd(2, 0.05, 150, 50);
    expect(after).toBeGreaterThan(before * 1.9);
  });
});
