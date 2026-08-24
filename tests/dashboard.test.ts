import { describe, expect, it } from "vitest";
import { formatDashboard, type DashboardState, type SlotDashboardState } from "../src/cli/dashboard.js";

const flatSlotA: SlotDashboardState = {
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

const flatSlotB: SlotDashboardState = {
  ...flatSlotA,
  label: "B",
  reinforcement: { enabled: true, triggerDropPercent: 8, slotADrawdownPercent: undefined },
};

const base: DashboardState = {
  tokenSymbol: "CYBERLEEK",
  mode: "PAPER",
  autoBuyEnabled: true,
  priceUsd: 0.02521136,
  slotA: flatSlotA,
  slotB: flatSlotB,
  slotC: undefined,
  realizedPnlUsd: 0,
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
    expect(out).toContain("0.050000 SOL ($5.00)");
    expect(out).toContain("Rezerwa SOL:       0.020000 SOL");
    expect(out).toContain("Dostępne na kupna: 0.030000 SOL ($3.00)");
    expect(out).toContain("Kapitał początkowy: $1000.00");
  });

  it("shows no warning when AUTO_BUY_ENABLED is true (default)", () => {
    const out = formatDashboard(base);
    expect(out).not.toContain("AUTO_BUY_ENABLED=false");
  });

  it("shows a warning when AUTO_BUY_ENABLED is false", () => {
    const out = formatDashboard({ ...base, autoBuyEnabled: false });
    expect(out).toContain("AUTO_BUY_ENABLED=false");
  });

  it("shows the rebuy trigger for Slot A once a prior sell exists", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, rebuyTriggerUsd: 0.025, lastSellPriceUsd: 0.026 },
    });
    expect(out).toContain("Odkup poniżej:");
  });

  it("shows a waiting-for-manual-buy indicator instead of the rebuy trigger after a manual/panic sell", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, rebuyTriggerUsd: 0.025, lastSellPriceUsd: 0.026, requireManualNextBuy: true },
    });
    expect(out).toContain("Czeka na ręczne");
    expect(out).not.toContain("Odkup poniżej:");
  });

  it("shows a pending manual buy limit order (explicit USD amount) while flat", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, pendingManualBuy: { maxPriceUsd: 0.025, usdAmount: 50 } },
    });
    expect(out).toContain("Oczekujące zlecenie:");
    expect(out).toContain("$50.00");
    expect(out).toContain("$0.02500000");
  });

  it("shows a pending manual buy limit order (normal slot size) while flat", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, pendingManualBuy: { maxPriceUsd: 0.025, usdAmount: undefined } },
    });
    expect(out).toContain("30% salda");
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
          stopLossPercent: 25,
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
          stopLossPercent: 25,
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
    expect(out).toContain("DUAL_SLOT_ENABLED=false");
  });

  it("does not show a Slot C block when it's undefined (SLOT_C_ENABLED=false)", () => {
    const out = formatDashboard(base);
    expect(out).not.toContain("Slot C");
  });

  it("shows Slot C as its own block, disabled with its own flag name, when present", () => {
    const flatSlotC: SlotDashboardState = { ...flatSlotA, label: "C", reinforcement: { enabled: false, triggerDropPercent: 12, slotADrawdownPercent: undefined } };
    const out = formatDashboard({ ...base, slotC: flatSlotC });
    expect(out).toContain("Slot C");
    expect(out).toContain("SLOT_C_ENABLED=false");
  });

  it("shows Slot C waiting on Slot A's deeper drawdown, same as Slot B", () => {
    const flatSlotC: SlotDashboardState = { ...flatSlotA, label: "C", reinforcement: { enabled: true, triggerDropPercent: 15, slotADrawdownPercent: -18 } };
    const out = formatDashboard({ ...base, slotC: flatSlotC });
    expect(out).toContain("Czeka aż Slot A będzie na");
    expect(out).toContain("-15.00%");
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
          stopLossPercent: 25,
          trailingStop: { peakPriceUsd: 0.0263, armed: true, triggerPriceUsd: 0.02577 },
        },
      },
    });
    expect(out).toContain("UZBROJONY");
    expect(out).toContain("$0.02577000");
    expect(out).toContain("+5.20% od wejścia");
    expect(out).toContain("+3.08% od wejścia");
    expect(out).toContain("sprzeda tylko przy netto >= +2.00%");
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
          stopLossPercent: 25,
          trailingStop: { peakPriceUsd: 0.0252, armed: false, triggerPriceUsd: 0.024696 },
        },
      },
    });
    expect(out).toContain("nieuzbrojony");
    expect(out).toContain("+0.80% od wejścia");
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

  it("shows the stop loss percentage alongside the price", () => {
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
          stopLossPercent: 25,
          trailingStop: undefined,
        },
      },
    });
    expect(out).toContain("-25.00% od wejścia");
  });

  it("shows breakout-buy tracking once price has broken above the last sell", () => {
    const out = formatDashboard({
      ...base,
      slotA: {
        ...flatSlotA,
        rebuyTriggerUsd: 0.02,
        lastSellPriceUsd: 0.02,
        breakoutBuy: { peakUsd: 0.023, pullbackPercent: 3, triggerPriceUsd: 0.02231 },
      },
    });
    expect(out).toContain("Wybicie: szczyt");
    expect(out).toContain("$0.02231000");
  });

  it("shows breakout-buy as inactive until price actually breaks out", () => {
    const out = formatDashboard({
      ...base,
      slotA: { ...flatSlotA, breakoutBuy: { peakUsd: undefined, pullbackPercent: 3, triggerPriceUsd: undefined } },
    });
    expect(out).toContain("śledzenie nieaktywne");
  });
});
