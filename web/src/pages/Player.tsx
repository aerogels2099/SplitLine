import { useParams } from "react-router-dom";
import { useApi, type PlayerHistory } from "../api";
import { fmtDateTime, flag } from "../format";
import { Avatar, TierChip } from "../components/Avatar";
import { ErrorBox, LoadingNote } from "../components/ui";
import { tierOf } from "../tiers";
import GameHistory from "./player/GameHistory";

export default function Player() {
  const { id = "" } = useParams();
  const { data, error, loading } = useApi<PlayerHistory>(
    id ? `/api/players/${encodeURIComponent(id)}/history` : null,
  );

  if (error) {
    return (
      <ErrorBox
        message={
          error.includes("exists") || error.toLowerCase().includes("not found")
            ? `No MCSR Ranked player named "${id}" was found.`
            : `Failed to load ${id}: ${error}`
        }
      />
    );
  }
  if (loading && !data) return <LoadingNote />;
  if (!data) return null;

  const u = data.user;
  const tier = tierOf(u.eloRate);

  return (
    <div>
      <div
        className="player-hero"
        style={{ "--hero-c": tier?.color ?? "var(--gold)", marginBottom: 16 } as React.CSSProperties}
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

      <GameHistory id={id} initial={data} />
    </div>
  );
}
