import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useApi, type Leaderboard } from "../api";
import { flag } from "../format";
import { tierOf } from "../tiers";

const SHOWN = 150;

/** The season ladder beside a player page, scrolled to whoever is open. */
export function LadderSidebar({
  current,
  season,
  seasons = [],
  onSeason,
}: {
  current?: string;
  season?: number;
  seasons?: number[];
  onSeason?: (season: number) => void;
}) {
  const { data } = useApi<Leaderboard>(
    season === undefined ? "/api/leaderboard" : `/api/leaderboard?season=${season}`,
    60_000,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const users = data?.users.slice(0, SHOWN) ?? [];
  const here = current?.toLowerCase();
  const at = season === undefined ? -1 : seasons.indexOf(season);
  const pickable = onSeason !== undefined && seasons.length > 0 && season !== undefined;

  const centredFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!data || !here || centredFor.current === here) return;
    const el = listRef.current?.querySelector<HTMLElement>("a.on");
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    centredFor.current = here;
  }, [data, here]);

  return (
    <aside className="ladder-side">
      <div className="ladder-side-head">
        <span>Top {SHOWN}</span>
        {pickable ? (
          <span className="ladder-season">
            <button
              type="button"
              disabled={at <= 0}
              onClick={() => onSeason(seasons[at - 1]!)}
              aria-label="Earlier season"
            >
              ◂
            </button>
            <select
              value={season}
              onChange={(e) => onSeason(Number(e.target.value))}
              aria-label="Season"
            >
              {[...seasons].reverse().map((s) => (
                <option key={s} value={s}>
                  Season {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={at < 0 || at >= seasons.length - 1}
              onClick={() => onSeason(seasons[at + 1]!)}
              aria-label="Later season"
            >
              ▸
            </button>
          </span>
        ) : (
          data && <span>season {data.season.number}</span>
        )}
      </div>
      <div className="ladder-side-list" ref={listRef}>
        {users.length === 0 && <div className="ladder-side-empty">Loading ladder…</div>}
        {users.map((u) => {
          const tier = tierOf(u.eloRate);
          return (
            <Link
              key={u.uuid}
              to={`/player/${encodeURIComponent(u.nickname)}`}
              className={u.nickname.toLowerCase() === here ? "on" : ""}
            >
              <span className="ladder-rank">{u.eloRank ?? "—"}</span>
              <span className="ladder-name">
                {u.nickname} <span className="ladder-flag">{flag(u.country)}</span>
              </span>
              <span className="ladder-elo" style={{ color: tier?.color }}>
                {u.eloRate ?? "—"}
              </span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
