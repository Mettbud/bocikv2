import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConfig } from "./config.js";
import { type FlipState, initialFlipState } from "./strategy.js";

export interface PersistedState {
  slotA: FlipState;
  slotB: FlipState;
  /** Only meaningful in paper mode - live balances always come from chain. */
  paperSolBalance: number;
  paperTokenBalance: number;
  /** Sum of (sell proceeds - buy cost) across every completed flip, in USD, both slots combined. */
  realizedPnlUsd: number;
}

/** Older single-slot state files only had `flip`, not `slotA`/`slotB`. */
interface LegacySingleSlotState {
  flip?: FlipState;
}

export function loadState(config: BotConfig, defaultSolBalance: number): PersistedState {
  const path = config.files.state;
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState> & LegacySingleSlotState;
    return {
      // Migrate a pre-dual-slot state file: its one position becomes Slot A.
      slotA: raw.slotA ?? raw.flip ?? initialFlipState(),
      slotB: raw.slotB ?? initialFlipState(),
      paperSolBalance: raw.paperSolBalance ?? defaultSolBalance,
      paperTokenBalance: raw.paperTokenBalance ?? 0,
      realizedPnlUsd: raw.realizedPnlUsd ?? 0,
    };
  }
  return {
    slotA: initialFlipState(),
    slotB: initialFlipState(),
    paperSolBalance: defaultSolBalance,
    paperTokenBalance: 0,
    realizedPnlUsd: 0,
  };
}

export function saveState(config: BotConfig, state: PersistedState): void {
  mkdirSync(dirname(config.files.state), { recursive: true });
  writeFileSync(config.files.state, JSON.stringify(state, null, 2));
}

export interface TradeRecord {
  timestampIso: string;
  mode: "paper" | "live";
  slot: "A" | "B";
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
