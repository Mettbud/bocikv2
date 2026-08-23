/**
 * Position sizing: each slot spends a fixed % of the STARTING portfolio
 * value - not a % of the current balance. $1000 to start with and
 * SLOT_A_SIZE_PERCENT=30 means Slot A always targets $300, whether the
 * account is currently at $1200 or $600. Nothing compounds automatically;
 * realized PnL sits in the balance as a bigger (or smaller) cash cushion,
 * it doesn't change how big the next buy is.
 *
 * The actual buy still gets capped by whatever is really spendable right
 * now (see the MIN_SOL_RESERVE check at the call site in index.ts) - if
 * the account has drawn down below a slot's fixed target, that slot's next
 * buy just doesn't fire until there's enough balance again.
 */
export function computeFixedSlotTradeUsd(initialPortfolioUsd: number, sizePercent: number): number {
  return Math.max(0, initialPortfolioUsd) * (sizePercent / 100);
}
