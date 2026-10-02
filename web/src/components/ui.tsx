import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The pointer goes on the empty glow layer; on the card it would restyle every node inside. */
function useCardGlow() {
  const ref = useRef<HTMLSpanElement>(null);
  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return { ref, onMouseMove };
}

export interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
}

export function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const show = (e: { clientX: number; clientY: number }, content: ReactNode) =>
    setTip({ x: e.clientX, y: e.clientY, content });
  const hide = () => setTip(null);
  let el = null;
  if (tip) {
    // Placed by translation alone; offsetting from the left would squeeze the box near the right edge.
    const flipX = tip.x > window.innerWidth * 0.62;
    const flipY = tip.y > window.innerHeight * 0.72;
    const tx = flipX ? `calc(${tip.x}px - 100% - 14px)` : `${tip.x + 14}px`;
    const ty = flipY ? `calc(${tip.y}px - 100% - 12px)` : `${tip.y + 16}px`;
    // Portalled to the body, since a transformed ancestor would anchor this fixed box to itself.
    el = createPortal(
      <div className="viz-tooltip" style={{ left: 0, top: 0, transform: `translate(${tx}, ${ty})` }}>
        {tip.content}
      </div>,
      document.body,
    );
  }
  return { show, hide, el };
}

export interface TableSpec {
  headers: string[];
  rows: (string | number)[][];
  numeric?: number[];
}

export function ChartCard(props: {
  title: string;
  sub?: string;
  table?: TableSpec;
  actions?: ReactNode;
  stale?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const glow = useCardGlow();
  return (
    <div className={`card glow-card${props.stale ? " stale" : ""}`} onMouseMove={glow.onMouseMove}>
      <span className="card-glow" aria-hidden ref={glow.ref} />
      <div className="card-head">
        <span className="card-title">{props.title}</span>
        {props.sub && <span className="card-sub">{props.sub}</span>}
        {props.actions && <span className="card-actions">{props.actions}</span>}
        {props.table && (
          <span className="card-actions">
            <button className={showTable ? "" : "on"} onClick={() => setShowTable(false)}>
              Chart
            </button>
            <button className={showTable ? "on" : ""} onClick={() => setShowTable(true)}>
              Table
            </button>
          </span>
        )}
      </div>
      {showTable && props.table ? <DataTable spec={props.table} /> : props.children}
      {props.footer}
    </div>
  );
}

export function DataTable({ spec }: { spec: TableSpec }) {
  const numeric = new Set(spec.numeric ?? []);
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table className="data">
        <thead>
          <tr>
            {spec.headers.map((h, i) => (
              <th key={i} className={numeric.has(i) ? "num" : ""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={numeric.has(j) ? "num" : j === 0 ? "strong" : ""}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatTile(props: {
  label: string;
  value: ReactNode;
  delta?: { text: string; dir: "up" | "down" | "flat" };
  sub?: string;
  hero?: boolean;
}) {
  return (
    <div className="card">
      <div className="stat-label">{props.label}</div>
      <div className={`stat-value${props.hero ? " hero" : ""}`}>{props.value}</div>
      {props.delta && (
        <div className={`stat-delta ${props.delta.dir === "flat" ? "" : props.delta.dir}`}>
          {props.delta.text}
        </div>
      )}
      {props.sub && <div className="card-sub" style={{ marginTop: 4 }}>{props.sub}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="key" key={it.label}>
          <span className="swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="error-box">{message}</div>;
}

export function LoadingNote({ text }: { text?: string }) {
  const msg =
    text ?? "Loading — first view of a player ingests their history from the Ranked API (a few seconds)…";
  return (
    <div className="card">
      <span className="shimmer-text" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
        {msg}
        {/* the lit copy the sweep reveals; decoration, so it is hidden from readers */}
        <span className="shimmer-sweep" aria-hidden>
          {msg}
        </span>
      </span>
    </div>
  );
}
