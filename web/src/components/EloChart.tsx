import { useMemo, useRef, useState } from "react";
import { fmtDate, fmtDateTime, fmtSigned } from "../format";
import { TIERS } from "../tiers";
import { useTooltip } from "./ui";

export interface EloChartPoint {
  date: number; // epoch seconds
  elo: number; // post-match rating
  change: number;
  decayed: boolean;
}

const W = 920;
const PAD = { l: 52, r: 92, t: 18, b: 30 };

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

/** Hard step-after path: hold each rating until the next match. */
function stepPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` H${pts[i]!.x.toFixed(1)} V${pts[i]!.y.toFixed(1)}`;
  }
  return d;
}

export function EloChart({ points, height = 300 }: { points: EloChartPoint[]; height?: number }) {
  const tt = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;

  const view = useMemo(() => {
    const sorted = [...points].sort((a, b) => a.date - b.date);
    const x0 = sorted[0]?.date ?? 0;
    const x1 = sorted[sorted.length - 1]?.date ?? 1;
    const ys = sorted.map((p) => p.elo);
    let yLo = Math.min(...ys);
    let yHi = Math.max(...ys);
    const pad = Math.max((yHi - yLo) * 0.14, 24);
    yLo -= pad;
    yHi += pad;
    const sx = (x: number) => PAD.l + ((x - x0) / Math.max(x1 - x0, 1)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => H - PAD.b - ((y - yLo) / Math.max(yHi - yLo, 1)) * (H - PAD.t - PAD.b);
    const px = sorted.map((p) => ({ ...p, X: sx(p.date), Y: sy(p.elo) }));
    const peak = px.reduce((a, b) => (b.elo > a.elo ? b : a), px[0]!);
    const floor = px.reduce((a, b) => (b.elo < a.elo ? b : a), px[0]!);
    return { sorted: px, x0, x1, yLo, yHi, sx, sy, peak, floor };
  }, [points, H]);

  if (points.length === 0) return <div className="muted">No rated games.</div>;
  const { sorted, x0, x1, yLo, yHi, sx, sy, peak, floor } = view;

  const linePath = stepPath(sorted.map((p) => ({ x: p.X, y: p.Y })));
  const last = sorted[sorted.length - 1]!;
  const areaPath = `${linePath} V${(H - PAD.b).toFixed(1)} H${sorted[0]!.X.toFixed(1)} Z`;

  const bands = TIERS.filter((t) => t.min < yHi && (t.max === Infinity ? yHi > 2000 : t.max > yLo));

  const onMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((evt.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    sorted.forEach((p, i) => {
      const d = Math.abs(p.X - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
    const p = sorted[best]!;
    tt.show(evt, (
      <div>
        <div className="tt-title">{fmtDateTime(p.date)}</div>
        <div>
          <b style={{ color: "var(--text-primary)" }}>{p.elo}</b> elo{" "}
          <span style={{ color: p.change >= 0 ? "var(--ahead)" : "var(--behind)" }}>
            ({fmtSigned(p.change)})
          </span>
        </div>
        {p.decayed && <div style={{ color: "var(--behind)" }}>rank decay entry</div>}
      </div>
    ));
  };

  const sq = (x: number, y: number, s: number, fill: string, key?: string | number) => (
    <rect
      key={key}
      x={x - s / 2}
      y={y - s / 2}
      width={s}
      height={s}
      fill={fill}
      stroke="var(--void)"
      strokeWidth={2}
      shapeRendering="crispEdges"
    />
  );

  return (
    <div className="scroll-x">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", minWidth: 520, display: "block", cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          tt.hide();
        }}
      >
        <defs>
          <linearGradient id="eloArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
          </linearGradient>
          <clipPath id="plot">
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
          </clipPath>
        </defs>

        {/* plot slot */}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={W - PAD.l - PAD.r}
          height={H - PAD.t - PAD.b}
          fill="var(--slot)"
          stroke="var(--border)"
          strokeWidth={2}
          shapeRendering="crispEdges"
        />

        {/* tier bands */}
        <g clipPath="url(#plot)">
          {bands.map((t) => {
            const top = sy(Math.min(t.max === Infinity ? yHi : t.max, yHi));
            const bot = sy(Math.max(t.min, yLo));
            return (
              <g key={t.key}>
                <rect x={PAD.l} y={top} width={W - PAD.l - PAD.r} height={Math.max(bot - top, 0)} fill={t.color} opacity={0.045} />
                {t.min > yLo && (
                  <line
                    x1={PAD.l}
                    x2={W - PAD.r}
                    y1={sy(t.min)}
                    y2={sy(t.min)}
                    stroke={t.color}
                    strokeOpacity={0.3}
                    strokeWidth={1}
                  />
                )}
              </g>
            );
          })}
        </g>
        {/* tier labels in the right gutter */}
        {bands.map((t) => {
          const top = Math.min(t.max === Infinity ? yHi : t.max, yHi);
          const bot = Math.max(t.min, yLo);
          const mid = sy((top + bot) / 2);
          if (sy(bot) - sy(top) < 14) return null;
          return (
            <text
              key={t.key}
              x={W - PAD.r + 12}
              y={mid + 3}
              fontSize={8.5}
              fontFamily="var(--font-pixel-sm)"
              letterSpacing="1"
              fill={t.color}
              opacity={0.9}
            >
              {t.label.toUpperCase()}
            </text>
          );
        })}

        {/* grid + ticks */}
        {niceTicks(yLo, yHi).map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" strokeWidth={1} shapeRendering="crispEdges" />
            <text x={PAD.l - 8} y={sy(v) + 3.5} textAnchor="end" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {niceTicks(x0, x1, 6).map((v) => (
          <text key={v} x={sx(v)} y={H - 9} textAnchor="middle" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
            {fmtDate(v)}
          </text>
        ))}

        {/* stepped area + line */}
        <g clipPath="url(#plot)">
          <path d={areaPath} fill="url(#eloArea)" />
          <path d={linePath} fill="none" stroke="var(--gold)" strokeWidth={2} shapeRendering="crispEdges" />
          {/* decay entries: red squares (decay = losing time) */}
          {sorted.filter((p) => p.decayed).map((p, i) => sq(p.X, p.Y, 7, "var(--behind)", i))}
        </g>

        {/* peak / floor flags */}
        {peak !== last && (
          <g>
            {sq(peak.X, peak.Y, 7, "var(--gold-hot)")}
            <text x={peak.X} y={peak.Y - 10} textAnchor="middle" fontSize={9} fontFamily="var(--font-pixel-sm)" fill="var(--gold-hot)">
              PB {peak.elo}
            </text>
          </g>
        )}
        <g>
          {sq(floor.X, floor.Y, 7, "var(--text-muted)")}
          <text x={floor.X} y={floor.Y + 18} textAnchor="middle" fontSize={9} fontFamily="var(--font-pixel-sm)" fill="var(--text-muted)">
            LOW {floor.elo}
          </text>
        </g>

        {/* crosshair */}
        {hover !== null && sorted[hover] && (
          <g>
            <line
              x1={sorted[hover]!.X}
              x2={sorted[hover]!.X}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--gold-dim)"
              strokeWidth={1}
            />
            {sq(sorted[hover]!.X, sorted[hover]!.Y, 9, "var(--gold-hot)")}
          </g>
        )}

        {/* end-value slab badge */}
        <g>
          {sq(last.X, last.Y, 8, "var(--gold)")}
          <rect x={last.X + 9} y={last.Y - 12} width={52} height={22} fill="var(--gold)" stroke="var(--void)" strokeWidth={2} shapeRendering="crispEdges" />
          <text x={last.X + 35} y={last.Y + 4} textAnchor="middle" fontSize={12} fontWeight={700} fontFamily="var(--font-mono)" fill="#171205">
            {last.elo}
          </text>
        </g>
      </svg>
      {tt.el}
    </div>
  );
}
