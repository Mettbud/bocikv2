import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardState, SlotDashboardState } from "../src/cli/dashboard.js";

const flatSlot: SlotDashboardState = {
  label: "A",
  sizePercent: 30,
  position: undefined,
  rebuyTriggerUsd: undefined,
  lastSellPriceUsd: undefined,
  requireManualNextBuy: false,
  completedFlips: 0,
  adaptiveTargetEnabled: false,
  nextTargetGainPercent: undefined,
  staticTargetGainPercent: 6,
  nextBuyUsdEstimate: undefined,
  buyImpactPercent: undefined,
  sellImpactPercent: undefined,
  roundTripCostPercent: undefined,
  maxRoundTripCostPercent: 4,
  minNetProfitPercent: 2,
  reinforcement: undefined,
  breakoutBuy: undefined,
  pendingManualBuy: undefined,
  autoBuyPausedSecondsLeft: undefined,
};

function makeState(priceUsd: number): DashboardState {
  return {
    tokenSymbol: "CYBERLEEK",
    mode: "PAPER",
    autoBuyEnabled: true,
    priceUsd,
    slotA: flatSlot,
    slotB: { ...flatSlot, label: "B" },
    slotC: undefined,
    realizedPnlUsd: 0,
    solBalance: 0.05,
    solValueUsd: 5,
    initialPortfolioUsd: 1000,
    tokenBalance: 0,
    investedUsd: 0,
    investedPercentOfEquity: undefined,
    paperUsdBalance: 1000,
    spreadPercent: undefined,
    maxSpreadPercent: 1,
    recentTrades: [],
    lastEvent: undefined,
    lastErrorMessage: undefined,
  };
}

// dashboard.ts keeps the "last printed frame" at module scope, so each
// test needs a fresh module instance to stay isolated from the others.
async function freshDashboardModule() {
  vi.resetModules();
  return import("../src/cli/dashboard.js");
}

describe("renderDashboard", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints a plain console.log line - no cursor-movement or screen-clear escape codes", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(makeState(0.02));

    expect(logSpy).toHaveBeenCalledTimes(1);
    // Color codes (\x1b[32m etc.) are fine and expected - it's cursor
    // movement (CUU, e.g. \x1b[3A) and screen-clearing (ED/ED2, e.g.
    // \x1b[0J / \x1b[2J) that this test guards against ever coming back.
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).not.toMatch(/\x1b\[\d*[AJH]/);
  });

  it("prints again when the state actually changed", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(makeState(0.02));
    renderDashboard(makeState(0.0201));

    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("skips repeat frames when nothing changed since the last print", async () => {
    const { renderDashboard } = await freshDashboardModule();
    const state = makeState(0.02);
    renderDashboard(state);
    renderDashboard(state);
    renderDashboard(state);

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
