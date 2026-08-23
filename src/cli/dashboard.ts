import { colorize, colors, pct, signColor, usd } from "./format.js";

export interface DashboardEvent {
  message: string;
  ageMs: number;
}

export interface PositionSnapshot {
  tokenAmount: number;
  buyPriceUsd: number;
  positionValueUsd: number | undefined;
  unrealizedPercent: number | undefined;
  unrealizedUsd: number | undefined;
  /** What net profit % selling right now would clear, after live-estimated round-trip costs. */
  netIfSoldNowPercent: number | undefined;
  sellTargetUsd: number;
  /** The gain % actually used for this position's target - frozen at buy time. */
  targetGainPercent: number;
  stopLossPriceUsd: number | undefined;
}

export interface ReinforcementInfo {
  /** DUAL_SLOT_ENABLED - false means Slot B never buys at all. */
  enabled: boolean;
  /** The live-computed drawdown Slot A must reach before Slot B reinforces. */
  triggerDropPercent: number;
  /** Slot A's current unrealized %, when it holds a position (negative = underwater). */
  slotADrawdownPercent: number | undefined;
}

export interface SlotDashboardState {
  label: "A" | "B";
  sizePercent: number;
  position: PositionSnapshot | undefined;
  /** Slot A only: rebuy trigger below its own last sell. Slot B never rebuys on its own. */
  rebuyTriggerUsd: number | undefined;
  lastSellPriceUsd: number | undefined;
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
  /** Slot B only - undefined for Slot A. */
  reinforcement: ReinforcementInfo | undefined;
}

export interface DashboardState {
  tokenSymbol: string;
  mode: "PAPER" | "LIVE";
  priceUsd: number | undefined;
  slotA: SlotDashboardState;
  slotB: SlotDashboardState;
  /** Combined across both slots. */
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

  lines.push("");
  lines.push(`Realized PnL (oba sloty): ${colorize(usd(s.realizedPnlUsd, 2), signColor(s.realizedPnlUsd))}`);
  const investedPctLabel = s.investedPercentOfEquity !== undefined ? ` (${s.investedPercentOfEquity.toFixed(1)}% portfela)` : "";
  lines.push(`W rynku teraz:            ${usd(s.investedUsd, 2)}${investedPctLabel}`);

  lines.push("");
  lines.push(`SOL balance:       ${s.solBalance.toFixed(6)}`);
  lines.push(`${s.tokenSymbol} balance: ${s.tokenBalance.toLocaleString()}`);
  if (s.paperUsdBalance !== undefined) {
    lines.push(`Paper equity (SOL + pozycje): ${usd(s.paperUsdBalance, 2)}`);
  }

  lines.push("");
  lines.push(`Spread puli: ${formatPct(s.spreadPercent)} (max ${s.maxSpreadPercent}%)`);

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

  return lines.join("\n");
}

function formatSlot(slot: SlotDashboardState, tokenSymbol: string): string[] {
  const lines: string[] = [];
  lines.push(`${colors.BOLD}Slot ${slot.label}${colors.RESET} (${slot.sizePercent}% portfela)`);

  if (slot.position) {
    const p = slot.position;
    lines.push(`  Pozycja:       ${p.tokenAmount.toLocaleString()} ${tokenSymbol}`);
    lines.push(`  Wartość:       ${usd(p.positionValueUsd)}`);
    lines.push(`  Cena wejścia:  ${usd(p.buyPriceUsd, 8)}`);
    lines.push(
      `  Niezreal.:     ${colorize(pct(p.unrealizedPercent), signColor(p.unrealizedPercent))} (${colorize(usd(p.unrealizedUsd, 2), signColor(p.unrealizedUsd))})`,
    );
    lines.push(`  Cel sprzedaży: ${usd(p.sellTargetUsd, 8)} (+${p.targetGainPercent.toFixed(2)}%, ustalony przy zakupie)`);
    const netLabel =
      p.netIfSoldNowPercent === undefined
        ? "-"
        : `${colorize(pct(p.netIfSoldNowPercent), signColor(p.netIfSoldNowPercent))} ${p.netIfSoldNowPercent >= slot.minNetProfitPercent ? colorize("(sprzedałby)", colors.GREEN) : colorize("(za mało netto)", colors.DIM)}`;
    lines.push(`  Netto teraz:   ${netLabel}`);
    if (p.stopLossPriceUsd !== undefined) {
      lines.push(`  Stop loss:     ${usd(p.stopLossPriceUsd, 8)}`);
    }
  } else if (slot.reinforcement) {
    const r = slot.reinforcement;
    if (!r.enabled) {
      lines.push(`  ${colorize("Wyłączony (DUAL_SLOT_ENABLED=false)", colors.DIM)}`);
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
  }

  if (!slot.position) {
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

export function renderDashboard(s: DashboardState): void {
  // console.clear() is a no-op on some Windows terminals, which stacks every
  // refresh under the last one instead of replacing it. This ANSI sequence
  // clears the visible screen AND scrollback and homes the cursor, which
  // works everywhere console.clear() does, plus where it doesn't.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  console.log(formatDashboard(s));
  console.log(
    "\ncommands: buy <usd> [a|b]  sell [percent] [a|b]  panic [a|b]  reset  status  quit",
  );
}
