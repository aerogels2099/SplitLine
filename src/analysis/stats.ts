export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function pick(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Percentile interpolated between neighbouring values; the input need not be sorted. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  return pick([...xs].sort((a, b) => a - b), p);
}

/** Several percentiles off a single sort. */
export function percentiles(xs: number[], ps: number[]): number[] {
  if (xs.length === 0) return ps.map(() => NaN);
  const sorted = [...xs].sort((a, b) => a - b);
  return ps.map((p) => pick(sorted, p));
}

export const median = (xs: number[]): number => percentile(xs, 50);

/** The share of the sample at or below the given value. */
export function percentileRank(xs: number[], x: number): number {
  if (xs.length === 0) return NaN;
  let below = 0;
  for (const v of xs) if (v <= x) below++;
  return below / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Abramowitz & Stegun 7.1.26 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-z * z));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export const ELO_DIVISOR = 400;

/** Expected score for a against b, where 0.5 is an even matchup. */
export function eloExpectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / ELO_DIVISOR));
}
