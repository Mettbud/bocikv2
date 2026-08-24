import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("separate secrets environment", () => {
  it("loads only wallet and Jupiter credentials from the configured file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bocik-secrets-"));
    created.push(dir);
    const file = join(dir, "secrets.env");
    writeFileSync(
      file,
      "WALLET_PRIVATE_KEY=test-wallet\nJUPITER_API_KEY=test-jupiter\nTARGET_TOKEN_MINT=must-not-override\n",
    );

    const config = loadConfig({
      SECRETS_ENV_FILE: file,
      TRADING_MODE: "live",
      TARGET_TOKEN_MINT: "configured-mint",
    });

    expect(config.wallet.privateKey).toBe("test-wallet");
    expect(config.jupiter.apiKey).toBe("test-jupiter");
    expect(config.token.mint).toBe("configured-mint");
  });

  it("keeps non-empty main environment credentials as the higher priority", () => {
    const dir = mkdtempSync(join(tmpdir(), "bocik-secrets-"));
    created.push(dir);
    const file = join(dir, "secrets.env");
    writeFileSync(file, "WALLET_PRIVATE_KEY=file-wallet\nJUPITER_API_KEY=file-jupiter\n");

    const config = loadConfig({
      SECRETS_ENV_FILE: file,
      WALLET_PRIVATE_KEY: "main-wallet",
      JUPITER_API_KEY: "main-jupiter",
      TRADING_MODE: "live",
      TARGET_TOKEN_MINT: "configured-mint",
    });

    expect(config.wallet.privateKey).toBe("main-wallet");
    expect(config.jupiter.apiKey).toBe("main-jupiter");
  });
});
