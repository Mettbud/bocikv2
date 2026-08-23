import { createInterface } from "node:readline";
import type { Logger } from "../logger.js";

export interface CommandDeps {
  logger: Logger;
  mode: "paper" | "live";
  /** Manual buy, bypassing the strategy's buy signal (still respects safety limits). */
  manualBuy: (usdAmount: number) => Promise<void>;
  /** Manual sell of `percent`% of the current position, bypassing the profit gate. */
  manualSell: (percent: number) => Promise<void>;
  /** Sells the whole position immediately, no questions asked. */
  panic: () => Promise<void>;
  /** Paper mode only: wipes the position and balances back to a fresh start. */
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

export async function handleLine(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, arg] = line.split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "buy": {
      const usdAmount = Number(arg ?? "0");
      if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
        console.log('usage: buy <usd amount>, e.g. "buy 50"');
        return;
      }
      await deps.manualBuy(usdAmount);
      return;
    }
    case "sell": {
      const percent = arg === undefined ? 100 : Number(arg);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        console.log('usage: sell [percent], e.g. "sell 50" or just "sell" for 100%');
        return;
      }
      await deps.manualSell(percent);
      return;
    }
    case "panic":
      await deps.panic();
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
      console.log("commands: buy <usd>  sell [percent]  panic  reset  status  quit");
      return;
    case "quit":
    case "exit":
      deps.onExit();
      return;
    default:
      if (cmd) console.log(`unknown command: ${cmd} (try "help")`);
  }
}
