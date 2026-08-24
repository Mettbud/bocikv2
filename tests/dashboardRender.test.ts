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

// dashboard.ts keeps redraw state (last printed line, owned line width)
// at module scope, so each test needs a fresh module instance to stay
// isolated from the others.
async function freshDashboardModule() {
  vi.resetModules();
  return import("../src/cli/dashboard.js");
}

describe("renderDashboard on a non-TTY stream (e.g. output redirected to a file)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints a plain console.log line with no carriage-return/escape tricks", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(makeState(0.02));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).not.toMatch(/[\r\x1b]/);
  });

  it("skips repeat frames when nothing changed since the last print", async () => {
    const { renderDashboard } = await freshDashboardModule();
    const state = makeState(0.02);
    renderDashboard(state);
    renderDashboard(state);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe("renderDashboard on a real TTY", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("updates a single line with \\r - never a cursor-movement or screen-clear escape code", async () => {
    const { renderDashboard } = await freshDashboardModule();
    renderDashboard(makeState(0.02));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0]?.[0] as string;
    expect(written.startsWith("\r")).toBe(true);
    expect(written).not.toMatch(/\n/);
    // Cursor movement (e.g. \x1b[3A) and screen-clearing (e.g. \x1b[0J,
    // \x1b[2J) codes are exactly what earlier versions relied on and what
    // turned out to be unreliable - this line must never depend on them.
    expect(written).not.toMatch(/\x1b\[/);
  });

  it("skips repeat frames when nothing changed since the last print", async () => {
    const { renderDashboard } = await freshDashboardModule();
    const state = makeState(0.02);
    renderDashboard(state);
    renderDashboard(state);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("blanks the sticky line with \\r + spaces (no escape codes) before an external write", async () => {
    const { renderDashboard, prepareForExternalWrite } = await freshDashboardModule();
    renderDashboard(makeState(0.02));
    writeSpy.mockClear();

    prepareForExternalWrite();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0]?.[0] as string;
    expect(written).toMatch(/^\r +\r$/);
  });

  it("does nothing when prepareForExternalWrite runs with no sticky line up yet", async () => {
    const { prepareForExternalWrite } = await freshDashboardModule();
    prepareForExternalWrite();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("printFullDashboard moves off the sticky line, then prints full detail via console.log", async () => {
    const { renderDashboard, printFullDashboard } = await freshDashboardModule();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    renderDashboard(makeState(0.02)); // puts a sticky line up
    writeSpy.mockClear();
    printFullDashboard(makeState(0.02));

    expect(writeSpy).toHaveBeenCalledWith("\r\n");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("CYBERLEEK");

    logSpy.mockRestore();
  });
});
