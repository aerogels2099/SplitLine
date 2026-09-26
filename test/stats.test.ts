import { describe, expect, it } from "vitest";
import {
  conditionalRemaining,
  ELO_DIVISOR,
  eloExpectedScore,
  kaplanMeier,
  mean,
  normalCdf,
  stddev,
} from "../src/analysis/stats.js";

describe("stats primitives", () => {
  it("computes sample standard deviation", () => {
    expect(stddev([2, 3, 4, 5, 6])).toBeCloseTo(Math.sqrt(2.5), 10);
    expect(stddev([7, 7, 7])).toBe(0);
  });

  it("returns zero standard deviation below two samples", () => {
    expect(stddev([])).toBe(0);
    expect(stddev([42])).toBe(0);
  });

  it("evaluates the normal CDF against known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1)).toBeCloseTo(0.841344746, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 5);
  });

  it("keeps the normal CDF monotone and bounded", () => {
    let prev = 0;
    for (let z = -5; z <= 5; z += 0.25) {
      const p = normalCdf(z);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    expect(normalCdf(-40)).toBeCloseTo(0, 6);
    expect(normalCdf(40)).toBeCloseTo(1, 6);
  });

  it("scores an even matchup at one half", () => {
    expect(eloExpectedScore(1500, 1500)).toBe(0.5);
    expect(eloExpectedScore(0, 0)).toBe(0.5);
  });

  it("scores a rating gap by its size, not its position", () => {
    expect(eloExpectedScore(1900, 1500)).toBeCloseTo(0.834219, 5);
    expect(eloExpectedScore(1500, 1900)).toBeCloseTo(0.165781, 5);
    expect(eloExpectedScore(2400, 2000)).toBeCloseTo(eloExpectedScore(1900, 1500), 10);
  });

  it("puts the fitted divisor on the odds it implies", () => {
    expect(eloExpectedScore(1500 + ELO_DIVISOR, 1500)).toBeCloseTo(10 / 11, 10);
    expect(ELO_DIVISOR).toBe(570);
  });

  it("keeps the two sides of a matchup complementary", () => {
    for (const [a, b] of [[1500, 1500], [2000, 1200], [900, 1750], [2622, 2600]]) {
      expect(eloExpectedScore(a!, b!) + eloExpectedScore(b!, a!)).toBeCloseTo(1, 10);
    }
  });
});

describe("survival estimates", () => {
  it("matches the sample mean when nothing is censored", () => {
    const xs = [3, 5, 5, 8, 9];
    const curve = kaplanMeier(xs.map((time) => ({ time, observed: true })));
    expect(curve.survival.at(-1)).toBeCloseTo(0, 10);
    expect(conditionalRemaining(curve, 0)!.mean).toBeCloseTo(mean(xs), 10);
  });

  it("keeps censored observations in the risk set without counting them as events", () => {
    const curve = kaplanMeier([
      { time: 2, observed: true },
      { time: 4, observed: false },
      { time: 6, observed: true },
    ]);
    // Three are at risk at 2; by 6 the censored run has left, so only one is.
    expect(curve.times).toEqual([0, 2, 6]);
    expect(curve.survival[1]).toBeCloseTo(2 / 3, 10);
    expect(curve.survival[2]).toBeCloseTo(0, 10);
  });

  it("conditions on time already survived", () => {
    const curve = kaplanMeier([2, 4, 6, 8].map((time) => ({ time, observed: true })));
    const fromStart = conditionalRemaining(curve, 0)!;
    // Only the finishes at 6 and 8 remain, one and three away.
    const afterFive = conditionalRemaining(curve, 5)!;
    expect(afterFive.mean).toBeCloseTo(2, 10);
    expect(5 + afterFive.mean).toBeGreaterThan(fromStart.mean);
    expect(conditionalRemaining(curve, 8)).toBeNull();
  });
});
