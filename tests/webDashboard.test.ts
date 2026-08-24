import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardHttpServer } from "../src/cli/webDashboard.js";
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

const state: DashboardState = {
  tokenSymbol: "CYBERLEEK",
  mode: "PAPER",
  autoBuyEnabled: true,
  priceUsd: 0.025,
  slotA: flatSlot,
  slotB: { ...flatSlot, label: "B" },
  slotC: undefined,
  realizedPnlUsd: 1.23,
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

async function listenOnEphemeralPort(server: ReturnType<typeof createDashboardHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("createDashboardHttpServer", () => {
  let server: ReturnType<typeof createDashboardHttpServer> | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("serves the current snapshot as JSON on /api/state", async () => {
    server = createDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as DashboardState;
    expect(body.tokenSymbol).toBe("CYBERLEEK");
    expect(body.realizedPnlUsd).toBe(1.23);
  });

  it("calls getSnapshot fresh on every request, not just once at startup", async () => {
    let price = 0.02;
    server = createDashboardHttpServer(() => ({ ...state, priceUsd: price }));
    const port = await listenOnEphemeralPort(server);

    const first = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as DashboardState;
    price = 0.03;
    const second = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as DashboardState;

    expect(first.priceUsd).toBe(0.02);
    expect(second.priceUsd).toBe(0.03);
  });

  it("serves an HTML page on /", async () => {
    server = createDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
  });

  it("404s on an unknown path", async () => {
    server = createDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
