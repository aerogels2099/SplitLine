import { useEffect, useState } from "react";
import { useApi, type PlayerSessions, type Session, type SessionBucket } from "../../api";
import { fmtDateTime, fmtPct, fmtSigned } from "../../format";
import { DivergingBars, HBars } from "../../components/charts";
import { ChartCard, ErrorBox, Legend, LoadingNote, StatTile, type TableSpec } from "../../components/ui";
import { usePlayer } from "../Player";

const SESSIONS_POLL_MS = 3000;
const RECENT_SESSIONS = 15;

const LEGEND = [
  { label: "better than usual", color: "var(--ahead)" },
  { label: "worse than usual", color: "var(--behind)" },
];

function pts(x: number): string {
  const n = Math.round(x * 100);
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)} pts`;
}

const gameLabel = (b: SessionBucket) => `Game ${b.label}`;
const streakLabel = (b: SessionBucket) =>
  b.label === "0" ? "Not after a loss" : `After ${b.label} ${b.label === "1" ? "loss" : "losses"}`;

export default function Sessions() {
  const { id, season } = usePlayer();
  const [poll, setPoll] = useState<number | undefined>(undefined);
  const { data, error, loading, stale } = useApi<PlayerSessions>(
    `/api/players/${encodeURIComponent(id)}/sessions?season=${season}`,
    poll,
  );
  const filling = data !== null && !data.complete;
  useEffect(() => {
    setPoll(filling ? SESSIONS_POLL_MS : undefined);
  }, [filling]);

  if (error) return <ErrorBox message={error} />;
  if (loading && !data) return <LoadingNote text="Grouping games into sessions…" />;
  if (!data) return null;
  if (data.sessions.length === 0) return <ErrorBox message="No ranked games this season." />;

  const games = data.sessions.reduce((n, s) => n + s.games.length, 0);
  const forfeits = data.sessions.reduce((n, s) => n + s.forfeits, 0);
  const lengths = data.sessions.map((s) => s.games.length).sort((a, b) => a - b);
  const recent = data.sessions.slice(-RECENT_SESSIONS).reverse();
  const sub = `against Elo's expectation, relative to the usual ${pts(data.baseline)}`;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid cols-3">
        <StatTile label="Sessions" value={data.sessions.length} sub={`${games} ranked games`} />
        <StatTile
          label="Typical session"
          value={`${lengths[Math.floor(lengths.length / 2)]} games`}
          sub="median, split at 30-minute breaks"
        />
        <StatTile label="Forfeit rate" value={fmtPct(forfeits / games)} sub="games lost by forfeiting" />
      </div>

      <div className="card">
        <div className="card-title">Within a session</div>
        {verdict(data).map((line) => (
          <div key={line} style={{ marginTop: 6, color: "var(--text-secondary)" }}>
            {line}
          </div>
        ))}
      </div>

      <div className="grid cols-2">
        <ChartCard
          title="By game in session"
          sub={sub}
          table={bucketTable(data.byPosition, gameLabel)}
          stale={stale}
        >
          <Legend items={LEGEND} />
          <BucketBars buckets={data.byPosition} label={gameLabel} />
        </ChartCard>
        <ChartCard
          title="After losses in a row"
          sub={sub}
          table={bucketTable(data.afterLosses, streakLabel)}
          stale={stale}
        >
          <Legend items={LEGEND} />
          <BucketBars buckets={data.afterLosses} label={streakLabel} />
        </ChartCard>
      </div>

      <ChartCard title="Forfeits after losses in a row" sub="a tilt sign when it climbs" stale={stale}>
        <HBars
          items={data.afterLosses
            .filter((b) => b.games > 0)
            .map((b) => ({
              label: streakLabel(b),
              value: b.forfeitRate,
              display: fmtPct(b.forfeitRate),
              hint: (
                <div>
                  <div className="tt-title">{streakLabel(b)}</div>
                  <div>
                    {Math.round(b.forfeitRate * b.games)} forfeits in {b.games} games
                  </div>
                </div>
              ),
            }))}
        />
      </ChartCard>

      <ChartCard title="Recent sessions" stale={stale}>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Started</th>
                <th>Results</th>
                <th className="num">Games</th>
                <th className="num">W–L–D</th>
                <th className="num">Forfeits</th>
                <th className="num">Elo</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.start}>
                  <td className="strong">{fmtDateTime(s.start)}</td>
                  <td>
                    <ResultStrip session={s} />
                  </td>
                  <td className="num">{s.games.length}</td>
                  <td className="num">
                    {s.wins}–{s.losses}–{s.draws}
                  </td>
                  <td className="num">{s.forfeits}</td>
                  <td
                    className="num"
                    style={{ color: s.eloChange > 0 ? "var(--ahead)" : s.eloChange < 0 ? "var(--behind)" : undefined }}
                  >
                    {fmtSigned(s.eloChange)}
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

function verdict(data: PlayerSessions): string[] {
  const n = data.dropFrom;
  const lines = [
    n === null
      ? "No clear drop within sessions: later games go about as well as earlier ones, against what Elo expected."
      : `From game ${n} of a session on, results fall clearly below ${n === 2 ? "game 1" : `games 1–${n - 1}`} of the same sessions, against what Elo expected.`,
  ];
  const streaks = data.afterLosses.slice(1).filter((b) => !b.thin);
  const worse = streaks.find((b) => b.high < 0);
  const better = streaks.find((b) => b.low > 0);
  if (worse) lines.push(`${streakLabel(worse)} in a row, results are clearly worse than usual.`);
  else if (better) lines.push(`${streakLabel(better)} in a row, results are clearly better than usual.`);
  else lines.push("Losing streaks don't clearly predict further losses.");
  return lines;
}

function BucketBars({ buckets, label }: { buckets: SessionBucket[]; label: (b: SessionBucket) => string }) {
  const shown = buckets.filter((b) => !b.thin);
  const hidden = buckets.filter((b) => b.thin && b.games > 0);
  return (
    <>
      {shown.length > 0 && (
        <DivergingBars
          posColor="var(--ahead)"
          negColor="var(--behind)"
          items={shown.map((b) => ({
            label: label(b),
            value: b.relative,
            display: pts(b.relative),
            hint: (
              <div>
                <div className="tt-title">{label(b)}</div>
                <div>
                  {b.rated} rated games · 99% range {pts(b.low)} to {pts(b.high)}
                </div>
                <div>{b.high < 0 ? "clearly worse than usual" : b.low > 0 ? "clearly better than usual" : "within the noise"}</div>
              </div>
            ),
          }))}
        />
      )}
      {hidden.length > 0 && (
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Too few rated games to read: {hidden.map(label).join(", ")}.
        </div>
      )}
    </>
  );
}

function bucketTable(buckets: SessionBucket[], label: (b: SessionBucket) => string): TableSpec {
  return {
    headers: ["", "Games", "Vs usual", "99% range", "Forfeits"],
    numeric: [1, 2, 3, 4],
    rows: buckets.map((b) => [
      label(b),
      b.games,
      b.thin ? "—" : pts(b.relative),
      b.thin ? "—" : `${pts(b.low)} to ${pts(b.high)}`,
      fmtPct(b.forfeitRate),
    ]),
  };
}

function ResultStrip({ session }: { session: Session }) {
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 3, maxWidth: 220 }}>
      {session.games.map((g) => (
        <span
          key={g.matchId}
          title={g.score === 1 ? "win" : g.score === 0 ? (g.forfeitedByPlayer ? "forfeit" : "loss") : "draw"}
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: g.score === 1 ? "var(--ahead)" : g.score === 0 ? "var(--behind)" : "var(--text-muted)",
            opacity: g.forfeitedByPlayer ? 0.45 : 1,
          }}
        />
      ))}
    </span>
  );
}
