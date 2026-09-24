import { describe, expect, it } from "vitest";
import { predictMatchup, type MatchupSide } from "../src/analysis/matchup.js";
import { buildSplitDistributions } from "../src/analysis/pacing.js";
import { extractAllRuns } from "../src/analysis/splits.js";
import { buildWinProbModel, type WinProbModel } from "../src/analysis/winprob.js";
import { asEpochSeconds, asMillis } from "../src/shared/brand.js";
import type { MatchInfo, UserProfile } from "../src/shared/types.js";
import { matchDetails, userA, userAMatches, userB, userBMatches } from "./helpers.js";

const runs = extractAllRuns(matchDetails());
const model = buildWinProbModel(runs);
const splits = buildSplitDistributions(runs);

const profile = (uuid: string): UserProfile => ({
  uuid,
  nickname: uuid,
  roleType: 0,
  eloRate: 1500,
  eloRank: 1,
  country: null,
});

function seedMatch(uuid: string, foe: string, bastion: string, won: boolean, i: number): MatchInfo {
  return {
    id: i,
    type: 2,
    season: 12,
    date: asEpochSeconds(1_700_000_000 + i),
    players: [profile(uuid), profile(foe)],
    spectators: [],
    result: { uuid: won ? uuid : foe, time: asMillis(9 * 60_000) },
    forfeited: false,
    decayed: false,
    rank: { season: 12, allTime: 12 },
    changes: [],
    beginner: false,
    botSource: null,
    bastionType: bastion,
  } as MatchInfo;
}

function side(uuid: string, elo: number | null, matches: MatchInfo[] = []): MatchupSide {
  return { uuid, nickname: uuid, elo, matches, model, splits, band: "all" };
}

const realA = (elo: number | null = 1850) => side(userA().uuid, elo, userAMatches());
const realB = (elo: number | null = 1620) => side(userB().uuid, elo, userBMatches());

describe("matchup prediction", () => {
  it("is an even call with equal ratings and no history", () => {
    const p = predictMatchup(side("a", 1500), side("b", 1500));
    expect(p.pElo).toBe(0.5);
    expect(p.pBase).toBe(0.5);
    expect(p.h2h.games).toBe(0);
    expect(p.bastion).toEqual([]);
  });

  it("reads a rating gap through the elo prior", () => {
    const p = predictMatchup(side("a", 1900), side("b", 1500));
    expect(p.pElo).toBeCloseTo(0.834, 3);
    expect(p.pBase).toBeCloseTo(0.834, 3);
  });

  it("treats an unrated player as an even call", () => {
    expect(predictMatchup(side("a", null), side("b", 1500)).pElo).toBe(0.5);
    expect(predictMatchup(side("a", 2400), side("b", null)).pElo).toBe(0.5);
  });

  it("shrinks a thin head-to-head record and trusts a thick one", () => {
    const even = () => [side("a", 1500), side("b", 1500)] as const;
    const thin = predictMatchup(...even(), { aWins: 1, bWins: 0, draws: 0 });
    const thick = predictMatchup(...even(), { aWins: 20, bWins: 0, draws: 0 });

    expect(thin.pBase).toBeGreaterThan(0.5);
    expect(thin.pBase).toBeLessThan(0.56);
    expect(thick.pBase).toBeGreaterThan(0.8);
    expect(thick.pBase).toBeLessThan(1);
  });

  it("lets a losing record pull against the rating", () => {
    const favoured = predictMatchup(side("a", 1900), side("b", 1500));
    const haunted = predictMatchup(side("a", 1900), side("b", 1500), { aWins: 0, bWins: 12, draws: 0 });
    expect(haunted.pBase).toBeLessThan(favoured.pBase);
    expect(haunted.pBase).toBeLessThan(0.5);
  });

  it("counts a drawn game as half a win and as a whole game", () => {
    const even = () => [side("a", 1500), side("b", 1500)] as const;
    const clean = predictMatchup(...even(), { aWins: 5, bWins: 5, draws: 0 });
    const drawn = predictMatchup(...even(), { aWins: 4, bWins: 4, draws: 2 });
    expect(drawn.pBase).toBeCloseTo(clean.pBase, 10);
    expect(drawn.h2h.games).toBe(10);
    expect(drawn.h2h.draws).toBe(2);

    const bare = predictMatchup(...even(), { aWins: 8, bWins: 0, draws: 0 });
    const padded = predictMatchup(...even(), { aWins: 8, bWins: 0, draws: 4 });
    expect(padded.pBase).toBeLessThan(bare.pBase);
  });

  it("stays complementary when the two sides are swapped", () => {
    const ab = predictMatchup(realA(), realB(), { aWins: 7, bWins: 3, draws: 0 });
    const ba = predictMatchup(realB(), realA(), { aWins: 3, bWins: 7, draws: 0 });

    expect(ab.pElo + ba.pElo).toBeCloseTo(1, 10);
    expect(ab.pBase + ba.pBase).toBeCloseTo(1, 10);

    expect(ab.bastion.length).toBeGreaterThan(0);
    for (const row of ab.bastion) {
      const mirror = ba.bastion.find((r) => r.archetype === row.archetype);
      expect(mirror).toBeDefined();
      expect(row.p + mirror!.p).toBeCloseTo(1, 10);
    }
  });
});

describe("seed conditioning", () => {
  it("favours the player who is stronger on the archetype", () => {
    const aMatches = [
      ...Array.from({ length: 20 }, (_, i) => seedMatch("a", "x", "housing", true, i)),
      ...Array.from({ length: 20 }, (_, i) => seedMatch("a", "x", "treasury", false, 100 + i)),
    ];
    const bMatches = [
      ...Array.from({ length: 20 }, (_, i) => seedMatch("b", "y", "housing", false, 200 + i)),
      ...Array.from({ length: 20 }, (_, i) => seedMatch("b", "y", "treasury", true, 300 + i)),
    ];
    const p = predictMatchup(side("a", 1500, aMatches), side("b", 1500, bMatches));

    const housing = p.bastion.find((r) => r.archetype === "housing")!;
    const treasury = p.bastion.find((r) => r.archetype === "treasury")!;
    expect(housing.p).toBeGreaterThan(p.pBase);
    expect(treasury.p).toBeLessThan(p.pBase);
    expect(housing.shift).toBeGreaterThan(0);
    expect(treasury.shift).toBeLessThan(0);
    expect(housing.shift).toBeCloseTo(-treasury.shift, 6);
  });

  it("keeps every row auditable by its sample", () => {
    const p = predictMatchup(realA(), realB());
    expect(p.bastion.length).toBeGreaterThan(0);
    expect(p.overworld.length).toBeGreaterThan(0);
    for (const row of [...p.bastion, ...p.overworld]) {
      expect(row.a !== null || row.b !== null).toBe(true);
      expect(Math.max(row.a?.games ?? 0, row.b?.games ?? 0)).toBeGreaterThanOrEqual(3);
      expect(row.p).toBeGreaterThan(0);
      expect(row.p).toBeLessThan(1);
    }
  });

  it("drops archetypes neither player has played enough", () => {
    const aMatches = [
      ...Array.from({ length: 10 }, (_, i) => seedMatch("a", "x", "housing", true, i)),
      seedMatch("a", "x", "bridge", true, 50),
    ];
    const p = predictMatchup(side("a", 1500, aMatches), side("b", 1500));
    expect(p.bastion.map((r) => r.archetype)).toEqual(["housing"]);
  });

  it("ignores decayed and non-ranked games", () => {
    const junk = Array.from({ length: 10 }, (_, i) => {
      const m = seedMatch("a", "x", "housing", true, i);
      return i % 2 === 0 ? { ...m, decayed: true } : { ...m, type: 1 as const };
    });
    const p = predictMatchup(side("a", 1500, junk as MatchInfo[]), side("b", 1500));
    expect(p.bastion).toEqual([]);
  });
});

describe("split scenarios", () => {
  const p = predictMatchup(side("a", 1500), side("b", 1500));

  it("covers the milestones the corpus knows, never the finish", () => {
    expect(p.splits.length).toBeGreaterThan(0);
    expect(p.splits.map((s) => s.key)).not.toContain("finish");
    for (const s of p.splits) expect(s.points.length).toBe(5);
  });

  it("pays a faster split with a better result", () => {
    for (const s of p.splits) {
      const times = s.points.map((pt) => pt.timeMs);
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      for (let i = 1; i < s.points.length; i++) {
        expect(s.points[i]!.p).toBeLessThanOrEqual(s.points[i - 1]!.p);
      }
      expect(s.points[0]!.p).toBeGreaterThan(s.points[4]!.p);
    }
  });

  it("carries the sample each scenario was built from", () => {
    for (const s of p.splits) {
      const dist = splits.find((d) => d.key === s.key)!;
      expect(s.count).toBe(dist.count);
      expect(s.count).toBeGreaterThanOrEqual(8);
    }
  });

  it("drops a milestone the band has barely any runs for", () => {
    const thin = splits.map((d) => (d.key === "bastion" ? { ...d, count: 3 } : d));
    const thinSide: MatchupSide = { ...side("a", 1500), splits: thin };
    const out = predictMatchup(thinSide, side("b", 1500));
    expect(out.splits.map((s) => s.key)).not.toContain("bastion");
    expect(p.splits.map((s) => s.key)).toContain("bastion");
  });

  it("keeps a rating edge visible across the whole sweep", () => {
    const strong = predictMatchup(side("a", 2000, []), side("b", 1400, []));
    for (const s of strong.splits) {
      const same = p.splits.find((o) => o.key === s.key)!;
      for (let i = 0; i < s.points.length; i++) {
        expect(s.points[i]!.p).toBeGreaterThan(same.points[i]!.p);
      }
    }
  });
});

describe("real players", () => {
  it("predicts a matchup off the checked-in fixtures", () => {
    const p = predictMatchup(
      realA(userA().eloRate),
      realB(userB().eloRate),
      { aWins: 4, bWins: 6, draws: 0 },
    );
    expect(p.pBase).toBeGreaterThan(0);
    expect(p.pBase).toBeLessThan(1);
    expect(p.a.modelRuns).toBe(model.overall.n);
    expect(p.a.band).toBe("all");
    expect(p.h2h.games).toBe(10);
  });
});

describe("per-player pace models", () => {
  const paceModel = (meanFinalMs: number): WinProbModel => ({
    milestones: {
      nether_enter: { n: 50, meanRemaining: meanFinalMs * 0.8, sdRemaining: 60_000 },
      bastion: { n: 50, meanRemaining: meanFinalMs * 0.65, sdRemaining: 60_000 },
      fortress: { n: 50, meanRemaining: meanFinalMs * 0.5, sdRemaining: 60_000 },
      first_portal: { n: 50, meanRemaining: meanFinalMs * 0.35, sdRemaining: 60_000 },
      stronghold: { n: 50, meanRemaining: meanFinalMs * 0.2, sdRemaining: 60_000 },
      end_enter: { n: 50, meanRemaining: meanFinalMs * 0.1, sdRemaining: 60_000 },
    },
    overall: { n: 50, meanFinal: meanFinalMs, sdFinal: 90_000 },
  });

  const withModel = (uuid: string, m: WinProbModel, band: string): MatchupSide => ({
    uuid,
    nickname: uuid,
    elo: 1500,
    matches: [],
    model: m,
    splits,
    band,
  });

  const fast = paceModel(8 * 60_000);
  const slow = paceModel(13 * 60_000);

  it("reports the band and sample behind each side", () => {
    const p = predictMatchup(withModel("a", fast, "2400–2699"), withModel("b", slow, "900–1199"));
    expect(p.a.band).toBe("2400–2699");
    expect(p.b.band).toBe("900–1199");
    expect(p.a.modelRuns).toBe(50);
    expect(p.b.modelRuns).toBe(50);
  });
});
