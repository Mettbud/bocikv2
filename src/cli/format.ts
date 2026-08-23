const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export function usd(value: number | undefined, decimals = 4): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(decimals)}`;
}

export function pct(value: number | undefined, decimals = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function signColor(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return DIM;
  return value >= 0 ? GREEN : RED;
}

export function colorize(text: string, color: string): string {
  return `${color}${text}${RESET}`;
}

export const colors = { GREEN, RED, YELLOW, DIM, RESET, BOLD };
