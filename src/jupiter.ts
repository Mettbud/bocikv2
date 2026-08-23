import type { BotConfig } from "./config.js";

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  [key: string]: unknown;
}

export interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export class JupiterApiError extends Error {
  constructor(status: number, statusText: string, readonly body: unknown) {
    super(`Jupiter API ${status} ${statusText}${body ? " - " + safeJson(body) : ""}`);
    this.name = "JupiterApiError";
  }
}

function safeJson(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

/**
 * Thin Jupiter REST client: quote + swap only, with the rate limiting a
 * free-tier API key needs. Same shape as the full bot's client, trimmed
 * down to what this simpler strategy actually calls.
 */
export class JupiterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly minIntervalMs: number;
  private nextRequestAtMs = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: BotConfig) {
    this.baseUrl = config.jupiter.baseUrl;
    this.apiKey = config.jupiter.apiKey;
    this.minIntervalMs = config.jupiter.minRequestIntervalMs;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  private async throttle(): Promise<void> {
    const wait = Math.max(0, this.nextRequestAtMs - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nextRequestAtMs = Date.now() + this.minIntervalMs;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
  }): Promise<QuoteResponse> {
    return this.enqueue(async () => {
      await this.throttle();
      const url = new URL(`${this.baseUrl}/swap/v1/quote`);
      url.searchParams.set("inputMint", params.inputMint);
      url.searchParams.set("outputMint", params.outputMint);
      url.searchParams.set("amount", params.amount);
      url.searchParams.set("slippageBps", String(params.slippageBps));
      url.searchParams.set("swapMode", "ExactIn");
      const res = await fetch(url, { headers: this.headers() });
      return this.parse<QuoteResponse>(res);
    });
  }

  async buildSwap(
    quote: QuoteResponse,
    userPublicKey: string,
    config: BotConfig,
  ): Promise<SwapResponse> {
    return this.enqueue(async () => {
      await this.throttle();
      const res = await fetch(`${this.baseUrl}/swap/v1/swap`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: config.execution.priorityMaxLamports,
              priorityLevel: config.execution.priorityLevel,
            },
          },
        }),
      });
      return this.parse<SwapResponse>(res);
    });
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const body = text ? safeParse(text) : undefined;
    if (!res.ok) throw new JupiterApiError(res.status, res.statusText, body);
    return body as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Price impact of a quote, as a percentage (1.5 = 1.5%). */
export function priceImpactPercent(quote: QuoteResponse): number {
  return Number(quote.priceImpactPct) * 100;
}

/** Effective execution price: output units per 1 input unit, in human terms. */
export function effectivePrice(
  quote: QuoteResponse,
  inputDecimals: number,
  outputDecimals: number,
): number {
  const inAmount = Number(quote.inAmount) / 10 ** inputDecimals;
  const outAmount = Number(quote.outAmount) / 10 ** outputDecimals;
  return outAmount / inAmount;
}
