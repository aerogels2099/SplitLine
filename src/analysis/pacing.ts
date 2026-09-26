import { MILESTONES, SEGMENTS, type MilestoneKey, type RunSplits, type SegmentKey } from "./splits.js";
import { mean, median, percentile, percentileRank, percentiles } from "./stats.js";

export const ELO_BAND_SIZE = 300;

export function eloBand(elo: number | null): string {
  if (elo === null) return "placement";
  const lo = Math.floor(elo / ELO_BAND_SIZE) * ELO_BAND_SIZE;
  return `${lo}–${lo + ELO_BAND_SIZE - 1}`;
}

export interface SplitDistribution {
  key: MilestoneKey;
  label: string;
  count: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export function buildSplitDistributions(runs: RunSplits[]): SplitDistribution[] {
  return MILESTONES.map((m) => {
    const xs = runs
      .map((r) => r.splits[m.key])
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map(Number);
    const [p10, p25, p50, p75, p90] = percentiles(xs, [10, 25, 50, 75, 90]);
    return { key: m.key, label: m.label, count: xs.length, p10: p10!, p25: p25!, p50: p50!, p75: p75!, p90: p90! };
  }).filter((d) => d.count > 0);
}

export function buildBandedDistributions(runs: RunSplits[]): Record<string, SplitDistribution[]> {
  const byBand = new Map<string, RunSplits[]>();
  for (const r of runs) {
    const band = eloBand(r.eloAtMatch);
    const arr = byBand.get(band) ?? [];
    arr.push(r);
    byBand.set(band, arr);
  }
  const out: Record<string, SplitDistribution[]> = {};
  for (const [band, rs] of byBand) out[band] = buildSplitDistributions(rs);
  return out;
}

export interface SegmentComparison {
  key: SegmentKey;
  label: string;
  playerMedian: number | null;
  peerMedian: number | null;
  deltaMs: number | null;
  playerPercentile: number | null;
  playerSamples: number;
  peerSamples: number;
}

export interface PacingComparison {
  band: string;
  segments: SegmentComparison[];
  worstSegment: SegmentKey | null;
  milestoneMedians: { key: MilestoneKey; label: string; player: number | null; peer: number | null }[];
}

export function comparePacing(
  playerRuns: RunSplits[],
  peerRuns: RunSplits[],
  opts: { band?: string } = {},
): PacingComparison {
  const bandCounts = new Map<string, number>();
  for (const r of playerRuns) {
    const b = eloBand(r.eloAtMatch);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  }
  const band =
    opts.band ??
    [...bandCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "placement";

  // Peers are the band the player spent most games in, minus the player's own runs.
  const playerUuids = new Set(playerRuns.map((r) => r.uuid));
  const peers = peerRuns.filter(
    (r) => eloBand(r.eloAtMatch) === band && !playerUuids.has(r.uuid),
  );

  const segments: SegmentComparison[] = SEGMENTS.map((s) => {
    const mine = playerRuns
      .map((r) => r.segments[s.key])
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map(Number);
    const theirs = peers
      .map((r) => r.segments[s.key])
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map(Number);
    const playerMedian = mine.length > 0 ? median(mine) : null;
    const peerMedian = theirs.length > 0 ? median(theirs) : null;
    return {
      key: s.key,
      label: s.label,
      playerMedian,
      peerMedian,
      deltaMs: playerMedian !== null && peerMedian !== null ? playerMedian - peerMedian : null,
      playerPercentile:
        playerMedian !== null && theirs.length >= 5 ? percentileRank(theirs, playerMedian) : null,
      playerSamples: mine.length,
      peerSamples: theirs.length,
    };
  });

  let worst: SegmentComparison | null = null;
  for (const s of segments) {
    if (s.deltaMs === null || s.playerSamples < 3 || s.peerSamples < 5) continue;
    if (worst === null || s.deltaMs > (worst.deltaMs ?? -Infinity)) worst = s;
  }

  const milestoneMedians = MILESTONES.map((m) => {
    const mine = playerRuns
      .map((r) => r.splits[m.key])
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map(Number);
    const theirs = peers
      .map((r) => r.splits[m.key])
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map(Number);
    return {
      key: m.key,
      label: m.label,
      player: mine.length > 0 ? median(mine) : null,
      peer: theirs.length > 0 ? median(theirs) : null,
    };
  });

  return { band, segments, worstSegment: worst?.key ?? null, milestoneMedians };
}

export interface WinProbBin {
  tMax: number;
  winRate: number;
  n: number;
}

export function conditionalWinProbability(
  runs: RunSplits[],
  key: MilestoneKey,
  bins = 5,
): WinProbBin[] {
  const reached = runs
    .filter((r) => r.splits[key] !== null)
    .map((r) => ({ t: Number(r.splits[key]), score: r.won ? 1 : r.draw ? 0.5 : 0 }));
  if (reached.length < bins * 4) return [];
  const ts = reached.map((r) => r.t);
  // Quantile edges, so each bin holds about the same number of runs.
  const edges: number[] = [];
  for (let i = 1; i <= bins; i++) edges.push(percentile(ts, (100 * i) / bins));

  return edges.map((tMax, i) => {
    const lo = i === 0 ? -Infinity : edges[i - 1]!;
    const inBin = reached.filter((r) => r.t > lo && r.t <= tMax);
    return {
      tMax,
      winRate: inBin.length > 0 ? mean(inBin.map((r) => r.score)) : NaN,
      n: inBin.length,
    };
  });
}
