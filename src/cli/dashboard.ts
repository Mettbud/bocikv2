import { colorize, colors, pct, signColor, usd } from "./format.js";

export interface DashboardEvent {
  message: string;
  ageMs: number;
}

export interface TrailingStopInfo {
  peakPriceUsd: number;
  /** True once the peak has reached TRAILING_STOP_ARM_PERCENT gain from entry. */
  armed: boolean;
  /** Price that would trigger a sell consideration - peak minus TRAILING_STOP_PERCENT. */
  triggerPriceUsd: number | undefined;
}

export interface PositionSnapshot {
  tokenAmount: number;
  buyPriceUsd: number;
  positionValueUsd: number | undefined;
  unrealizedPercent: number | undefined;
  unrealizedUsd: number | undefined;
  /** What net profit % selling right now would clear, after live-estimated round-trip costs. */
  netIfSoldNowPercent: number | undefined;
  netIfSoldNowUsd: number | undefined;
  sellTargetUsd: number;
  /** The gain % actually used for this position's target - frozen at buy time. */
  targetGainPercent: number;
  stopLossPriceUsd: number | undefined;
  stopLossPercent: number | undefined;
  /** Undefined when TRAILING_STOP_ENABLED=false. */
  trailingStop: TrailingStopInfo | undefined;
}

export interface ReinforcementInfo {
  /** DUAL_SLOT_ENABLED (Slot B) / SLOT_C_ENABLED (Slot C) - false means this slot never buys at all. */
  enabled: boolean;
  /** The live-computed drawdown Slot A must reach before this slot reinforces. */
  triggerDropPercent: number;
  /** Slot A's current unrealized %, when it holds a position (negative = underwater). */
  slotADrawdownPercent: number | undefined;
}

export interface SlotDashboardState {
  label: "A" | "B" | "C";
  sizePercent: number;
  position: PositionSnapshot | undefined;
  /** Slot A only: rebuy trigger below its own last sell. Slots B/C never rebuy on their own. */
  rebuyTriggerUsd: number | undefined;
  lastSellPriceUsd: number | undefined;
  /** true if the last sell on this slot was a manual "sell" or "panic" - blocks every automatic buy path until a manual "buy". */
  requireManualNextBuy: boolean;
  completedFlips: number;
  adaptiveTargetEnabled: boolean;
  nextTargetGainPercent: number | undefined;
  staticTargetGainPercent: number;
  nextBuyUsdEstimate: number | undefined;
  buyImpactPercent: number | undefined;
  sellImpactPercent: number | undefined;
  roundTripCostPercent: number | undefined;
  maxRoundTripCostPercent: number;
  minNetProfitPercent: number;
  /** Slots B/C only - undefined for Slot A. */
  reinforcement: ReinforcementInfo | undefined;
  /** Slot A only, and only while BREAKOUT_BUY_ENABLED - undefined otherwise. */
  breakoutBuy: BreakoutBuyInfo | undefined;
  /** A manual "buy ... @maxPrice" limit order waiting for the price to drop to it - undefined when none is pending. */
  pendingManualBuy: PendingManualBuyInfo | undefined;
  /** Seconds left on the auto-buy circuit breaker (see AUTO_BUY_FAILURE_LIMIT) - undefined when not paused. */
  autoBuyPausedSecondsLeft: number | undefined;
}

export interface PendingManualBuyInfo {
  maxPriceUsd: number;
  usdAmount: number | undefined;
}

export interface BreakoutBuyInfo {
  peakUsd: number | undefined;
  pullbackPercent: number;
  triggerPriceUsd: number | undefined;
}

export interface RecentTrade {
  ageMs: number;
  slot: "A" | "B" | "C";
  side: "BUY" | "SELL";
  tokenAmount: number;
  priceUsd: number;
  usdValue: number;
  /** Undefined for BUY rows - only a SELL has a realized net result. */
  netProfitPercent: number | undefined;
  netProfitUsd: number | undefined;
}

export interface DashboardState {
  tokenSymbol: string;
  mode: "PAPER" | "LIVE";
  /** AUTO_BUY_ENABLED - true is the default (unchanged behavior), so this only ever needs to show up when false. */
  autoBuyEnabled: boolean;
  priceUsd: number | undefined;
  slotA: SlotDashboardState;
  slotB: SlotDashboardState;
  /** Opt-in third tier - undefined unless SLOT_C_ENABLED, so it's simply not shown otherwise. */
  slotC: SlotDashboardState | undefined;
  /** Combined across all open slots. */
  realizedPnlUsd: number;
  solBalance: number;
  tokenBalance: number;
  /** Combined market value of both slots' open positions, at the current price. */
  investedUsd: number;
  investedPercentOfEquity: number | undefined;
  paperUsdBalance: number | undefined;
  /** Baseline pool spread (size-independent) - last checked at the last buy attempt. */
  spreadPercent: number | undefined;
  maxSpreadPercent: number;
  /** Newest first - a handful of the most recent fills, both slots combined. */
  recentTrades: RecentTrade[];
  lastEvent: DashboardEvent | undefined;
  lastErrorMessage: string | undefined;
}

export function formatDashboard(s: DashboardState): string {
  const lines: string[] = [];
  const modeColor = s.mode === "LIVE" ? colors.RED : colors.GREEN;

  lines.push(`${colors.BOLD}${s.tokenSymbol}${colors.RESET}`);
  lines.push(`Price: ${usd(s.priceUsd, 8)}`);
  lines.push("");

  lines.push(...formatSlot(s.slotA, s.tokenSymbol));
  lines.push("");
  lines.push(...formatSlot(s.slotB, s.tokenSymbol));
  if (s.slotC) {
    lines.push("");
    lines.push(...formatSlot(s.slotC, s.tokenSymbol));
  }

  lines.push("");
  lines.push(`Realized PnL (wszystkie sloty): ${colorize(usd(s.realizedPnlUsd, 2), signColor(s.realizedPnlUsd))}`);
  const investedPctLabel = s.investedPercentOfEquity !== undefined ? ` (${s.investedPercentOfEquity.toFixed(1)}% portfela)` : "";
  lines.push(`W rynku teraz:            ${usd(s.investedUsd, 2)}${investedPctLabel}`);

  lines.push("");
  lines.push(`SOL balance:       ${s.solBalance.toFixed(6)}`);
  lines.push(`${s.tokenSymbol} balance: ${s.tokenBalance.toLocaleString("en-US")}`);
  if (s.paperUsdBalance !== undefined) {
    lines.push(`Paper equity (SOL + pozycje): ${usd(s.paperUsdBalance, 2)}`);
  }

  lines.push("");
  lines.push(`Spread puli: ${formatPct(s.spreadPercent)} (max ${s.maxSpreadPercent}%)`);

  if (s.recentTrades.length > 0) {
    lines.push("");
    lines.push(`${colors.BOLD}Ostatnie transakcje${colors.RESET}`);
    for (const t of s.recentTrades) {
      lines.push(`  ${formatTradeLine(t, s.tokenSymbol)}`);
    }
  }

  if (s.lastEvent) {
    lines.push("");
    lines.push(`${s.lastEvent.message} (${formatAge(s.lastEvent.ageMs)})`);
  }

  if (s.lastErrorMessage) {
    lines.push("");
    lines.push(colorize(s.lastErrorMessage, colors.YELLOW));
  }

  lines.push("");
  lines.push(`Mode: ${colorize(s.mode, modeColor)}`);
  if (!s.autoBuyEnabled) {
    lines.push(colorize("AUTO_BUY_ENABLED=false - żaden slot nie kupi sam, tylko ręczne \"buy\"", colors.YELLOW));
  }

  return lines.join("\n");
}

function formatSlot(slot: SlotDashboardState, tokenSymbol: string): string[] {
  const lines: string[] = [];
  lines.push(`${colors.BOLD}Slot ${slot.label}${colors.RESET} (${slot.sizePercent}% portfela)`);

  if (slot.position) {
    const p = slot.position;
    lines.push(`  Pozycja:       ${p.tokenAmount.toLocaleString("en-US")} ${tokenSymbol}`);
    lines.push(`  Wartość:       ${usd(p.positionValueUsd)}`);
    lines.push(`  Cena wejścia:  ${usd(p.buyPriceUsd, 8)}`);
    lines.push(
      `  Niezreal.:     ${colorize(pct(p.unrealizedPercent), signColor(p.unrealizedPercent))} (${colorize(usd(p.unrealizedUsd, 2), signColor(p.unrealizedUsd))})`,
    );
    lines.push(`  Cel sprzedaży: ${usd(p.sellTargetUsd, 8)} (+${p.targetGainPercent.toFixed(2)}%, ustalony przy zakupie)`);
    const netLabel =
      p.netIfSoldNowPercent === undefined
        ? "-"
        : `${colorize(pct(p.netIfSoldNowPercent), signColor(p.netIfSoldNowPercent))} (${colorize(usd(p.netIfSoldNowUsd, 2), signColor(p.netIfSoldNowUsd))}) ${p.netIfSoldNowPercent >= slot.minNetProfitPercent ? colorize("(sprzedałby)", colors.GREEN) : colorize("(za mało netto)", colors.DIM)}`;
    lines.push(`  Netto teraz:   ${netLabel}`);
    if (p.stopLossPriceUsd !== undefined) {
      lines.push(`  Stop loss:     ${usd(p.stopLossPriceUsd, 8)} (-${(p.stopLossPercent ?? 0).toFixed(2)}% od wejścia)`);
    }
    if (p.trailingStop) {
      const t = p.trailingStop;
      if (t.armed && t.triggerPriceUsd !== undefined) {
        lines.push(`  Trailing stop: ${colorize("UZBROJONY", colors.GREEN)}, szczyt ${usd(t.peakPriceUsd, 8)}, sprzeda poniżej ${usd(t.triggerPriceUsd, 8)}`);
      } else {
        lines.push(`  Trailing stop: ${colorize("nieuzbrojony", colors.DIM)} (szczyt ${usd(t.peakPriceUsd, 8)}, jeszcze za mało zysku)`);
      }
    }
  } else if (slot.requireManualNextBuy) {
    lines.push("  Pozycja: brak - czeka na sygnał kupna");
    lines.push(
      `  ${colorize("Czeka na ręczne \"buy\"", colors.YELLOW)} (ostatnia sprzedaż była ręczna/panic - auto-kupno nie wznowi się samo)`,
    );
  } else if (slot.reinforcement) {
    const r = slot.reinforcement;
    const disabledFlag = slot.label === "B" ? "DUAL_SLOT_ENABLED=false" : "SLOT_C_ENABLED=false";
    if (!r.enabled) {
      lines.push(`  ${colorize(`Wyłączony (${disabledFlag})`, colors.DIM)}`);
    } else if (r.slotADrawdownPercent === undefined) {
      lines.push(`  Czeka na otwartą pozycję w Slocie A.`);
    } else {
      lines.push(
        `  Czeka aż Slot A będzie na ${colorize(`-${r.triggerDropPercent.toFixed(2)}%`, colors.YELLOW)} ` +
          `(teraz: ${colorize(pct(r.slotADrawdownPercent), signColor(r.slotADrawdownPercent))})`,
      );
    }
  } else {
    lines.push("  Pozycja: brak - czeka na sygnał kupna");
    if (slot.rebuyTriggerUsd !== undefined) {
      lines.push(`  Odkup poniżej: ${usd(slot.rebuyTriggerUsd, 8)} (ostatnia sprzedaż ${usd(slot.lastSellPriceUsd, 8)})`);
    } else {
      lines.push("  Pierwsze wejście - kupi przy najbliższym ticku.");
    }
    if (slot.breakoutBuy) {
      const b = slot.breakoutBuy;
      if (b.peakUsd === undefined) {
        lines.push(`  ${colorize("Wybicie:", colors.DIM)} śledzenie nieaktywne (cena nie przebiła ostatniej sprzedaży)`);
      } else {
        lines.push(
          `  Wybicie: szczyt ${usd(b.peakUsd, 8)}, kupi przy cofnięciu poniżej ` +
            `${usd(b.triggerPriceUsd, 8)} (-${b.pullbackPercent.toFixed(2)}%)`,
        );
      }
    }
  }

  if (!slot.position) {
    if (slot.autoBuyPausedSecondsLeft !== undefined) {
      lines.push(
        `  ${colorize("Auto-kupno WSTRZYMANE", colors.RED)} (${slot.autoBuyPausedSecondsLeft}s) - kilka nieudanych prób z rzędu; ręczne "buy" nadal działa`,
      );
    }
    if (slot.pendingManualBuy) {
      const m = slot.pendingManualBuy;
      const amountLabel = m.usdAmount !== undefined ? usd(m.usdAmount, 2) : `${slot.sizePercent}% salda`;
      lines.push(`  ${colorize("Oczekujące zlecenie:", colors.YELLOW)} kup ${amountLabel} przy cenie <= ${usd(m.maxPriceUsd, 8)}`);
    }
    if (slot.nextBuyUsdEstimate !== undefined) {
      lines.push(`  Wielkość kupna: ${slot.sizePercent}% salda (~${usd(slot.nextBuyUsdEstimate, 2)})`);
    }
    if (slot.adaptiveTargetEnabled) {
      const targetLabel = slot.nextTargetGainPercent !== undefined ? `+${slot.nextTargetGainPercent.toFixed(2)}%` : "-";
      lines.push(`  Następny cel:   ${colorize("adaptacyjny", colors.GREEN)}, aktualnie liczyłby ${targetLabel}`);
    } else {
      lines.push(`  Następny cel:   ${colorize("stały", colors.DIM)} +${slot.staticTargetGainPercent.toFixed(2)}%`);
    }
  }

  lines.push(`  Ukończone flipy: ${slot.completedFlips}`);
  lines.push(
    `  Impact: kup ${formatPct(slot.buyImpactPercent)} sprzedaj ${formatPct(slot.sellImpactPercent)} | ` +
      `koszt rundy: ${formatPct(slot.roundTripCostPercent)} (max ${slot.maxRoundTripCostPercent}%)`,
  );

  return lines;
}

function formatTradeLine(t: RecentTrade, tokenSymbol: string): string {
  const sideLabel = t.side === "BUY" ? colorize("KUPNO", colors.YELLOW) : colorize("SPRZEDAŻ", colors.GREEN);
  const base = `[Slot ${t.slot}] ${sideLabel} ${t.tokenAmount.toLocaleString("en-US")} ${tokenSymbol} @ ${usd(t.priceUsd, 8)}`;
  const detail =
    t.netProfitPercent !== undefined && t.netProfitUsd !== undefined
      ? ` (net ${colorize(pct(t.netProfitPercent), signColor(t.netProfitPercent))} / ${colorize(usd(t.netProfitUsd, 2), signColor(t.netProfitUsd))})`
      : ` (~${usd(t.usdValue, 2)})`;
  return `${base}${detail} (${formatAge(t.ageMs)})`;
}

function formatPct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "unknown age";
  const safeAgeMs = Math.max(0, ageMs);
  if (safeAgeMs < 1_000) return "now";
  if (safeAgeMs < 60_000) return `${Math.floor(safeAgeMs / 1_000)}s ago`;
  if (safeAgeMs < 3_600_000) return `${Math.floor(safeAgeMs / 60_000)}m ago`;
  return `${Math.floor(safeAgeMs / 3_600_000)}h ago`;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Counts the physical terminal rows `text` will occupy at a given
 * terminal width, not just its `\n` count. A logical line longer than
 * the terminal is wrapped by the terminal itself, so undercounting rows
 * here (e.g. the long commands line at 80 columns) would move the
 * cursor up too little on the next redraw and leave stray leftover
 * characters from the previous frame - which looks exactly like the
 * screen scrolling forever, just slower than a full-screen clear bug.
 */
function countPhysicalRows(text: string, columns: number): number {
  return text.split("\n").reduce((total, line) => {
    const visibleWidth = line.replace(ANSI_PATTERN, "").length;
    return total + Math.max(1, Math.ceil(visibleWidth / columns));
  }, 0);
}

let clearedScrollbackOnce = false;
let previousRenderRowCount = 0;

/**
 * Reclaims the dashboard's own screen space before something else (a log
 * line) writes to stdout outside of renderDashboard(). Must be called
 * BEFORE that write, not after: if the log gets printed first, its text
 * ends up sitting right where the old dashboard was, so erasing
 * afterwards would either wipe the log itself or land in the wrong
 * place. Erasing first means the log becomes the only new content, and
 * the next renderDashboard() call simply prints a fresh frame below it
 * instead of trying to redraw over unknown territory.
 *
 * Skipping this (i.e. letting a log print past a live dashboard
 * uncleared) is what caused the dashboard to visibly grow forever: every
 * log line left a whole stale copy of the dashboard behind it, on top of
 * the fresh one the next render added.
 */
export function prepareForExternalWrite(): void {
  if (previousRenderRowCount > 0) {
    process.stdout.write(`\x1b[${previousRenderRowCount}A\x1b[0J`);
    previousRenderRowCount = 0;
  }
}

export function renderDashboard(s: DashboardState): void {
  const body =
    formatDashboard(s) +
    "\n\ncommands: buy [usd] [a|b|c] [@maxPrice]  cancel [a|b|c]  sell [percent] [a|b|c]  panic [a|b|c]  reset  status  quit";
  // 80 matches conhost's traditional default width and is a safe
  // (slight over-count, never under-count for anything narrower) guess
  // when the terminal doesn't report its size at all.
  const columns = process.stdout.columns || 80;

  if (!clearedScrollbackOnce) {
    // \x1b[3J wipes scrollback too - run only ONCE, on the very first
    // render, to clear stale content from before this run started.
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    clearedScrollbackOnce = true;
  } else if (previousRenderRowCount > 0) {
    // Redraw in place: move the cursor back up over the previous render,
    // then erase from there to the end of the screen. This is preferred
    // over a fresh \x1b[2J\x1b[H every refresh because plain Windows
    // console windows (conhost outside Windows Terminal - e.g. a classic
    // cmd.exe window) don't clear \x1b[2J in place; they scroll the whole
    // viewport into scrollback and blank it, so every refresh pushed a
    // full screen of blank lines into the buffer and the dashboard
    // appeared to scroll forever. Moving up + erasing-to-end overwrites
    // the previous render's lines directly and works the same everywhere.
    process.stdout.write(`\x1b[${previousRenderRowCount}A\x1b[0J`);
  }
  console.log(body);
  previousRenderRowCount = countPhysicalRows(body, columns);
}
