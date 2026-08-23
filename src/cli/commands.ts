import { createInterface } from "node:readline";
import type { Logger } from "../logger.js";

export type SlotKey = "A" | "B";

export interface CommandDeps {
  logger: Logger;
  mode: "paper" | "live";
  /**
   * Manual buy, bypassing the strategy's buy signal (still respects safety
   * limits). Omit usdAmount to use the slot's normal fixed size (% of the
   * starting portfolio), same as an automatic buy would.
   */
  manualBuy: (usdAmount: number | undefined, slot: SlotKey) => Promise<void>;
  /** Manual sell of `percent`% of the given slot's position, bypassing the profit gate. */
  manualSell: (percent: number, slot: SlotKey) => Promise<void>;
  /** Sells a slot's whole position immediately, no questions asked. Omit slot to panic both. */
  panic: (slot: SlotKey | undefined) => Promise<void>;
  /** Paper mode only: wipes both slots and balances back to a fresh start. */
  reset: () => void;
  onExit: () => void;
}

/** Wires up interactive stdin commands: buy/sell/panic/reset/status/quit. */
export function startCommandLoop(deps: CommandDeps): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line.trim(), deps).catch((err) => {
      deps.logger.error(`command failed: ${String((err as Error).message ?? err)}`);
    });
  });
}

function parseSlot(token: string | undefined): SlotKey | undefined {
  if (token === undefined) return undefined;
  const lower = token.toLowerCase();
  if (lower === "a") return "A";
  if (lower === "b") return "B";
  return undefined;
}

export async function handleLine(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, ...rest] = line.split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "buy": {
      // "buy", "buy a", "buy 50", "buy 50 b" - an explicit USD amount is
      // optional; without one, manualBuy falls back to the slot's normal
      // fixed size (% of the starting portfolio).
      let usdAmount: number | undefined;
      let slot: SlotKey | undefined;
      for (const token of rest) {
        const asSlot = parseSlot(token);
        if (asSlot) {
          slot = asSlot;
          continue;
        }
        const asNumber = Number(token);
        if (Number.isFinite(asNumber) && asNumber > 0) usdAmount = asNumber;
      }
      slot ??= "A";
      await deps.manualBuy(usdAmount, slot);
      return;
    }
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
        console.log('usage: sell [percent] [a|b], e.g. "sell 50" or "sell b" or "sell 50 b"');
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
    case "status":
      return; // dashboard redraws on its own timer
    case "help":
      console.log(
        "commands: buy [usd] [a|b]  sell [percent] [a|b]  panic [a|b]  reset  status  quit\n" +
          '  "buy" or "buy a" alone uses the slot\'s normal fixed size (e.g. 30% of the starting portfolio)',
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
