import type { EpochSeconds, Millis } from "../shared/brand.js";
import type { MatchInfo } from "../shared/types.js";
import { MILESTONES, SEGMENTS, type RunSplits } from "./splits.js";

export type GameOutcome = "win" | "loss" | "draw";

export interface GameRecord {
  matchId: number;
  date: EpochSeconds;
  season: number;
  outcome: GameOutcome;
  forfeited: boolean;
  /** Synthetic decay entry, not a real game (gotcha 2). */
  decayed: boolean;
  /** The deciding completion time; null on a draw. */
  time: Millis | null;
  opponent: { uuid: string; nickname: string; eloAtMatch: number | null } | null;
  /** Pre-match rating; null on placement games (gotcha 4). */
  eloBefore: number | null;
  eloChange: number | null;
  eloAfter: number | null;
}

export interface LabelledSplit {
  key: string;
  label: string;
  time: Millis | null;
}

export interface LabelledRun {
  uuid: string;
  nickname: string;
  finished: boolean;
  won: boolean;
  forfeited: boolean;
  deaths: number;
  resets: number;
  splits: LabelledSplit[];
  segments: LabelledSplit[];
}

/** Seasons the player has a match in, newest first. */
export function seasonsPlayed(matches: MatchInfo[]): number[] {
  const seen = new Set<number>();
  for (const m of matches) seen.add(m.season);
  return [...seen].sort((a, b) => b - a);
}

/** One record per match, newest first. Decay entries are kept and flagged. */
export function buildGameHistory(
  matches: MatchInfo[],
  uuid: string,
  season?: number,
): GameRecord[] {
  return matches
    .filter((m) => season === undefined || m.season === season)
    .sort((a, b) => b.date - a.date || b.id - a.id)
    .map((m) => {
      const mine = m.changes.find((c) => c.uuid === uuid) ?? null;
      const eloBefore = mine?.eloRate ?? null;
      const eloChange = mine?.change ?? null;
      const other = m.players.find((p) => p.uuid !== uuid) ?? null;
      const oppChange = other ? m.changes.find((c) => c.uuid === other.uuid) : undefined;
      return {
        matchId: m.id,
        date: m.date,
        season: m.season,
        outcome:
          m.result.uuid === null ? "draw" : m.result.uuid === uuid ? "win" : ("loss" as GameOutcome),
        forfeited: m.forfeited,
        decayed: m.decayed,
        time: m.result.uuid === null ? null : m.result.time,
        opponent: other
          ? { uuid: other.uuid, nickname: other.nickname, eloAtMatch: oppChange?.eloRate ?? null }
          : null,
        eloBefore,
        eloChange,
        eloAfter: eloBefore !== null && eloChange !== null ? eloBefore + eloChange : null,
      };
    });
}

export function labelRun(run: RunSplits): LabelledRun {
  return {
    uuid: run.uuid,
    nickname: run.nickname,
    finished: run.finished,
    won: run.won,
    forfeited: run.forfeited,
    deaths: run.deaths,
    resets: run.resets,
    splits: MILESTONES.map((m) => ({ key: m.key, label: m.label, time: run.splits[m.key] })),
    segments: SEGMENTS.map((s) => ({ key: s.key, label: s.label, time: run.segments[s.key] })),
  };
}
