import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConfig } from "./config.js";
import { type FlipState, initialFlipState } from "./strategy.js";

export interface PersistedState {
  slotA: FlipState;
  slotB: FlipState;
  /** Opt-in third reinforcement tier - see SLOT_C_ENABLED in config.ts. Always present (even when disabled) so the state shape is stable. */
  slotC: FlipState;
  /** Successful full-sell timestamps; persist per-slot re-entry cooldowns across restarts. */
  slotLastSellAtMs: Record<"A" | "B" | "C", number>;
  /** Cooldown duration frozen at each sell, so restart cannot recalculate it. */
  slotReentryCooldownMs: Record<"A" | "B" | "C", number>;
  /** Only meaningful in paper mode - live balances always come from chain. */
  paperSolBalance: number;
  paperTokenBalance: number;
  /** Sum of (sell proceeds - buy cost) across every completed flip, in USD, both slots combined. */
  realizedPnlUsd: number;
  /**
   * The portfolio's USD value the FIRST time the bot ever ran (or the last
   * paper reset) - each slot's buy size is a fixed % of THIS, not of the
   * current balance, so it never silently compounds or shrinks trade size
   * as PnL accumulates. Captured once and then carried forward untouched.
   */
  initialPortfolioUsd: number;
  /**
   * Which mode this state was saved under. STATE_FILE is a plain path -
   * switching TRADING_MODE without also changing it points the bot at the
   * same file it used in the other mode, and paper's fake positions/PnL
   * would otherwise silently show up as if they were real (or vice versa).
   * loadState refuses to reuse a state file saved under a different mode -
   * see below.
   */
  mode: "paper" | "live";
}

/** Older single-slot state files only had `flip`, not `slotA`/`slotB`/`initialPortfolioUsd`. */
interface LegacySingleSlotState {
  flip?: FlipState;
}

export function loadState(
  config: BotConfig,
  defaultSolBalance: number,
  defaultInitialPortfolioUsd: number,
): PersistedState {
  const path = config.files.state;
  const fresh = (): PersistedState => ({
    slotA: initialFlipState(),
    slotB: initialFlipState(),
    slotC: initialFlipState(),
    slotLastSellAtMs: { A: 0, B: 0, C: 0 },
    slotReentryCooldownMs: { A: 0, B: 0, C: 0 },
    paperSolBalance: defaultSolBalance,
    paperTokenBalance: 0,
    realizedPnlUsd: 0,
    initialPortfolioUsd: defaultInitialPortfolioUsd,
    mode: config.mode,
  });

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState> & LegacySingleSlotState;
    // A state file with no `mode` at all predates this check (old file,
    // always paper back then) - only refuse when it explicitly disagrees
    // with the mode we're starting in now.
    if (raw.mode !== undefined && raw.mode !== config.mode) {
      // eslint-disable-next-line no-console
      console.warn(
        `WARNING: ${path} was last saved in "${raw.mode}" mode, but this run is "${config.mode}" - ` +
          "ignoring its positions/PnL and starting fresh instead of mixing paper and live numbers. " +
          "Use a separate STATE_FILE per mode (e.g. state-live.json) to avoid this warning entirely.",
      );
      return fresh();
    }
    return {
      // Migrate a pre-dual-slot state file: its one position becomes Slot A.
      slotA: raw.slotA ?? raw.flip ?? initialFlipState(),
      slotB: raw.slotB ?? initialFlipState(),
      slotC: raw.slotC ?? initialFlipState(),
      slotLastSellAtMs: {
        A: raw.slotLastSellAtMs?.A ?? 0,
        B: raw.slotLastSellAtMs?.B ?? 0,
        C: raw.slotLastSellAtMs?.C ?? 0,
      },
      slotReentryCooldownMs: {
        A: raw.slotReentryCooldownMs?.A ?? 0,
        B: raw.slotReentryCooldownMs?.B ?? 0,
        C: raw.slotReentryCooldownMs?.C ?? 0,
      },
      paperSolBalance: raw.paperSolBalance ?? defaultSolBalance,
      paperTokenBalance: raw.paperTokenBalance ?? 0,
      realizedPnlUsd: raw.realizedPnlUsd ?? 0,
      initialPortfolioUsd: raw.initialPortfolioUsd ?? defaultInitialPortfolioUsd,
      mode: config.mode,
    };
  }
  return fresh();
}

export function saveState(config: BotConfig, state: PersistedState): void {
  mkdirSync(dirname(config.files.state), { recursive: true });
  writeFileSync(config.files.state, JSON.stringify(state, null, 2));
}

export interface TradeRecord {
  timestampIso: string;
  mode: "paper" | "live";
  slot: "A" | "B" | "C";
  side: "BUY" | "SELL";
  price: number;
  tokenAmount: number;
  solAmount: number;
  usdValue: number;
  roundTripCostPercent?: number;
  netProfitPercent?: number;
  txSignature?: string;
}

const CSV_HEADER =
  "timestamp,mode,slot,side,price,tokenAmount,solAmount,usdValue,roundTripCostPercent,netProfitPercent,txSignature\n";

export function appendTrade(config: BotConfig, trade: TradeRecord): void {
  const path = config.files.tradesCsv;
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, CSV_HEADER);
  const row = [
    trade.timestampIso,
    trade.mode,
    trade.slot,
    trade.side,
    trade.price,
    trade.tokenAmount,
    trade.solAmount,
    trade.usdValue,
    trade.roundTripCostPercent ?? "",
    trade.netProfitPercent ?? "",
    trade.txSignature ?? "",
  ].join(",");
  appendFileSync(path, row + "\n");
}
