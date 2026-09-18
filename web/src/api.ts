/**
 * Typed client for the SplitLine backend. Analysis types are imported
 * type-only from the backend source.
 */
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

export type {
  Leaderboard,
  MatchInfo,
  UserDetails,
};

export interface Overview {
  season: LeaderboardSeason;
  top: UserProfileWithSeasonResult[];
  playersOnline: number;
  liveMatchCount: number;
  weekly: { id: number; endsAt: number; podium: WeeklyRaceEntry[]; entrants: number };
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

/**
 * Fetch-on-mount hook with a stale-while-revalidate cache. A recently
 * fetched path renders instantly and revalidates silently; `loading` and
 * `stale` apply only to user-visible loads, never to background polls.
 */
const responseCache = new Map<string, { data: unknown; time: number }>();
const RESPONSE_TTL = 60_000;

function cachedResponse<T>(path: string | null): T | null {
  if (!path) return null;
  const hit = responseCache.get(path);
  return hit && Date.now() - hit.time < RESPONSE_TTL ? (hit.data as T) : null;
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
          responseCache.set(path, { data: d, time: Date.now() });
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
    load(hit !== null); // fresh cache -> silent revalidate; else visible load
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
