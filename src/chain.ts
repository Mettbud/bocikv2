import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { BotConfig } from "./config.js";
import type { JupiterClient } from "./jupiter.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

let connection: Connection | undefined;

export function getConnection(config: BotConfig): Connection {
  if (!connection) {
    connection = new Connection(config.rpc.url, { commitment: "confirmed" });
  }
  return connection;
}

const decimalsCache = new Map<string, number>();

export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  const key = mint.toBase58();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const info = await getMint(connection, mint);
  decimalsCache.set(key, info.decimals);
  return info.decimals;
}

export async function getSolBalanceSol(
  connection: Connection,
  owner: PublicKey,
): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

export async function getTokenBalanceUi(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<number> {
  const decimals = await getMintDecimals(connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const account = await getAccount(connection, ata, "confirmed");
    return Number(account.amount) / 10 ** decimals;
  } catch {
    return 0;
  }
}

const REFERENCE_SOL_FOR_PRICE = 1;
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

/**
 * SOL/USD price via a small reference quote against USDC, cached for a
 * few seconds - it's a secondary input (used for fee-to-% conversion and
 * paper-mode USD accounting), not the asset being traded.
 */
export class SolPriceTracker {
  private lastPrice: number | undefined;
  private lastFetchMs = 0;
  private inFlight: Promise<number> | undefined;

  constructor(
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
    private readonly refreshMs = 10_000,
  ) {}

  async getPrice(): Promise<number> {
    const now = Date.now();
    if (this.lastPrice !== undefined && now - this.lastFetchMs < this.refreshMs) {
      return this.lastPrice;
    }
    if (this.inFlight) return this.inFlight;

    const request = this.fetchFresh();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async fetchFresh(): Promise<number> {
    const amountLamports = REFERENCE_SOL_FOR_PRICE * 10 ** SOL_DECIMALS;
    const quote = await this.client.getQuote({
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.usdcMint,
      amount: String(amountLamports),
      slippageBps: 50,
    });
    const usdcOut = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
    this.lastPrice = usdcOut / REFERENCE_SOL_FOR_PRICE;
    this.lastFetchMs = Date.now();
    return this.lastPrice;
  }
}
