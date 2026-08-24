import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardHttpServer, createReadOnlyDashboardHttpServer } from "../src/cli/webDashboard.js";
import type { CommandDeps } from "../src/cli/commands.js";
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
  solValueUsd: 5,
  minSolReserve: 0.02,
  availableSolForBuys: 0.03,
  availableUsdForBuys: 3,
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

function fakeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mode: "paper",
    manualBuy: vi.fn().mockResolvedValue(undefined),
    manualSell: vi.fn().mockResolvedValue(undefined),
    panic: vi.fn().mockResolvedValue(undefined),
    cancelManualBuy: vi.fn(),
    reset: vi.fn(),
    rebase: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn(),
    ...overrides,
  };
}

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
    server = createDashboardHttpServer(() => state, fakeDeps());
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
    server = createDashboardHttpServer(() => ({ ...state, priceUsd: price }), fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const first = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as DashboardState;
    price = 0.03;
    const second = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as DashboardState;

    expect(first.priceUsd).toBe(0.02);
    expect(second.priceUsd).toBe(0.03);
  });

  it("serves an HTML page on / with a syntactically valid embedded script", async () => {
    server = createDashboardHttpServer(() => state, fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('data-action="renameSelf"');
    expect(body).toContain('"bocik.selfName." + location.port');
    expect(body).toContain("const peerPorts = { b: 4174, c: 4175, ...savedPeerPorts }");

    // The page's client-side JS is a hand-written template-literal string
    // with no build step to catch a typo/unescaped-quote mistake - this
    // is the only thing that would have caught the multi-instance panel
    // JS failing to parse at all.
    const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const js of scripts) {
      expect(() => new Function(js)).not.toThrow();
    }
  });

  it("404s on an unknown path", async () => {
    server = createDashboardHttpServer(() => state, fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it("POST /api/command routes the line through the same handleLine() path as the terminal", async () => {
    const deps = fakeDeps();
    server = createDashboardHttpServer(() => state, deps);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "buy a" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(deps.manualBuy).toHaveBeenCalledWith(undefined, "A", undefined);
  });

  it("POST /api/command rejects a missing line with 400, without calling any command", async () => {
    const deps = fakeDeps();
    server = createDashboardHttpServer(() => state, deps);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(deps.manualBuy).not.toHaveBeenCalled();
  });

  it("POST /api/command surfaces a thrown error as a 500 instead of crashing the server", async () => {
    const deps = fakeDeps({ panic: vi.fn().mockRejectedValue(new Error("simulation failed")) });
    server = createDashboardHttpServer(() => state, deps);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "panic a" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("simulation failed");
  });

  it("reflects a 127.0.0.1 Origin so a sibling instance's page can fetch this one", async () => {
    server = createDashboardHttpServer(() => state, fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Origin: "http://127.0.0.1:4174" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4174");
  });

  it("does not send CORS headers for a non-localhost Origin", async () => {
    server = createDashboardHttpServer(() => state, fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers an OPTIONS preflight with 204 and the expected CORS headers", async () => {
    server = createDashboardHttpServer(() => state, fakeDeps());
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:4175" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4175");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("createReadOnlyDashboardHttpServer", () => {
  let server: ReturnType<typeof createReadOnlyDashboardHttpServer> | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("serves live state and a page marked as read-only", async () => {
    server = createReadOnlyDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);

    const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(stateRes.status).toBe(200);
    expect(((await stateRes.json()) as DashboardState).priceUsd).toBe(0.025);

    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(page).toContain("bocik — podgląd tylko");
    expect(page).toContain("const READ_ONLY = true;");
    expect(page).toContain("const peerPorts = { b: 4274, c: 4275, ...savedPeerPorts }");
  });

  it("has no command endpoint, even for a manually crafted POST", async () => {
    const manualBuy = vi.fn().mockResolvedValue(undefined);
    server = createReadOnlyDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "buy a" }),
    });

    expect(res.status).toBe(404);
    expect(manualBuy).not.toHaveBeenCalled();
  });

  it("advertises only GET for cross-port read-only requests", async () => {
    server = createReadOnlyDashboardHttpServer(() => state);
    const port = await listenOnEphemeralPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:4273" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});
