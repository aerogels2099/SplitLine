import { useSearchParams } from "react-router-dom";
import {
  useApi,
  type ArchetypeStats,
  type GameSplits,
  type LabelledRun,
  type PlayerAnalysis,
} from "../../api";
import { fmtDeltaMs, fmtMs, fmtPct, titleCase } from "../../format";
import { DivergingBars, HBars } from "../../components/charts";
import { RadarChart } from "../../components/RadarChart";
import { SplitHeatmap } from "../../components/SplitHeatmap";
import { ChartCard, ErrorBox, Legend, LoadingNote } from "../../components/ui";
import { usePlayer } from "../Player";

export default function Analysis() {
  const { id, season } = usePlayer();
  const [params] = useSearchParams();
  const match = params.get("match");

  const { data, error, loading, stale } = useApi<PlayerAnalysis>(
    `/api/players/${encodeURIComponent(id)}/analysis?season=${season}`,
  );
  // Only when arriving from a game card: the run that prompted the question.
  const { data: run } = useApi<GameSplits>(
    match ? `/api/players/${encodeURIComponent(id)}/games/${match}` : null,
  );

  if (error) return <ErrorBox message={error} />;
  if (loading && !data) return <LoadingNote text="Reconstructing runs from match timelines…" />;
  if (!data) return null;

  if (data.runCount === 0) {
    return (
      <ErrorBox message="No timed runs ingested for this player yet. Timelines are fetched in the background on first visit — re-open this tab shortly." />
    );
  }

  const cmp = data.comparison;
  const withBoth = cmp.segments.filter((s) => s.deltaMs !== null);
  const worst = cmp.segments.find((s) => s.key === cmp.worstSegment);
  const highlight = run?.bastion ?? null;
  // The server drops runs with no timeline, so the player's is not always
  // first; picking it out by identity avoids captioning an opponent's run.
  const myRun = run?.runs.find((r) => r.uuid === data.user.uuid) ?? null;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {run && myRun && <RunCard run={run} mine={myRun} comparison={cmp} />}

      {worst && worst.deltaMs !== null && worst.deltaMs > 0 && (
        <div className="card">
          <div className="card-title">Where the time goes</div>
          <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>
            Across {data.runCount} timed runs,{" "}
            <b style={{ color: "var(--text-primary)" }}>{worst.label}</b> costs the most against the{" "}
            {cmp.band} band — <b style={{ color: "var(--text-primary)" }}>{fmtDeltaMs(worst.deltaMs)}</b>{" "}
            per run at the median
            {worst.playerPercentile !== null && ` (slower than ${fmtPct(worst.playerPercentile)} of peers)`}
            .
          </div>
        </div>
      )}

      <ChartCard title="Time lost per segment" stale={stale}>
        <Legend
          items={[
            { label: "ahead of band", color: "var(--ahead)" },
            { label: "behind band", color: "var(--behind)" },
          ]}
        />
        <DivergingBars
          items={withBoth.map((s) => ({
            label: s.label,
            value: s.deltaMs!,
            display: fmtDeltaMs(s.deltaMs),
            hint: (
              <div>
                <div className="tt-title">{s.label}</div>
                <div>
                  you {fmtMs(s.playerMedian)} · peers {fmtMs(s.peerMedian)}
                </div>
                <div>
                  {s.playerSamples} of your runs vs {s.peerSamples} peer runs
                </div>
              </div>
            ),
          }))}
        />
      </ChartCard>

      <ChartCard title="Split medians by elo band" stale={stale}>
        <SplitHeatmap data={data.bandedDistributions} />
      </ChartCard>

      <h2>Seed archetypes</h2>

      <BastionRadar stats={data.byBastion} name={data.user.nickname} stale={stale} />

      <div className="grid cols-2">
        <ArchetypeCard
          title="By bastion"
          stats={data.byBastion}
          highlight={highlight}
          stale={stale}
        />
        <ArchetypeCard
          title="By overworld"
          stats={data.byOverworld}
          highlight={run?.overworld ?? null}
          stale={stale}
        />
      </div>
    </div>
  );
}

/** The run the game card linked from, against the player's own band. */
function RunCard({
  run,
  mine,
  comparison,
}: {
  run: GameSplits;
  mine: LabelledRun;
  comparison: PlayerAnalysis["comparison"];
}) {
  const peer = new Map<string, number | null>(
    comparison.milestoneMedians.map((m) => [m.key, m.peer]),
  );
  return (
    <ChartCard
      title="This run"
      actions={
        run.bastion ? <button type="button" className="on">{titleCase(run.bastion)}</button> : null
      }
    >
      <table className="data" style={{ width: "auto", minWidth: "min(460px, 100%)" }}>
        <thead>
          <tr>
            <th>Milestone</th>
            <th className="num">This run</th>
            <th className="num">{comparison.band} median</th>
            <th className="num">Delta</th>
          </tr>
        </thead>
        <tbody>
          {mine.splits.map((s) => {
            const p = peer.get(s.key) ?? null;
            const delta = s.time !== null && p !== null ? s.time - p : null;
            return (
              <tr key={s.key}>
                <td className="strong">{s.label}</td>
                <td className="num">{fmtMs(s.time)}</td>
                <td className="num">{fmtMs(p)}</td>
                <td className="num" style={{ color: deltaColor(delta) }}>
                  {delta === null ? "—" : fmtDeltaMs(delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ChartCard>
  );
}

function deltaColor(delta: number | null): string {
  if (delta === null) return "var(--text-muted)";
  return delta > 0 ? "var(--behind)" : "var(--ahead)";
}

function BastionRadar({
  stats,
  name,
  stale,
}: {
  stats: ArchetypeStats[];
  name: string;
  stale: boolean;
}) {
  const rows = stats.filter((s) => s.games >= 5).slice(0, 8);
  if (rows.length < 3) return null;
  return (
    <ChartCard title="Bastion win-rate profile" stale={stale}>
      <RadarChart
        axes={rows.map((s) => titleCase(s.archetype))}
        series={[
          {
            name,
            color: "var(--gold)",
            values: rows.map((s) => s.winRate),
            counts: rows.map((s) => s.games),
          },
        ]}
      />
    </ChartCard>
  );
}

function ArchetypeCard({
  title,
  stats,
  highlight,
  stale,
}: {
  title: string;
  stats: ArchetypeStats[];
  highlight: string | null;
  stale: boolean;
}) {
  const rows = stats.filter((s) => s.games >= 3);
  if (rows.length === 0) {
    return (
      <ChartCard title={title} stale={stale}>
        <div className="muted" style={{ marginTop: 8 }}>
          No games with seed data yet.
        </div>
      </ChartCard>
    );
  }
  return (
    <ChartCard title={title} stale={stale}>
      <HBars
        items={rows.map((s) => ({
          label: titleCase(s.archetype),
          value: s.winRate,
          display: `${fmtPct(s.winRate)} · ${s.games}g`,
          color: s.archetype === highlight ? "var(--gold-hot)" : undefined,
          hint: (
            <div>
              <div className="tt-title">{titleCase(s.archetype)}</div>
              <div>
                {s.wins}–{s.losses}–{s.draws} · {fmtPct(s.winRate)}
              </div>
              <div>median win {fmtMs(s.medianWinTime)}</div>
            </div>
          ),
        }))}
        max={1}
      />
    </ChartCard>
  );
}
