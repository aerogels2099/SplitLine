export interface Tier {
  key: string;
  label: string;
  min: number;
  /** Exclusive upper bound, unbounded for the top tier. */
  max: number;
  color: string; // a theme variable, resolved both in the page and in inline vector art
}

export const TIERS: Tier[] = [
  { key: "coal", label: "Coal", min: 0, max: 600, color: "var(--tier-coal)" },
  { key: "iron", label: "Iron", min: 600, max: 900, color: "var(--tier-iron)" },
  { key: "gold", label: "Gold", min: 900, max: 1200, color: "var(--tier-gold)" },
  { key: "emerald", label: "Emerald", min: 1200, max: 1500, color: "var(--tier-emerald)" },
  { key: "diamond", label: "Diamond", min: 1500, max: 2000, color: "var(--tier-diamond)" },
  { key: "netherite", label: "Netherite", min: 2000, max: Infinity, color: "var(--tier-netherite)" },
];

export function tierOf(elo: number | null | undefined): Tier | null {
  if (elo === null || elo === undefined) return null;
  return TIERS.find((t) => elo >= t.min && elo < t.max) ?? null;
}
