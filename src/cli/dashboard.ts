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
  /** Current SOL holdings marked at the latest SOL/USD quote. */
  solValueUsd: number | undefined;
  /** SOL deliberately unavailable to strategies so transaction fees remain funded. */
  minSolReserve: number;
  /** What strategies may actually spend after preserving minSolReserve. */
  availableSolForBuys: number;
  availableUsdForBuys: number | undefined;
  /** Fixed sizing baseline captured on first run or explicitly changed by rebase. */
  initialPortfolioUsd: number;
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
  lines.push(`W SOL teraz:       ${s.solBalance.toFixed(6)} SOL${s.solValueUsd !== undefined ? ` (${usd(s.solValueUsd, 2)})` : ""}`);
  lines.push(`Rezerwa SOL:       ${s.minSolReserve.toFixed(6)} SOL`);
  lines.push(
    `Dostępne na kupna: ${s.availableSolForBuys.toFixed(6)} SOL${s.availableUsdForBuys !== undefined ? ` (${usd(s.availableUsdForBuys, 2)})` : ""}`,
  );
  lines.push(`Kapitał początkowy: ${usd(s.initialPortfolioUsd, 2)}`);
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
      const peakGainPercent = ((t.peakPriceUsd / p.buyPriceUsd) - 1) * 100;
      if (t.armed && t.triggerPriceUsd !== undefined) {
        const triggerGainPercent = ((t.triggerPriceUsd / p.buyPriceUsd) - 1) * 100;
        lines.push(
          `  Trailing stop: ${colorize("UZBROJONY", colors.GREEN)}, szczyt ${usd(t.peakPriceUsd, 8)} (${pct(peakGainPercent)} od wejścia), próg cofnięcia ${usd(t.triggerPriceUsd, 8)} (${pct(triggerGainPercent)} od wejścia); sprzeda tylko przy netto >= +${slot.minNetProfitPercent.toFixed(2)}%`,
        );
      } else {
        lines.push(
          `  Trailing stop: ${colorize("nieuzbrojony", colors.DIM)} (szczyt ${usd(t.peakPriceUsd, 8)}, ${pct(peakGainPercent)} od wejścia, jeszcze za mało zysku)`,
        );
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

let lastPrintedBody: string | undefined;

/**
 * Prints the dashboard as a normal, scrolling console line - the same
 * way every BUY/SELL/error log line already prints, which never had a
 * duplication problem. Earlier versions tried to make this a
 * self-updating, in-place "live" panel using ANSI cursor movement
 * (\x1b[<n>A) and screen erase (\x1b[0J/\x1b[2J) codes, refreshed on a
 * timer. That depends on the terminal executing those codes exactly as
 * intended; in practice it kept failing in subtly different ways across
 * terminals (plain cmd.exe scrolling instead of clearing on \x1b[2J,
 * wrapped long lines desyncing the cursor-up count, and finally cursor
 * movement just not taking effect at all in one reporter's console,
 * even though colors rendered fine) - each fix traded one failure mode
 * for another. A plain scrolling print has no failure mode: it's the
 * same mechanism the rest of the bot's own output already uses
 * successfully.
 *
 * Repeated identical frames (nothing changed since the last tick) are
 * skipped so a quiet market doesn't spam the terminal every
 * DASHBOARD_REFRESH_MS for no reason.
 */
export function renderDashboard(s: DashboardState): void {
  const body =
    formatDashboard(s) +
    "\n\ncommands: buy [usd] [a|b|c] [@maxPrice]  cancel [a|b|c]  sell [percent] [a|b|c]  panic [a|b|c]  reset  status  quit";
  if (body === lastPrintedBody) return;
  lastPrintedBody = body;
  console.log(body);
}
