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

  // Two independent slots, each sized as a fixed % of the STARTING
  // portfolio value (PAPER_BALANCE_USD in paper mode, or whatever the
  // wallet holds the very first time the bot runs in live mode) - not a %
  // of the current balance. $1000 to start and SLOT_A_SIZE_PERCENT=30
  // means Slot A always targets $300, whether the account is later at
  // $1200 or $600 - nothing compounds automatically. "buy <usd>" from the
  // console still lets you force an exact amount for a one-off trade.
  // Slot A runs the flip strategy on its own. Slot B only ever buys as
  // "reinforcement" while Slot A is open and underwater - see the
  // DUAL_TRIGGER_* settings below.
  SLOT_A_SIZE_PERCENT: numeric(30),
  SLOT_B_SIZE_PERCENT: numeric(30),
  // Master switch - false means Slot B never buys, so the bot behaves
  // exactly like the single-slot version.
  DUAL_SLOT_ENABLED: boolFlag(true),
  // How far underwater Slot A must be before Slot B reinforces, computed
  // the same adaptive way as the sell target: (typical recent move over
  // VOLATILITY_LOOKBACK_MS) * DUAL_TRIGGER_MULTIPLIER, clamped to
  // [DUAL_TRIGGER_MIN_PERCENT, DUAL_TRIGGER_MAX_PERCENT]. Keep the max
  // below STOP_LOSS_PERCENT, or Slot A gets stopped out before Slot B
  // ever gets a chance to reinforce it.
  DUAL_TRIGGER_MULTIPLIER: numeric(1),
  DUAL_TRIGGER_MIN_PERCENT: numeric(3),
  DUAL_TRIGGER_MAX_PERCENT: numeric(20),
  // Opt-in third reinforcement tier, OFF by default - a deeper DCA-style
  // rung below Slot B. Slot C only ever buys when Slot A's drawdown crosses
  // its OWN (deeper) trigger, same mechanism as Slot B but independent of
  // whether Slot B currently happens to be open (Slot B keeps cycling on
  // its own schedule - gating C on B's transient phase would make C's
  // entries unreliable). This works well in a genuinely mean-reverting /
  // ranging market (a deeper dip usually means a better entry price for the
  // eventual bounce) but adds real risk in a real downtrend - each tier
  // commits more capital the further price falls, and in the worst case
  // A+B+C are all open at once. Keep SLOT_C_SIZE_PERCENT smaller than
  // A/B's, and keep SLOT_C_TRIGGER_MAX_PERCENT below STOP_LOSS_PERCENT for
  // the same reason as DUAL_TRIGGER_MAX_PERCENT above. Try it on a
  // side-by-side config first (README, A/B/C comparison section) before
  // enabling on your primary one.
  SLOT_C_ENABLED: boolFlag(false),
  SLOT_C_SIZE_PERCENT: numeric(20),
  SLOT_C_TRIGGER_MULTIPLIER: numeric(2),
  SLOT_C_TRIGGER_MIN_PERCENT: numeric(10),
  SLOT_C_TRIGGER_MAX_PERCENT: numeric(22),
  // Same idea as SLOT_B_TRAILING_STOP_* - lets Slot C arm/trail at smaller
  // moves than Slot A, since it's also a quick-flip reinforcement position,
  // not a "ride to the full target" one. Defaults match Slot A/B's.
  SLOT_C_TRAILING_STOP_ARM_PERCENT: numeric(4),
  SLOT_C_TRAILING_STOP_PERCENT: numeric(2),
  MIN_SOL_RESERVE: numeric(0.05),

  // --- The flip strategy -----------------------------------------------
  // Gross markup we aim to sell at, measured from our buy price. Used as-is
  // when ADAPTIVE_TARGET_ENABLED=false, and as the fallback while there
  // isn't yet enough live price history to compute an adaptive one.
  TARGET_GAIN_PERCENT: numeric(6),
  // When enabled, every new buy sets its OWN sell target from how much the
  // token has actually been moving recently (VOLATILITY_LOOKBACK_MS of
  // in-memory price history), instead of the fixed TARGET_GAIN_PERCENT
  // above. The target is frozen at buy time and never changes while the
  // position is open - only the next buy recomputes it.
  ADAPTIVE_TARGET_ENABLED: boolFlag(true),
  VOLATILITY_LOOKBACK_MS: numeric(300_000),
  // Target = (typical recent move over the lookback window) * this multiplier.
  ADAPTIVE_TARGET_MULTIPLIER: numeric(1.5),
  // Hard floor/ceiling on the adaptive target - independent of the live
  // round-trip cost check that still runs before every actual sell.
  ADAPTIVE_TARGET_MIN_PERCENT: numeric(3),
  ADAPTIVE_TARGET_MAX_PERCENT: numeric(15),
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
  // When true, the very first-ever entry into Slot A (no prior sell yet) is
  // never taken automatically - only a manual "buy" command opens it.
  // Every rebuy after that first position closes still fires automatically
  // off the recorded last-sell price, exactly as always.
  SLOT_A_REQUIRE_MANUAL_FIRST_BUY: boolFlag(true),
  // Locks in gains on a position that got meaningfully into profit and then
  // pulled back, instead of only ever exiting at the full TARGET_GAIN_PERCENT
  // (which a choppy/ranging market may never reach). Once a position's peak
  // price since entry reaches TRAILING_STOP_ARM_PERCENT gain, the trailing
  // stop "arms"; from then on, if price falls TRAILING_STOP_PERCENT below
  // that peak, a sell is considered (still has to clear MIN_NET_PROFIT_PERCENT
  // like any other sell - this only decides WHEN to look).
  TRAILING_STOP_ENABLED: boolFlag(true),
  TRAILING_STOP_ARM_PERCENT: numeric(4),
  TRAILING_STOP_PERCENT: numeric(2),
  // Slot B specifically exists to flip fast while Slot A is underwater - in
  // a tight, choppy range that never actually clears TRAILING_STOP_ARM_PERCENT,
  // Slot B's position can sit forever (both the target AND the shared
  // trailing stop above require a real move into profit first, and neither
  // will ever sell at a loss just because it's a local high - that would
  // violate MIN_NET_PROFIT_PERCENT). These let Slot B arm/trail at smaller
  // moves than Slot A, so it locks in small pops instead of waiting for a
  // bigger move that a narrow range may never produce. Default to the same
  // values as Slot A's (no behavior change until you lower them for B).
  SLOT_B_TRAILING_STOP_ARM_PERCENT: numeric(4),
  SLOT_B_TRAILING_STOP_PERCENT: numeric(2),
  // The "peak" is whatever price a single PRICE_POLL_INTERVAL_MS tick
  // happened to see - a brief spike/wick sets it just as much as a real
  // move. When > 0, the pullback condition above must hold continuously
  // for this many ms (i.e. across consecutive ticks) before the sell
  // actually fires, filtering out one-tick noise. 0 = fire immediately,
  // same as before this setting existed.
  TRAILING_STOP_CONFIRMATION_MS: numeric(4000),
  // On a volatile token, requiring the pullback to hold EXACTLY past the
  // trigger on every single tick rarely survives 4 seconds - one tick
  // ticking back a fraction of a percent resets the whole timer to zero.
  // This tolerance loosens the trigger by this many percentage points
  // *only* for the purpose of keeping the confirmation timer alive (not
  // for the actual sell decision, which still needs the real, un-loosened
  // trigger) - so a small bounce within the band doesn't restart the clock.
  TRAILING_STOP_CONFIRMATION_TOLERANCE_PERCENT: numeric(0.5),
  // Opt-in, OFF by default (0). Once a position is armed (already past
  // TRAILING_STOP_ARM_PERCENT gain), it can still get stuck chopping
  // sideways near its high forever - never making a new peak (so the
  // trailing stop keeps waiting) but never falling TRAILING_STOP_PERCENT
  // below it either (so it never actually fires). When > 0: if the peak
  // hasn't made a new high for this many ms while armed, sell at the
  // current price instead of waiting indefinitely - still has to clear
  // MIN_NET_PROFIT_PERCENT like every other sell, so this only ever
  // realizes a position that's genuinely still profitable, just refuses to
  // keep circling in place for one that already is.
  TRAILING_STOP_STAGNATION_MS: numeric(0),
  // Opt-in, OFF by default - Slot A's normal rule is "never buy above
  // lastSellPrice". If a token just keeps running up without ever dipping
  // back to it, Slot A stays in cash and misses the whole move. When
  // enabled, Slot A ALSO buys on a confirmed pullback within a breakout
  // above lastSellPrice: pullback = (typical recent move) *
  // BREAKOUT_BUY_MULTIPLIER, clamped to [MIN, MAX], and - same as the
  // trailing stop - must hold for BREAKOUT_BUY_CONFIRMATION_MS before it
  // actually fires. This is a real strategy change (buying into strength,
  // not only dips) - keep it off on your primary config and try it on a
  // side-by-side comparison run first (see README).
  BREAKOUT_BUY_ENABLED: boolFlag(false),
  BREAKOUT_BUY_MULTIPLIER: numeric(0.5),
  BREAKOUT_BUY_MIN_PERCENT: numeric(2),
  BREAKOUT_BUY_MAX_PERCENT: numeric(10),
  BREAKOUT_BUY_CONFIRMATION_MS: numeric(4000),
  // Same tolerance-band idea as TRAILING_STOP_CONFIRMATION_TOLERANCE_PERCENT,
  // applied to the breakout-buy pullback confirmation.
  BREAKOUT_BUY_CONFIRMATION_TOLERANCE_PERCENT: numeric(0.5),

  MAX_SLIPPAGE_BPS: numeric(150),
  MAX_PRICE_IMPACT_BPS: numeric(250),
  // Baseline pool spread (round-tripping a small, fixed reference amount),
  // independent of our own trade size. A wide spread here means the pool is
  // thin right now - refuse to trade at all, no matter how small the order.
  MAX_SPREAD_BPS: numeric(100),

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
      slotASizePercent: env.SLOT_A_SIZE_PERCENT,
      slotBSizePercent: env.SLOT_B_SIZE_PERCENT,
      slotCSizePercent: env.SLOT_C_SIZE_PERCENT,
      minSolReserve: env.MIN_SOL_RESERVE,
    },
    strategy: {
      targetGainPercent: env.TARGET_GAIN_PERCENT,
      minNetProfitPercent: env.MIN_NET_PROFIT_PERCENT,
      rebuyDropPercent: env.REBUY_DROP_PERCENT,
      maxRoundTripCostPercent: env.MAX_ROUND_TRIP_COST_PERCENT,
      maxSpreadPercent: env.MAX_SPREAD_BPS / 100,
      stopLossPercent: env.STOP_LOSS_PERCENT,
      adaptiveTargetEnabled: env.ADAPTIVE_TARGET_ENABLED,
      volatilityLookbackMs: env.VOLATILITY_LOOKBACK_MS,
      adaptiveTargetMultiplier: env.ADAPTIVE_TARGET_MULTIPLIER,
      adaptiveTargetMinPercent: env.ADAPTIVE_TARGET_MIN_PERCENT,
      adaptiveTargetMaxPercent: env.ADAPTIVE_TARGET_MAX_PERCENT,
      dualSlotEnabled: env.DUAL_SLOT_ENABLED,
      dualTriggerMultiplier: env.DUAL_TRIGGER_MULTIPLIER,
      dualTriggerMinPercent: env.DUAL_TRIGGER_MIN_PERCENT,
      dualTriggerMaxPercent: env.DUAL_TRIGGER_MAX_PERCENT,
      slotCEnabled: env.SLOT_C_ENABLED,
      slotCTriggerMultiplier: env.SLOT_C_TRIGGER_MULTIPLIER,
      slotCTriggerMinPercent: env.SLOT_C_TRIGGER_MIN_PERCENT,
      slotCTriggerMaxPercent: env.SLOT_C_TRIGGER_MAX_PERCENT,
      slotARequireManualFirstBuy: env.SLOT_A_REQUIRE_MANUAL_FIRST_BUY,
      trailingStopEnabled: env.TRAILING_STOP_ENABLED,
      trailingStopArmPercent: env.TRAILING_STOP_ARM_PERCENT,
      trailingStopPercent: env.TRAILING_STOP_PERCENT,
      slotBTrailingStopArmPercent: env.SLOT_B_TRAILING_STOP_ARM_PERCENT,
      slotBTrailingStopPercent: env.SLOT_B_TRAILING_STOP_PERCENT,
      slotCTrailingStopArmPercent: env.SLOT_C_TRAILING_STOP_ARM_PERCENT,
      slotCTrailingStopPercent: env.SLOT_C_TRAILING_STOP_PERCENT,
      trailingStopConfirmationMs: env.TRAILING_STOP_CONFIRMATION_MS,
      trailingStopConfirmationTolerancePercent: env.TRAILING_STOP_CONFIRMATION_TOLERANCE_PERCENT,
      trailingStopStagnationMs: env.TRAILING_STOP_STAGNATION_MS,
      breakoutBuyEnabled: env.BREAKOUT_BUY_ENABLED,
      breakoutBuyMultiplier: env.BREAKOUT_BUY_MULTIPLIER,
      breakoutBuyMinPercent: env.BREAKOUT_BUY_MIN_PERCENT,
      breakoutBuyMaxPercent: env.BREAKOUT_BUY_MAX_PERCENT,
      breakoutBuyConfirmationMs: env.BREAKOUT_BUY_CONFIRMATION_MS,
      breakoutBuyConfirmationTolerancePercent: env.BREAKOUT_BUY_CONFIRMATION_TOLERANCE_PERCENT,
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
