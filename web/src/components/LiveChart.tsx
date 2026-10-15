import { useRef, useState } from "react";
import type { LivePoint } from "../api";
import { fmtMs } from "../format";
import { useTooltip } from "./ui";

const W = 920;
const H = 240;
const PAD = { l: 44, r: 130, t: 14, b: 30 };
const MINUTE = 60_000;

const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);

export function LiveChart({
  history,
  nowMs,
  nameA,
  nameB,
}: {
  history: LivePoint[];
  nowMs: number;
  nameA: string;
  nameB: string;
}) {
  const tt = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const span = Math.max(nowMs, MINUTE);
  const sx = (t: number) => PAD.l + (t / span) * (W - PAD.l - PAD.r);
  const sy = (p: number) => PAD.t + (1 - p) * (H - PAD.t - PAD.b);
  const mid = sy(0.5);
  const pts = history.map((h) => ({ x: sx(h.t), y: sy(h.pA), ...h }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area =
    pts.length > 0 ? `${line} L${pts.at(-1)!.x.toFixed(1)},${mid} L${pts[0]!.x.toFixed(1)},${mid} Z` : "";
  const stepMin = Math.max(1, Math.ceil(span / MINUTE / 6));
  const ticks = Array.from({ length: Math.floor(span / MINUTE / stepMin) + 1 }, (_, i) => i * stepMin);
  const last = pts.at(-1);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || pts.length === 0) return;
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.x - mx) < Math.abs(pts[best]!.x - mx)) best = i;
    setHover(best);
    const p = pts[best]!;
    tt.show(e, (
      <div>
        <div className="tt-title">{fmtMs(p.t)}</div>
        <div>
          {nameA} {Math.round(p.pA * 100)}% · {nameB} {Math.round((1 - p.pA) * 100)}%
        </div>
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
        onMouseLeave={() => {
          setHover(null);
          tt.hide();
        }}
      >
        <defs>
          <clipPath id="live-top">
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={mid - PAD.t} />
          </clipPath>
          <clipPath id="live-bottom">
            <rect x={PAD.l} y={mid} width={W - PAD.l - PAD.r} height={H - PAD.b - mid} />
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
        />
        {[0.25, 0.75].map((p) => (
          <line key={p} x1={PAD.l} x2={W - PAD.r} y1={sy(p)} y2={sy(p)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} stroke="var(--baseline)" strokeWidth={1} />
        {[1, 0.5, 0].map((p) => (
          <text key={p} x={PAD.l - 8} y={sy(p) + 3.5} textAnchor="end" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
            {p === 0.5 ? "50%" : "100%"}
          </text>
        ))}
        <text x={W - PAD.r + 10} y={PAD.t + 12} fontSize={11} fontFamily="var(--font-mono)" fill="var(--gold)">
          {short(nameA)}
        </text>
        <text x={W - PAD.r + 10} y={H - PAD.b - 4} fontSize={11} fontFamily="var(--font-mono)" fill="var(--diamond)">
          {short(nameB)}
        </text>
        {ticks.map((m) => (
          <text key={m} x={sx(m * MINUTE)} y={H - 9} textAnchor="middle" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-muted)">
            {m}:00
          </text>
        ))}

        <path d={area} fill="var(--gold)" fillOpacity={0.16} clipPath="url(#live-top)" />
        <path d={area} fill="var(--diamond)" fillOpacity={0.16} clipPath="url(#live-bottom)" />
        <path d={line} fill="none" stroke="var(--text-primary)" strokeWidth={2} strokeLinejoin="round" />
        {last && <circle cx={last.x} cy={last.y} r={4} fill={last.pA >= 0.5 ? "var(--gold)" : "var(--diamond)"} />}
        {hover !== null && pts[hover] && (
          <line x1={pts[hover]!.x} x2={pts[hover]!.x} y1={PAD.t} y2={H - PAD.b} stroke="var(--gold-dim)" strokeWidth={1} />
        )}
      </svg>
      {tt.el}
    </div>
  );
}
