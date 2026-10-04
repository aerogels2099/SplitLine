import { useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { useApi, type PlayerHistory } from "../api";
import { fmtDateTime, flag } from "../format";
import { Avatar, TierChip } from "../components/Avatar";
import { ErrorBox, LoadingNote } from "../components/ui";
import { LadderSidebar } from "../components/LadderSidebar";
import { tierOf } from "../tiers";

const BACKFILL_POLL_MS = 1500;

export interface PlayerContext {
  id: string;
  history: PlayerHistory;
  season: number;
  /** The URL's season, for links that should stay in it; empty when the server chose. */
  search: string;
  filling: boolean;
}

export function usePlayer() {
  return useOutletContext<PlayerContext>();
}

export default function Player() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  // set by a pick or a season's ladder link; otherwise the server picks the latest
  const raw = params.get("season");
  const season = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
  // The server fills older pages after responding; poll until it says complete.
  const [poll, setPoll] = useState<number | undefined>(undefined);
  const query = season === undefined ? "" : `?season=${season}`;
  const { data, error, loading } = useApi<PlayerHistory>(
    id ? `/api/players/${encodeURIComponent(id)}/history${query}` : null,
    poll,
  );
  const filling = data !== null && !data.complete;
  useEffect(() => {
    setPoll(filling ? BACKFILL_POLL_MS : undefined);
  }, [filling]);

  const u = data?.user;
  const tier = tierOf(u?.eloRate);
  // the API lists seasons newest-first; show them left to right as a timeline
  const seasons = data ? [...data.seasons].reverse() : [];
  const real = data?.games.filter((g) => !g.decayed) ?? [];
  const wins = real.filter((g) => g.outcome === "win").length;
  const losses = real.filter((g) => g.outcome === "loss").length;

  return (
    <div className="player-layout">
      {/* Outside the loading branch: the ladder does not depend on this request. */}
      <LadderSidebar
        current={u?.nickname}
        season={data?.season}
        seasons={seasons}
        onSeason={(s) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("season", String(s));
            return next;
          })
        }
      />
      <div className="player-main">
        {error ? (
          <ErrorBox
            message={
              error.includes("exists") || error.toLowerCase().includes("not found")
                ? `No MCSR Ranked player named "${id}" was found.`
                : `Failed to load ${id}: ${error}`
            }
          />
        ) : !data || !u ? (
          loading ? (
            <LoadingNote />
          ) : null
        ) : (
          <>
            <div
              className="player-hero"
              style={{ "--hero-c": tier?.color ?? "var(--gold)" } as React.CSSProperties}
            >
              <Avatar uuid={u.uuid} name={u.nickname} size={84} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <h1>
                    {u.nickname} <span style={{ fontSize: 22 }}>{flag(u.country)}</span>
                  </h1>
                  <TierChip elo={u.eloRate} showElo />
                </div>
                <div className="meta">last online {fmtDateTime(u.timestamp.lastOnline)}</div>
              </div>
            </div>

            <div className="player-bar">
              <nav className="tabs">
                <NavLink to={`/player/${encodeURIComponent(id)}${query}`} end>
                  Games
                </NavLink>
                <NavLink to={`/player/${encodeURIComponent(id)}/analysis${query}`}>
                  Pacing &amp; seeds
                </NavLink>
                <NavLink to={`/player/${encodeURIComponent(id)}/sessions${query}`}>Sessions</NavLink>
                <NavLink to={`/player/${encodeURIComponent(id)}/versus${query}`}>Versus</NavLink>
              </nav>

              <span className="season-tally">
                {wins}–{losses} in {real.length} ranked games
                {filling && <span className="muted"> · loading older games…</span>}
              </span>
            </div>

            <Outlet
              context={
                { id, history: data, season: data.season, search: query, filling } satisfies PlayerContext
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
