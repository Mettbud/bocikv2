/**
 * Shared, pure volatility math - used both by `npm run analyze` (a
 * standalone snapshot) and by the live bot's adaptive target (see
 * `computeAdaptiveTargetPercent` and index.ts's rolling price history).
 * No I/O here on purpose, so all of it is unit-testable without a network.
 */

export interface PriceSample {
  tMs: number;
  priceUsd: number;
}

export interface WindowStat {
  count: number;
  meanAbsPercent: number;
  medianAbsPercent: number;
  maxUpPercent: number;
  maxDownPercent: number;
}

/** For each sample, compares it to the nearest earlier sample at least
 *  `windowMs` back, and collects the % change over that gap. */
export function windowStats(samples: PriceSample[], windowMs: number): WindowStat {
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
  return { count: changes.length, meanAbsPercent: mean, medianAbsPercent: median, maxUpPercent: maxUp, maxDownPercent: maxDown };
}

/** Per-sqrt-second volatility from log returns - the standard random-walk estimator. */
export function volatilityPerSqrtSecond(samples: PriceSample[]): number {
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

/**
 * The adaptive sell target: a multiple of how much the token has typically
 * moved (median absolute %) over the lookback window, clamped to a sane
 * floor/ceiling. A quiet token gets a smaller, faster-to-hit target; a wild
 * one gets a bigger target instead of selling into normal noise.
 */
export function computeAdaptiveTargetPercent(
  typicalMovePercent: number,
  multiplier: number,
  minPercent: number,
  maxPercent: number,
): number {
  const raw = typicalMovePercent * multiplier;
  return Math.min(maxPercent, Math.max(minPercent, raw));
}

/** Linear 2-5 minute style cooldown: quiet market -> min, configured
 * full-volatility point (or above) -> max. */
export function computeAdaptiveCooldownMs(
  typicalMovePercent: number,
  minMs: number,
  maxMs: number,
  fullAtVolatilityPercent: number,
): number {
  const ratio = Math.min(1, Math.max(0, typicalMovePercent / fullAtVolatilityPercent));
  return Math.round(minMs + (maxMs - minMs) * ratio);
}

/** Drops samples older than `maxAgeMs` from the front of a time-ordered buffer. */
export function trimOldSamples(samples: PriceSample[], nowMs: number, maxAgeMs: number): PriceSample[] {
  const cutoff = nowMs - maxAgeMs;
  const firstFresh = samples.findIndex((s) => s.tMs >= cutoff);
  if (firstFresh <= 0) return samples;
  return samples.slice(firstFresh);
}
