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

export interface DashboardState {
  tokenSymbol: string;
  mode: "PAPER" | "LIVE";
  priceUsd: number | undefined;
  position: PositionSnapshot | undefined;
  /** Only meaningful while flat and a previous sell has happened. */
  rebuyTriggerUsd: number | undefined;
  lastSellPriceUsd: number | undefined;
  completedFlips: number;
  realizedPnlUsd: number;
  solBalance: number;
  tokenBalance: number;
  paperUsdBalance: number | undefined;
  buyImpactPercent: number | undefined;
  sellImpactPercent: number | undefined;
  roundTripCostPercent: number | undefined;
  /** Baseline pool spread (size-independent) - last checked at the last buy attempt. */
  spreadPercent: number | undefined;
  maxSpreadPercent: number;
  minNetProfitPercent: number;
  maxRoundTripCostPercent: number;
  adaptiveTargetEnabled: boolean;
  /** What the adaptive target would set the NEXT buy's sell target to, right now. */
  nextTargetGainPercent: number | undefined;
  /** The fixed TARGET_GAIN_PERCENT - shown when adaptive targeting is off. */
  staticTargetGainPercent: number;
  /** Next automatic buy size, as % of the spendable balance. */
  tradeSizePercent: number;
  nextBuyUsdEstimate: number | undefined;
  lastEvent: DashboardEvent | undefined;
  lastErrorMessage: string | undefined;
}

export function formatDashboard(s: DashboardState): string {
  const lines: string[] = [];
  const modeColor = s.mode === "LIVE" ? colors.RED : colors.GREEN;

  lines.push(`${colors.BOLD}${s.tokenSymbol}${colors.RESET}`);
  lines.push(`Price: ${usd(s.priceUsd, 8)}`);
  lines.push("");

  if (s.position) {
    const p = s.position;
    lines.push(`Position:       ${p.tokenAmount.toLocaleString()} ${s.tokenSymbol}`);
    lines.push(`Position value: ${usd(p.positionValueUsd)}`);
    lines.push(`Entry price:    ${usd(p.buyPriceUsd, 8)}`);
    lines.push(
      `Unrealized:     ${colorize(pct(p.unrealizedPercent), signColor(p.unrealizedPercent))} (${colorize(usd(p.unrealizedUsd, 2), signColor(p.unrealizedUsd))})`,
    );
    lines.push(`Sell target:    ${usd(p.sellTargetUsd, 8)} (cel +${p.targetGainPercent.toFixed(2)}%, ustalony przy zakupie)`);
    const netLabel =
      p.netIfSoldNowPercent === undefined
        ? "-"
        : `${colorize(pct(p.netIfSoldNowPercent), signColor(p.netIfSoldNowPercent))} ${p.netIfSoldNowPercent >= s.minNetProfitPercent ? colorize("(would sell)", colors.GREEN) : colorize("(below min net)", colors.DIM)}`;
    lines.push(`Net if sold now: ${netLabel}`);
    if (p.stopLossPriceUsd !== undefined) {
      lines.push(`Stop loss:      ${usd(p.stopLossPriceUsd, 8)}`);
    }
  } else {
    lines.push("Position: none - awaiting buy signal");
    if (s.rebuyTriggerUsd !== undefined) {
      lines.push(`Rebuy below:    ${usd(s.rebuyTriggerUsd, 8)} (last sell ${usd(s.lastSellPriceUsd, 8)})`);
    } else {
      lines.push("First entry - buys on the next tick.");
    }
    if (s.nextBuyUsdEstimate !== undefined) {
      lines.push(`Next buy size:  ${s.tradeSizePercent}% of balance (~${usd(s.nextBuyUsdEstimate, 2)})`);
    }
    if (s.adaptiveTargetEnabled) {
      const targetLabel = s.nextTargetGainPercent !== undefined ? `+${s.nextTargetGainPercent.toFixed(2)}%` : "-";
      lines.push(`Next target:    ${colorize("adaptive", colors.GREEN)}, aktualnie liczyłby ${targetLabel}`);
    } else {
      lines.push(`Next target:    ${colorize("stały", colors.DIM)} +${s.staticTargetGainPercent.toFixed(2)}%`);
    }
  }

  lines.push("");
  lines.push(`Completed flips: ${s.completedFlips}`);
  lines.push(`Realized PnL:    ${colorize(usd(s.realizedPnlUsd, 2), signColor(s.realizedPnlUsd))}`);

  lines.push("");
  lines.push(`SOL balance:       ${s.solBalance.toFixed(6)}`);
  lines.push(`${s.tokenSymbol} balance: ${s.tokenBalance.toLocaleString()}`);
  if (s.paperUsdBalance !== undefined) {
    lines.push(`Paper equity (SOL + position): ${usd(s.paperUsdBalance, 2)}`);
  }

  lines.push("");
  lines.push(
    `Spread: ${formatPct(s.spreadPercent)} (max ${s.maxSpreadPercent}%)  ` +
      `Price impact: buy ${formatPct(s.buyImpactPercent)}  sell ${formatPct(s.sellImpactPercent)}`,
  );
  lines.push(
    `Round-trip cost est: ${formatPct(s.roundTripCostPercent)} (max ${s.maxRoundTripCostPercent}%)`,
  );

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
  console.log("\ncommands: buy <usd>  sell [percent]  panic  reset  status  quit");
}
