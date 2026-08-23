import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { loadConfig, type BotConfig } from "../src/config.js";
import { JupiterClient } from "../src/jupiter.js";
import { getConnection, getMintDecimals, SolPriceTracker } from "../src/chain.js";
import { fetchDexScreenerSnapshot } from "../src/dexscreener.js";

/**
 * Standalone market-analysis tool - answers the actual question before you
 * tune TARGET_GAIN_PERCENT / MIN_NET_PROFIT_PERCENT by guessing: "how much
 * does this token realistically move, and over what time?"
 *
 * Two layers of data:
 *   1. Instant: a DexScreener snapshot with price change over the last
 *      5m/1h/6h/24h - Jupiter has no history endpoint, so this is the only
 *      way to see the recent past without having already been polling.
 *   2. Live: polls the price at the bot's own PRICE_POLL_INTERVAL_MS for
 *      ANALYZE_DURATION_MINUTES (default 15, Ctrl+C to stop early and still
 *      see the report on whatever was collected), then reports how much the
 *      price actually moved over 5s/15s/30s/1min/5min windows and estimates
 *      how long a move of TARGET_GAIN_PERCENT realistically takes, given the
 *      volatility just measured.
 *
 * Run it with: npm run analyze
 *   ANALYZE_DURATION_MINUTES=60 npm run analyze   # longer live sample
 */

interface Sample {
  tMs: number;
  priceUsd: number;
}

const DURATION_MINUTES = Number(process.env.ANALYZE_DURATION_MINUTES ?? 15);

/**
 * Jupiter can't answer "what did the price do an hour ago" - this is the
 * only piece of this tool that looks at the actual past, via DexScreener's
 * free public API. Best-effort: DexScreener not having this pair indexed,
 * or being unreachable, should never block the live measurement below.
 */
async function printHistoricalSnapshot(config: BotConfig): Promise<void> {
  console.log(`Historia (DexScreener) dla ${config.token.symbol}:\n`);
  try {
    const snapshot = await fetchDexScreenerSnapshot(config.token.mint);
    if (!snapshot) {
      console.log("  brak danych - token jeszcze nie zaindeksowany na DexScreener.\n");
      return;
    }
    const c = snapshot.priceChangePercent;
    console.log(`  cena teraz:        ${snapshot.priceUsd !== undefined ? `$${snapshot.priceUsd}` : "-"}`);
    console.log(`  zmiana 5 min:      ${histPct(c.m5)}`);
    console.log(`  zmiana 1 godz.:    ${histPct(c.h1)}`);
    console.log(`  zmiana 6 godz.:    ${histPct(c.h6)}`);
    console.log(`  zmiana 24 godz.:   ${histPct(c.h24)}`);
    console.log(`  wolumen 24h:       ${snapshot.volumeUsd24h !== undefined ? `$${snapshot.volumeUsd24h.toLocaleString()}` : "-"}`);
    console.log(`  płynność puli:     ${snapshot.liquidityUsd !== undefined ? `$${snapshot.liquidityUsd.toLocaleString()}` : "-"} (${snapshot.dexId ?? "?"})`);
    console.log(
      "\n  To są RUCHY NETTO w te okna (np. +8% w 1h może kryć w sobie ruch\n" +
        "  +15% i potem -6%) - dobre do wyczucia trendu, ale nie zastępuje\n" +
        "  pomiaru poniżej, który mierzy faktyczne wahania krok po kroku.\n",
    );
  } catch (err) {
    console.log(`  nie udało się pobrać (pomijam, to tylko dodatkowy kontekst): ${String(err)}\n`);
  }
}

function histPct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

async function main() {
  console.log("Start...\n");
  const config = loadConfig();
  const client = new JupiterClient(config);
  const connection = getConnection(config);
  const solPrice = new SolPriceTracker(client, config);
  const tokenMint = new PublicKey(config.token.mint);
  const solDecimals = 9;

  // DexScreener first - it doesn't need our RPC at all, so it's the
  // fastest way to see *something* on screen and confirm the process is
  // actually alive, before we make any Solana RPC calls.
  await printHistoricalSnapshot(config);

  console.log(`Łączę z RPC (${config.rpc.url}) i pobieram dane tokena...`);
  const tokenDecimals = await withTimeout(
    getMintDecimals(connection, tokenMint),
    15_000,
    "RPC nie odpowiedziało w 15s - sprawdź RPC_URL w .env, albo spróbuj innego publicznego RPC.",
  );
  console.log("Połączono.\n");

  const samples: Sample[] = [];
  const endAtMs = Date.now() + DURATION_MINUTES * 60_000;

  console.log(
    `Zbieram cenę ${config.token.symbol} NA ŻYWO przez ${DURATION_MINUTES} min, co ${config.pricePollIntervalMs}ms.\n` +
      `Skończy się samo po tym czasie - albo wciśnij Ctrl+C w dowolnym momencie, żeby przerwać\n` +
      `wcześniej i i tak zobaczyć raport z tego, co zdążyło się zebrać.\n`,
  );

  process.on("SIGINT", () => {
    console.log("\n\nPrzerwano - analiza tego, co udało się zebrać.\n");
    report(samples, config);
    process.exit(0);
  });

  while (Date.now() < endAtMs) {
    try {
      const solUsd = await withTimeout(solPrice.getPrice(), 15_000, "Jupiter (SOL/USD) nie odpowiedziało w 15s");
      const amountLamports = Math.round(config.priceReferenceSolAmount * 10 ** solDecimals);
      const quote = await withTimeout(
        client.getQuote({
          inputMint: config.token.solMint,
          outputMint: config.token.mint,
          amount: String(amountLamports),
          slippageBps: config.execution.maxSlippageBps,
        }),
        15_000,
        "Jupiter (quote) nie odpowiedziało w 15s",
      );
      const tokenOut = Number(quote.outAmount) / 10 ** tokenDecimals;
      const priceUsd = (config.priceReferenceSolAmount / tokenOut) * solUsd;
      samples.push({ tMs: Date.now(), priceUsd });
      process.stdout.write(`\r${samples.length} próbek | ostatnia cena: $${priceUsd.toFixed(8)}   `);
    } catch (err) {
      process.stdout.write(`\nblad przy pobieraniu ceny: ${String(err)}\n`);
    }
    await sleep(config.pricePollIntervalMs);
  }

  console.log("\n\nZbieranie zakończone.\n");
  report(samples, config);
}

interface WindowStat {
  label: string;
  count: number;
  meanAbsPercent: number;
  medianAbsPercent: number;
  maxUpPercent: number;
  maxDownPercent: number;
}

/** For each sample, compares it to the nearest earlier sample at least
 *  `windowMs` back, and collects the % change over that gap. */
export function windowStats(samples: Sample[], windowMs: number, label: string): WindowStat {
  const changes: number[] = [];
  let maxUp = 0;
  let maxDown = 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    if (!cur) continue;
    while (j < i) {
      const candidate = samples[j];
      if (!candidate || cur.tMs - candidate.tMs <= windowMs) break;
      j++;
    }
    const earliest = samples[j];
    if (!earliest) continue;
    const gapMs = cur.tMs - earliest.tMs;
    if (gapMs < windowMs * 0.5) continue; // not enough lookback yet for this window
    const change = ((cur.priceUsd - earliest.priceUsd) / earliest.priceUsd) * 100;
    changes.push(change);
    if (change > maxUp) maxUp = change;
    if (change < maxDown) maxDown = change;
  }
  const abs = changes.map(Math.abs).sort((a, b) => a - b);
  const mean = abs.length ? abs.reduce((sum, v) => sum + v, 0) / abs.length : 0;
  const median = abs.length ? (abs[Math.floor(abs.length / 2)] ?? 0) : 0;
  return { label, count: changes.length, meanAbsPercent: mean, medianAbsPercent: median, maxUpPercent: maxUp, maxDownPercent: maxDown };
}

/** Per-sqrt-second volatility from log returns - the standard random-walk estimator. */
export function volatilityPerSqrtSecond(samples: Sample[]): number {
  const normalized: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur) continue;
    const dtSec = (cur.tMs - prev.tMs) / 1000;
    if (dtSec <= 0) continue;
    normalized.push(Math.log(cur.priceUsd / prev.priceUsd) / Math.sqrt(dtSec));
  }
  return stdev(normalized);
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function report(samples: Sample[], config: BotConfig): void {
  if (samples.length < 5) {
    console.log("Za mało próbek do sensownej analizy - zbierz dane dłużej (ANALYZE_DURATION_MINUTES).");
    return;
  }

  const windows = [
    { label: "5s", ms: 5_000 },
    { label: "15s", ms: 15_000 },
    { label: "30s", ms: 30_000 },
    { label: "1min", ms: 60_000 },
    { label: "5min", ms: 300_000 },
  ];

  console.log("Ile realnie porusza się cena, w zależności od okna czasu:\n");
  console.log("okno   | próbek | śr. ruch | mediana | max w górę | max w dół");
  for (const w of windows) {
    const stat = windowStats(samples, w.ms, w.label);
    console.log(
      `${w.label.padEnd(6)} | ${String(stat.count).padStart(6)} | ${pctStr(stat.meanAbsPercent).padStart(8)} | ${pctStr(stat.medianAbsPercent).padStart(7)} | ${("+" + stat.maxUpPercent.toFixed(2) + "%").padStart(10)} | ${(stat.maxDownPercent.toFixed(2) + "%").padStart(9)}`,
    );
  }

  const sigma = volatilityPerSqrtSecond(samples);
  console.log(`\nZmierzona zmienność: ~${(sigma * 100).toFixed(3)}% na sqrt(sekunda) (random-walk model)`);

  const target = config.strategy.targetGainPercent;
  if (sigma > 0) {
    const expectedSeconds = (target / 100 / sigma) ** 2;
    console.log(
      `Przy tej zmienności: oczekiwany czas do ruchu +${target}% (Twój TARGET_GAIN_PERCENT) ` +
        `to ok. ${formatDuration(expectedSeconds)} (typowy random-walk czas oczekiwania).`,
    );
    console.log("\nOrientacyjnie dla innych progów:");
    for (const pct of [2, 3, 4, 6, 8, 10]) {
      const seconds = (pct / 100 / sigma) ** 2;
      console.log(`  +${pct}%  -> ~${formatDuration(seconds)}`);
    }
  }

  console.log(
    `\nBieżąca konfiguracja: TARGET_GAIN_PERCENT=${target}%, ` +
      `MIN_NET_PROFIT_PERCENT=${config.strategy.minNetProfitPercent}%, ` +
      `MAX_ROUND_TRIP_COST_PERCENT=${config.strategy.maxRoundTripCostPercent}%, ` +
      `MAX_SPREAD_BPS=${(config.strategy.maxSpreadPercent * 100).toFixed(0)}`,
  );
  console.log(
    "\nUwaga: to jest model losowego błądzenia (random walk) na podstawie zmierzonej zmienności -\n" +
      "realny ruch memecoina bywa bardziej \"skokowy\" (nagłe wybicia, potem cisza) niż zakłada ten\n" +
      "model, więc traktuj powyższe czasy jako rząd wielkości, nie gwarancję.",
  );
}

function pctStr(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)} dni`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A hung RPC call should fail loudly with a clear message, not sit silently forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

// Only run when executed directly ("npm run analyze") - not when the pure
// helpers above are imported for unit testing.
// Compare resolved OS paths, not raw URL strings - on Windows
// import.meta.url is "file:///C:/..." (forward slashes, %-encoded) while
// process.argv[1] is "C:\..." (backslashes), so a naive string comparison
// never matches there and main() silently never ran.
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error("fatal error:", err);
    process.exit(1);
  });
}
