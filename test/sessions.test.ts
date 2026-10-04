import { describe, expect, it } from "vitest";
import { SESSION_GAP_SECONDS, sessionReport, splitSessions } from "../src/analysis/sessions.js";
import { asEpochSeconds, asMillis } from "../src/shared/brand.js";
import type { MatchInfo, MatchType, UserProfile } from "../src/shared/types.js";
import { userA, userAMatches } from "./helpers.js";

const ME = "me";
const FOE = "foe";
const T0 = 1_700_000_000;

const profile = (uuid: string): UserProfile => ({
  uuid,
  nickname: uuid,
  roleType: 0,
  eloRate: null,
  eloRank: null,
  country: null,
});

interface GameOptions {
  result?: "win" | "loss" | "draw";
  forfeited?: boolean;
  decayed?: boolean;
  type?: MatchType;
  elo?: [number | null, number | null];
}

// Only the fields the session analysis reads; the rest of the match is left out.
function game(id: number, seconds: number, o: GameOptions = {}): MatchInfo {
  const result = o.result ?? "win";
  const [mine, theirs] = o.elo ?? [1500, 1500];
  return {
    id,
    type: o.type ?? 2,
    season: 12,
    date: asEpochSeconds(T0 + seconds),
    players: [profile(ME), profile(FOE)],
    spectators: [],
    result: { uuid: result === "draw" ? null : result === "win" ? ME : FOE, time: asMillis(600_000) },
    forfeited: o.forfeited ?? false,
    decayed: o.decayed ?? false,
    rank: { season: 12, allTime: 12 },
    changes: [
      { uuid: ME, change: mine === null ? null : result === "win" ? 10 : -10, eloRate: mine },
      { uuid: FOE, change: theirs === null ? null : result === "win" ? -10 : 10, eloRate: theirs },
    ],
    beginner: false,
    botSource: null,
  } as MatchInfo;
}

function sessionsOf(count: number, length: number, pattern: (s: number, p: number) => boolean): MatchInfo[] {
  const out: MatchInfo[] = [];
  for (let s = 0; s < count; s++) {
    for (let p = 1; p <= length; p++) {
      const id = out.length + 1;
      out.push(game(id, s * 4 * 3600 + p * 600, { result: pattern(s, p) ? "win" : "loss" }));
    }
  }
  return out;
}

describe("splitSessions on real matches", () => {
  const uuid = userA().uuid;
  const matches = userAMatches();
  const sessions = splitSessions(matches, uuid);
  const counted = matches.filter((m) => m.type === 2 && !m.decayed);

  it("places every ranked game in exactly one session, oldest first", () => {
    const ids = sessions.flatMap((s) => s.games.map((g) => g.matchId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(counted.map((m) => m.id).sort());
    const dates = sessions.flatMap((s) => s.games.map((g) => g.date));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(sessions.length).toBeGreaterThan(1);
  });

  it("breaks sessions only at gaps over the threshold", () => {
    for (const s of sessions) {
      for (let i = 1; i < s.games.length; i++) {
        expect(s.games[i]!.date - s.games[i - 1]!.date).toBeLessThanOrEqual(SESSION_GAP_SECONDS);
      }
    }
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i]!.start - sessions[i - 1]!.end).toBeGreaterThan(SESSION_GAP_SECONDS);
    }
  });

  it("tallies each session from its own games", () => {
    for (const s of sessions) {
      expect(s.wins + s.losses + s.draws).toBe(s.games.length);
      expect(s.eloChange).toBe(s.games.reduce((n, g) => n + (g.eloChange ?? 0), 0));
      expect(s.games.map((g) => g.position)).toEqual(s.games.map((_, i) => i + 1));
    }
  });
});

describe("splitSessions", () => {
  it("keeps a game exactly at the gap in the same session and splits one second past it", () => {
    const same = splitSessions([game(1, 0), game(2, SESSION_GAP_SECONDS)], ME);
    expect(same).toHaveLength(1);
    const split = splitSessions([game(1, 0), game(2, SESSION_GAP_SECONDS + 1)], ME);
    expect(split).toHaveLength(2);
  });

  it("measures the gap from the previous game, not the session's start", () => {
    const chain = [0, 1, 2, 3].map((i) => game(i + 1, i * 20 * 60));
    expect(splitSessions(chain, ME)).toHaveLength(1);
  });

  it("leaves out decayed, unranked and other players' games (gotcha 2)", () => {
    const other = { ...game(4, 1200), players: [profile("x"), profile("y")] };
    const sessions = splitSessions(
      [game(1, 0), game(2, 600, { decayed: true }), game(3, 900, { type: 1 }), other],
      ME,
    );
    expect(sessions.flatMap((s) => s.games.map((g) => g.matchId))).toEqual([1]);
  });

  it("counts losses in a row before each game, restarting each session", () => {
    const results = ["loss", "loss", "win", "loss", "draw", "loss"] as const;
    const matches = results.map((r, i) => game(i + 1, i * 600, { result: r }));
    matches.push(game(7, 10 * 3600, { result: "loss" }));
    const [first, second] = splitSessions(matches, ME);
    expect(first!.games.map((g) => g.lossStreak)).toEqual([0, 1, 2, 0, 1, 0]);
    expect(second!.games[0]!.lossStreak).toBe(0);
  });

  it("counts a forfeit against the player only when they lost it", () => {
    const [s] = splitSessions(
      [game(1, 0, { result: "loss", forfeited: true }), game(2, 600, { result: "win", forfeited: true })],
      ME,
    );
    expect(s!.games.map((g) => g.forfeitedByPlayer)).toEqual([true, false]);
    expect(s!.forfeits).toBe(1);
  });

  it("scores draws as half and leaves placement games unrated (gotcha 4)", () => {
    const [s] = splitSessions(
      [game(1, 0, { result: "draw" }), game(2, 600, { elo: [null, 1500] }), game(3, 1200, { elo: [1700, 1500] })],
      ME,
    );
    expect(s!.games.map((g) => g.score)).toEqual([0.5, 1, 1]);
    expect(s!.games[1]!.expected).toBeNull();
    expect(s!.games[2]!.expected).toBeGreaterThan(0.5);
    expect(s!.draws).toBe(1);
  });
});

describe("sessionReport", () => {
  it("reads every bucket against the player's own baseline", () => {
    // Three sessions in four won outright: well above Elo, but no better or worse at any game number.
    const report = sessionReport(sessionsOf(80, 3, (s) => s % 4 !== 0), ME);
    expect(report.baseline).toBeCloseTo(0.25, 10);
    for (const b of report.byPosition.slice(0, 3)) expect(b.relative).toBeCloseTo(0, 10);
    expect(report.dropFrom).toBeNull();
  });

  it("finds the game number where results fall off", () => {
    const report = sessionReport(sessionsOf(60, 6, (_, p) => p <= 3), ME);
    expect(report.dropFrom).toBe(4);
    const four = report.byPosition[3]!;
    expect(four.high).toBeLessThan(0);
    expect(report.byPosition[0]!.low).toBeGreaterThan(0);
  });

  it("does not report a rise as a drop", () => {
    const report = sessionReport(sessionsOf(60, 6, (_, p) => p > 3), ME);
    expect(report.dropFrom).toBeNull();
  });

  it("does not call a drop on too few games", () => {
    const report = sessionReport(sessionsOf(8, 6, (_, p) => p <= 3), ME);
    expect(report.dropFrom).toBeNull();
    expect(report.byPosition.every((b) => b.thin)).toBe(true);
  });

  it("groups long sessions and long streaks into a final bucket", () => {
    const report = sessionReport(sessionsOf(10, 10, () => false), ME);
    expect(report.byPosition.map((b) => b.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8+"]);
    expect(report.byPosition.at(-1)!.games).toBe(30);
    expect(report.afterLosses.map((b) => b.label)).toEqual(["0", "1", "2", "3+"]);
    expect(report.afterLosses.at(-1)!.games).toBe(70);
  });

  it("reports the forfeit rate after losses", () => {
    const matches = [
      game(1, 0, { result: "loss" }),
      game(2, 600, { result: "loss", forfeited: true }),
      game(3, 1200, { result: "win", forfeited: true }),
    ];
    const report = sessionReport(matches, ME);
    expect(report.afterLosses.map((b) => b.forfeitRate)).toEqual([0, 1, 0, 0]);
  });
});
