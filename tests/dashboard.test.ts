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
  spreadPercent: undefined,
  maxSpreadPercent: 1,
  minNetProfitPercent: 2,
  maxRoundTripCostPercent: 4,
  adaptiveTargetEnabled: false,
  nextTargetGainPercent: undefined,
  staticTargetGainPercent: 6,
  tradeSizePercent: 50,
  nextBuyUsdEstimate: undefined,
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
        targetGainPercent: 6,
        stopLossPriceUsd: 0.01875,
      },
    });
    expect(out).toContain("Position:       1,000 CYBERLEEK");
    expect(out).toContain("Sell target:    $0.02650000 (cel +6.00%, ustalony przy zakupie)");
    expect(out).toContain("Net if sold now:");
    expect(out).toContain("Stop loss:      $0.01875000");
  });

  it("shows the next buy size as a % of balance while flat", () => {
    const out = formatDashboard({ ...base, tradeSizePercent: 50, nextBuyUsdEstimate: 475.12 });
    expect(out).toContain("Next buy size:  50% of balance (~$475.12)");
  });

  it("shows the pool spread against its configured max", () => {
    const out = formatDashboard({ ...base, spreadPercent: 0.24, maxSpreadPercent: 1 });
    expect(out).toContain("Spread: 0.24% (max 1%)");
  });

  it("shows the adaptive target when enabled", () => {
    const out = formatDashboard({ ...base, adaptiveTargetEnabled: true, nextTargetGainPercent: 4.8 });
    expect(out).toContain("Next target:");
    expect(out).toContain("+4.80%");
  });

  it("shows the static target when adaptive targeting is off", () => {
    const out = formatDashboard({ ...base, adaptiveTargetEnabled: false, staticTargetGainPercent: 6 });
    expect(out).toContain("stały");
    expect(out).toContain("+6.00%");
  });
});
