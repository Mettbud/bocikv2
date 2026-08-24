import { createInterface } from "node:readline";
import type { Logger } from "../logger.js";

export type SlotKey = "A" | "B" | "C";

export interface CommandDeps {
  logger: Logger;
  mode: "paper" | "live";
  /**
   * Manual buy, bypassing the strategy's buy signal (still respects safety
   * limits). Omit usdAmount to use the slot's normal fixed size (% of the
   * starting portfolio), same as an automatic buy would. With maxPriceUsd,
   * doesn't buy immediately - waits (checked every tick) until the price is
   * at or below it, like a limit order; omit it to buy right away as before.
   */
  manualBuy: (usdAmount: number | undefined, slot: SlotKey, maxPriceUsd?: number) => Promise<void>;
  /** Manual sell of `percent`% of the given slot's position, bypassing the profit gate. */
  manualSell: (percent: number, slot: SlotKey) => Promise<void>;
  /** Sells a slot's whole position immediately, no questions asked. Omit slot to panic both. */
  panic: (slot: SlotKey | undefined) => Promise<void>;
  /** Cancels a pending "buy ... @price" limit order for a slot, if one is waiting. No-op otherwise. */
  cancelManualBuy: (slot: SlotKey) => void;
  /** Paper mode only: wipes both slots and balances back to a fresh start. */
  reset: () => void;
  /**
   * Recomputes initialPortfolioUsd (the base that SLOT_A/B/C_SIZE_PERCENT
   * are a fixed % of) from the wallet's ACTUAL current value - use after
   * depositing/withdrawing so future buy sizes reflect the new balance.
   * Unlike reset, doesn't touch open positions, history, or PnL, and works
   * in both paper and live mode.
   */
  rebase: () => Promise<void>;
  /** Prints the full multi-line dashboard once, on demand ("status" command). */
  printStatus: () => void;
  onExit: () => void;
}

/**
 * Wires up interactive stdin commands: buy/sell/panic/reset/status/quit.
 * Returns the readline interface so the caller can check `.line` (the
 * partially-typed command, if any) before doing a full-screen dashboard
 * redraw - without that, a redraw mid-keystroke wipes out whatever the
 * user was typing, since it clears the whole terminal.
 */
export function startCommandLoop(deps: CommandDeps): ReturnType<typeof createInterface> {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line.trim(), deps).catch((err) => {
      deps.logger.error(`command failed: ${String((err as Error).message ?? err)}`);
    });
  });
  return rl;
}

function parseSlot(token: string | undefined): SlotKey | undefined {
  if (token === undefined) return undefined;
  const lower = token.toLowerCase();
  if (lower === "a") return "A";
  if (lower === "b") return "B";
  if (lower === "c") return "C";
  return undefined;
}

export async function handleLine(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, ...rest] = line.split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "buy": {
      // "buy", "buy a", "buy 50", "buy 50 b", "buy a @0.025", "buy 50 b @0.025"
      // - an explicit USD amount is optional (falls back to the slot's normal
      // fixed size); a "@price" token is also optional - with one, this
      // doesn't buy immediately, it waits for the price to come down to (or
      // below) it first, like a limit order.
      let usdAmount: number | undefined;
      let slot: SlotKey | undefined;
      let maxPriceUsd: number | undefined;
      for (const token of rest) {
        if (token.startsWith("@")) {
          const asPrice = Number(token.slice(1));
          if (Number.isFinite(asPrice) && asPrice > 0) maxPriceUsd = asPrice;
          continue;
        }
        const asSlot = parseSlot(token);
        if (asSlot) {
          slot = asSlot;
          continue;
        }
        const asNumber = Number(token);
        if (Number.isFinite(asNumber) && asNumber > 0) usdAmount = asNumber;
      }
      slot ??= "A";
      await deps.manualBuy(usdAmount, slot, maxPriceUsd);
      return;
    }
    case "cancel":
      deps.cancelManualBuy(parseSlot(rest[0]) ?? "A");
      return;
    case "sell": {
      // "sell", "sell 50", "sell b", "sell 50 b" - a token is either the
      // slot letter or the percent, in either order.
      let percent: number | undefined;
      let slot: SlotKey | undefined;
      for (const token of rest) {
        const asSlot = parseSlot(token);
        if (asSlot) {
          slot = asSlot;
          continue;
        }
        const asNumber = Number(token);
        if (Number.isFinite(asNumber)) percent = asNumber;
      }
      percent ??= 100;
      slot ??= "A";
      if (percent <= 0 || percent > 100) {
        console.log('usage: sell [percent] [a|b|c], e.g. "sell 50" or "sell b" or "sell 50 b"');
        return;
      }
      await deps.manualSell(percent, slot);
      return;
    }
    case "panic":
      await deps.panic(parseSlot(rest[0]));
      return;
    case "reset":
      if (deps.mode === "live") {
        console.log("reset: refused - not available in live mode (safety).");
        return;
      }
      deps.reset();
      return;
    case "rebase":
      await deps.rebase();
      return;
    case "status":
      deps.printStatus();
      return;
    case "help":
      console.log(
        "commands: buy [usd] [a|b|c] [@maxPrice]  cancel [a|b|c]  sell [percent] [a|b|c]  panic [a|b|c]  reset  rebase  status  quit\n" +
          '  "buy" or "buy a" alone uses the slot\'s normal fixed size (e.g. 30% of the starting portfolio)\n' +
          '  "buy a @0.025" waits for the price to drop to $0.025 or below before buying (normal size); "cancel a" cancels it\n' +
          '  "rebase" recomputes the 30%-of-starting-balance base from your CURRENT wallet value - use after a deposit/withdrawal',
      );
      return;
    case "quit":
    case "exit":
      deps.onExit();
      return;
    default:
      if (cmd) console.log(`unknown command: ${cmd} (try "help")`);
  }
}
