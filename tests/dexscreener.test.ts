import { describe, expect, it } from "vitest";
import { pickDeepestPair } from "../src/dexscreener.js";

describe("pickDeepestPair", () => {
  it("picks the pair with the most liquidity", () => {
    const pairs = [
      { dexId: "raydium", liquidity: { usd: 5_000 } },
      { dexId: "meteora", liquidity: { usd: 42_000 } },
      { dexId: "orca", liquidity: { usd: 12_000 } },
    ];
    expect(pickDeepestPair(pairs)?.dexId).toBe("meteora");
  });

  it("handles pairs with no liquidity field", () => {
    const pairs = [{ dexId: "raydium" }, { dexId: "orca", liquidity: { usd: 100 } }];
    expect(pickDeepestPair(pairs)?.dexId).toBe("orca");
  });

  it("returns undefined for an empty list", () => {
    expect(pickDeepestPair([])).toBeUndefined();
  });
});
