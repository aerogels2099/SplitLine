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
