import { describe, expect, it } from "vitest";
import { estimateRoundTripCostPercent, netProfitPercent } from "../src/costModel.js";

describe("round-trip cost model", () => {
  it("sums both legs' price impact plus network fees as a % of trade size", () => {
    const result = estimateRoundTripCostPercent({
      buyPriceImpactPercent: 0.4,
      sellPriceImpactPercent: 0.5,
      networkFeeLamportsBothLegs: 2 * 1_000_000, // 2 legs x 0.001 SOL priority fee each, roughly
      solPriceUsd: 150,
      tradeSizeUsd: 50,
    });
    // network fee: 0.002 SOL * $150 = $0.30 -> 0.6% of a $50 trade
    expect(result.networkFeePercent).toBeCloseTo(0.6, 5);
    expect(result.totalPercent).toBeCloseTo(0.4 + 0.5 + 0.6, 5);
  });

  it("a small trade pays a much larger fixed-fee percentage than a big one", () => {
    const small = estimateRoundTripCostPercent({
      buyPriceImpactPercent: 0,
      sellPriceImpactPercent: 0,
      networkFeeLamportsBothLegs: 2_000_000,
      solPriceUsd: 150,
      tradeSizeUsd: 20,
    });
    const large = estimateRoundTripCostPercent({
      buyPriceImpactPercent: 0,
      sellPriceImpactPercent: 0,
      networkFeeLamportsBothLegs: 2_000_000,
      solPriceUsd: 150,
      tradeSizeUsd: 500,
    });
    expect(small.networkFeePercent).toBeGreaterThan(large.networkFeePercent);
  });

  it("net profit is the gross move minus the round-trip cost", () => {
    expect(netProfitPercent(6, 2.3)).toBeCloseTo(3.7, 5);
    expect(netProfitPercent(1, 2.3)).toBeCloseTo(-1.3, 5);
  });
});
