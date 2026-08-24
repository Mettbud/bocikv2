import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const profiles = [
  { file: "BOCIK-A.env.ready", mode: "live", port: 4173, state: "./data/state.json", slotCEnabled: true },
  { file: "BOCIK-B.env.ready", mode: "paper", port: 4174, state: "./data/state-b.json", slotCEnabled: false },
  { file: "BOCIK-C.env.ready", mode: "paper", port: 4175, state: "./data/state-c.json", slotCEnabled: true },
] as const;

describe("ready environment profiles", () => {
  for (const profile of profiles) {
    it(`${profile.file} is complete, safe and parses`, () => {
      const raw = parse(readFileSync(resolve(profile.file)));
      const config = loadConfig({
        ...raw,
        // The distributable LIVE profile must keep the real secret blank.
        // loadConfig only needs a non-empty marker to validate the remaining
        // settings; wallet decoding happens later and is deliberately not run.
        WALLET_PRIVATE_KEY: profile.mode === "live" ? "test-only-placeholder" : raw.WALLET_PRIVATE_KEY,
      });

      expect(raw.WALLET_PRIVATE_KEY).toBe("");
      expect(raw.JUPITER_API_KEY).toBe("");
      expect(config.mode).toBe(profile.mode);
      expect(config.dashboardWeb).toEqual({ enabled: true, port: profile.port });
      expect(config.files.state).toBe(profile.state);
      expect(config.strategy.slotCEnabled).toBe(profile.slotCEnabled);
      expect(config.trade.slotCSizePercent).toBe(30);
      expect(config.strategy.breakoutBuyEnabled).toBe(true);
      expect(config.strategy.slotCTriggerMinPercent).toBe(10);
      expect(config.strategy.slotCTriggerMaxPercent).toBe(22);
    });
  }
});
