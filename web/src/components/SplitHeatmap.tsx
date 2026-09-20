/** Elo bands by milestone; columns are normalized on their own, so brightness
 *  compares bands within one split. */
import type { SplitDistribution } from "../api";
import { fmtMs } from "../format";
import { useTooltip } from "./ui";

export function SplitHeatmap({ data }: { data: Record<string, SplitDistribution[]> }) {
  const tt = useTooltip();

  const bands = Object.entries(data)
    .filter(([b]) => b !== "placement")
    .sort(([a], [b]) => Number(a.split("–")[0]) - Number(b.split("–")[0]));
  if (bands.length === 0) return <div className="muted">No banded corpus yet.</div>;

  const labels = bands[0]![1].map((d) => d.label);
  const rows = bands.map(
    ([band, dists]) => [band, new Map(dists.map((d) => [d.label, d]))] as const,
  );
  const colStats = labels.map((l) => {
    const vals = rows
      .map(([, byLabel]) => byLabel.get(l)?.p50)
      .filter((v): v is number => v != null && !Number.isNaN(v));
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const cols = `108px repeat(${labels.length}, minmax(54px, 1fr))`;

  return (
    <div className="scroll-x" style={{ marginTop: 10 }}>
      <div style={{ minWidth: 480, display: "grid", gridTemplateColumns: cols, gap: 2 }}>
        {/* header */}
        <div />
        {labels.map((l) => (
          <div
            key={l}
            style={{
              fontFamily: "var(--font-label)",
              fontSize: 8,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--gold-dim)",
              textAlign: "center",
              padding: "0 2px 4px",
              alignSelf: "end",
              lineHeight: 1.25,
            }}
          >
            {l}
          </div>
        ))}

        {/* rows */}
        {rows.map(([band, byLabel], bi) => (
          <Row key={band}>
            <div
              className="mono"
              style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center" }}
            >
              {band}
            </div>
            {labels.map((l, ci) => {
              const d = byLabel.get(l);
              const { min, max } = colStats[ci]!;
              if (!d || d.p50 == null || Number.isNaN(d.p50)) {
                return <div key={l} style={{ height: 34, background: "var(--slot)" }} />;
              }
              const span = max - min;
              const t = span > 0 ? (max - d.p50) / span : 0.6; // highest scores the fastest band
              const alpha = 0.1 + 0.82 * t;
              const dark = t > 0.52;
              return (
                <div
                  key={l}
                  style={{
                    height: 34,
                    background: `rgba(255, 204, 51, ${alpha.toFixed(3)})`,
                    color: dark ? "#171205" : "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontWeight: dark ? 700 : 500,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "default",
                  }}
                  onMouseMove={(e) =>
                    tt.show(e, (
                      <div>
                        <div className="tt-title">
                          {l} · {band}
                        </div>
                        <div>
                          median <b style={{ color: "var(--text-primary)" }}>{fmtMs(d.p50)}</b> · {d.count} runs
                        </div>
                        <div className="muted">
                          {span > 0
                            ? `${Math.round(t * 100)}% toward fastest band at this split`
                            : "only band with data here"}
                        </div>
                      </div>
                    ))
                  }
                  onMouseLeave={tt.hide}
                >
                  {fmtMs(d.p50)}
                </div>
              );
            })}
          </Row>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          fontFamily: "var(--font-label)",
          fontSize: 8,
          textTransform: "uppercase",
          letterSpacing: 1,
          color: "var(--text-muted)",
        }}
      >
        <span>slower</span>
        <span
          style={{
            width: 120,
            height: 8,
            background: "linear-gradient(90deg, rgba(255,204,51,0.10), rgba(255,204,51,0.92))",
            border: "1px solid var(--border)",
          }}
        />
        <span>faster (per split)</span>
      </div>
      {tt.el}
    </div>
  );
}

// The wrapper is transparent to layout, so each row's cells sit directly in the parent grid.
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "contents" }}>{children}</div>;
}
