import type { LiveMatch } from "../shared/types.js";
import { eloBand } from "./pacing.js";
import { MILESTONES, milestoneForEvent, type MilestoneKey, type RunSplits } from "./splits.js";
import { eloExpectedScore, mean, normalCdf, stddev } from "./stats.js";

export interface MilestoneModel {
  n: number;
  meanRemaining: number;
  sdRemaining: number;
}

export interface WinProbModel {
  milestones: Partial<Record<MilestoneKey, MilestoneModel>>;
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

  const finals = finished.map((r) => Number(r.splits.finish));
  return {
    milestones,
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

const MIN_BAND_RUNS = 30;

export interface ModelLookup {
  model: WinProbModel;
  band: string;
  fellBack: boolean;
}

export function modelForElo(banded: BandedWinProbModel, elo: number | null): ModelLookup {
  const band = eloBand(elo);
  const hit = banded.bands[band];
  if (hit && hit.overall.n >= MIN_BAND_RUNS) return { model: hit, band, fellBack: false };
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
  const stats = milestone ? model.milestones[milestone] : undefined;
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

export function headToHeadWinProb(
  model: WinProbModel,
  a: LiveRunState,
  b: LiveRunState,
  elapsedMs: number,
  eloA: number | null = null,
  eloB: number | null = null,
): { pA: number; projA: FinishProjection; projB: FinishProjection } {
  const projA = projectFinish(model, a, elapsedMs);
  const projB = projectFinish(model, b, elapsedMs);

  if (projA.milestone === "finish" && projB.milestone !== "finish") {
    return { pA: 0.99, projA, projB };
  }
  if (projB.milestone === "finish" && projA.milestone !== "finish") {
    return { pA: 0.01, projA, projB };
  }

  const z = (projB.meanMs - projA.meanMs) / Math.sqrt(projA.sdMs ** 2 + projB.sdMs ** 2);
  const pTime = normalCdf(z);

  const pElo = eloA !== null && eloB !== null ? eloExpectedScore(eloA, eloB) : 0.5;
  const w = Math.min(1, elapsedMs / (8 * 60_000)) * 0.85;
  const pA = w * pTime + (1 - w) * pElo;
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

export function scoreLiveMatch(model: WinProbModel, match: LiveMatch): LiveWinProbEntry {
  const states = match.players.map((p) => {
    const data = match.data[p.uuid];
    return {
      profile: p,
      liveUrl: data?.liveUrl ?? null,
      state: {
        lastEventType: data?.timeline?.type ?? null,
        lastEventTime: data?.timeline?.time !== undefined ? Number(data.timeline.time) : null,
      } satisfies LiveRunState,
    };
  });

  if (states.length === 2) {
    const [sa, sb] = states as [(typeof states)[0], (typeof states)[0]];
    const { pA, projA, projB } = headToHeadWinProb(
      model,
      sa.state,
      sb.state,
      Number(match.currentTime),
      sa.profile.eloRate,
      sb.profile.eloRate,
    );
    const mk = (s: typeof sa, proj: FinishProjection, p: number) => ({
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
    return {
      currentTimeMs: Number(match.currentTime),
      players: [mk(sa, projA, pA), mk(sb, projB, 1 - pA)],
    };
  }

  return {
    currentTimeMs: Number(match.currentTime),
    players: states.map((s) => {
      const proj = projectFinish(model, s.state, Number(match.currentTime));
      return {
        uuid: s.profile.uuid,
        nickname: s.profile.nickname,
        elo: s.profile.eloRate,
        liveUrl: s.liveUrl,
        lastEventType: s.state.lastEventType,
        lastEventTimeMs: s.state.lastEventTime,
        milestone: proj.milestone,
        projectedFinishMs: Math.round(proj.meanMs),
        winProb: 1 / Math.max(states.length, 1),
      };
    }),
  };
}
