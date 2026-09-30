import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Leaderboard,
  LeaderboardSeason,
  MatchInfo,
  UserDetails,
  UserProfileWithSeasonResult,
  VersusStats,
  WeeklyRaceEntry,
} from "../../src/shared/types.js";
import type { GameRecord, LabelledRun } from "../../src/analysis/history.js";
import type { MatchupPrediction } from "../../src/analysis/matchup.js";
import type { PacingComparison, SplitDistribution } from "../../src/analysis/pacing.js";
import type { ArchetypeStats } from "../../src/analysis/seeds.js";

export type {
  ArchetypeStats,
  GameRecord,
  LabelledRun,
  PacingComparison,
  SplitDistribution,
  Leaderboard,
  MatchInfo,
  UserDetails,
};

export interface Overview {
  season: LeaderboardSeason;
  top: UserProfileWithSeasonResult[];
  /** Absent when the live endpoint was unreachable; the ladder still renders. */
  playersOnline: number | null;
  liveMatchCount: number | null;
  weekly: { id: number; endsAt: number; podium: WeeklyRaceEntry[]; entrants: number } | null;
}

export interface PlayerHistory {
  user: UserDetails;
  seasons: number[];
  season: number;
  games: GameRecord[];
  /** False while older pages are still being fetched in the background. */
  complete: boolean;
}

export interface PlayerAnalysis {
  user: UserDetails;
  seasons: number[];
  season: number | null;
  runCount: number;
  corpusRunCount: number;
  comparison: PacingComparison;
  bandedDistributions: Record<string, SplitDistribution[]>;
  byBastion: ArchetypeStats[];
  byOverworld: ArchetypeStats[];
  complete: boolean;
}

export interface PlayerMatchup extends MatchupPrediction {
  seasons: number[];
  complete: boolean;
}

export interface GameSplits {
  matchId: number;
  runs: LabelledRun[];
  bastion: string | null;
  overworld: string | null;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  const body = (await res.json().catch(() => null)) as { error?: string } | T | null;
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `request failed (${res.status})`;
    throw new HttpError(msg, res.status);
  }
  return body as T;
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | T | null;
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `request failed (${res.status})`;
    throw new HttpError(msg, res.status);
  }
  return body as T;
}

/** loading and stale track visible loads only, never background polls. */
const responseCache = new Map<string, { data: unknown; time: number }>();
const RESPONSE_TTL = 60_000;
const MAX_RESPONSES = 200;

function cachedResponse<T>(path: string | null): T | null {
  if (!path) return null;
  const hit = responseCache.get(path);
  if (!hit) return null;
  if (Date.now() - hit.time >= RESPONSE_TTL) {
    responseCache.delete(path);
    return null;
  }
  return hit.data as T;
}

function cacheResponse(path: string, data: unknown) {
  const now = Date.now();
  if (responseCache.size >= MAX_RESPONSES) {
    for (const [k, v] of responseCache) {
      if (now - v.time >= RESPONSE_TTL) responseCache.delete(k);
    }
    // Insertion order, so this drops the oldest entries.
    for (const k of responseCache.keys()) {
      if (responseCache.size < MAX_RESPONSES) break;
      responseCache.delete(k);
    }
  }
  responseCache.set(path, { data, time: now });
}

export function useApi<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(() => cachedResponse<T>(path));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    (silent: boolean) => {
      if (!path) return;
      const gen = ++generation.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      apiGet<T>(path)
        .then((d) => {
          cacheResponse(path, d);
          if (generation.current === gen) {
            setData(d);
            if (!silent) setLoading(false);
          }
        })
        .catch((e: unknown) => {
          if (generation.current === gen && !silent) {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        });
    },
    [path],
  );

  useEffect(() => {
    const hit = cachedResponse<T>(path);
    setData(hit);
    setError(null);
    load(hit !== null); // a fresh cache refreshes quietly, otherwise the load is shown
  }, [load, path]);

  useEffect(() => {
    if (!pollMs || !path) return;
    const t = setInterval(() => load(true), pollMs);
    return () => clearInterval(t);
  }, [pollMs, path, load]);

  return {
    data,
    error,
    loading,
    reload: () => load(false),
    stale: loading && data !== null,
  };
}
