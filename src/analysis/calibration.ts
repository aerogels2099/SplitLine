import type { MatchInfo } from "../shared/types.js";
import { predictMatchup, type HeadToHead, type MatchupSide } from "./matchup.js";
import { bastionOf, overworldOf } from "./seeds.js";
import { milestoneForEvent, RESET_EVENT } from "./splits.js";
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

export function reliability(preds: Prediction[], bins = 10): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, o: 0 }));
  for (const { p, outcome } of preds) {
    const bin = acc[Math.min(bins - 1, Math.floor(p * bins))]!;
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
  const ece = reliability(preds, bins).reduce(
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

/** Sides are ordered by uuid so which player counts as "a" never depends on who won. */
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
  bastion: Prediction[];
  overworld: Prediction[];
  bastionRows: number;
  overworldRows: number;
}

/** Seed history and head-to-head come from the training games only, so no test result can leak in. */
export function pregamePredictions(train: MatchInfo[], test: MatchInfo[]): PregameLayers {
  const byPlayer = new Map<string, MatchInfo[]>();
  const byPair = new Map<string, HeadToHead>();
  for (const m of train) {
    if (m.type !== 2 || m.decayed || m.players.length !== 2) continue;
    for (const p of m.players) {
      const list = byPlayer.get(p.uuid);
      if (list) list.push(m);
      else byPlayer.set(p.uuid, [m]);
    }
    const [u, v] = m.players.map((p) => p.uuid).sort();
    const key = `${u}:${v}`;
    const h = byPair.get(key) ?? { aWins: 0, bWins: 0, draws: 0 };
    if (m.result.uuid === null) h.draws++;
    else if (m.result.uuid === u) h.aWins++;
    else h.bWins++;
    byPair.set(key, h);
  }

  const blank = buildWinProbModel([]);
  const side = (uuid: string, elo: number): MatchupSide => ({
    uuid,
    nickname: uuid,
    elo,
    matches: byPlayer.get(uuid) ?? [],
    model: blank,
    splits: [],
    band: "",
  });

  const out: PregameLayers = {
    elo: [],
    base: [],
    bastion: [],
    overworld: [],
    bastionRows: 0,
    overworldRows: 0,
  };
  for (const m of test) {
    const r = ratedPair(m);
    if (!r) continue;
    const pred = predictMatchup(
      side(r.a.uuid, r.a.elo),
      side(r.b.uuid, r.b.elo),
      byPair.get(`${r.a.uuid}:${r.b.uuid}`),
    );
    const bastion = pred.bastion.find((row) => row.archetype === bastionOf(m));
    const overworld = pred.overworld.find((row) => row.archetype === overworldOf(m));
    if (bastion) out.bastionRows++;
    if (overworld) out.overworldRows++;
    out.elo.push({ p: pred.pElo, outcome: r.outcome });
    out.base.push({ p: pred.pBase, outcome: r.outcome });
    out.bastion.push({ p: bastion?.p ?? pred.pBase, outcome: r.outcome });
    out.overworld.push({ p: overworld?.p ?? pred.pBase, outcome: r.outcome });
  }
  return out;
}

/** What a live poll at `at` would report: the latest mapped event since the last reset. */
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
