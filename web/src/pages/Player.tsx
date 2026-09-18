import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi, type PlayerHistory } from "../api";
import { fmtDateTime, flag } from "../format";
import { Avatar, TierChip } from "../components/Avatar";
import { ErrorBox, LoadingNote } from "../components/ui";
import { LadderSidebar } from "../components/LadderSidebar";
import { tierOf } from "../tiers";
import GameHistory from "./player/GameHistory";

const BACKFILL_POLL_MS = 1500;

export default function Player() {
  const { id = "" } = useParams();
  // The server fills older pages after responding; poll until it says complete.
  const [poll, setPoll] = useState<number | undefined>(undefined);
  const { data, error, loading } = useApi<PlayerHistory>(
    id ? `/api/players/${encodeURIComponent(id)}/history` : null,
    poll,
  );
  const filling = data !== null && !data.complete;
  useEffect(() => {
    setPoll(filling ? BACKFILL_POLL_MS : undefined);
  }, [filling]);

  const u = data?.user;
  const tier = tierOf(u?.eloRate);

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

            <GameHistory id={id} initial={data} filling={filling} />
          </>
        )}
      </div>
    </div>
  );
}
