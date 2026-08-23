import { z } from "zod";

/**
 * Deliberately small config surface. The point of this bot is one strategy
 * done well - buy low, sell high, rebuy on the dip, never on a move too
 * small to survive real trading costs - not a knob for every scenario.
 */
const numeric = (fallback: number) =>
  z.preprocess((v) => (v === undefined || v === "" ? fallback : Number(v)), z.number());

const boolFlag = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? fallback : String(v).toLowerCase() === "true"),
    z.boolean(),
  );

const envSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().default(""),
  JUPITER_API_KEY: z.string().default(""),

  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag"),
  JUPITER_MIN_REQUEST_INTERVAL_MS: numeric(2100),

  TARGET_TOKEN_MINT: z.string(),
  TARGET_TOKEN_SYMBOL: z.string().default("TOKEN"),
  SOL_MINT: z.string().default("So11111111111111111111111111111111111111112"),
  USDC_MINT: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  PAPER_BALANCE_USD: numeric(1000),

  TRADE_USD: numeric(50),
  MIN_SOL_RESERVE: numeric(0.05),

  // --- The flip strategy -----------------------------------------------
  // Gross markup we aim to sell at, measured from our buy price.
  TARGET_GAIN_PERCENT: numeric(6),
  // After subtracting the *live-estimated* round-trip cost (spread + price
  // impact + network/priority fees on both legs) from the gross move, the
  // trade only fires if what's left is still at least this much.
  MIN_NET_PROFIT_PERCENT: numeric(2),
  // How far below our last sell price the price must fall before we buy
  // back in. 0 = rebuy as soon as price is below the last sell.
  REBUY_DROP_PERCENT: numeric(0),
  // Refuse to trade at all if the live-estimated round-trip cost is above
  // this - a blown-out spread/impact means "don't trade this tick".
  MAX_ROUND_TRIP_COST_PERCENT: numeric(4),

  MAX_SLIPPAGE_BPS: numeric(150),
  MAX_PRICE_IMPACT_BPS: numeric(250),

  // Optional safety net only - not part of the flip logic itself. Set to 0
  // to disable. Guards against holding a bag through a crash while we wait
  // for a "sell high" that never comes.
  STOP_LOSS_PERCENT: numeric(25),

  PRIORITY_LEVEL: z.enum(["medium", "high", "veryHigh"]).default("medium"),
  PRIORITY_MAX_LAMPORTS: numeric(1_000_000),

  PRICE_POLL_INTERVAL_MS: numeric(5000),
  PRICE_REFERENCE_SOL_AMOUNT: numeric(0.01),
  DASHBOARD_REFRESH_MS: numeric(1000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FILE: z.string().default("./data/bot.log"),
  STATE_FILE: z.string().default("./data/state.json"),
  TRADES_CSV: z.string().default("./data/trades.csv"),

  DRY_RUN_LOG_SKIPS: boolFlag(true),
});

export type BotConfig = ReturnType<typeof buildConfig>;

function buildConfig(env: z.infer<typeof envSchema>) {
  return {
    wallet: { privateKey: env.WALLET_PRIVATE_KEY },
    jupiter: {
      apiKey: env.JUPITER_API_KEY,
      baseUrl: env.JUPITER_BASE_URL,
      minRequestIntervalMs: env.JUPITER_MIN_REQUEST_INTERVAL_MS,
    },
    rpc: { url: env.RPC_URL },
    token: {
      mint: env.TARGET_TOKEN_MINT,
      symbol: env.TARGET_TOKEN_SYMBOL,
      solMint: env.SOL_MINT,
      usdcMint: env.USDC_MINT,
    },
    mode: env.TRADING_MODE,
    paper: { startingBalanceUsd: env.PAPER_BALANCE_USD },
    trade: {
      usd: env.TRADE_USD,
      minSolReserve: env.MIN_SOL_RESERVE,
    },
    strategy: {
      targetGainPercent: env.TARGET_GAIN_PERCENT,
      minNetProfitPercent: env.MIN_NET_PROFIT_PERCENT,
      rebuyDropPercent: env.REBUY_DROP_PERCENT,
      maxRoundTripCostPercent: env.MAX_ROUND_TRIP_COST_PERCENT,
      stopLossPercent: env.STOP_LOSS_PERCENT,
    },
    execution: {
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: env.MAX_PRICE_IMPACT_BPS,
      priorityLevel: env.PRIORITY_LEVEL,
      priorityMaxLamports: env.PRIORITY_MAX_LAMPORTS,
    },
    pricePollIntervalMs: env.PRICE_POLL_INTERVAL_MS,
    priceReferenceSolAmount: env.PRICE_REFERENCE_SOL_AMOUNT,
    dashboardRefreshMs: env.DASHBOARD_REFRESH_MS,
    log: { level: env.LOG_LEVEL, file: env.LOG_FILE, logSkips: env.DRY_RUN_LOG_SKIPS },
    files: { state: env.STATE_FILE, tradesCsv: env.TRADES_CSV },
  };
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = envSchema.parse(rawEnv);
  if (parsed.TRADING_MODE === "live" && !parsed.WALLET_PRIVATE_KEY) {
    throw new Error("WALLET_PRIVATE_KEY is required when TRADING_MODE=live.");
  }
  return buildConfig(parsed);
}
