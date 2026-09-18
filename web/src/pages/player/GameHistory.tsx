import { memo, useMemo, useState } from "react";
import { useApi, type GameRecord, type GameSplits, type PlayerHistory } from "../../api";
import { fmtDate, fmtMs, fmtSigned } from "../../format";
import { EloChart, type EloChartPoint } from "../../components/EloChart";
import { ChartCard, ErrorBox } from "../../components/ui";

const RANGES = [0, 100, 50, 25];

export default function GameHistory({
  id,
  initial,
  filling = false,
}: {
  id: string;
  initial: PlayerHistory;
  /** Older pages are still landing, so counts here are not yet final. */
  filling?: boolean;
}) {
  const [season, setSeason] = useState(initial.season);
  // The page already loaded one season; re-fetch only when another is picked.
  const path = `/api/players/${encodeURIComponent(id)}/history?season=${season}`;
  const { data, error, stale } = useApi<PlayerHistory>(season === initial.season ? null : path);
  const view = season === initial.season ? initial : data;

  // the API lists seasons newest-first; show them left to right as a timeline
  const seasons = [...initial.seasons].reverse();
  const at = seasons.indexOf(season);
  const [range, setWindow] = useState(0);

  const games = view?.games;
  // Above the early returns so the hook order stays stable.
  const { points, wins, losses, played } = useMemo(() => {
    const list = games ?? [];
    const pts: EloChartPoint[] = list
      .filter((g): g is GameRecord & { eloAfter: number } => g.eloAfter !== null)
      .map((g) => ({
        matchId: g.matchId,
        date: g.date,
        elo: g.eloAfter,
        change: g.eloChange ?? 0,
        decayed: g.decayed,
      }));
    const real = list.filter((g) => !g.decayed);
    return {
      points: pts,
      wins: real.filter((g) => g.outcome === "win").length,
      losses: real.filter((g) => g.outcome === "loss").length,
      played: real.length,
    };
  }, [games]);

  // the range counts games back from the most recent, so 0 means the lot
  const shown = useMemo(() => (range === 0 ? points : points.slice(-range)), [points, range]);

  if (error) return <ErrorBox message={error} />;
  if (!games) return <div className="card">Loading season {season}…</div>;

  return (
    <div className={stale ? "stale" : ""}>
      <div className="season-bar">
        <button
          type="button"
          disabled={at <= 0}
          onClick={() => setSeason(seasons[at - 1]!)}
          aria-label="Earlier season"
        >
          ◂
        </button>
        <div className="season-list">
          {seasons.map((s) => (
            <button
              key={s}
              type="button"
              className={s === season ? "on" : ""}
              onClick={() => setSeason(s)}
            >
              S{s}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={at >= seasons.length - 1}
          onClick={() => setSeason(seasons[at + 1]!)}
          aria-label="Later season"
        >
          ▸
        </button>
        <span className="season-tally">
          {wins}–{losses} in {played} ranked games
          {filling && <span className="muted"> · loading older games…</span>}
        </span>
      </div>

      {points.length > 1 && (
        <ChartCard
          title={`Season ${season} rating`}
          actions={RANGES.filter((n) => n === 0 || n < points.length).map((n) => (
            <button
              key={n}
              type="button"
              className={n === range ? "on" : ""}
              onClick={() => setWindow(n)}
            >
              {n === 0 ? "All" : `Last ${n}`}
            </button>
          ))}
        >
          <EloChart points={shown} height={260} />
        </ChartCard>
      )}

      <h2>Games</h2>
      {games.length === 0 ? (
        <div className="card">No ranked games in season {season}.</div>
      ) : (
        <div className="game-list">
          {games.map((g) => (
            <GameRow key={g.matchId} id={id} game={g} />
          ))}
        </div>
      )}
    </div>
  );
}

const GameRow = memo(function GameRow({ id, game }: { id: string; game: GameRecord }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`game${open ? " open" : ""}`}>
      <button type="button" className="game-head" onClick={() => setOpen((o) => !o)}>
        <span className={`game-outcome ${game.outcome}`}>
          {game.decayed ? "decay" : game.outcome}
        </span>
        <span className="game-opponent">
          {game.decayed ? "—" : (game.opponent?.nickname ?? "unknown")}
          {game.opponent?.eloAtMatch != null && (
            <span className="game-oppelo"> {game.opponent.eloAtMatch}</span>
          )}
        </span>
        <span className="game-time">{game.forfeited ? "forfeit" : fmtMs(game.time)}</span>
        <span className={`game-delta ${(game.eloChange ?? 0) >= 0 ? "up" : "down"}`}>
          {fmtSigned(game.eloChange)}
        </span>
        <span className="game-elo">{game.eloAfter ?? "—"}</span>
        <span className="game-date">{fmtDate(game.date)}</span>
        <span className="game-chevron" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && <SplitCard id={id} matchId={game.matchId} />}
    </div>
  );
});

function SplitCard({ id, matchId }: { id: string; matchId: number }) {
  // Fetched on open: timelines are one upstream request per match.
  const { data, error } = useApi<GameSplits>(
    `/api/players/${encodeURIComponent(id)}/games/${matchId}`,
  );

  if (error) return <div className="split-card muted">{error}</div>;
  if (!data) return <div className="split-card muted">Loading splits…</div>;
  if (data.runs.length === 0) {
    return <div className="split-card muted">This match has no timeline data.</div>;
  }

  const runs = data.runs;
  return (
    <div className="split-card">
      <table className="data split-table">
        <thead>
          <tr>
            <th>Split</th>
            {runs.map((r) => (
              <th key={r.uuid} className="num">
                {r.nickname}
                {r.won && <span className="split-won"> ✦</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs[0]!.splits.map((s, i) => (
            <tr key={s.key}>
              <td className="strong">{s.label}</td>
              {/* labelRun emits splits in fixed milestone order. */}
              {runs.map((r) => (
                <td key={r.uuid} className="num">
                  {fmtMs(r.splits[i]?.time)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="split-meta">
        {runs.map((r) => (
          <span key={r.uuid}>
            {r.nickname}: {r.deaths} deaths · {r.resets} resets
            {r.forfeited && " · forfeited"}
          </span>
        ))}
      </div>
    </div>
  );
}
