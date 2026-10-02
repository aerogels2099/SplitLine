import { type ReactNode } from "react";
import { useTooltip } from "./ui";

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

export interface DivergingItem {
  label: string;
  value: number;
  display: string;
  hint?: ReactNode;
}

/** Negative is time saved, positive time lost. */
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
