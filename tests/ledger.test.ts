import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadState } from "../src/ledger.js";
import type { BotConfig } from "../src/config.js";

/** Only the two fields loadState actually reads. */
function stubConfig(statePath: string, mode: "paper" | "live"): BotConfig {
  return { files: { state: statePath }, mode } as unknown as BotConfig;
}

describe("loadState", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bocik-ledger-test-"));
    statePath = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts fresh (with the current mode stamped on it) when no file exists", () => {
    const state = loadState(stubConfig(statePath, "paper"), 5, 1000);
    expect(state.mode).toBe("paper");
    expect(state.slotA.phase).toBe("AWAITING_BUY");
    expect(state.initialPortfolioUsd).toBe(1000);
  });

  it("loads normally when the saved mode matches the current run", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ mode: "paper", realizedPnlUsd: 42, initialPortfolioUsd: 777, paperSolBalance: 3, paperTokenBalance: 0 }),
    );
    const state = loadState(stubConfig(statePath, "paper"), 5, 1000);
    expect(state.realizedPnlUsd).toBe(42);
    expect(state.initialPortfolioUsd).toBe(777);
  });

  it("refuses a state file saved under a different mode - starts fresh instead of mixing paper and live numbers", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ mode: "paper", realizedPnlUsd: 999, initialPortfolioUsd: 777, paperSolBalance: 3, paperTokenBalance: 12_345 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = loadState(stubConfig(statePath, "live"), 5, 1000);
    expect(state.mode).toBe("live");
    expect(state.realizedPnlUsd).toBe(0);
    expect(state.paperTokenBalance).toBe(0);
    expect(state.initialPortfolioUsd).toBe(1000);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("paper");
  });

  it("loads a legacy state file with no mode field at all (predates this check)", () => {
    writeFileSync(statePath, JSON.stringify({ realizedPnlUsd: 5, initialPortfolioUsd: 500 }));
    const state = loadState(stubConfig(statePath, "live"), 5, 1000);
    expect(state.realizedPnlUsd).toBe(5);
    expect(state.mode).toBe("live");
  });
});
