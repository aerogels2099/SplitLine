import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useApi, type PlayerMatchup } from "../../api";
import { Avatar, TierChip } from "../../components/Avatar";
import { ChartCard, ErrorBox, LoadingNote } from "../../components/ui";
import { fmtMs, fmtPct, titleCase } from "../../format";
import { usePlayer } from "../Player";

const MATCHUP_POLL_MS = 3000;
const FREQUENT_OPPONENTS = 6;

type Profile = PlayerMatchup["a"];
type SeedRow = PlayerMatchup["bastion"][number];

export default function Versus() {
  const { id, history, search } = usePlayer();
  const { other } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const frequent = useMemo(() => {
    const counts = new Map<string, { nickname: string; games: number }>();
    for (const g of history.games) {
      if (g.decayed || !g.opponent) continue;
      const c = counts.get(g.opponent.uuid) ?? { nickname: g.opponent.nickname, games: 0 };
      c.games++;
      counts.set(g.opponent.uuid, c);
    }
    return [...counts.values()].sort((a, b) => b.games - a.games).slice(0, FREQUENT_OPPONENTS);
  }, [history.games]);

  const open = (name: string) =>
    navigate(`/player/${encodeURIComponent(id)}/versus/${encodeURIComponent(name)}${search}`);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      open(q);
      setQuery("");
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Opponent… (nickname or UUID)"
            aria-label="Opponent"
          />
          <button type="submit">Compare</button>
        </form>
        {frequent.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
            <span className="card-sub">Frequent opponents this season</span>
            {frequent.map((f) => (
              <button type="button" key={f.nickname} onClick={() => open(f.nickname)}>
                {f.nickname} <span className="muted">· {f.games}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {other && <Matchup id={id} other={other} />}
    </div>
  );
}

function Matchup({ id, other }: { id: string; other: string }) {
  const [poll, setPoll] = useState<number | undefined>(undefined);
  const { data, error, loading, stale } = useApi<PlayerMatchup>(
    `/api/players/${encodeURIComponent(id)}/versus/${encodeURIComponent(other)}`,
    poll,
  );
  const filling = data !== null && !data.complete;
  useEffect(() => {
    setPoll(filling ? MATCHUP_POLL_MS : undefined);
  }, [filling]);

  if (error) {
    return (
      <ErrorBox
        message={
          error.includes("exists") || error.toLowerCase().includes("not found")
            ? `No MCSR Ranked player named "${other}" was found.`
            : error
        }
      />
    );
  }
  if (loading && !data) return <LoadingNote text="Loading both players' recent seasons…" />;
  if (!data) return null;

  return (
    <>
      <Headline m={data} filling={filling} />
      <Scenarios m={data} stale={stale} />
      <div className="grid cols-2">
        <SeedCard title="Bastion history" rows={data.bastion} m={data} stale={stale} />
        <SeedCard title="Overworld history" rows={data.overworld} m={data} stale={stale} />
      </div>
    </>
  );
}

function Side({ p, right = false }: { p: Profile; right?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: right ? "row-reverse" : "row",
        alignItems: "center",
        gap: 12,
        minWidth: 0,
        textAlign: right ? "right" : "left",
      }}
    >
      <Avatar uuid={p.uuid} name={p.nickname} size={48} />
      <div style={{ minWidth: 0 }}>
        <div className="strong" style={{ fontSize: 18, overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.nickname}
        </div>
        <TierChip elo={p.elo} showElo />
      </div>
    </div>
  );
}

function Headline({ m, filling }: { m: PlayerMatchup; filling: boolean }) {
  const { aWins, bWins, draws, games } = m.h2h;
  const seasons = [...m.seasons].sort((x, y) => x - y).join(" and ");
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <Side p={m.a} />
        <span className="muted" style={{ fontFamily: "var(--font-mono)" }}>
          vs
        </span>
        <Side p={m.b} right />
      </div>
      <div
        className="tug"
        style={{ marginTop: 16 }}
        role="img"
        aria-label={`${m.a.nickname} ${fmtPct(m.pBase)}, ${m.b.nickname} ${fmtPct(1 - m.pBase)}`}
      >
        <div className="side-b" />
        <div className="side-a" style={{ "--p": m.pBase } as React.CSSProperties} />
        <span className="pct a">{fmtPct(m.pBase)}</span>
        <span className="pct b">{fmtPct(1 - m.pBase)}</span>
      </div>
      <div
        className="card-sub"
        style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}
      >
        <span>rating alone {fmtPct(m.pElo)}</span>
        <span>
          {games > 0
            ? `head-to-head ${aWins}–${bWins}${draws > 0 ? `–${draws}` : ""} in seasons ${seasons}`
            : `no ranked games between them in seasons ${seasons}`}
        </span>
        {filling && <span>still loading match history…</span>}
      </div>
    </div>
  );
}

function tone(p: number, headline: number): string | undefined {
  if (p > headline + 0.02) return "var(--ahead)";
  if (p < headline - 0.02) return "var(--behind)";
  return undefined;
}

function Scenarios({ m, stale }: { m: PlayerMatchup; stale: boolean }) {
  const title = `If ${m.a.nickname} reaches a milestone at…`;
  if (m.splits.length === 0) {
    return (
      <ChartCard title={title} stale={stale}>
        <div className="muted" style={{ marginTop: 8 }}>
          Not enough timed runs in the {m.a.band} band yet.
        </div>
      </ChartCard>
    );
  }
  const percentiles = m.splits[0]!.points.map((pt) => pt.percentile);
  return (
    <ChartCard
      title={title}
      sub={`percentiles of the ${m.a.band} band's split times; win chance with ${m.b.nickname}'s progress unknown`}
      stale={stale}
    >
      <div className="scroll-x" style={{ marginTop: 8 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Milestone</th>
              {percentiles.map((p) => (
                <th key={p} className="num">
                  {p}th
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.splits.map((s) => (
              <tr key={s.key}>
                <td className="strong">{s.label}</td>
                {s.points.map((pt) => (
                  <td key={pt.percentile} className="num">
                    <span style={{ color: tone(pt.p, m.pBase), fontWeight: 700 }}>{fmtPct(pt.p)}</span>{" "}
                    <span className="muted">{fmtMs(pt.timeMs)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function SeedCell({ side }: { side: SeedRow["a"] }) {
  if (!side) return <td className="num muted">—</td>;
  const pts = Math.round(side.relative * 100);
  return (
    <td className="num">
      {fmtPct(side.stats.winRate)} <span className="muted">· {side.stats.games}g</span>{" "}
      <span style={{ color: pts > 0 ? "var(--ahead)" : pts < 0 ? "var(--behind)" : undefined }}>
        {pts > 0 ? `+${pts}` : pts < 0 ? `−${-pts}` : "±0"}
      </span>
    </td>
  );
}

function SeedCard({
  title,
  rows,
  m,
  stale,
}: {
  title: string;
  rows: SeedRow[];
  m: PlayerMatchup;
  stale: boolean;
}) {
  return (
    <ChartCard title={title} sub="against each player's own average; not part of the prediction" stale={stale}>
      {rows.length === 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          No filtered-seed games in these seasons.
        </div>
      ) : (
        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Archetype</th>
                <th className="num">{m.a.nickname}</th>
                <th className="num">{m.b.nickname}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.archetype}>
                  <td className="strong">{titleCase(r.archetype)}</td>
                  <SeedCell side={r.a} />
                  <SeedCell side={r.b} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}
