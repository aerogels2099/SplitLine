import type { MatchInfo } from "../shared/types.js";
import {
  H2H_SEASONS,
  predictMatchup,
  splitScenarioProbability,
  type HeadToHead,
  type MatchupSide,
  type ScenarioKey,
} from "./matchup.js";
import { extractRunSplits, milestoneForEvent, MILESTONES, RESET_EVENT } from "./splits.js";
import { eloExpectedScore } from "./stats.js";
import {
  buildWinProbModel,
  headToHeadWinProb,
  modelForElo,
  type BandedWinProbModel,
  type LiveRunState,
} from "./winprob.js";

export interface Prediction {
  p: number;
  outcome: number;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  observed: number;
}

export interface Scores {
  n: number;
  logLoss: number;
  brier: number;
  ece: number;
}

const EPS = 1e-12;

function binOf(p: number, bins: number): number {
  return Math.min(bins - 1, Math.floor(p * bins));
}

/** Side "a" is arbitrary, so a bin and its mirror are the same evidence. */
export function favouriteSide(pred: Prediction): Prediction {
  return pred.p >= 0.5 ? pred : { p: 1 - pred.p, outcome: 1 - pred.outcome };
}

export function reliability(preds: Prediction[], bins = 10): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, o: 0 }));
  for (const { p, outcome } of preds) {
    const bin = acc[binOf(p, bins)]!;
    bin.n++;
    bin.p += p;
    bin.o += outcome;
  }
  return acc.flatMap((b, i) =>
    b.n === 0
      ? []
      : [{ lo: i / bins, hi: (i + 1) / bins, n: b.n, predicted: b.p / b.n, observed: b.o / b.n }],
  );
}

export function logLoss(preds: Prediction[]): number {
  let total = 0;
  for (const { p, outcome } of preds) {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    total -= outcome * Math.log(q) + (1 - outcome) * Math.log(1 - q);
  }
  return total / preds.length;
}

export function score(preds: Prediction[], bins = 10): Scores {
  const n = preds.length;
  let brier = 0;
  for (const { p, outcome } of preds) brier += (p - outcome) ** 2;
  const ece = reliability(preds.map(favouriteSide), bins).reduce(
    (s, b) => s + (b.n / n) * Math.abs(b.observed - b.predicted),
    0,
  );
  return { n, logLoss: logLoss(preds), brier: brier / n, ece };
}

export function temporalCutoff(dates: number[], trainShare: number): number {
  const sorted = [...dates].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * trainShare))]!;
}

export interface RatedPair {
  a: { uuid: string; elo: number };
  b: { uuid: string; elo: number };
  outcome: number;
}

/** Ordered by uuid, so side "a" never depends on who won. */
export function ratedPair(m: MatchInfo): RatedPair | null {
  if (m.type !== 2 || m.decayed || m.changes.length !== 2) return null;
  const [x, y] = [...m.changes].sort((p, q) => (p.uuid < q.uuid ? -1 : 1));
  if (x!.eloRate === null || y!.eloRate === null) return null;
  const outcome = m.result.uuid === null ? 0.5 : m.result.uuid === x!.uuid ? 1 : 0;
  return { a: { uuid: x!.uuid, elo: x!.eloRate }, b: { uuid: y!.uuid, elo: y!.eloRate }, outcome };
}

export interface RatedGame {
  gap: number;
  outcome: number;
}

export function ratedGames(matches: MatchInfo[]): RatedGame[] {
  return matches.flatMap((m) => {
    const r = ratedPair(m);
    return r ? [{ gap: r.a.elo - r.b.elo, outcome: r.outcome }] : [];
  });
}

export function eloPredictions(games: RatedGame[], divisor: number): Prediction[] {
  return games.map((g) => ({ p: eloExpectedScore(g.gap, 0, divisor), outcome: g.outcome }));
}

export function fitEloDivisor(games: RatedGame[], candidates: number[]): number {
  let best = candidates[0]!;
  let bestLoss = Infinity;
  for (const d of candidates) {
    const loss = logLoss(eloPredictions(games, d));
    if (loss < bestLoss) {
      bestLoss = loss;
      best = d;
    }
  }
  return best;
}

export interface PregameLayers {
  elo: Prediction[];
  base: Prediction[];
}

/** Each result counts only after its own game is predicted; output is in play order. */
export function pregamePredictions(train: MatchInfo[], test: MatchInfo[]): PregameLayers {
  const byPairSeason = new Map<string, HeadToHead>();
  const record = (m: MatchInfo) => {
    if (m.type !== 2 || m.decayed || m.players.length !== 2) return;
    const [u, v] = m.players.map((p) => p.uuid).sort();
    const key = `${u}:${v}:${m.season}`;
    const h = byPairSeason.get(key) ?? { aWins: 0, bWins: 0, draws: 0 };
    if (m.result.uuid === null) h.draws++;
    else if (m.result.uuid === u) h.aWins++;
    else h.bWins++;
    byPairSeason.set(key, h);
  };
  const recent = (pair: string, season: number): HeadToHead => {
    const h = { aWins: 0, bWins: 0, draws: 0 };
    for (let s = season - H2H_SEASONS + 1; s <= season; s++) {
      const x = byPairSeason.get(`${pair}:${s}`);
      if (x) {
        h.aWins += x.aWins;
        h.bWins += x.bWins;
        h.draws += x.draws;
      }
    }
    return h;
  };
  for (const m of train) record(m);

  // No splits, so the pace model is never used.
  const blank = buildWinProbModel([]);
  const side = (uuid: string, elo: number): MatchupSide => ({
    uuid,
    nickname: uuid,
    elo,
    matches: [],
    model: blank,
    splits: [],
    band: "",
  });

  const out: PregameLayers = { elo: [], base: [] };
  for (const m of [...test].sort((x, y) => x.date - y.date || x.id - y.id)) {
    const r = ratedPair(m);
    if (r) {
      const pred = predictMatchup(
        side(r.a.uuid, r.a.elo),
        side(r.b.uuid, r.b.elo),
        recent(`${r.a.uuid}:${r.b.uuid}`, m.season),
      );
      out.elo.push({ p: pred.pElo, outcome: r.outcome });
      out.base.push({ p: pred.pBase, outcome: r.outcome });
    }
    record(m);
  }
  return out;
}

/** The state a live poll at `at` would have seen. */
export function replayState(detail: MatchInfo, uuid: string, at: number): LiveRunState {
  const seen = (detail.timelines ?? []).filter((t) => t.uuid === uuid && Number(t.time) <= at);
  const reset = seen
    .filter((t) => t.type === RESET_EVENT)
    .reduce((max, t) => Math.max(max, Number(t.time)), -1);
  let latest: { type: string; time: number } | null = null;
  for (const t of seen) {
    const time = Number(t.time);
    if (time <= reset || milestoneForEvent(t.type) === null) continue;
    if (latest === null || time >= latest.time) latest = { type: t.type, time };
  }
  return latest
    ? { lastEventType: latest.type, lastEventTime: latest.time }
    : { lastEventType: null, lastEventTime: null };
}

export interface InRunObservation {
  matchId: number;
  elapsedMs: number;
  model: Prediction;
  elo: Prediction;
}

export function inRunPredictions(
  banded: BandedWinProbModel,
  details: MatchInfo[],
  stepMs = 60_000,
): InRunObservation[] {
  const out: InRunObservation[] = [];
  for (const d of details) {
    const r = ratedPair(d);
    if (!r || !d.timelines?.length) continue;
    const modelA = modelForElo(banded, r.a.elo).model;
    const modelB = modelForElo(banded, r.b.elo).model;
    const elo = { p: eloExpectedScore(r.a.elo, r.b.elo), outcome: r.outcome };
    for (let t = stepMs; t < Number(d.result.time); t += stepMs) {
      const { pA } = headToHeadWinProb(
        { model: modelA, state: replayState(d, r.a.uuid, t), elo: r.a.elo },
        { model: modelB, state: replayState(d, r.b.uuid, t), elo: r.b.elo },
        t,
      );
      out.push({ matchId: d.id, elapsedMs: t, model: { p: pA, outcome: r.outcome }, elo });
    }
  }
  return out;
}

export interface MatchBin extends ReliabilityBin {
  matches: number;
}

/** Checkpoints within a match aren't independent, so bins also count matches. */
export function inRunReliability(
  obs: Pick<InRunObservation, "matchId" | "model">[],
  bins = 10,
): MatchBin[] {
  const ids = new Map<number, Set<number>>();
  const folded = obs.map((o) => {
    const f = favouriteSide(o.model);
    const b = binOf(f.p, bins);
    let set = ids.get(b);
    if (!set) ids.set(b, (set = new Set()));
    set.add(o.matchId);
    return f;
  });
  return reliability(folded, bins).map((r) => ({
    ...r,
    matches: ids.get(Math.round(r.lo * bins))!.size,
  }));
}

export interface ScenarioCase {
  key: ScenarioKey;
  a: MatchupSide;
  b: MatchupSide;
  timeMs: number;
  /** Elo alone: the weight on the split is what is being measured, not the head-to-head. */
  prior: number;
  outcome: number;
  matchId: number;
}

/** The opponent is unseen, as a split scenario poses it. */
export function scenarioCases(banded: BandedWinProbModel, details: MatchInfo[]): ScenarioCase[] {
  const out: ScenarioCase[] = [];
  for (const d of details) {
    const r = ratedPair(d);
    if (!r || !d.timelines?.length) continue;
    const side = (s: { uuid: string; elo: number }): MatchupSide => ({
      uuid: s.uuid,
      nickname: s.uuid,
      elo: s.elo,
      matches: [],
      model: modelForElo(banded, s.elo).model,
      splits: [],
      band: "",
    });
    for (const [x, y, outcome] of [
      [r.a, r.b, r.outcome],
      [r.b, r.a, 1 - r.outcome],
    ] as const) {
      const run = extractRunSplits(d, x.uuid);
      if (!run) continue;
      for (const m of MILESTONES) {
        if (m.event === null) continue;
        const t = run.splits[m.key];
        if (t === null) continue;
        out.push({
          key: m.key,
          a: side(x),
          b: side(y),
          timeMs: Number(t),
          prior: eloExpectedScore(x.elo, y.elo),
          outcome,
          matchId: d.id,
        });
      }
    }
  }
  return out;
}

export function scenarioPredictions(
  cases: ScenarioCase[],
  weights: Partial<Record<ScenarioKey, number>> = {},
): Prediction[] {
  return cases.map((c) => ({
    p: splitScenarioProbability(c.a, c.b, c.key, c.timeMs, c.prior, weights[c.key]),
    outcome: c.outcome,
  }));
}

export function fitScenarioWeights(
  cases: ScenarioCase[],
  candidates: number[],
): Partial<Record<ScenarioKey, number>> {
  const out: Partial<Record<ScenarioKey, number>> = {};
  for (const key of new Set(cases.map((c) => c.key))) {
    const mine = cases.filter((c) => c.key === key);
    let best = candidates[0]!;
    let bestLoss = Infinity;
    for (const w of candidates) {
      const loss = logLoss(scenarioPredictions(mine, { [key]: w }));
      if (loss < bestLoss) {
        bestLoss = loss;
        best = w;
      }
    }
    out[key] = best;
  }
  return out;
}
