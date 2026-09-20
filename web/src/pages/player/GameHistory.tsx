import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApi, type GameRecord, type GameSplits } from "../../api";
import { usePlayer } from "../Player";
import { fmtDate, fmtMs, fmtSigned } from "../../format";
import { EloChart, type EloChartPoint } from "../../components/EloChart";
import { ChartCard, ErrorBox } from "../../components/ui";

const RANGES = [0, 100, 50, 25];

/** A heavy season runs to roughly 1800 games, far too many rows for one page. */
const CHUNK = 50;

export default function GameHistory() {
  const { id, history, season, filling } = usePlayer();
  const [range, setWindow] = useState(0);
  // Which game's splits are expanded; the elo chart can set it too.
  const [openMatch, setOpenMatch] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingJump = useRef<number | null>(null);
  const [shownRows, setShownRows] = useState(CHUNK);
  const sentinel = useRef<HTMLDivElement>(null);

  const games = history.games;
  // Above the early returns so the hook order stays stable.
  const { points } = useMemo(() => {
    const list = games ?? [];
    const pts: EloChartPoint[] = list
      .filter((g): g is GameRecord & { eloAfter: number } => g.eloAfter !== null)
      .map((g) => ({
        matchId: g.matchId,
        date: g.date,
        elo: g.eloAfter,
        change: g.eloChange ?? 0,
        decayed: g.decayed,
        outcome: g.outcome,
        opponent: g.opponent?.nickname ?? null,
      }));
    return { points: pts };
  }, [games]);

  // games arrive newest first, so the most recent ones are at the head, not the tail
  const shown = useMemo(() => (range === 0 ? points : points.slice(0, range)), [points, range]);

  /** Jumps to a game picked on the chart, from an effect so the row exists first. */
  const openFromChart = (matchId: number) => {
    // The row has to exist before the effect below can scroll to it.
    const idx = games.findIndex((g) => g.matchId === matchId);
    if (idx >= 0) setShownRows((n) => Math.max(n, idx + 1));
    setOpenMatch(matchId);
    pendingJump.current = matchId;
  };
  useEffect(() => setShownRows(CHUNK), [season]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shownRows >= games.length) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setShownRows((n) => Math.min(n + CHUNK, games.length));
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shownRows, games.length]);

  useEffect(() => {
    const target = pendingJump.current;
    if (target === null) return;
    pendingJump.current = null;
    listRef.current
      ?.querySelector(`[data-match="${target}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [openMatch]);

  return (
    <div>
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
          <EloChart points={shown} height={260} onSelect={openFromChart} />
        </ChartCard>
      )}

      <h2>Games</h2>
      {games.length === 0 ? (
        <div className="card">
          {filling ? `Loading season ${season}…` : `No ranked games in season ${season}.`}
        </div>
      ) : (
        <div className="game-list" ref={listRef}>
          {games.slice(0, shownRows).map((g) => (
            <GameRow
              key={g.matchId}
              id={id}
              game={g}
              open={openMatch === g.matchId}
              onToggle={() => setOpenMatch((m) => (m === g.matchId ? null : g.matchId))}
            />
          ))}
          {shownRows < games.length && (
            <div ref={sentinel} className="game-more muted">
              {games.length - shownRows} older games
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const GameRow = memo(function GameRow({
  id,
  game,
  open,
  onToggle,
}: {
  id: string;
  game: GameRecord;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`game${open ? " open" : ""}`} data-match={game.matchId}>
      <button type="button" className="game-head" onClick={onToggle}>
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
              {/* splits come back in a fixed order, so position lines the rows up */}
              {runs.map((r) => (
                <td key={r.uuid} className="num">
                  {fmtMs(r.splits[i]?.time)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="split-actions">
        <Link to={`/player/${encodeURIComponent(id)}/analysis?match=${matchId}`}>
          Analyse this run →
        </Link>
      </div>
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
