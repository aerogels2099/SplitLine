/**
 * Win rate per player, broken down by overworld structure and bastion type.
 * A match whose seed was not filtered has no archetype and is skipped.
 */
import { median } from "./stats.js";
import type { MatchInfo } from "../shared/types.js";

export interface ArchetypeStats {
  archetype: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  /** Median finish time, in milliseconds, across the wins on this archetype. */
  medianWinTime: number | null;
}

function isScorable(m: MatchInfo, uuid: string): boolean {
  return (
    m.type === 2 &&
    !m.decayed &&
    m.players.some((p) => p.uuid === uuid) &&
    m.players.length === 2
  );
}

/** Prefers the undocumented flat fields and falls back to the seed record. */
export function bastionOf(m: MatchInfo): string | null {
  return m.bastionType ?? m.seed?.nether ?? null;
}
export function overworldOf(m: MatchInfo): string | null {
  return m.seedType ?? m.seed?.overworld ?? null;
}

function aggregate(
  matches: MatchInfo[],
  uuid: string,
  archetypeOf: (m: MatchInfo) => string | null,
): ArchetypeStats[] {
  const map = new Map<string, { wins: number; losses: number; draws: number; winTimes: number[] }>();
  for (const m of matches) {
    if (!isScorable(m, uuid)) continue;
    const arch = archetypeOf(m);
    if (arch === null) continue; // no filtered seed, so nothing to credit
    let acc = map.get(arch);
    if (!acc) {
      acc = { wins: 0, losses: 0, draws: 0, winTimes: [] };
      map.set(arch, acc);
    }
    if (m.result.uuid === uuid) {
      acc.wins++;
      if (!m.forfeited) acc.winTimes.push(Number(m.result.time));
    } else if (m.result.uuid === null) acc.draws++;
    else acc.losses++;
  }
  return [...map.entries()]
    .map(([archetype, a]) => {
      const games = a.wins + a.losses + a.draws;
      return {
        archetype,
        games,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        winRate: games > 0 ? (a.wins + a.draws / 2) / games : NaN,
        medianWinTime: a.winTimes.length > 0 ? median(a.winTimes) : null,
      };
    })
    .sort((x, y) => y.games - x.games);
}

export function performanceByBastion(matches: MatchInfo[], uuid: string): ArchetypeStats[] {
  return aggregate(matches, uuid, bastionOf);
}

export function performanceByOverworld(matches: MatchInfo[], uuid: string): ArchetypeStats[] {
  return aggregate(matches, uuid, overworldOf);
}

export interface PrematchPanel {
  bastion: { archetype: string; a: ArchetypeStats | null; b: ArchetypeStats | null }[];
  overworld: { archetype: string; a: ArchetypeStats | null; b: ArchetypeStats | null }[];
}

export function prematchPanel(
  matchesA: MatchInfo[],
  uuidA: string,
  matchesB: MatchInfo[],
  uuidB: string,
): PrematchPanel {
  const join = (
    aStats: ArchetypeStats[],
    bStats: ArchetypeStats[],
  ): { archetype: string; a: ArchetypeStats | null; b: ArchetypeStats | null }[] => {
    const keys = [...new Set([...aStats.map((s) => s.archetype), ...bStats.map((s) => s.archetype)])];
    return keys
      .map((k) => ({
        archetype: k,
        a: aStats.find((s) => s.archetype === k) ?? null,
        b: bStats.find((s) => s.archetype === k) ?? null,
      }))
      .sort((x, y) => (y.a?.games ?? 0) + (y.b?.games ?? 0) - ((x.a?.games ?? 0) + (x.b?.games ?? 0)));
  };
  return {
    bastion: join(performanceByBastion(matchesA, uuidA), performanceByBastion(matchesB, uuidB)),
    overworld: join(performanceByOverworld(matchesA, uuidA), performanceByOverworld(matchesB, uuidB)),
  };
}
