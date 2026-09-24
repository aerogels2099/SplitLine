import type { SplitDistribution } from "./pacing.js";
import { prematchPanel, type ArchetypeStats, type PrematchPanel } from "./seeds.js";
import { MILESTONES, type MilestoneKey } from "./splits.js";
import { eloExpectedScore, logistic, logit } from "./stats.js";
import { headToHeadWinProb, type WinProbModel } from "./winprob.js";
import type { MatchInfo } from "../shared/types.js";

const H2H_PRIOR_GAMES = 10;
const SEED_PRIOR_GAMES = 8;
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

export interface SeedProbability {
  archetype: string;
  p: number;
  shift: number;
  a: ArchetypeStats | null;
  b: ArchetypeStats | null;
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
  bastion: SeedProbability[];
  overworld: SeedProbability[];
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

function seedDelta(s: ArchetypeStats | null, baseline: number): number {
  if (!s || s.games === 0) return 0;
  const score = s.wins + s.draws / 2;
  const shrunk = (score + SEED_PRIOR_GAMES * baseline) / (s.games + SEED_PRIOR_GAMES);
  return logit(shrunk) - logit(baseline);
}

function seedProbabilities(rows: PrematchPanel["bastion"], pBase: number): SeedProbability[] {
  const notNull = (s: ArchetypeStats | null): s is ArchetypeStats => s !== null;
  const baseA = baselineRate(rows.map((r) => r.a).filter(notNull));
  const baseB = baselineRate(rows.map((r) => r.b).filter(notNull));

  return rows
    .filter((r) => (r.a?.games ?? 0) >= MIN_SEED_GAMES || (r.b?.games ?? 0) >= MIN_SEED_GAMES)
    .map((r) => {
      const p = logistic(logit(pBase) + seedDelta(r.a, baseA) - seedDelta(r.b, baseB));
      return { archetype: r.archetype, p, shift: p - pBase, a: r.a, b: r.b };
    });
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
    bastion: seedProbabilities(panel.bastion, pBase),
    overworld: seedProbabilities(panel.overworld, pBase),
    splits: splitScenarios(a, b),
  };
}
