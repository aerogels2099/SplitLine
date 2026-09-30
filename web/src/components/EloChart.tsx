import { useMemo, useRef, useState } from "react";
import { fmtDateTime, fmtSigned } from "../format";
import { TIERS } from "../tiers";
import { useTooltip } from "./ui";

export interface EloChartPoint {
  matchId: number;
  date: number; // epoch seconds
  elo: number; // post-match rating
  change: number;
  decayed: boolean;
  outcome?: "win" | "loss" | "draw";
  opponent?: string | null;
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

function linePathOf(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

/** Index of the point nearest the target; the positions must be in ascending order. */
function nearestIndex(xs: number[], target: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1]! - target) <= Math.abs(xs[lo]! - target)) return lo - 1;
  return lo;
}

const sq = (x: number, y: number, s: number, fill: string, key?: string | number) => (
  <rect
    key={key}
    x={x - s / 2}
    y={y - s / 2}
    width={s}
    height={s}
    rx={2}
    fill={fill}
    stroke="var(--void)"
    strokeWidth={2}
    shapeRendering="crispEdges"
  />
);

export function EloChart({
  points,
  height = 300,
  onSelect,
}: {
  points: EloChartPoint[];
  height?: number;
  onSelect?: (matchId: number) => void;
}) {
  const tt = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;

  const view = useMemo(() => {
    const sorted = [...points].sort((a, b) => a.date - b.date || a.matchId - b.matchId);
    const x0 = 0;
    const x1 = Math.max(sorted.length - 1, 1);
    const ys = sorted.map((p) => p.elo);
    let yLo = Math.min(...ys);
    let yHi = Math.max(...ys);
    const pad = Math.max((yHi - yLo) * 0.14, 24);
    yLo -= pad;
    yHi += pad;
    const sx = (x: number) => PAD.l + ((x - x0) / Math.max(x1 - x0, 1)) * (W - PAD.l - PAD.r);
    const sy = (y: number) => H - PAD.b - ((y - yLo) / Math.max(yHi - yLo, 1)) * (H - PAD.t - PAD.b);
    const px = sorted.map((p, i) => ({ ...p, X: sx(i), Y: sy(p.elo) }));
    const peak = px.reduce((a, b) => (b.elo > a.elo ? b : a), px[0]!);
    const floor = px.reduce((a, b) => (b.elo < a.elo ? b : a), px[0]!);
    return { sorted: px, xs: px.map((p) => p.X), x0, x1, yLo, yHi, sx, sy, peak, floor };
  }, [points, H]);

  /** Everything that does not depend on the cursor. */
  const statics = useMemo(() => {
    const { sorted, x0, x1, yLo, yHi, sx, sy, peak, floor } = view;
    if (sorted.length === 0) return null;

    const linePath = linePathOf(sorted.map((p) => ({ x: p.X, y: p.Y })));
    const last = sorted[sorted.length - 1]!;
    const areaPath = `${linePath} V${(H - PAD.b).toFixed(1)} H${sorted[0]!.X.toFixed(1)} Z`;
    const bands = TIERS.filter(
      (t) => t.min < yHi && (t.max === Infinity ? yHi > 2000 : t.max > yLo),
    );

    const layers = (
      <>
          <defs>
            <linearGradient id="eloArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
            </linearGradient>
            <clipPath id="plot">
              <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} rx={8} />
            </clipPath>
          </defs>

          <rect
            x={PAD.l}
            y={PAD.t}
            width={W - PAD.l - PAD.r}
            height={H - PAD.t - PAD.b}
            rx={8}
            fill="var(--slot)"
            stroke="var(--border)"
            strokeWidth={2}
            shapeRendering="crispEdges"
          />

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
                fontFamily="var(--font-label)"
                letterSpacing="1"
                fill={t.color}
                opacity={0.9}
              >
                {t.label.toUpperCase()}
              </text>
            );
          })}

          {niceTicks(yLo, yHi).map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.l - 8} y={sy(v) + 3.5} textAnchor="end" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
                {Math.round(v)}
              </text>
            </g>
          ))}
          {niceTicks(1, sorted.length, 6)
            .filter((v) => v >= 1 && v <= sorted.length)
            .map((v) => (
              <text key={v} x={sx(v - 1)} y={H - 9} textAnchor="middle" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
                {Math.round(v)}
              </text>
            ))}
          <text x={(PAD.l + W - PAD.r) / 2} y={H - 0.5} textAnchor="middle" fontSize={9} fontFamily="var(--font-label)" fill="var(--text-muted)" letterSpacing="1.4">
            RATED GAMES
          </text>

          <g clipPath="url(#plot)">
            <path d={areaPath} fill="url(#eloArea)" />
            <path d={linePath} fill="none" stroke="var(--gold)" strokeWidth={2} strokeLinejoin="round" />
            {sorted.filter((p) => p.decayed).map((p, i) => sq(p.X, p.Y, 7, "var(--behind)", i))}
          </g>

          {peak !== last && (
            <g>
              {sq(peak.X, peak.Y, 7, "var(--gold-hot)")}
              <text x={peak.X} y={peak.Y - 10} textAnchor="middle" fontSize={9} fontFamily="var(--font-label)" fill="var(--gold-hot)">
                PB {peak.elo}
              </text>
            </g>
          )}
          <g>
            {sq(floor.X, floor.Y, 7, "var(--text-muted)")}
            <text x={floor.X} y={floor.Y + 18} textAnchor="middle" fontSize={9} fontFamily="var(--font-label)" fill="var(--text-muted)">
              LOW {floor.elo}
            </text>
          </g>
      </>
    );

    // Drawn after the crosshair, so it stays on top of it.
    const badge = (
          <g>
            {sq(last.X, last.Y, 8, "var(--gold)")}
            <rect x={last.X + 9} y={last.Y - 12} width={52} height={22} rx={5} fill="var(--gold)" stroke="var(--void)" strokeWidth={2} />
            <text x={last.X + 35} y={last.Y + 4} textAnchor="middle" fontSize={12} fontWeight={700} fontFamily="var(--font-mono)" fill="#171205">
              {last.elo}
            </text>
          </g>
    );

    return { layers, badge };
  }, [view, H]);

  if (points.length === 0) return <div className="muted">No rated games.</div>;
  const { sorted, xs } = view;


  const indexAt = (evt: React.MouseEvent<SVGSVGElement>): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || xs.length === 0) return null;
    const mx = ((evt.clientX - rect.left) / rect.width) * W;
    return nearestIndex(xs, mx);
  };

  const onMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const best = indexAt(evt);
    if (best === null) return;
    setHover((prev) => (prev === best ? prev : best));
    const p = sorted[best]!;
    tt.show(evt, (
      <div>
        <div className="tt-title">
          {p.outcome ? p.outcome.toUpperCase() : "GAME"}
          {p.opponent ? ` vs ${p.opponent}` : ""}
        </div>
        <div>{fmtDateTime(p.date)}</div>
        <div>
          <b style={{ color: "var(--text-primary)" }}>{p.elo}</b> elo{" "}
          <span style={{ color: p.change >= 0 ? "var(--ahead)" : "var(--behind)" }}>
            ({fmtSigned(p.change)})
          </span>
        </div>
        {p.decayed && <div style={{ color: "var(--behind)" }}>rank decay entry</div>}
        {onSelect && !p.decayed && (
          <div style={{ color: "var(--gold-dim)", marginTop: 4 }}>click to open this game</div>
        )}
      </div>
    ));
  };

  return (
    <div className="scroll-x">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", minWidth: 520, display: "block", cursor: "crosshair" }}
        onMouseMove={onMove}
        onClick={(evt) => {
          if (!onSelect) return;
          const at = indexAt(evt);
          const p = at === null ? null : sorted[at];
          if (p) onSelect(p.matchId);
        }}
        onMouseLeave={() => {
          setHover(null);
          tt.hide();
        }}
      >
        {statics?.layers}

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

        {statics?.badge}
      </svg>
      {tt.el}
    </div>
  );
}
