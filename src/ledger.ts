import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConfig } from "./config.js";
import { type FlipState, initialFlipState } from "./strategy.js";

export interface PersistedState {
  flip: FlipState;
  /** Only meaningful in paper mode - live balances always come from chain. */
  paperSolBalance: number;
  paperTokenBalance: number;
}

export function loadState(config: BotConfig, defaultSolBalance: number): PersistedState {
  const path = config.files.state;
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedState;
    return {
      flip: raw.flip ?? initialFlipState(),
      paperSolBalance: raw.paperSolBalance ?? defaultSolBalance,
      paperTokenBalance: raw.paperTokenBalance ?? 0,
    };
  }
  return {
    flip: initialFlipState(),
    paperSolBalance: defaultSolBalance,
    paperTokenBalance: 0,
  };
}

export function saveState(config: BotConfig, state: PersistedState): void {
  mkdirSync(dirname(config.files.state), { recursive: true });
  writeFileSync(config.files.state, JSON.stringify(state, null, 2));
}

export interface TradeRecord {
  timestampIso: string;
  mode: "paper" | "live";
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
  "timestamp,mode,side,price,tokenAmount,solAmount,usdValue,roundTripCostPercent,netProfitPercent,txSignature\n";

export function appendTrade(config: BotConfig, trade: TradeRecord): void {
  const path = config.files.tradesCsv;
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, CSV_HEADER);
  const row = [
    trade.timestampIso,
    trade.mode,
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
