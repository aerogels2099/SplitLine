import { describe, expect, it } from "vitest";
import {
  performanceByBastion,
  performanceByOverworld,
  prematchPanel,
} from "../src/analysis/seeds.js";
import { userA, userAMatches, userB, userBMatches } from "./helpers.js";

describe("seed archetype performance", () => {
  const matches = userAMatches();
  const uuid = userA().uuid;

  it("aggregates win rate by bastion type", () => {
    const stats = performanceByBastion(matches, uuid);
    expect(stats.length).toBeGreaterThan(0);
    for (const s of stats) {
      expect(s.wins + s.losses + s.draws).toBe(s.games);
      expect(s.winRate).toBeGreaterThanOrEqual(0);
      expect(s.winRate).toBeLessThanOrEqual(1);
      // Bastion archetypes come from the API's known set.
      expect(typeof s.archetype).toBe("string");
      expect(s.archetype.length).toBeGreaterThan(0);
    }
    // Total games across archetypes never exceeds the input match count.
    const total = stats.reduce((n, s) => n + s.games, 0);
    expect(total).toBeLessThanOrEqual(matches.length);
  });

  it("guards against null seeds: decayed matches contribute nothing", () => {
    const decayed = matches.filter((m) => m.decayed);
    for (const list of [performanceByBastion(decayed, uuid), performanceByOverworld(decayed, uuid)]) {
      expect(list.length).toBe(0);
    }
  });

  it("builds a two-player pre-match panel with shared archetype keys", () => {
    const panel = prematchPanel(matches, uuid, userBMatches(), userB().uuid);
    expect(panel.bastion.length).toBeGreaterThan(0);
    for (const row of panel.bastion) {
      expect(row.a !== null || row.b !== null).toBe(true);
      if (row.a) expect(row.a.archetype).toBe(row.archetype);
      if (row.b) expect(row.b.archetype).toBe(row.archetype);
    }
  });
});
