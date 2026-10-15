import type { LiveMatch } from "../shared/types.js";
import { eloBand } from "./pacing.js";
import { MILESTONES, milestoneForEvent, type MilestoneKey, type RunSplits } from "./splits.js";
import {
  conditionalRemaining,
  eloExpectedScore,
  kaplanMeier,
  logistic,
  logit,
  normalCdf,
  type Observation,
  type SurvivalCurve,
} from "./stats.js";

export interface MilestoneModel {
  n: number;
  meanRemaining: number;
  sdRemaining: number;
  curve?: SurvivalCurve;
}

export interface WinProbModel {
  milestones: Partial<Record<MilestoneKey, MilestoneModel>>;
  events: Record<string, MilestoneModel>;
  overall: { n: number; meanFinal: number; sdFinal: number; curve?: SurvivalCurve };
}

const MIN_SAMPLES = 8;

const SD_FLOOR_MS = 30_000;

/** Fitted on held-out checkpoints: timing evidence beyond this many log-odds was not borne out. */
const EVIDENCE_CAP = 2.5;

function isFinished(r: RunSplits): boolean {
  return r.finished && r.splits.finish !== null;
}

/** Every finished run is a win, so unfinished ones are censored at the match's end rather than dropped. */
function remainingModel(
  runs: RunSplits[],
  startOf: (r: RunSplits) => number | null,
): MilestoneModel | null {
  const observations: Observation[] = [];
  let n = 0;
  for (const r of runs) {
    const start = startOf(r);
    if (start === null) continue;
    if (isFinished(r)) {
      observations.push({ time: Number(r.splits.finish) - start, observed: true });
      n++;
    } else {
      observations.push({ time: Math.max(Number(r.matchTime) - start, 0), observed: false });
    }
  }
  if (n < MIN_SAMPLES) return null;
  const curve = kaplanMeier(observations);
  const m = conditionalRemaining(curve, 0)!;
  return { n, meanRemaining: m.mean, sdRemaining: Math.max(m.sd, SD_FLOOR_MS), curve };
}

export function buildWinProbModel(runs: RunSplits[]): WinProbModel {
  const milestones: Partial<Record<MilestoneKey, MilestoneModel>> = {};
  for (const m of MILESTONES) {
    if (m.key === "finish") continue;
    const model = remainingModel(runs, (r) => (r.splits[m.key] !== null ? Number(r.splits[m.key]) : null));
    if (model) milestones[m.key] = model;
  }

  // Alias events, like crying obsidian for bastion, get timings of their own.
  const types = new Set<string>();
  for (const r of runs) for (const t of Object.keys(r.eventTimes)) types.add(t);
  const events: Record<string, MilestoneModel> = {};
  for (const type of types) {
    const model = remainingModel(runs, (r) =>
      r.eventTimes[type] !== undefined ? Number(r.eventTimes[type]) : null,
    );
    if (model) events[type] = model;
  }

  const finals = runs.filter(isFinished).length;
  if (finals === 0) {
    return { milestones, events, overall: { n: 0, meanFinal: 12 * 60_000, sdFinal: 150_000 } };
  }
  const curve = kaplanMeier(
    runs.map((r) =>
      isFinished(r)
        ? { time: Number(r.splits.finish), observed: true }
        : { time: Number(r.matchTime), observed: false },
    ),
  );
  const m = conditionalRemaining(curve, 0)!;
  return {
    milestones,
    events,
    overall: {
      n: finals,
      meanFinal: m.mean,
      sdFinal: finals >= 2 ? Math.max(m.sd, 60_000) : 150_000,
      curve,
    },
  };
}

export interface BandedWinProbModel {
  bands: Record<string, WinProbModel>;
  global: WinProbModel;
}

export function buildBandedWinProbModels(runs: RunSplits[]): BandedWinProbModel {
  const byBand = new Map<string, RunSplits[]>();
  for (const r of runs) {
    const band = eloBand(r.eloAtMatch);
    const list = byBand.get(band);
    if (list) list.push(r);
    else byBand.set(band, [r]);
  }

  const bands: Record<string, WinProbModel> = {};
  for (const [band, list] of byBand) bands[band] = buildWinProbModel(list);
  return { bands, global: buildWinProbModel(runs) };
}

export interface ModelLookup {
  model: WinProbModel;
  band: string;
  fellBack: boolean;
}

function bandFloor(band: string): number | null {
  const lo = Number(band.split("–")[0]);
  return Number.isFinite(lo) ? lo : null;
}

export function modelForElo(banded: BandedWinProbModel, elo: number | null): ModelLookup {
  const band = eloBand(elo);
  const hit = banded.bands[band];
  if (hit) return { model: hit, band, fellBack: false };

  const floor = bandFloor(band);
  if (floor !== null) {
    let best: { band: string; model: WinProbModel; distance: number } | null = null;
    for (const [other, model] of Object.entries(banded.bands)) {
      const otherFloor = bandFloor(other);
      if (otherFloor === null) continue;
      const distance = Math.abs(otherFloor - floor);
      if (best === null || distance < best.distance) best = { band: other, model, distance };
    }
    if (best !== null) return { model: best.model, band: best.band, fellBack: true };
  }

  return { model: banded.global, band: "all", fellBack: true };
}

export interface LiveRunState {
  lastEventType: string | null;
  lastEventTime: number | null;
}

export interface FinishProjection {
  meanMs: number;
  sdMs: number;
  milestone: MilestoneKey | null;
}

function fromCurve(curve: SurvivalCurve, elapsedMs: number, stuckMs: number): [number, number] {
  const c = conditionalRemaining(curve, stuckMs);
  // Stuck past every recorded run, so at least the whole stage is taken to be still ahead.
  const r = c && stuckMs < curve.times.at(-1)! ? c : conditionalRemaining(curve, 0)!;
  return [elapsedMs + r.mean, Math.max(r.sd, SD_FLOOR_MS)];
}

/** Conditioned on the time since the last event, or since the start when there is none. */
export function projectFinish(
  model: WinProbModel,
  state: LiveRunState,
  elapsedMs: number,
): FinishProjection {
  const milestone = state.lastEventType ? milestoneForEvent(state.lastEventType) : null;
  const stats =
    (state.lastEventType ? model.events[state.lastEventType] : undefined) ??
    (milestone ? model.milestones[milestone] : undefined);
  let meanMs: number;
  let sdMs: number;
  if (stats && state.lastEventTime !== null) {
    if (stats.curve) {
      [meanMs, sdMs] = fromCurve(stats.curve, elapsedMs, Math.max(elapsedMs - state.lastEventTime, 0));
    } else {
      meanMs = state.lastEventTime + stats.meanRemaining;
      sdMs = stats.sdRemaining;
    }
  } else if (milestone === "finish") {
    // No timing from this kill in the band, so completion is taken as seconds away, not certain.
    meanMs = elapsedMs;
    sdMs = SD_FLOOR_MS;
  } else if (model.overall.curve) {
    [meanMs, sdMs] = fromCurve(model.overall.curve, elapsedMs, elapsedMs);
  } else {
    meanMs = model.overall.meanFinal;
    sdMs = model.overall.sdFinal;
  }
  if (meanMs <= elapsedMs) {
    meanMs = elapsedMs + Math.max(0.15 * sdMs, 20_000);
  }
  return { meanMs, sdMs, milestone };
}

export interface RunSide {
  model: WinProbModel;
  state: LiveRunState;
  elo: number | null;
}

/** Positive when a is projected to finish first, in spreads. */
export function paceGap(
  a: RunSide,
  b: RunSide,
  elapsedMs: number,
): { z: number; projA: FinishProjection; projB: FinishProjection } {
  const projA = projectFinish(a.model, a.state, elapsedMs);
  const projB = projectFinish(b.model, b.state, elapsedMs);
  // Pace is judged against each runner's own band, so the rating is not counted twice.
  const paceA = projA.meanMs - a.model.overall.meanFinal;
  const paceB = projB.meanMs - b.model.overall.meanFinal;
  return { z: (paceB - paceA) / Math.sqrt(projA.sdMs ** 2 + projB.sdMs ** 2), projA, projB };
}

export function timingEvidence(z: number, cap = EVIDENCE_CAP): number {
  return Math.min(cap, Math.max(-cap, logit(normalCdf(z))));
}

export function headToHeadWinProb(
  a: RunSide,
  b: RunSide,
  elapsedMs: number,
  cap = EVIDENCE_CAP,
): { pA: number; projA: FinishProjection; projB: FinishProjection } {
  const { z, projA, projB } = paceGap(a, b, elapsedMs);

  // Only one dragon down: its killer completes first in 96-100% of held-out checkpoints.
  if (projA.milestone === "finish" && projB.milestone !== "finish") {
    return { pA: 0.99, projA, projB };
  }
  if (projB.milestone === "finish" && projA.milestone !== "finish") {
    return { pA: 0.01, projA, projB };
  }

  const pElo = a.elo !== null && b.elo !== null ? eloExpectedScore(a.elo, b.elo) : 0.5;
  const pA = logistic(logit(pElo) + timingEvidence(z, cap));
  return { pA: Math.min(0.99, Math.max(0.01, pA)), projA, projB };
}

export interface LiveRunner {
  uuid: string;
  nickname: string;
  elo: number | null;
  liveUrl: string | null;
  lastEventType: string | null;
  lastEventTimeMs: number | null;
  milestone: MilestoneKey | null;
  projectedFinishMs: number;
  winProb: number;
}

export interface LiveScore {
  currentTimeMs: number;
  players: [LiveRunner, LiveRunner];
}

export function scoreLiveMatch(banded: BandedWinProbModel, match: LiveMatch): LiveScore | null {
  if (match.players.length !== 2) return null;
  const elapsed = Number(match.currentTime);
  const [a, b] = match.players.map((p) => {
    const snap = match.data[p.uuid];
    return {
      profile: p,
      liveUrl: snap?.liveUrl ?? null,
      side: {
        model: modelForElo(banded, p.eloRate).model,
        state: {
          lastEventType: snap?.timeline?.type ?? null,
          lastEventTime: snap?.timeline ? Number(snap.timeline.time) : null,
        },
        // The current rating, which mid-match is still the pre-match one (gotcha 10).
        elo: p.eloRate,
      } satisfies RunSide,
    };
  }) as [Runner, Runner];
  const { pA, projA, projB } = headToHeadWinProb(a.side, b.side, elapsed);
  return { currentTimeMs: elapsed, players: [liveRunner(a, projA, pA), liveRunner(b, projB, 1 - pA)] };
}

interface Runner {
  profile: LiveMatch["players"][number];
  liveUrl: string | null;
  side: RunSide;
}

function liveRunner(r: Runner, proj: FinishProjection, winProb: number): LiveRunner {
  return {
    uuid: r.profile.uuid,
    nickname: r.profile.nickname,
    elo: r.profile.eloRate,
    liveUrl: r.liveUrl,
    lastEventType: r.side.state.lastEventType,
    lastEventTimeMs: r.side.state.lastEventTime,
    milestone: proj.milestone,
    projectedFinishMs: Math.round(proj.meanMs),
    winProb,
  };
}
