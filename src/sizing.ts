/**
 * Position sizing for automatic buys: a % of the *spendable* balance
 * (current SOL balance minus the reserve we never touch), not a fixed
 * dollar figure. This means the position size compounds with the
 * account - a winning streak buys bigger, a losing one buys smaller -
 * same as "betting a % of the bankroll" in any other sizing scheme.
 */
export function computePortfolioTradeUsd(
  solBalance: number,
  minSolReserve: number,
  solPriceUsd: number,
  sizePercent: number,
): number {
  const spendableSol = Math.max(0, solBalance - minSolReserve);
  return spendableSol * solPriceUsd * (sizePercent / 100);
}
