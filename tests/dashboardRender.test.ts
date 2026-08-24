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

const minimalState: DashboardState = {
  tokenSymbol: "CYBERLEEK",
  mode: "PAPER",
  autoBuyEnabled: true,
  priceUsd: 0.02521136,
  slotA: flatSlot,
  slotB: { ...flatSlot, label: "B" },
  slotC: undefined,
  realizedPnlUsd: 0,
  solBalance: 0.05,
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

// dashboard.ts keeps redraw state (clearedScrollbackOnce, previous row
// count) at module scope, so each test needs a fresh module instance to
// stay isolated from the others.
async function freshDashboardModule() {
  vi.resetModules();
  return import("../src/cli/dashboard.js");
}

describe("renderDashboard / notifyExternalStdoutWrite", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;

  beforeEach(() => {
    // Wide enough that formatDashboard's lines never wrap, so the redraw
    // row count is just the newline count - keeps assertions simple.
    Object.defineProperty(process.stdout, "columns", { value: 500, configurable: true });
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("wipes scrollback only on the very first render", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(minimalState);
    expect(writeSpy).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");

    writeSpy.mockClear();
    renderDashboard(minimalState);
    expect(writeSpy).not.toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");
  });

  it("redraws in place (cursor up + erase) when nothing else wrote to stdout in between", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(minimalState);
    const firstBody = logSpy.mock.calls[0]?.[0] as string;
    const expectedRows = firstBody.split("\n").length;

    writeSpy.mockClear();
    renderDashboard(minimalState);
    expect(writeSpy).toHaveBeenCalledWith(`\x1b[${expectedRows}A\x1b[0J`);
  });

  it("prints fresh, without an erase, right after an external stdout write", async () => {
    const { renderDashboard, notifyExternalStdoutWrite } = await freshDashboardModule();
    renderDashboard(minimalState); // first render - full clear
    writeSpy.mockClear();

    notifyExternalStdoutWrite(); // simulates a logger.info() call in between
    renderDashboard(minimalState);

    // No cursor-up/erase sequence - a log line may be sitting right above
    // the cursor and must not be clobbered.
    for (const call of writeSpy.mock.calls) {
      expect(call[0]).not.toMatch(/\x1b\[\d+A/);
    }
  });
});
