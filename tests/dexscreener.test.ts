import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDexScreenerSnapshot, pickDeepestPair } from "../src/dexscreener.js";

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

describe("fetchDexScreenerSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives up instead of hanging forever when DexScreener accepts the request but never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }),
    );

    await expect(fetchDexScreenerSnapshot("someMint", 20)).rejects.toThrow();
  });

  it("still returns a parsed snapshot on a normal, fast response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pairs: [{ dexId: "raydium", priceUsd: "0.025", priceChange: { m5: 1.5 }, liquidity: { usd: 1000 } }],
        }),
      })),
    );

    const snapshot = await fetchDexScreenerSnapshot("someMint", 20);
    expect(snapshot?.priceChangePercent.m5).toBe(1.5);
  });
});
