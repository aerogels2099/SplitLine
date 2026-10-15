import type { MatchInfo } from "../shared/types.js";
import {
  H2H_SEASONS,
  predictMatchup,
  splitScenarioProbability,
  type HeadToHead,
  type MatchupSide,
  type ScenarioKey,
} from "./matchup.js";
import { eloBand } from "./pacing.js";
import { extractRunSplits, MILESTONES, RESET_EVENT, SPLIT_EVENTS } from "./splits.js";
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
    if (time <= reset || !SPLIT_EVENTS.has(t.type)) continue;
    if (latest === null || time >= latest.time) latest = { type: t.type, time };
  }
  return latest
    ? { lastEventType: latest.type, lastEventTime: latest.time }
    : { lastEventType: null, lastEventTime: null };
}

export interface InRunObservation {
  matchId: number;
  band: string;
  elapsedMs: number;
  model: Prediction;
  elo: Prediction;
}

export function inRunPredictions(
  banded: BandedWinProbModel,
  details: MatchInfo[],
  stepMs = 60_000,
  capFor?: (band: string) => number,
): InRunObservation[] {
  const out: InRunObservation[] = [];
  for (const d of details) {
    const r = ratedPair(d);
    if (!r || !d.timelines?.length) continue;
    const modelA = modelForElo(banded, r.a.elo).model;
    const modelB = modelForElo(banded, r.b.elo).model;
    const elo = { p: eloExpectedScore(r.a.elo, r.b.elo), outcome: r.outcome };
    const band = pairBand(r.a.elo, r.b.elo);
    for (let t = stepMs; t < Number(d.result.time); t += stepMs) {
      const { pA } = headToHeadWinProb(
        { model: modelA, state: replayState(d, r.a.uuid, t), elo: r.a.elo },
        { model: modelB, state: replayState(d, r.b.uuid, t), elo: r.b.elo },
        t,
        capFor?.(band),
      );
      out.push({ matchId: d.id, band, elapsedMs: t, model: { p: pA, outcome: r.outcome }, elo });
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
  /** Elo alone, so the fit measures the split's weight, not the head-to-head. */
  prior: number;
  outcome: number;
  matchId: number;
  band: string;
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
          band: pairBand(x.elo, y.elo),
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

/** Matchmaking pairs similar ratings, so their mean places a game in one band. */
export function pairBand(eloA: number, eloB: number): string {
  return eloBand(Math.round((eloA + eloB) / 2));
}

export interface BandedCall extends Prediction {
  band: string;
  matchId: number;
}

export type TailVerdict = "insufficient" | "ok" | "uncertain" | "overconfident" | "underconfident";

export interface BandTail {
  band: string;
  matches: number;
  predicted: number;
  observed: number;
  /** 95% interval on observed less predicted, resampling whole matches. */
  low: number;
  high: number;
  verdict: TailVerdict;
}

/** Deterministic, so the same data always gets the same verdict. */
function seededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A band fails only when it is over 5 points off and its 95% interval excludes zero. */
export function tailsByBand(
  calls: BandedCall[],
  from = 0.8,
  minMatches = 30,
  resamples = 1000,
): BandTail[] {
  const bands = new Map<string, Map<number, { p: number; o: number; n: number }>>();
  for (const c of calls) {
    const f = favouriteSide(c);
    if (f.p < from) continue;
    const matches = bands.get(c.band) ?? new Map<number, { p: number; o: number; n: number }>();
    const m = matches.get(c.matchId) ?? { p: 0, o: 0, n: 0 };
    m.p += f.p;
    m.o += f.outcome;
    m.n++;
    matches.set(c.matchId, m);
    bands.set(c.band, matches);
  }
  const random = seededRandom(1);
  return [...bands]
    .map(([band, byMatch]): BandTail => {
      const ms = [...byMatch.values()];
      const sum = (xs: typeof ms) => xs.reduce((a, m) => ({ p: a.p + m.p, o: a.o + m.o, n: a.n + m.n }), { p: 0, o: 0, n: 0 });
      const all = sum(ms);
      const gaps: number[] = [];
      for (let r = 0; r < resamples; r++) {
        const pick = Array.from({ length: ms.length }, () => ms[Math.floor(random() * ms.length)]!);
        const s = sum(pick);
        gaps.push((s.o - s.p) / s.n);
      }
      gaps.sort((x, y) => x - y);
      const gap = (all.o - all.p) / all.n;
      const low = gaps[Math.floor(0.025 * (resamples - 1))]!;
      const high = gaps[Math.ceil(0.975 * (resamples - 1))]!;
      const verdict: TailVerdict =
        ms.length < minMatches
          ? "insufficient"
          : Math.abs(gap) <= 0.05
            ? "ok"
            : low <= 0 && high >= 0
              ? "uncertain"
              : gap < 0
                ? "overconfident"
                : "underconfident";
      return { band, matches: ms.length, predicted: all.p / all.n, observed: all.o / all.n, low, high, verdict };
    })
    .sort((x, y) => parseInt(x.band) - parseInt(y.band));
}

export function pullTowardGlobal(fitted: number, matches: number, global: number, pull: number): number {
  return (matches * fitted + pull * global) / (matches + pull);
}

export interface BandCap {
  band: string;
  /** Matches with a call at 80%+, the same count the tail gates use. */
  matches: number;
  fitted: number;
  cap: number;
}

export function fitBandCaps(
  banded: BandedWinProbModel,
  details: MatchInfo[],
  candidates: number[],
  global = 2.5,
  pull = 30,
): BandCap[] {
  const base = inRunPredictions(banded, details);
  const confident = new Map<string, Set<number>>();
  for (const o of base) {
    if (favouriteSide(o.model).p < 0.8) continue;
    const ids = confident.get(o.band) ?? new Set<number>();
    ids.add(o.matchId);
    confident.set(o.band, ids);
  }
  const scored = candidates.map((c) => ({ cap: c, obs: inRunPredictions(banded, details, 60_000, () => c) }));
  return [...new Set(base.map((o) => o.band))]
    .map((band) => {
      let fitted = global;
      let best = Infinity;
      for (const { cap, obs } of scored) {
        const loss = logLoss(obs.filter((o) => o.band === band).map((o) => o.model));
        if (loss < best) {
          best = loss;
          fitted = cap;
        }
      }
      const matches = confident.get(band)?.size ?? 0;
      return { band, matches, fitted, cap: pullTowardGlobal(fitted, matches, global, pull) };
    })
    .sort((x, y) => parseInt(x.band) - parseInt(y.band));
}
