import { useTooltip } from "./ui";

export interface RadarSeries {
  name: string;
  color: string;
  /** One entry per axis, in the same order; a missing value is drawn hollow at the centre. */
  values: (number | null)[];
  counts?: (number | null)[];
}

// Wider than tall so the axis labels at the sides have room.
const VW = 420;
const VH = 340;
const CX = VW / 2;
const CY = 168;
const R = 116;
const RINGS = [0.25, 0.5, 0.75, 1];

export function RadarChart({
  axes,
  series,
  max = 1,
  fmtValue = (v: number) => `${Math.round(v * 100)}%`,
}: {
  axes: string[];
  series: RadarSeries[];
  max?: number;
  fmtValue?: (v: number) => string;
}) {
  const tt = useTooltip();
  const n = axes.length;
  if (n < 3) return <div className="muted" style={{ marginTop: 8 }}>Need at least 3 archetypes with data.</div>;

  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, v: number) => {
    const r = (Math.max(0, Math.min(v, max)) / max) * R;
    return [CX + r * Math.cos(angle(i)), CY + r * Math.sin(angle(i))] as const;
  };

  return (
    <div className="scroll-x">
      <svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", maxWidth: 460, margin: "0 auto", display: "block" }}>
        {RINGS.map((lvl) => (
          <polygon
            key={lvl}
            points={axes.map((_, i) => pt(i, lvl * max).join(",")).join(" ")}
            fill="none"
            stroke="var(--grid)"
            strokeWidth={1}
          />
        ))}
        {axes.map((ax, i) => {
          const [ex, ey] = pt(i, max);
          const [lx, ly] = [CX + (R + 18) * Math.cos(angle(i)), CY + (R + 18) * Math.sin(angle(i))];
          const anchor = Math.abs(lx - CX) < 12 ? "middle" : lx > CX ? "start" : "end";
          return (
            <g key={ax}>
              <line x1={CX} y1={CY} x2={ex} y2={ey} stroke="var(--grid)" strokeWidth={1} />
              <text
                x={lx}
                y={ly + 3}
                textAnchor={anchor}
                fontSize={9.5}
                fontFamily="var(--font-mono)"
                fill="var(--text-secondary)"
              >
                {ax}
              </text>
            </g>
          );
        })}
        <text x={CX + 4} y={CY - R - 4} fontSize={8.5} fontFamily="var(--font-label)" fill="var(--text-muted)">
          {fmtValue(max)}
        </text>

        {series.map((s) => {
          const poly = axes
            .map((_, i) => {
              const v = s.values[i];
              return pt(i, v ?? 0).join(",");
            })
            .join(" ");
          return (
            <g key={s.name}>
              <polygon points={poly} fill={s.color} fillOpacity={series.length > 1 ? 0.14 : 0.2} stroke={s.color} strokeWidth={2} />
            </g>
          );
        })}
        {/* above the fills, so they can be hovered */}
        {series.map((s) =>
          axes.map((ax, i) => {
            const v = s.values[i];
            const [x, y] = pt(i, v ?? 0);
            const hollow = v == null;
            return (
              <rect
                key={`${s.name}-${ax}`}
                x={x - 4}
                y={y - 4}
                width={8}
                height={8}
                fill={hollow ? "var(--slot)" : s.color}
                stroke={s.color}
                strokeWidth={2}
                shapeRendering="crispEdges"
                style={{ cursor: "default" }}
                onMouseMove={(e) =>
                  tt.show(e, (
                    <div>
                      <div className="tt-title">
                        {s.name} · {ax}
                      </div>
                      <div>
                        {v == null ? "no games" : <b style={{ color: "var(--text-primary)" }}>{fmtValue(v)}</b>}
                        {s.counts && s.counts[i] != null ? ` · ${s.counts[i]} games` : ""}
                      </div>
                    </div>
                  ))
                }
                onMouseLeave={tt.hide}
              />
            );
          }),
        )}
      </svg>
      {tt.el}
    </div>
  );
}
