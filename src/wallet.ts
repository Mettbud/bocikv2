import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { BotConfig } from "./config.js";

/**
 * Loads the bot's hot wallet from WALLET_PRIVATE_KEY. Accepts a base58
 * secret key (the documented format) or a JSON byte array (what
 * `solana-keygen` prints). Never logged, never returned as a string - only
 * ever turned into an in-memory Keypair for local signing.
 */
export function loadWalletKeypair(config: BotConfig): Keypair {
  const raw = config.wallet.privateKey.trim();
  if (!raw) {
    throw new Error(
      "WALLET_PRIVATE_KEY is empty. Create a dedicated hot wallet for this bot " +
        "and set it in .env - never your main wallet's key.",
    );
  }
  try {
    if (raw.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
      return Keypair.fromSecretKey(bytes);
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new Error(
      "WALLET_PRIVATE_KEY could not be parsed. Expected a base58 secret key or a JSON byte array.",
    );
  }
}
