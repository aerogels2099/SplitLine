/** Chart primitives: bars, lines, gridlines, and a tooltip on every mark. */
import { type ReactNode } from "react";
import { useTooltip } from "./ui";

// ------------------------------------------------------ horizontal bars

export interface HBarItem {
  label: string;
  value: number;
  display: string; // the label printed at the tip of the bar
  color?: string;
  hint?: ReactNode; // shown in the tooltip
}

export function HBars({ items, max }: { items: HBarItem[]; max?: number }) {
  const tt = useTooltip();
  const m = max ?? Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{ display: "grid", gridTemplateColumns: "130px 1fr 62px", gap: 8, alignItems: "center", minHeight: 24 }}
          onMouseMove={it.hint ? (e) => tt.show(e, it.hint) : undefined}
          onMouseLeave={it.hint ? tt.hide : undefined}
        >
          <span
            style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={it.label}
          >
            {it.label}
          </span>
          <div style={{ position: "relative", height: 16 }}>
            <div
              style={{
                position: "absolute",
                insetBlock: 0,
                left: 0,
                width: `${Math.max((it.value / m) * 100, 0.5)}%`,
                background: it.color ?? "var(--series-1)",
                borderRadius: "0 4px 4px 0",
              }}
            />
          </div>
          <span className="mono" style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>
            {it.display}
          </span>
        </div>
      ))}
      {tt.el}
    </div>
  );
}

// ------------------------------------------------------- diverging bars

export interface DivergingItem {
  label: string;
  value: number;
  display: string;
  hint?: ReactNode;
}

/** Diverging bars around a zero baseline; negative is time saved, positive time lost. */
export function DivergingBars({ items, posColor, negColor }: {
  items: DivergingItem[];
  posColor?: string;
  negColor?: string;
}) {
  const tt = useTooltip();
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const pos = posColor ?? "var(--behind)";
  const neg = negColor ?? "var(--ahead)";
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {items.map((it, i) => {
        const pct = (Math.abs(it.value) / max) * 50;
        return (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "130px 1fr 62px", gap: 8, alignItems: "center", minHeight: 24 }}
            onMouseMove={it.hint ? (e) => tt.show(e, it.hint) : undefined}
            onMouseLeave={it.hint ? tt.hide : undefined}
          >
            <span style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.label}
            </span>
            <div style={{ position: "relative", height: 16 }}>
              <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--baseline)" }} />
              <div
                style={{
                  position: "absolute",
                  insetBlock: 0,
                  ...(it.value >= 0
                    ? { left: "50%", width: `${pct}%`, borderRadius: "0 4px 4px 0", background: pos }
                    : { right: "50%", width: `${pct}%`, borderRadius: "4px 0 0 4px", background: neg }),
                }}
              />
            </div>
            <span className="mono" style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>
              {it.display}
            </span>
          </div>
        );
      })}
      {tt.el}
    </div>
  );
}

const PAD = { l: 44, r: 14, t: 10, b: 24 };

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) ?? mag * 10;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

// -------------------------------------------------------------- columns

export interface ColumnItem {
  label: string;
  value: number;
  hint?: ReactNode;
}

export function Columns({ items, height, fmtValue }: {
  items: ColumnItem[];
  height?: number;
  fmtValue?: (v: number) => string;
}) {
  const tt = useTooltip();
  const H = height ?? 120;
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: H, marginTop: 10, borderBottom: "1px solid var(--baseline)" }}>
        {items.map((it, i) => (
          <div
            key={i}
            style={{ flex: 1, display: "flex", alignItems: "flex-end", height: "100%", minWidth: 3, cursor: it.hint ? "default" : undefined }}
            onMouseMove={(e) => tt.show(e, it.hint ?? (
              <div>
                <div className="tt-title">{it.label}</div>
                <div>{fmtValue ? fmtValue(it.value) : it.value}</div>
              </div>
            ))}
            onMouseLeave={tt.hide}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 24,
                margin: "0 auto",
                height: `${(it.value / max) * 100}%`,
                minHeight: it.value > 0 ? 2 : 0,
                background: "var(--series-1)",
                borderRadius: "4px 4px 0 0",
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
        <span>{items[0]?.label}</span>
        <span>{items[items.length - 1]?.label}</span>
      </div>
      {tt.el}
    </div>
  );
}

// -------------------------------------------------------------- scatter

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
  hint?: ReactNode;
  emphasized?: boolean;
}

export function Scatter(props: {
  points: ScatterPoint[];
  height?: number;
  fmtX: (x: number) => string;
  fmtY: (y: number) => string;
  xLabel: string;
  yLabel: string;
}) {
  const tt = useTooltip();
  const W = 640;
  const H = props.height ?? 240;
  const xs = props.points.map((p) => p.x);
  const ys = props.points.map((p) => p.y);
  if (props.points.length === 0) return <div className="muted">No data.</div>;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const sx = (x: number) => PAD.l + ((x - x0) / Math.max(x1 - x0, 1e-9)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - ((y - y0) / Math.max(y1 - y0, 1e-9)) * (H - PAD.t - PAD.b);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 360, display: "block" }}>
        {niceTicks(y0, y1).map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 6} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {props.fmtY(t)}
            </text>
          </g>
        ))}
        {niceTicks(x0, x1, 5).map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - 7} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {props.fmtX(t)}
          </text>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--baseline)" strokeWidth={1} />
        <text x={W - PAD.r} y={H - PAD.b - 6} textAnchor="end" fontSize={10} fill="var(--text-muted)">
          {props.xLabel} →
        </text>
        <text x={PAD.l + 4} y={PAD.t + 8} fontSize={10} fill="var(--text-muted)">
          ↑ {props.yLabel}
        </text>
        {props.points.map((p, i) => (
          <circle
            key={i}
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={p.emphasized ? 6 : 4.5}
            fill={p.emphasized ? "var(--series-2)" : "var(--series-1)"}
            stroke="var(--surface-solid)"
            strokeWidth={2}
            style={{ cursor: "default" }}
            onMouseMove={(e) =>
              tt.show(e, p.hint ?? (
                <div>
                  <div className="tt-title">{p.label}</div>
                  <div>
                    {props.xLabel}: {props.fmtX(p.x)} · {props.yLabel}: {props.fmtY(p.y)}
                  </div>
                </div>
              ))
            }
            onMouseLeave={tt.hide}
          />
        ))}
      </svg>
      {tt.el}
    </div>
  );
}
