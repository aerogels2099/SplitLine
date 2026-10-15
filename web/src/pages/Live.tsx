import { Link, useParams } from "react-router-dom";
import { useApi, type LiveMatchView, type LiveRunner, type LiveView } from "../api";
import { Avatar, TierChip } from "../components/Avatar";
import { LiveChart } from "../components/LiveChart";
import { ChartCard, ErrorBox, LoadingNote } from "../components/ui";
import { fmtMs, fmtPct, fmtNum } from "../format";

const LIVE_POLL_MS = 10_000;

const SPLITS: Record<string, string> = {
  nether_enter: "Nether",
  bastion: "Bastion",
  fortress: "Fortress",
  first_portal: "First portal",
  stronghold: "Stronghold",
  end_enter: "End",
  finish: "Finish",
};

const splitOf = (r: LiveRunner) =>
  r.milestone ? `${SPLITS[r.milestone] ?? r.milestone} ${fmtMs(r.lastEventTimeMs)}` : "Overworld";

export default function Live() {
  const { key } = useParams();
  const { data, error, loading } = useApi<LiveView>("/api/live", LIVE_POLL_MS);

  if (error) return <ErrorBox message={`Live matches are unavailable: ${error}`} />;
  if (loading && !data) return <LoadingNote text="Loading live matches…" />;
  if (!data) return null;

  if (key) {
    const match = data.matches.find((m) => m.key === key);
    return match ? (
      <MatchView match={match} />
    ) : (
      <div className="card">
        This match has ended or is no longer public. <Link to="/live">Back to live matches</Link>
      </div>
    );
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card-sub">
        {fmtNum(data.online)} players online · {data.matches.length} public live matches · updates every 10 seconds
      </div>
      {data.matches.length === 0 && <div className="card">No public matches are live right now.</div>}
      {[...data.matches]
        .sort((a, b) => b.currentTimeMs - a.currentTimeMs)
        .map((m) => (
          <Link key={m.key} to={`/live/${encodeURIComponent(m.key)}`} className="card live-row">
            <Runner r={m.players[0]} />
            <div style={{ display: "grid", gap: 6, justifyItems: "center" }}>
              <span className="mono muted">{fmtMs(m.currentTimeMs)}</span>
              <Tug match={m} />
            </div>
            <Runner r={m.players[1]} right />
          </Link>
        ))}
    </div>
  );
}

function Runner({ r, right = false }: { r: LiveRunner; right?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: right ? "row-reverse" : "row", alignItems: "center", gap: 10, minWidth: 0, textAlign: right ? "right" : "left" }}>
      <Avatar uuid={r.uuid} name={r.nickname} size={40} />
      <div style={{ minWidth: 0 }}>
        <div className="strong" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.nickname}
        </div>
        <div className="mono muted" style={{ fontSize: 12 }}>
          {splitOf(r)}
        </div>
      </div>
    </div>
  );
}

function Tug({ match }: { match: LiveMatchView }) {
  const [a, b] = match.players;
  return (
    <div className="tug" style={{ width: "100%" }} role="img" aria-label={`${a.nickname} ${fmtPct(a.winProb)}, ${b.nickname} ${fmtPct(b.winProb)}`}>
      <div className="side-b" />
      <div className="side-a" style={{ "--p": a.winProb } as React.CSSProperties} />
      <span className="pct a">{fmtPct(a.winProb)}</span>
      <span className="pct b">{fmtPct(b.winProb)}</span>
    </div>
  );
}

function MatchView({ match }: { match: LiveMatchView }) {
  const [a, b] = match.players;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Link to="/live" className="muted">
        ← All live matches
      </Link>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <Runner r={a} />
          <span className="mono muted">{fmtMs(match.currentTimeMs)}</span>
          <Runner r={b} right />
        </div>
        <div style={{ marginTop: 16 }}>
          <Tug match={match} />
        </div>
      </div>

      <ChartCard title="Win probability" sub="from when SplitLine started watching this match">
        <LiveChart history={match.history} nowMs={match.currentTimeMs} nameA={a.nickname} nameB={b.nickname} />
      </ChartCard>

      <ChartCard title="Runners">
        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Runner</th>
                <th>Rating</th>
                <th>Latest split</th>
                <th className="num">Projected finish</th>
                <th className="num">Win chance</th>
                <th>Stream</th>
              </tr>
            </thead>
            <tbody>
              {match.players.map((r) => (
                <tr key={r.uuid}>
                  <td className="strong">{r.nickname}</td>
                  <td>
                    <TierChip elo={r.elo} showElo />
                  </td>
                  <td>{splitOf(r)}</td>
                  <td className="num">{fmtMs(r.projectedFinishMs)}</td>
                  <td className="num">{fmtPct(r.winProb)}</td>
                  <td>
                    {r.liveUrl ? (
                      <a href={r.liveUrl} target="_blank" rel="noreferrer">
                        Watch
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}
