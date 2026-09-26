import type { LiveMatch } from "../shared/types.js";
import { eloBand } from "./pacing.js";
import { MILESTONES, milestoneForEvent, type MilestoneKey, type RunSplits } from "./splits.js";
import { eloExpectedScore, logistic, logit, mean, normalCdf, stddev } from "./stats.js";

export interface MilestoneModel {
  n: number;
  meanRemaining: number;
  sdRemaining: number;
}

export interface WinProbModel {
  milestones: Partial<Record<MilestoneKey, MilestoneModel>>;
  events: Record<string, MilestoneModel>;
  overall: { n: number; meanFinal: number; sdFinal: number };
}

const MIN_SAMPLES = 8;

export function buildWinProbModel(runs: RunSplits[]): WinProbModel {
  const finished = runs.filter((r) => r.finished && r.splits.finish !== null);

  const milestones: Partial<Record<MilestoneKey, MilestoneModel>> = {};
  for (const m of MILESTONES) {
    if (m.key === "finish") continue;
    const remaining = finished
      .filter((r) => r.splits[m.key] !== null)
      .map((r) => Number(r.splits.finish) - Number(r.splits[m.key]));
    if (remaining.length >= MIN_SAMPLES) {
      milestones[m.key] = {
        n: remaining.length,
        meanRemaining: mean(remaining),
        sdRemaining: Math.max(stddev(remaining), 30_000),
      };
    }
  }

  const events: Record<string, MilestoneModel> = {};
  const seen = new Set<string>();
  for (const r of finished) for (const t of Object.keys(r.eventTimes)) seen.add(t);
  for (const type of seen) {
    const remaining = finished
      .filter((r) => r.eventTimes[type] !== undefined)
      .map((r) => Number(r.splits.finish) - Number(r.eventTimes[type]));
    if (remaining.length >= MIN_SAMPLES) {
      events[type] = {
        n: remaining.length,
        meanRemaining: mean(remaining),
        sdRemaining: Math.max(stddev(remaining), 30_000),
      };
    }
  }

  const finals = finished.map((r) => Number(r.splits.finish));
  return {
    milestones,
    events,
    overall: {
      n: finals.length,
      meanFinal: finals.length > 0 ? mean(finals) : 12 * 60_000,
      sdFinal: finals.length >= 2 ? Math.max(stddev(finals), 60_000) : 150_000,
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

export function projectFinish(
  model: WinProbModel,
  state: LiveRunState,
  elapsedMs: number,
): FinishProjection {
  const milestone = state.lastEventType ? milestoneForEvent(state.lastEventType) : null;
  if (milestone === "finish") {
    return { meanMs: state.lastEventTime ?? elapsedMs, sdMs: 1, milestone };
  }
  const stats =
    (state.lastEventType ? model.events[state.lastEventType] : undefined) ??
    (milestone ? model.milestones[milestone] : undefined);
  let meanMs: number;
  let sdMs: number;
  if (stats && state.lastEventTime !== null) {
    meanMs = state.lastEventTime + stats.meanRemaining;
    sdMs = stats.sdRemaining;
  } else {
    meanMs = model.overall.meanFinal;
    sdMs = model.overall.sdFinal;
  }
  if (meanMs < elapsedMs) {
    meanMs = elapsedMs + Math.max(0.15 * sdMs, 20_000);
  }
  return { meanMs, sdMs, milestone };
}

export interface RunSide {
  model: WinProbModel;
  state: LiveRunState;
  elo: number | null;
}

export function headToHeadWinProb(
  a: RunSide,
  b: RunSide,
  elapsedMs: number,
): { pA: number; projA: FinishProjection; projB: FinishProjection } {
  const projA = projectFinish(a.model, a.state, elapsedMs);
  const projB = projectFinish(b.model, b.state, elapsedMs);

  if (projA.milestone === "finish" && projB.milestone !== "finish") {
    return { pA: 0.99, projA, projB };
  }
  if (projB.milestone === "finish" && projA.milestone !== "finish") {
    return { pA: 0.01, projA, projB };
  }

  const pElo = a.elo !== null && b.elo !== null ? eloExpectedScore(a.elo, b.elo) : 0.5;

  const paceA = projA.meanMs - a.model.overall.meanFinal;
  const paceB = projB.meanMs - b.model.overall.meanFinal;
  const z = (paceB - paceA) / Math.sqrt(projA.sdMs ** 2 + projB.sdMs ** 2);

  const pA = logistic(logit(pElo) + logit(normalCdf(z)));
  return { pA: Math.min(0.99, Math.max(0.01, pA)), projA, projB };
}

export interface LiveWinProbEntry {
  currentTimeMs: number;
  players: {
    uuid: string;
    nickname: string;
    elo: number | null;
    liveUrl: string | null;
    lastEventType: string | null;
    lastEventTimeMs: number | null;
    milestone: MilestoneKey | null;
    projectedFinishMs: number;
    winProb: number;
  }[];
}

export function scoreLiveMatch(banded: BandedWinProbModel, match: LiveMatch): LiveWinProbEntry {
  const states = match.players.map((p) => ({
    profile: p,
    liveUrl: match.data[p.uuid]?.liveUrl ?? null,
    elo: p.eloRate,
    model: modelForElo(banded, p.eloRate).model,
    state: {
      lastEventType: match.data[p.uuid]?.timeline?.type ?? null,
      lastEventTime:
        match.data[p.uuid]?.timeline?.time !== undefined
          ? Number(match.data[p.uuid]!.timeline!.time)
          : null,
    } satisfies LiveRunState,
  }));

  const mk = (s: (typeof states)[0], proj: FinishProjection, p: number) => ({
    uuid: s.profile.uuid,
    nickname: s.profile.nickname,
    elo: s.profile.eloRate,
    liveUrl: s.liveUrl,
    lastEventType: s.state.lastEventType,
    lastEventTimeMs: s.state.lastEventTime,
    milestone: proj.milestone,
    projectedFinishMs: Math.round(proj.meanMs),
    winProb: p,
  });

  if (states.length === 2) {
    const [sa, sb] = states as [(typeof states)[0], (typeof states)[0]];
    const { pA, projA, projB } = headToHeadWinProb(sa, sb, Number(match.currentTime));
    return {
      currentTimeMs: Number(match.currentTime),
      players: [mk(sa, projA, pA), mk(sb, projB, 1 - pA)],
    };
  }

  return {
    currentTimeMs: Number(match.currentTime),
    players: states.map((s) =>
      mk(
        s,
        projectFinish(s.model, s.state, Number(match.currentTime)),
        1 / Math.max(states.length, 1),
      ),
    ),
  };
}
