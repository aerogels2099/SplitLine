import { describe, expect, it } from "vitest";
import { buildGameHistory, labelRun, seasonsPlayed } from "../src/analysis/history.js";
import { extractRunSplits, MILESTONES, SEGMENTS } from "../src/analysis/splits.js";
import { matchDetails, userA, userAMatches } from "./helpers.js";

const uuid = userA().uuid;
const ranked = userAMatches().filter((m) => m.type === 2);

describe("seasonsPlayed", () => {
  it("lists each season once, newest first", () => {
    const seasons = seasonsPlayed(ranked);
    expect(seasons).toEqual([...new Set(ranked.map((m) => m.season))].sort((a, b) => b - a));
    expect(new Set(seasons).size).toBe(seasons.length);
  });

  it("is empty for a player with no matches", () => {
    expect(seasonsPlayed([])).toEqual([]);
  });
});

describe("buildGameHistory", () => {
  const games = buildGameHistory(ranked, uuid);

  it("returns one record per match, newest first", () => {
    expect(games).toHaveLength(ranked.length);
    const dates = games.map((g) => g.date);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("classifies the outcome from result.uuid, with null meaning a draw", () => {
    for (const g of games) {
      const m = ranked.find((x) => x.id === g.matchId)!;
      const expected =
        m.result.uuid === null ? "draw" : m.result.uuid === uuid ? "win" : "loss";
      expect(g.outcome).toBe(expected);
    }
    expect(games.filter((g) => g.outcome === "draw").every((g) => g.time === null)).toBe(true);
  });

  it("reports the pre-match rating, not the current one (gotcha 10)", () => {
    for (const g of games) {
      const m = ranked.find((x) => x.id === g.matchId)!;
      const change = m.changes.find((c) => c.uuid === uuid);
      expect(g.eloBefore).toBe(change?.eloRate ?? null);
      if (g.eloBefore !== null && g.eloChange !== null) {
        expect(g.eloAfter).toBe(g.eloBefore + g.eloChange);
      }
    }
  });

  it("chains: each game's post-match rating is the next game's pre-match rating", () => {
    const rated = [...games]
      .filter((g) => g.eloBefore !== null && g.eloAfter !== null)
      .reverse(); // oldest first, so each game follows the one before it
    for (let i = 1; i < rated.length; i++) {
      expect(rated[i]!.eloBefore).toBe(rated[i - 1]!.eloAfter);
    }
    expect(rated.length).toBeGreaterThan(1);
  });

  it("names the opponent with their rating at match time", () => {
    const withOpponent = games.filter((g) => g.opponent !== null);
    expect(withOpponent.length).toBeGreaterThan(0);
    for (const g of withOpponent) {
      const m = ranked.find((x) => x.id === g.matchId)!;
      expect(m.players.some((p) => p.uuid === g.opponent!.uuid)).toBe(true);
      expect(g.opponent!.uuid).not.toBe(uuid);
    }
  });

  it("restricts to one season when asked", () => {
    const season = seasonsPlayed(ranked)[0]!;
    const only = buildGameHistory(ranked, uuid, season);
    expect(only.every((g) => g.season === season)).toBe(true);
    expect(only.length).toBe(ranked.filter((m) => m.season === season).length);
  });
});

describe("labelRun", () => {
  it("emits one labelled row per milestone and per segment", () => {
    const completed = matchDetails().find((m) => !m.forfeited && m.result.uuid !== null)!;
    const run = labelRun(extractRunSplits(completed, completed.result.uuid!)!);
    expect(run.splits.map((s) => s.key)).toEqual(MILESTONES.map((m) => m.key));
    expect(run.segments.map((s) => s.key)).toEqual(SEGMENTS.map((s) => s.key));
    expect(run.splits.every((s) => s.label.length > 0)).toBe(true);
    expect(run.won).toBe(true);
    expect(run.splits.at(-1)!.time).toBe(completed.result.time);
  });
});
