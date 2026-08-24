import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { getActualOutputAmountUi } from "../src/trader.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_MINT = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg";
const OWNER = "97fSjcKDWm1YCiMtDhLmVuShwdtQazQvjiCghJqaAPQn";

function fakeConnection(tx: unknown): Connection {
  return { getTransaction: async () => tx } as unknown as Connection;
}

describe("getActualOutputAmountUi", () => {
  it("reads the real SPL token amount received, not the quoted estimate", async () => {
    const connection = fakeConnection({
      meta: {
        fee: 5000,
        preBalances: [1_000_000],
        postBalances: [995_000],
        preTokenBalances: [
          { mint: TOKEN_MINT, owner: OWNER, uiTokenAmount: { uiAmount: 10 } },
        ],
        postTokenBalances: [
          { mint: TOKEN_MINT, owner: OWNER, uiTokenAmount: { uiAmount: 185.5 } },
        ],
      },
    });
    const amount = await getActualOutputAmountUi(connection, "sig", TOKEN_MINT, SOL_MINT, OWNER);
    expect(amount).toBeCloseTo(175.5);
  });

  it("reads native SOL received off the fee payer's lamport delta, adding back the fee", async () => {
    const connection = fakeConnection({
      meta: {
        fee: 5000,
        preBalances: [1_000_000_000],
        postBalances: [1_049_995_000], // +0.05 SOL net, after the 5000 lamport fee
        preTokenBalances: [],
        postTokenBalances: [],
      },
    });
    const amount = await getActualOutputAmountUi(connection, "sig", SOL_MINT, SOL_MINT, OWNER);
    expect(amount).toBeCloseTo(0.05, 6);
  });

  it("falls back to undefined when the confirmed transaction has no meta", async () => {
    const connection = fakeConnection(null);
    const amount = await getActualOutputAmountUi(connection, "sig", TOKEN_MINT, SOL_MINT, OWNER);
    expect(amount).toBeUndefined();
  });

  it("falls back to undefined when there's no post-balance entry for the mint/owner", async () => {
    const connection = fakeConnection({
      meta: { fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [] },
    });
    const amount = await getActualOutputAmountUi(connection, "sig", TOKEN_MINT, SOL_MINT, OWNER);
    expect(amount).toBeUndefined();
  });

  it("falls back to undefined instead of throwing when getTransaction rejects", async () => {
    const connection = {
      getTransaction: async () => {
        throw new Error("RPC hiccup");
      },
    } as unknown as Connection;
    const amount = await getActualOutputAmountUi(connection, "sig", TOKEN_MINT, SOL_MINT, OWNER);
    expect(amount).toBeUndefined();
  });
});
