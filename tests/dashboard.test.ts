import { describe, expect, it } from "vitest";
import { formatDashboard, type DashboardState, type SlotDashboardState } from "../src/cli/dashboard.js";

const flatSlotA: SlotDashboardState = {
  label: "A",
  sizePercent: 30,
  position: undefined,
  rebuyTriggerUsd: undefined,
  lastSellPriceUsd: undefined,
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
};

const flatSlotB: SlotDashboardState = {
  ...flatSlotA,
  label: "B",
  reinforcement: { enabled: true, triggerDropPercent: 8, slotADrawdownPercent: undefined },
};

const base: DashboardState = {
  tokenSymbol: "CYBERLEEK",
  mode: "PAPER",
  priceUsd: 0.02521136,
  slotA: flatSlotA,
  slotB: flatSlotB,
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

describe("formatDashboard", () => {
  it("shows both slots, 'awaiting buy', and the token price while flat", () => {
    const out = formatDashboard(base);
    expect(out).toContain("CYBERLEEK");
    expect(out).toContain("Slot A");
    expect(out).toContain("Slot B");
    expect(out).toContain("Pozycja: brak");
    expect(out).toContain("$0.02521136");
    expect(out).toContain("Mode: ");
    expect(out).toContain("PAPER");
  });

  it("shows the rebuy trigger for Slot A once a prior sell exists", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, rebuyTriggerUsd: 0.025, lastSellPriceUsd: 0.026 },
    });
    expect(out).toContain("Odkup poniżej:");
  });

  it("shows position details, sell target, and net-if-sold-now while holding", () => {
    const out = formatDashboard({
      ...base,
      slotA: {
        ...flatSlotA,
        position: {
          tokenAmount: 1000,
          buyPriceUsd: 0.025,
          positionValueUsd: 26.5,
          unrealizedPercent: 6,
          unrealizedUsd: 1.5,
          netIfSoldNowPercent: 3.2,
          netIfSoldNowUsd: 1.6,
          sellTargetUsd: 0.0265,
          targetGainPercent: 6,
          stopLossPriceUsd: 0.01875,
          trailingStop: undefined,
        },
      },
    });
    expect(out).toContain("1,000 CYBERLEEK");
    expect(out).toContain("+6.00%, ustalony przy zakupie");
    expect(out).toContain("Netto teraz:");
    expect(out).toContain("Stop loss:");
  });

  it("shows Slot B waiting on Slot A's drawdown", () => {
    const out = formatDashboard({
      ...base,
      slotA: {
        ...flatSlotA,
        position: {
          tokenAmount: 1000,
          buyPriceUsd: 0.025,
          positionValueUsd: 22,
          unrealizedPercent: -12,
          unrealizedUsd: -3,
          netIfSoldNowPercent: -14,
          netIfSoldNowUsd: -7,
          sellTargetUsd: 0.0265,
          targetGainPercent: 6,
          stopLossPriceUsd: 0.01875,
          trailingStop: undefined,
        },
      },
      slotB: { ...flatSlotB, reinforcement: { enabled: true, triggerDropPercent: 8, slotADrawdownPercent: -12 } },
    });
    expect(out).toContain("Czeka aż Slot A będzie na");
    expect(out).toContain("-8.00%");
  });

  it("shows Slot B as disabled when DUAL_SLOT_ENABLED is off", () => {
    const out = formatDashboard({
      ...base,
      slotB: { ...flatSlotB, reinforcement: { enabled: false, triggerDropPercent: 8, slotADrawdownPercent: undefined } },
    });
    expect(out).toContain("Wyłączony");
  });

  it("shows the next buy size as a % of balance while flat", () => {
    const out = formatDashboard({ ...base, slotA: { ...flatSlotA, nextBuyUsdEstimate: 475.12 } });
    expect(out).toContain("30% salda (~$475.12)");
  });

  it("shows the pool spread against its configured max", () => {
    const out = formatDashboard({ ...base, spreadPercent: 0.24, maxSpreadPercent: 1 });
    expect(out).toContain("Spread puli: 0.24% (max 1%)");
  });

  it("shows how much is currently deployed in the market", () => {
    const out = formatDashboard({ ...base, investedUsd: 320.5, investedPercentOfEquity: 32.05 });
    expect(out).toContain("W rynku teraz:");
    expect(out).toContain("$320.50");
    expect(out).toContain("32.0% portfela");
  });

  it("shows the adaptive target when enabled", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, adaptiveTargetEnabled: true, nextTargetGainPercent: 4.8 },
    });
    expect(out).toContain("adaptacyjny");
    expect(out).toContain("+4.80%");
  });

  it("shows the static target when adaptive targeting is off", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, adaptiveTargetEnabled: false, staticTargetGainPercent: 6 },
    });
    expect(out).toContain("stały");
    expect(out).toContain("+6.00%");
  });

  it("shows an armed trailing stop with its trigger price", () => {
    const out = formatDashboard({
      ...base,
      slotA: {
        ...flatSlotA,
        position: {
          tokenAmount: 1000,
          buyPriceUsd: 0.025,
          positionValueUsd: 26.5,
          unrealizedPercent: 5,
          unrealizedUsd: 1.25,
          netIfSoldNowPercent: 2.5,
          netIfSoldNowUsd: 1.25,
          sellTargetUsd: 0.0265,
          targetGainPercent: 6,
          stopLossPriceUsd: 0.01875,
          trailingStop: { peakPriceUsd: 0.0263, armed: true, triggerPriceUsd: 0.02577 },
        },
      },
    });
    expect(out).toContain("UZBROJONY");
    expect(out).toContain("$0.02577000");
  });

  it("shows an unarmed trailing stop", () => {
    const out = formatDashboard({
      ...base,
      slotA: {
        ...flatSlotA,
        position: {
          tokenAmount: 1000,
          buyPriceUsd: 0.025,
          positionValueUsd: 25.2,
          unrealizedPercent: 0.8,
          unrealizedUsd: 0.2,
          netIfSoldNowPercent: -1.2,
          netIfSoldNowUsd: -0.6,
          sellTargetUsd: 0.0265,
          targetGainPercent: 6,
          stopLossPriceUsd: 0.01875,
          trailingStop: { peakPriceUsd: 0.0252, armed: false, triggerPriceUsd: 0.024696 },
        },
      },
    });
    expect(out).toContain("nieuzbrojony");
  });

  it("lists recent trades, newest first", () => {
    const out = formatDashboard({
      ...base,
      recentTrades: [
        {
          ageMs: 60_000,
          slot: "A",
          side: "BUY",
          tokenAmount: 15104.6681,
          priceUsd: 0.01986141,
          usdValue: 300,
          netProfitPercent: undefined,
          netProfitUsd: undefined,
        },
        {
          ageMs: 300_000,
          slot: "B",
          side: "SELL",
          tokenAmount: 17530.5574,
          priceUsd: 0.01778077,
          usdValue: 311.7,
          netProfitPercent: 3.74,
          netProfitUsd: 11.2,
        },
      ],
    });
    expect(out).toContain("Ostatnie transakcje");
    expect(out).toContain("[Slot A]");
    expect(out).toContain("[Slot B]");
    expect(out).toContain("+3.74%");
    expect(out).toContain("$11.20");
  });
});
