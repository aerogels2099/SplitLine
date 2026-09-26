import { useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
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
  filling: boolean;
}

export function usePlayer() {
  return useOutletContext<PlayerContext>();
}

export default function Player() {
  const { id = "" } = useParams();
  // unset until the reader picks one, which leaves the server to choose the latest
  const [season, setSeason] = useState<number | undefined>(undefined);
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
  const at = data ? seasons.indexOf(data.season) : -1;
  const real = data?.games.filter((g) => !g.decayed) ?? [];
  const wins = real.filter((g) => g.outcome === "win").length;
  const losses = real.filter((g) => g.outcome === "loss").length;

  return (
    <div className="player-layout">
      {/* Outside the loading branch: the ladder does not depend on this request. */}
      <LadderSidebar current={u?.nickname} />
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
                <NavLink to={`/player/${encodeURIComponent(id)}`} end>
                  Games
                </NavLink>
                <NavLink to={`/player/${encodeURIComponent(id)}/analysis`}>
                  Pacing &amp; seeds
                </NavLink>
              </nav>

              <button
                type="button"
                disabled={at <= 0}
                onClick={() => setSeason(seasons[at - 1])}
                aria-label="Earlier season"
              >
                ◂
              </button>
              <div className="season-list">
                {seasons.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={s === data.season ? "on" : ""}
                    onClick={() => setSeason(s)}
                  >
                    S{s}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={at < 0 || at >= seasons.length - 1}
                onClick={() => setSeason(seasons[at + 1])}
                aria-label="Later season"
              >
                ▸
              </button>

              <span className="season-tally">
                {wins}–{losses} in {real.length} ranked games
                {filling && <span className="muted"> · loading older games…</span>}
              </span>
            </div>

            <Outlet
              context={
                { id, history: data, season: data.season, filling } satisfies PlayerContext
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
