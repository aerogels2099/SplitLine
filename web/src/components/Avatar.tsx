/** Minecraft head avatar with a graceful fallback block, + rank tier chip. */
import { useState } from "react";
import { tierOf } from "../tiers";

export function Avatar({ uuid, name, size = 32 }: { uuid: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="avatar"
        aria-hidden
        style={{
          width: size,
          height: size,
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: size * 0.45,
          color: "var(--text-secondary)",
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      src={`https://mc-heads.net/avatar/${uuid}/${size * 2}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function TierChip({ elo, showElo = false }: { elo: number | null; showElo?: boolean }) {
  const tier = tierOf(elo);
  if (!tier) {
    return <span className="pill">unrated</span>;
  }
  return (
    <span className="tier-chip" style={{ "--tier-c": tier.color } as React.CSSProperties}>
      <span className="dot" />
      {tier.label}
      {showElo && elo !== null ? ` · ${elo}` : ""}
    </span>
  );
}
