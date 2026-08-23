import { describe, expect, it } from "vitest";
import { formatDashboard, type DashboardState } from "../src/cli/dashboard.js";

const base: DashboardState = {
  tokenSymbol: "CYBERLEEK",
  mode: "PAPER",
  priceUsd: 0.02521136,
  position: undefined,
  rebuyTriggerUsd: undefined,
  lastSellPriceUsd: undefined,
  completedFlips: 0,
  realizedPnlUsd: 0,
  solBalance: 0.05,
  tokenBalance: 0,
  paperUsdBalance: 1000,
  buyImpactPercent: undefined,
  sellImpactPercent: undefined,
  roundTripCostPercent: undefined,
  minNetProfitPercent: 2,
  maxRoundTripCostPercent: 4,
  lastEvent: undefined,
  lastErrorMessage: undefined,
};

describe("formatDashboard", () => {
  it("shows 'awaiting buy' and the token price while flat", () => {
    const out = formatDashboard(base);
    expect(out).toContain("CYBERLEEK");
    expect(out).toContain("Position: none");
    expect(out).toContain("$0.02521136");
    expect(out).toContain("Mode: ");
    expect(out).toContain("PAPER");
  });

  it("shows the rebuy trigger once a prior sell exists", () => {
    const out = formatDashboard({ ...base, rebuyTriggerUsd: 0.025, lastSellPriceUsd: 0.026 });
    expect(out).toContain("Rebuy below:");
  });

  it("shows position details, sell target, and net-if-sold-now while holding", () => {
    const out = formatDashboard({
      ...base,
      position: {
        tokenAmount: 1000,
        buyPriceUsd: 0.025,
        positionValueUsd: 26.5,
        unrealizedPercent: 6,
        unrealizedUsd: 1.5,
        netIfSoldNowPercent: 3.2,
        sellTargetUsd: 0.0265,
        stopLossPriceUsd: 0.01875,
      },
    });
    expect(out).toContain("Position:       1,000 CYBERLEEK");
    expect(out).toContain("Sell target:    $0.02650000");
    expect(out).toContain("Net if sold now:");
    expect(out).toContain("Stop loss:      $0.01875000");
  });
});
