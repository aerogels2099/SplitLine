import type { SplitDistribution } from "./pacing.js";
import { prematchPanel, type ArchetypeStats, type PrematchPanel } from "./seeds.js";
import { MILESTONES, type MilestoneKey } from "./splits.js";
import { eloExpectedScore } from "./stats.js";
import { headToHeadWinProb, type WinProbModel } from "./winprob.js";
import type { MatchInfo } from "../shared/types.js";

const H2H_PRIOR_GAMES = 10;
const MIN_SEED_GAMES = 3;
const MIN_SPLIT_SAMPLES = 8;

export interface MatchupSide {
  uuid: string;
  nickname: string;
  elo: number | null;
  matches: MatchInfo[];
  model: WinProbModel;
  splits: SplitDistribution[];
  band: string;
}

export interface HeadToHead {
  aWins: number;
  bWins: number;
  draws: number;
}

export interface SeedRecordSide {
  stats: ArchetypeStats;
  /** Measured against the player's own rate across archetypes, so their usual opposition mostly cancels out. */
  relative: number;
}

/** History only: held-out games showed per-archetype records add nothing to the prediction. */
export interface SeedRecord {
  archetype: string;
  a: SeedRecordSide | null;
  b: SeedRecordSide | null;
}

export interface SplitScenario {
  key: MilestoneKey;
  label: string;
  count: number;
  points: { percentile: number; timeMs: number; p: number }[];
}

export interface MatchupProfile {
  uuid: string;
  nickname: string;
  elo: number | null;
  band: string;
  modelRuns: number;
}

export interface MatchupPrediction {
  a: MatchupProfile;
  b: MatchupProfile;
  pElo: number;
  pBase: number;
  h2h: { aWins: number; bWins: number; draws: number; games: number };
  bastion: SeedRecord[];
  overworld: SeedRecord[];
  splits: SplitScenario[];
}

function baselineRate(stats: ArchetypeStats[]): number {
  let games = 0;
  let score = 0;
  for (const s of stats) {
    games += s.games;
    score += s.wins + s.draws / 2;
  }
  return games > 0 ? score / games : 0.5;
}

function seedRecords(rows: PrematchPanel["bastion"]): SeedRecord[] {
  const notNull = (s: ArchetypeStats | null): s is ArchetypeStats => s !== null;
  const baseA = baselineRate(rows.map((r) => r.a).filter(notNull));
  const baseB = baselineRate(rows.map((r) => r.b).filter(notNull));
  const side = (s: ArchetypeStats | null, base: number): SeedRecordSide | null =>
    s ? { stats: s, relative: s.winRate - base } : null;

  return rows
    .filter((r) => (r.a?.games ?? 0) >= MIN_SEED_GAMES || (r.b?.games ?? 0) >= MIN_SEED_GAMES)
    .map((r) => ({ archetype: r.archetype, a: side(r.a, baseA), b: side(r.b, baseB) }));
}

function splitScenarios(a: MatchupSide, b: MatchupSide): SplitScenario[] {
  const out: SplitScenario[] = [];
  for (const m of MILESTONES) {
    if (m.event === null) continue;
    const dist = a.splits.find((d) => d.key === m.key);
    if (!dist || dist.count < MIN_SPLIT_SAMPLES) continue;

    const sweep: [number, number][] = [
      [10, dist.p10],
      [25, dist.p25],
      [50, dist.p50],
      [75, dist.p75],
      [90, dist.p90],
    ];
    out.push({
      key: m.key,
      label: m.label,
      count: dist.count,
      points: sweep.map(([percentile, timeMs]) => ({
        percentile,
        timeMs,
        // The opponent's progress is unknown, so only their clock is modelled.
        p: headToHeadWinProb(
          { model: a.model, state: { lastEventType: m.event, lastEventTime: timeMs }, elo: a.elo },
          { model: b.model, state: { lastEventType: null, lastEventTime: null }, elo: b.elo },
          timeMs,
        ).pA,
      })),
    });
  }
  return out;
}

export function predictMatchup(
  a: MatchupSide,
  b: MatchupSide,
  h2h: HeadToHead = { aWins: 0, bWins: 0, draws: 0 },
): MatchupPrediction {
  const pElo = a.elo !== null && b.elo !== null ? eloExpectedScore(a.elo, b.elo) : 0.5;
  const games = h2h.aWins + h2h.bWins + h2h.draws;
  const score = h2h.aWins + h2h.draws / 2;
  // The elo prior stands in for H2H_PRIOR_GAMES games, so a short record moves it only a little.
  const pBase = (score + H2H_PRIOR_GAMES * pElo) / (games + H2H_PRIOR_GAMES);

  const panel = prematchPanel(a.matches, a.uuid, b.matches, b.uuid);
  const profile = (s: MatchupSide): MatchupProfile => ({
    uuid: s.uuid,
    nickname: s.nickname,
    elo: s.elo,
    band: s.band,
    modelRuns: s.model.overall.n,
  });

  return {
    a: profile(a),
    b: profile(b),
    pElo,
    pBase,
    h2h: { aWins: h2h.aWins, bWins: h2h.bWins, draws: h2h.draws, games },
    bastion: seedRecords(panel.bastion),
    overworld: seedRecords(panel.overworld),
    splits: splitScenarios(a, b),
  };
}
