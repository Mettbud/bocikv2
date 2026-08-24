/**
 * Jupiter only ever answers "what's the price right now" - there is no
 * historical endpoint, so our own polling can only look forward from the
 * moment it starts. DexScreener's free public API already tracks price
 * change over 5m/1h/6h/24h for any token with a live pool, so a single
 * request gives an instant read on recent volatility without waiting.
 */
export interface DexScreenerSnapshot {
  priceUsd: number | undefined;
  priceChangePercent: {
    m5: number | undefined;
    h1: number | undefined;
    h6: number | undefined;
    h24: number | undefined;
  };
  volumeUsd24h: number | undefined;
  liquidityUsd: number | undefined;
  dexId: string | undefined;
}

interface DexScreenerPair {
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  dexId?: string;
  liquidity_usd?: number;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

/** Picks the pair with the most liquidity - a token can have several pools/DEXes. */
export function pickDeepestPair(pairs: DexScreenerPair[]): DexScreenerPair | undefined {
  return pairs.reduce<DexScreenerPair | undefined>((best, pair) => {
    const liq = pair.liquidity?.usd ?? 0;
    const bestLiq = best?.liquidity?.usd ?? -1;
    return liq > bestLiq ? pair : best;
  }, undefined);
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function fetchDexScreenerSnapshot(
  tokenMint: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DexScreenerSnapshot | undefined> {
  // This is a best-effort, one-shot startup call (see the caller) - if
  // DexScreener accepts the connection but never answers (rate limit,
  // an overloaded backend, ...), a plain fetch() with no deadline just
  // hangs forever with no error and no log line, which froze the whole
  // bot at startup before it printed anything. AbortController turns
  // that silent hang into a normal rejection the caller already
  // catches and falls back from.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return undefined;
  const body = (await res.json()) as DexScreenerResponse;
  const pairs = body.pairs ?? [];
  if (pairs.length === 0) return undefined;

  const pair = pickDeepestPair(pairs);
  if (!pair) return undefined;

  return {
    priceUsd: pair.priceUsd !== undefined ? Number(pair.priceUsd) : undefined,
    priceChangePercent: {
      m5: pair.priceChange?.m5,
      h1: pair.priceChange?.h1,
      h6: pair.priceChange?.h6,
      h24: pair.priceChange?.h24,
    },
    volumeUsd24h: pair.volume?.h24,
    liquidityUsd: pair.liquidity?.usd,
    dexId: pair.dexId,
  };
}
