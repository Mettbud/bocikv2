/**
 * The round-trip cost model - this is the answer to "what % do we need to
 * make per flip".
 *
 * Every buy-then-sell round trip pays for itself twice over before a single
 * dollar is profit:
 *
 *   1. Pool "spread" / swap tax - Jupiter's quote already prices this in.
 *      `priceImpactPct` on a quote is the gap between the pool's mid-price
 *      and what you actually receive: the AMM's swap fee (e.g. Raydium's
 *      ~0.25%) plus the price impact your order size causes. It is paid on
 *      BOTH legs (buying in, selling out) since each is its own swap.
 *   2. Solana network + priority fees - a flat lamport cost per transaction,
 *      independent of trade size, so it matters *more* the smaller the
 *      trade is.
 *
 * Round-trip cost % = priceImpact(buy)% + priceImpact(sell)% +
 *                      (networkFeeLamportsBothLegs -> USD) / tradeSizeUsd * 100
 *
 * A flip only clears the bar when:
 *   targetGainPercent - roundTripCostPercent >= minNetProfitPercent
 *
 * Both legs' quotes are fetched live right before a decision, so this
 * reacts to the pool's *actual* current liquidity instead of a guess baked
 * into a config file.
 */

export interface RoundTripCostInput {
  buyPriceImpactPercent: number;
  sellPriceImpactPercent: number;
  networkFeeLamportsBothLegs: number;
  solPriceUsd: number;
  tradeSizeUsd: number;
}

export interface RoundTripCostResult {
  buyLegPercent: number;
  sellLegPercent: number;
  networkFeePercent: number;
  totalPercent: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export function estimateRoundTripCostPercent(
  input: RoundTripCostInput,
): RoundTripCostResult {
  const networkFeeUsd =
    (input.networkFeeLamportsBothLegs / LAMPORTS_PER_SOL) * input.solPriceUsd;
  const networkFeePercent =
    input.tradeSizeUsd > 0 ? (networkFeeUsd / input.tradeSizeUsd) * 100 : 0;

  const buyLegPercent = Math.max(0, input.buyPriceImpactPercent);
  const sellLegPercent = Math.max(0, input.sellPriceImpactPercent);

  return {
    buyLegPercent,
    sellLegPercent,
    networkFeePercent,
    totalPercent: buyLegPercent + sellLegPercent + networkFeePercent,
  };
}

/**
 * Net profit % a flip would actually clear after costs, given the gross
 * price move from buy to (candidate) sell.
 */
export function netProfitPercent(
  grossMovePercent: number,
  roundTripCostPercent: number,
): number {
  return grossMovePercent - roundTripCostPercent;
}
