import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { BotConfig } from "./config.js";
import { JupiterClient, priceImpactPercent, type QuoteResponse, type SwapResponse } from "./jupiter.js";
import { LAMPORTS_PER_SOL } from "./chain.js";

export const BASE_SIGNATURE_FEE_LAMPORTS = 5_000;

export interface FillResult {
  /** Effective price paid/received, in the quote's output-per-input terms. */
  quote: QuoteResponse;
  priceImpactPercent: number;
  networkFeeLamports: number;
  outputAmountUi: number;
  txSignature?: string;
}

/** Builds (but for paper mode never sends) a swap, to read Jupiter's real fee estimate. */
async function estimateNetworkFeeLamports(
  client: JupiterClient,
  config: BotConfig,
  quote: QuoteResponse,
  userPublicKey: string,
): Promise<{ swap: SwapResponse | undefined; lamports: number }> {
  try {
    const swap = await client.buildSwap(quote, userPublicKey, config);
    return {
      swap,
      lamports:
        BASE_SIGNATURE_FEE_LAMPORTS +
        (swap.prioritizationFeeLamports ?? config.execution.priorityMaxLamports),
    };
  } catch {
    // Best-effort - a paper tick or a cost estimate should not be blocked
    // by a build failure; fall back to a conservative constant.
    return {
      swap: undefined,
      lamports: BASE_SIGNATURE_FEE_LAMPORTS + config.execution.priorityMaxLamports,
    };
  }
}

/**
 * Gets a real quote and a real fee estimate for a leg, without executing
 * anything. Used both to price a hypothetical trade for the cost model and
 * as the first half of actually executing one.
 */
export async function priceLeg(
  client: JupiterClient,
  config: BotConfig,
  params: { inputMint: string; outputMint: string; amount: string },
  userPublicKey: string,
): Promise<{ quote: QuoteResponse; swap: SwapResponse | undefined; networkFeeLamports: number }> {
  const quote = await client.getQuote({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: config.execution.maxSlippageBps,
  });
  const { swap, lamports } = await estimateNetworkFeeLamports(
    client,
    config,
    quote,
    userPublicKey,
  );
  return { quote, swap, networkFeeLamports: lamports };
}

/**
 * Reads what a confirmed swap actually delivered, instead of trusting the
 * pre-trade quote estimate. Jupiter's Route only guarantees the output
 * meets the slippage-adjusted minimum, not the quoted `outAmount` itself -
 * real fills routinely land a bit below quote. If the bot keeps recording
 * the optimistic quote amount as the position size, that gap compounds
 * across flips until the tracked balance no longer matches the wallet and
 * every subsequent sell is rejected with "insufficient funds" before it
 * ever reaches an AMM.
 *
 * Returns undefined (caller falls back to the quote estimate) whenever the
 * transaction's balance deltas can't be read - this must never throw and
 * must never block a fill that otherwise confirmed fine on-chain.
 */
export async function getActualOutputAmountUi(
  connection: Connection,
  signature: string,
  outputMint: string,
  nativeSolMint: string,
  owner: string,
): Promise<number | undefined> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const meta = tx?.meta;
    if (!meta) return undefined;

    if (outputMint === nativeSolMint) {
      // Native SOL isn't an SPL token balance - read it off the fee
      // payer's lamport balance. The fee payer is always account index 0
      // in a Solana transaction message, and it's the same keypair that
      // signs here, so this is exactly the wallet we care about. Add back
      // the network fee since it's deducted from the same balance.
      const pre = meta.preBalances?.[0];
      const post = meta.postBalances?.[0];
      if (pre === undefined || post === undefined) return undefined;
      const receivedLamports = post - pre + meta.fee;
      return receivedLamports > 0 ? receivedLamports / LAMPORTS_PER_SOL : undefined;
    }

    const pre = meta.preTokenBalances?.find((b) => b.mint === outputMint && b.owner === owner);
    const post = meta.postTokenBalances?.find((b) => b.mint === outputMint && b.owner === owner);
    if (!post) return undefined;
    const preAmount = pre?.uiTokenAmount.uiAmount ?? 0;
    const postAmount = post.uiTokenAmount.uiAmount ?? 0;
    const delta = postAmount - preAmount;
    return delta > 0 ? delta : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Executes a leg. In paper mode this just formats the already-fetched
 * quote into a fill (no network send). In live mode it signs and submits
 * the pre-built swap transaction, then reconciles the fill against what
 * actually landed on-chain (see getActualOutputAmountUi).
 */
export async function executeLeg(
  connection: Connection,
  config: BotConfig,
  keypair: Keypair | undefined,
  quote: QuoteResponse,
  swap: SwapResponse | undefined,
  outputDecimals: number,
): Promise<FillResult> {
  const outputAmountUi = Number(quote.outAmount) / 10 ** outputDecimals;
  const impact = priceImpactPercent(quote);

  if (config.mode === "paper") {
    return {
      quote,
      priceImpactPercent: impact,
      networkFeeLamports: BASE_SIGNATURE_FEE_LAMPORTS + config.execution.priorityMaxLamports,
      outputAmountUi,
    };
  }

  if (!keypair) throw new Error("Live trading requires a loaded wallet keypair.");
  if (!swap) throw new Error("No swap transaction available to execute live trade.");

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([keypair]);
  const rawTx = tx.serialize();

  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 0,
  });

  const deadline = Date.now() + 60_000;
  let lastResend = Date.now();
  let confirmed = false;
  while (Date.now() < deadline) {
    const { value: statuses } = await connection.getSignatureStatuses([signature]);
    const status = statuses[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      confirmed = status.err === null;
      break;
    }
    const blockHeight = await connection.getBlockHeight("confirmed");
    if (blockHeight > swap.lastValidBlockHeight) break;
    if (Date.now() - lastResend > 2_000) {
      lastResend = Date.now();
      await connection
        .sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 })
        .catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!confirmed) {
    throw new Error(`Swap transaction ${signature} did not confirm in time.`);
  }

  const actualOutputAmountUi = await getActualOutputAmountUi(
    connection,
    signature,
    quote.outputMint,
    config.token.solMint,
    keypair.publicKey.toBase58(),
  );

  return {
    quote,
    priceImpactPercent: impact,
    networkFeeLamports:
      BASE_SIGNATURE_FEE_LAMPORTS + (swap.prioritizationFeeLamports ?? config.execution.priorityMaxLamports),
    outputAmountUi: actualOutputAmountUi ?? outputAmountUi,
    txSignature: signature,
  };
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}
