import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useApi, type GameRecord, type GameSplits } from "../../api";
import { usePlayer } from "../Player";
import { fmtAgo, fmtDate, fmtMs, fmtSigned } from "../../format";
import { EloChart, type EloChartPoint } from "../../components/EloChart";
import { ChartCard, ErrorBox } from "../../components/ui";

const RANGES = [50, 100, 0];
const DEFAULT_RANGE = 50;
const CLOCK_MS = 60_000;

/** A heavy season runs to roughly 1800 games, far too many rows for one page. */
const CHUNK = 50;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const scrollBehavior = (): ScrollBehavior =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

export default function GameHistory() {
  const { id, history, season, filling } = usePlayer();
  const [range, setWindow] = useState(DEFAULT_RANGE);
  // Which game's splits are expanded; the elo chart can set it too.
  const [openMatch, setOpenMatch] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingJump = useRef<number | null>(null);
  const [shownRows, setShownRows] = useState(CHUNK);
  const sentinel = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [farDown, setFarDown] = useState(false);
  const [gameOffscreen, setGameOffscreen] = useState(false);
  const [now, setNow] = useState(nowSeconds);

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

  const openFromChart = (matchId: number) => {
    // The row has to exist before the effect below can scroll to it.
    const idx = games.findIndex((g) => g.matchId === matchId);
    if (idx >= 0) setShownRows((n) => Math.max(n, idx + 1));
    setOpenMatch(matchId);
    pendingJump.current = matchId;
  };
  // Stable, so memoised rows don't re-render when another row opens or more load.
  const scrollToGame = (matchId: number) =>
    listRef.current
      ?.querySelector(`[data-match="${matchId}"]`)
      ?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  const toggleMatch = useCallback(
    (matchId: number) => setOpenMatch((m) => (m === matchId ? null : matchId)),
    [],
  );
  useEffect(() => {
    setShownRows(CHUNK);
    setWindow(DEFAULT_RANGE);
  }, [season]);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSeconds()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    // The root reaches two screens above the viewport, so the marker leaves it once that far down.
    const io = new IntersectionObserver(([e]) => setFarDown(!e!.isIntersecting), {
      rootMargin: "200% 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    setGameOffscreen(false);
    const el = openMatch === null ? null : listRef.current?.querySelector(`[data-match="${openMatch}"]`);
    if (!el) return;
    let seen = false;
    const io = new IntersectionObserver(([e]) => {
      // Not until the game has been on screen, so the scroll from the chart doesn't flash the button.
      if (e!.isIntersecting) seen = true;
      setGameOffscreen(seen && !e!.isIntersecting && e!.boundingClientRect.top > 0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [openMatch]);
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
    scrollToGame(target);
  }, [openMatch]);

  const openGame = openMatch === null ? null : games.find((g) => g.matchId === openMatch);
  const showGame = gameOffscreen && openGame != null;

  return (
    <div>
      <div ref={top} />
      {points.length > 1 && (
        <ChartCard
          title={`Season ${season} rating`}
          actions={RANGES.filter((n) => n !== 100 || points.length > 50).map((n) => (
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
          <EloChart key={`${season}:${range}`} points={shown} height={260} onSelect={openFromChart} />
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
              ago={fmtAgo(g.date, now)}
              onToggle={toggleMatch}
            />
          ))}
          {shownRows < games.length && (
            <div ref={sentinel} className="game-more muted">
              {games.length - shownRows} older games
            </div>
          )}
        </div>
      )}

      {createPortal(
        <div className="float-nav">
          <button
            type="button"
            className={`float-btn${showGame ? " show" : ""}${farDown ? " lifted" : ""}`}
            inert={!showGame}
            onClick={() => openMatch !== null && scrollToGame(openMatch)}
          >
            ↓ Back to game{openGame?.opponent ? ` vs ${openGame.opponent.nickname}` : ""}
          </button>
          <button
            type="button"
            className={`float-btn${farDown ? " show" : ""}`}
            inert={!farDown}
            onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}
          >
            ↑ Back to top
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface GameRowProps {
  id: string;
  game: GameRecord;
  open: boolean;
  ago: string;
  onToggle: (matchId: number) => void;
}

// Played games never change, so a row only redraws when it opens, closes or ages.
const sameRow = (a: GameRowProps, b: GameRowProps) =>
  a.game.matchId === b.game.matchId &&
  a.open === b.open &&
  a.ago === b.ago &&
  a.id === b.id &&
  a.onToggle === b.onToggle;

const GameRow = memo(function GameRow({ id, game, open, ago, onToggle }: GameRowProps) {
  return (
    <div className={`game${open ? " open" : ""}`} data-match={game.matchId}>
      <button type="button" className="game-head" onClick={() => onToggle(game.matchId)}>
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
        <span className="game-date">
          {fmtDate(game.date)} · {ago}
        </span>
        <span className="game-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="split-wrap">
          <div>
            <SplitCard id={id} matchId={game.matchId} season={game.season} />
          </div>
        </div>
      )}
    </div>
  );
}, sameRow);

function SplitCard({ id, matchId, season }: { id: string; matchId: number; season: number }) {
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
        <Link to={`/player/${encodeURIComponent(id)}/analysis?season=${season}&match=${matchId}`}>
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
