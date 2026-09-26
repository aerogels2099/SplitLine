import { Link } from "react-router-dom";
import { useApi, type Overview } from "../api";
import { fmtDate, fmtMs, fmtNum, flag } from "../format";
import { Avatar, TierChip } from "../components/Avatar";
import { ChartCard, ErrorBox, StatTile } from "../components/ui";
import { tierOf } from "../tiers";

export default function Home() {
  const { data, error, stale } = useApi<Overview>("/api/overview", 60_000);

  if (error)
    return <ErrorBox message={`Could not reach the backend: ${error}. Is the server running? (npm run dev)`} />;

  const podium = data?.top.slice(0, 3) ?? [];
  const rest = data?.top.slice(3) ?? [];
  const leader = data?.weekly?.podium[0] ?? null;

  return (
    <div className={stale ? "stale" : ""}>
      <h1>Dashboard</h1>

      <div className="grid cols-4">
        <StatTile
          label="Players online"
          value={data ? fmtNum(data.playersOnline) : "…"}
          sub={
            data && data.liveMatchCount !== null
              ? `${data.liveMatchCount} public live matches`
              : undefined
          }
        />
        <StatTile
          label="Season"
          value={data ? `S${data.season.number}` : "…"}
          sub={data ? `ends ${fmtDate(data.season.endsAt)}` : undefined}
        />
        <StatTile
          label="Weekly race"
          value={data ? (data.weekly ? `#${data.weekly.id}` : "—") : "…"}
          sub={
            data?.weekly
              ? `${data.weekly.entrants} entrants · ends ${fmtDate(data.weekly.endsAt)}`
              : undefined
          }
        />
        <StatTile
          label="Race leader"
          value={
            leader ? (
              <Link to={`/player/${encodeURIComponent(leader.player.nickname)}`}>
                {leader.player.nickname}
              </Link>
            ) : (
              "—"
            )
          }
          sub={leader ? fmtMs(Number(leader.time)) : undefined}
        />
      </div>

      <h2>Season {data ? data.season.number : ""} ladder</h2>

      {podium.length === 3 && (
        <div className="podium" style={{ marginTop: 56 }}>
          {[podium[1]!, podium[0]!, podium[2]!].map((u, i) => {
            const place = i === 1 ? 1 : i === 0 ? 2 : 3;
            return (
              <div key={u.uuid} className={`podium-card p${place}`}>
                <div className="podium-rank">
                  {place === 1 ? "◆ CHAMPION" : place === 2 ? "2ND" : "3RD"}
                </div>
                <Avatar uuid={u.uuid} name={u.nickname} size={place === 1 ? 76 : 64} />
                <div className="podium-name">
                  <Link to={`/player/${encodeURIComponent(u.nickname)}`}>
                    {flag(u.country)} {u.nickname}
                  </Link>
                </div>
                <div
                  className="podium-stat mono tier-text"
                  style={{ "--tier-c": tierOf(u.eloRate)?.color ?? "var(--text-muted)", fontSize: 20, fontWeight: 700 } as React.CSSProperties}
                >
                  {u.eloRate ?? "—"}
                </div>
                <div className="podium-stat">{u.seasonResult.phasePoint} phase pts</div>
                <div style={{ marginTop: 8 }}>
                  <TierChip elo={u.eloRate} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data && (
        <ChartCard
          title={`Top 20 — season ${data.season.number}`}
          sub="click a player for the full breakdown"
          table={{
            headers: ["#", "Player", "Country", "Elo", "Phase pts"],
            numeric: [0, 3, 4],
            rows: data.top.map((u) => [
              u.eloRank ?? "—",
              u.nickname,
              u.country ?? "—",
              u.eloRate ?? "—",
              u.seasonResult.phasePoint,
            ]),
          }}
        >
          <div className="scroll-x" style={{ marginTop: 8 }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Player</th>
                  <th>Tier</th>
                  <th className="num">Elo</th>
                  <th className="num">Phase pts</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((u) => (
                  <tr key={u.uuid}>
                    <td className="num">{u.eloRank ?? "—"}</td>
                    <td className="strong">
                      <Link
                        to={`/player/${encodeURIComponent(u.nickname)}`}
                        style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "inherit" }}
                      >
                        <Avatar uuid={u.uuid} name={u.nickname} size={24} />
                        {u.nickname} <span style={{ opacity: 0.8 }}>{flag(u.country)}</span>
                      </Link>
                    </td>
                    <td>
                      <TierChip elo={u.eloRate} />
                    </td>
                    <td
                      className="num tier-text"
                      style={{ "--tier-c": tierOf(u.eloRate)?.color ?? "var(--text-secondary)", fontWeight: 700 } as React.CSSProperties}
                    >
                      {u.eloRate ?? "—"}
                    </td>
                    <td className="num">{u.seasonResult.phasePoint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </div>
  );
}
