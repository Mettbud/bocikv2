import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConfig } from "./config.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(config: BotConfig): Logger {
  mkdirSync(dirname(config.log.file), { recursive: true });
  const minLevelIdx = LEVELS.indexOf(config.log.level);

  const write = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS.indexOf(level) < minLevelIdx) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}${
      meta ? " " + JSON.stringify(meta) : ""
    }`;
    // eslint-disable-next-line no-console
    console.log(line);
    try {
      appendFileSync(config.log.file, line + "\n");
    } catch {
      // Logging to disk is best-effort - never crash the bot over it.
    }
  };

  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}
