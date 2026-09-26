import { describe, expect, it } from "vitest";
import {
  eloPredictions,
  fitEloDivisor,
  inRunPredictions,
  logLoss,
  pregamePredictions,
  ratedGames,
  ratedPair,
  reliability,
  replayState,
  score,
  temporalCutoff,
} from "../src/analysis/calibration.js";
import { extractAllRuns, RESET_EVENT } from "../src/analysis/splits.js";
import { eloExpectedScore } from "../src/analysis/stats.js";
import { buildBandedWinProbModels } from "../src/analysis/winprob.js";
import { asMillis } from "../src/shared/brand.js";
import type { MatchInfo } from "../src/shared/types.js";
import { matchDetails, userAMatches, userBMatches, versusMatches } from "./helpers.js";

describe("scoring", () => {
  it("bins predictions and reports what happened in each", () => {
    const bins = reliability([
      { p: 0.05, outcome: 0 },
      { p: 0.15, outcome: 0 },
      { p: 0.72, outcome: 1 },
      { p: 0.78, outcome: 0 },
      { p: 1, outcome: 1 },
    ]);
    expect(bins.map((b) => b.lo)).toEqual([0, 0.1, 0.7, 0.9]);
    const seventy = bins.find((b) => b.lo === 0.7)!;
    expect(seventy.n).toBe(2);
    expect(seventy.predicted).toBeCloseTo(0.75, 10);
    expect(seventy.observed).toBe(0.5);
    expect(bins.find((b) => b.lo === 0.9)!.n).toBe(1);
  });

  it("scores a coin flip at ln 2 and a quarter", () => {
    const flips = [
      { p: 0.5, outcome: 1 },
      { p: 0.5, outcome: 0 },
    ];
    expect(logLoss(flips)).toBeCloseTo(Math.LN2, 10);
    const s = score(flips);
    expect(s.n).toBe(2);
    expect(s.brier).toBeCloseTo(0.25, 10);
    expect(s.ece).toBe(0);
  });

  it("charges more for a confident mistake", () => {
    expect(logLoss([{ p: 0.9, outcome: 0 }])).toBeGreaterThan(logLoss([{ p: 0.6, outcome: 0 }]));
  });

  it("scores a draw as half a win, best met by predicting one half", () => {
    expect(logLoss([{ p: 0.5, outcome: 0.5 }])).toBeCloseTo(Math.LN2, 10);
    expect(logLoss([{ p: 0.5, outcome: 0.5 }])).toBeLessThan(logLoss([{ p: 0.7, outcome: 0.5 }]));
  });

  it("measures calibration error as the sample-weighted gap per bin", () => {
    const preds = [
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.75, outcome: i < 5 ? 1 : 0 })),
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.25, outcome: i < 5 ? 1 : 0 })),
    ];
    // Both bins observe 0.5 against predictions a quarter away.
    expect(score(preds).ece).toBeCloseTo(0.25, 10);
  });
});

describe("elo divisor fit", () => {
  const gaps = Array.from({ length: 81 }, (_, i) => (i - 40) * 20);
  const candidates = Array.from({ length: 161 }, (_, i) => 200 + i * 5);

  it("recovers the divisor that generated the games", () => {
    // Labels set to the exact expected score make the generating divisor the unique minimum.
    for (const truth of [400, 570, 750]) {
      const games = gaps.map((gap) => ({ gap, outcome: eloExpectedScore(gap, 0, truth) }));
      expect(fitEloDivisor(games, candidates)).toBe(truth);
    }
  });

  it("predicts from the rating gap alone", () => {
    const [even, oneDivisor] = eloPredictions(
      [
        { gap: 0, outcome: 1 },
        { gap: 570, outcome: 1 },
      ],
      570,
    );
    expect(even!.p).toBe(0.5);
    expect(oneDivisor!.p).toBeCloseTo(10 / 11, 10);
  });
});

describe("rated pairs", () => {
  const base = matchDetails().find((m) => ratedPair(m) !== null && m.result.uuid !== null)!;

  it("orders sides by uuid, whoever the api lists first", () => {
    const flipped: MatchInfo = {
      ...base,
      players: [...base.players].reverse(),
      changes: [...base.changes].reverse(),
    };
    expect(ratedPair(flipped)).toEqual(ratedPair(base));
    const r = ratedPair(base)!;
    expect(r.a.uuid < r.b.uuid).toBe(true);
  });

  it("scores the result from the side of a", () => {
    const r = ratedPair(base)!;
    expect(r.outcome).toBe(base.result.uuid === r.a.uuid ? 1 : 0);
    expect(ratedPair({ ...base, result: { ...base.result, uuid: null } })!.outcome).toBe(0.5);
  });

  it("skips games that carry no usable rating", () => {
    expect(ratedPair({ ...base, decayed: true })).toBeNull();
    expect(ratedPair({ ...base, type: 1 })).toBeNull();
    const placement = base.changes.map((c, i) => (i === 0 ? { ...c, eloRate: null } : c));
    expect(ratedPair({ ...base, changes: placement })).toBeNull();
  });

  it("builds games as the rating gap seen from a", () => {
    const r = ratedPair(base)!;
    expect(ratedGames([base])).toEqual([{ gap: r.a.elo - r.b.elo, outcome: r.outcome }]);
  });
});

describe("temporal split", () => {
  it("puts the requested share of dates before the cutoff", () => {
    const dates = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    const cut = temporalCutoff(dates, 0.7);
    expect(dates.filter((d) => d < cut).length).toBe(7);
    expect(dates.filter((d) => d >= cut).length).toBe(3);
  });
});

describe("replaying a timeline", () => {
  const base = matchDetails()[0]!;
  const at = (uuid: string, time: number, type: string) => ({ uuid, time: asMillis(time), type });
  const detail: MatchInfo = {
    ...base,
    timelines: [
      at("a", 30_000, "story.smelt_iron"),
      at("a", 90_000, "story.enter_the_nether"),
      at("a", 150_000, "nether.find_bastion"),
      at("a", 200_000, RESET_EVENT),
      at("a", 260_000, "story.enter_the_nether"),
      at("b", 100_000, "story.enter_the_nether"),
    ],
  };

  it("reports nothing until a mapped event has happened", () => {
    expect(replayState(detail, "a", 60_000)).toEqual({ lastEventType: null, lastEventTime: null });
  });

  it("reports the latest mapped event up to the clock, and nothing after it", () => {
    expect(replayState(detail, "a", 120_000)).toEqual({
      lastEventType: "story.enter_the_nether",
      lastEventTime: 90_000,
    });
    expect(replayState(detail, "a", 170_000)).toEqual({
      lastEventType: "nether.find_bastion",
      lastEventTime: 150_000,
    });
  });

  it("forgets everything before a reset", () => {
    expect(replayState(detail, "a", 230_000)).toEqual({ lastEventType: null, lastEventTime: null });
    expect(replayState(detail, "a", 300_000)).toEqual({
      lastEventType: "story.enter_the_nether",
      lastEventTime: 260_000,
    });
  });

  it("keeps each player to their own timeline", () => {
    expect(replayState(detail, "b", 300_000)).toEqual({
      lastEventType: "story.enter_the_nether",
      lastEventTime: 100_000,
    });
  });
});

describe("pre-match backtest", () => {
  const seen = new Set<number>();
  const list = [...userAMatches(), ...userBMatches(), ...versusMatches()].filter(
    (m) => !seen.has(m.id) && seen.add(m.id),
  );
  const cut = temporalCutoff(
    list.map((m) => m.date),
    0.7,
  );
  const train = list.filter((m) => m.date < cut);
  const test = list.filter((m) => m.date >= cut);
  const out = pregamePredictions(train, test);
  const games = ratedGames(test);

  it("scores every rated test game on every layer", () => {
    expect(games.length).toBeGreaterThan(0);
    for (const layer of [out.elo, out.base, out.bastion, out.overworld]) {
      expect(layer.length).toBe(games.length);
    }
  });

  it("starts from the elo prior", () => {
    out.elo.forEach((p, i) => {
      expect(p.p).toBeCloseTo(eloExpectedScore(games[i]!.gap, 0), 10);
      expect(p.outcome).toBe(games[i]!.outcome);
    });
  });

  it("adds nothing to the prior without training history", () => {
    const bare = pregamePredictions([], test);
    bare.base.forEach((p, i) => expect(p.p).toBeCloseTo(bare.elo[i]!.p, 12));
    bare.bastion.forEach((p, i) => expect(p.p).toBeCloseTo(bare.elo[i]!.p, 12));
    expect(bare.bastionRows).toBe(0);
    expect(bare.overworldRows).toBe(0);
  });

  it("moves off the prior once it has history to use", () => {
    expect(out.bastionRows).toBeGreaterThan(0);
    expect(out.bastion.some((p, i) => Math.abs(p.p - out.base[i]!.p) > 1e-9)).toBe(true);
  });
});

describe("in-run backtest", () => {
  const details = matchDetails();
  const byId = new Map(details.map((d) => [d.id, d]));
  const obs = inRunPredictions(buildBandedWinProbModels(extractAllRuns(details)), details);

  it("samples every minute while the match is still undecided", () => {
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.elapsedMs % 60_000).toBe(0);
      expect(o.elapsedMs).toBeLessThan(Number(byId.get(o.matchId)!.result.time));
    }
    for (const d of details) {
      const expected = Math.floor((Number(d.result.time) - 1) / 60_000);
      expect(obs.filter((o) => o.matchId === d.id).length).toBe(expected);
    }
  });

  it("never samples the instant the result is known", () => {
    // Ending on an exact minute would otherwise put a checkpoint on the winning finish.
    const onTheMinute = { ...details[0]!, result: { ...details[0]!.result, time: asMillis(180_000) } };
    const banded = buildBandedWinProbModels(extractAllRuns(details));
    expect(inRunPredictions(banded, [onTheMinute]).map((o) => o.elapsedMs)).toEqual([60_000, 120_000]);
  });

  it("scores each checkpoint against that match result", () => {
    for (const o of obs) {
      const r = ratedPair(byId.get(o.matchId)!)!;
      expect(o.model.outcome).toBe(r.outcome);
      expect(o.elo.p).toBeCloseTo(eloExpectedScore(r.a.elo, r.b.elo), 12);
      expect(o.model.p).toBeGreaterThanOrEqual(0.01);
      expect(o.model.p).toBeLessThanOrEqual(0.99);
    }
  });
});
