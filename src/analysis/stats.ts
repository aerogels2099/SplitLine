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

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  return pick([...xs].sort((a, b) => a - b), p);
}

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

/** Fitted to ranked results; the textbook 400 makes rating gaps look too decisive. */
export const ELO_DIVISOR = 570;

/** Expected score for a against b, where 0.5 is an even matchup. */
export function eloExpectedScore(a: number, b: number, divisor = ELO_DIVISOR): number {
  return 1 / (1 + 10 ** ((b - a) / divisor));
}

export const P_FLOOR = 0.01;

export const clampProbability = (p: number) => Math.min(1 - P_FLOOR, Math.max(P_FLOOR, p));

export function logit(p: number): number {
  const q = clampProbability(p);
  return Math.log(q / (1 - q));
}

export const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export interface Observation {
  time: number;
  observed: boolean;
}

export interface SurvivalCurve {
  times: number[];
  survival: number[];
}

export function kaplanMeier(observations: Observation[]): SurvivalCurve {
  const sorted = [...observations].sort((a, b) => a.time - b.time);
  const times = [0];
  const survival = [1];
  let s = 1;
  let atRisk = sorted.length;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i]!.time;
    let events = 0;
    let censored = 0;
    while (i < sorted.length && sorted[i]!.time === t) {
      if (sorted[i]!.observed) events++;
      else censored++;
      i++;
    }
    if (events > 0) {
      s *= 1 - events / atRisk;
      times.push(t);
      survival.push(s);
    }
    atRisk -= events + censored;
  }
  return { times, survival };
}

/** Given `elapsed` survived: E[X] integrates S, E[X²] integrates 2u·S. Null once nothing survives. */
export function conditionalRemaining(
  curve: SurvivalCurve,
  elapsed: number,
): { mean: number; sd: number } | null {
  const { times, survival } = curve;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= elapsed) lo = mid;
    else hi = mid - 1;
  }
  const base = survival[lo]!;
  if (base <= 1e-9) return null;
  let m1 = 0;
  let m2 = 0;
  let from = elapsed;
  for (let k = lo; k + 1 < times.length; k++) {
    const to = times[k + 1]!;
    if (to <= from) continue;
    const s = survival[k]! / base;
    const a = from - elapsed;
    const b = to - elapsed;
    m1 += s * (b - a);
    m2 += s * (b * b - a * a);
    from = to;
  }
  return { mean: m1, sd: Math.sqrt(Math.max(m2 - m1 * m1, 0)) };
}
