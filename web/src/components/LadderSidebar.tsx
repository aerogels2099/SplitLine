import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useApi, type Leaderboard } from "../api";
import { flag } from "../format";
import { tierOf } from "../tiers";

const SHOWN = 150;

/** The season ladder beside a player page, scrolled to whoever is open. */
export function LadderSidebar({ current }: { current?: string }) {
  const { data } = useApi<Leaderboard>("/api/leaderboard", 60_000);
  const listRef = useRef<HTMLDivElement>(null);
  const users = data?.users.slice(0, SHOWN) ?? [];
  const here = current?.toLowerCase();

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>("a.on");
    el?.scrollIntoView({ block: "center" });
  }, [data, here]);

  return (
    <aside className="ladder-side">
      <div className="ladder-side-head">
        Top {SHOWN}
        {data && <span>season {data.season.number}</span>}
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
