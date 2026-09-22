import { describe, expect, it } from "vitest";
import { eloBand } from "../src/analysis/pacing.js";
import { extractAllRuns, type RunSplits } from "../src/analysis/splits.js";
import { asEpochSeconds, asMillis } from "../src/shared/brand.js";
import {
  buildBandedWinProbModels,
  buildWinProbModel,
  headToHeadWinProb,
  modelForElo,
  projectFinish,
  scoreLiveMatch,
} from "../src/analysis/winprob.js";
import { liveData, matchDetails } from "./helpers.js";

describe("win probability model", () => {
  const runs = extractAllRuns(matchDetails());
  const model = buildWinProbModel(runs);

  it("learns remaining-time stats from historical timelines", () => {
    expect(model.overall.n).toBeGreaterThan(0);
    expect(model.overall.meanFinal).toBeGreaterThan(5 * 60_000);
    for (const m of Object.values(model.milestones)) {
      expect(m.meanRemaining).toBeGreaterThan(0);
      expect(m.sdRemaining).toBeGreaterThan(0);
    }
    const ne = model.milestones.nether_enter;
    const ee = model.milestones.end_enter;
    if (ne && ee) expect(ee.meanRemaining).toBeLessThan(ne.meanRemaining);
  });

  it("projects finishes that are never in the past", () => {
    const elapsed = 20 * 60_000;
    const p = projectFinish(
      model,
      { lastEventType: "story.enter_the_nether", lastEventTime: 5 * 60_000 },
      elapsed,
    );
    expect(p.meanMs).toBeGreaterThan(elapsed);
  });

  it("favors the player who is further ahead", () => {
    const elapsed = 9 * 60_000;
    const ahead = { lastEventType: "story.enter_the_end", lastEventTime: 8 * 60_000 };
    const behind = { lastEventType: "story.enter_the_nether", lastEventTime: 8 * 60_000 };
    const { pA } = headToHeadWinProb(model, ahead, behind, elapsed, 1500, 1500);
    expect(pA).toBeGreaterThan(0.5);
    const rev = headToHeadWinProb(model, behind, ahead, elapsed, 1500, 1500);
    expect(rev.pA).toBeLessThan(0.5);
  });

  it("falls back to the elo prior early in a run", () => {
    const blank = { lastEventType: null, lastEventTime: null };
    const early = headToHeadWinProb(model, blank, blank, 30_000, 1800, 1200);
    expect(early.pA).toBeGreaterThan(0.5); // 600 elo edge dominates

    const even = headToHeadWinProb(model, blank, blank, 30_000, null, null);
    expect(even.pA).toBeCloseTo(0.5, 6);
  });

  it("scores real live matches with probabilities summing to 1", () => {
    for (const lm of liveData().liveMatches) {
      const scored = scoreLiveMatch(model, lm);
      const sum = scored.players.reduce((s, p) => s + p.winProb, 0);
      expect(sum).toBeCloseTo(1, 5);
      for (const p of scored.players) {
        expect(p.winProb).toBeGreaterThan(0);
        expect(p.winProb).toBeLessThan(1);
        expect(p.projectedFinishMs).toBeGreaterThan(0);
      }
    }
  });
});

describe("band conditioning", () => {
  const runs = extractAllRuns(matchDetails());
  const banded = buildBandedWinProbModels(runs);

  it("fits a separate model per band without losing runs", () => {
    expect(Object.keys(banded.bands).length).toBeGreaterThan(1);
    const perBand = Object.values(banded.bands).reduce((n, m) => n + m.overall.n, 0);
    expect(perBand).toBe(banded.global.overall.n);
  });

  it("pairs each band with the runs that produced it", () => {
    for (const [band, m] of Object.entries(banded.bands)) {
      const expected = runs.filter(
        (r) => eloBand(r.eloAtMatch) === band && r.finished && r.splits.finish !== null,
      );
      expect(m.overall.n).toBe(expected.length);
    }
  });
});

function syntheticRun(elo: number, finishMs: number, i: number): RunSplits {
  const at = (frac: number) => asMillis(Math.round(finishMs * frac));
  return {
    matchId: i,
    date: asEpochSeconds(1_700_000_000 + i),
    uuid: `u${i}`,
    nickname: `p${i}`,
    eloAtMatch: elo,
    finished: true,
    won: i % 2 === 0,
    draw: false,
    forfeited: false,
    deaths: 0,
    resets: 0,
    splits: {
      nether_enter: at(0.2),
      bastion: at(0.35),
      fortress: at(0.5),
      first_portal: at(0.65),
      stronghold: at(0.8),
      end_enter: at(0.9),
      finish: asMillis(finishMs),
    },
    segments: {
      overworld: at(0.2),
      nether_to_bastion: at(0.15),
      bastion_to_fortress: at(0.15),
      fortress_to_portal: at(0.15),
      portal_to_stronghold: at(0.15),
      stronghold_to_end: at(0.1),
      end_fight: at(0.1),
    },
  };
}

function syntheticCorpus(): RunSplits[] {
  const out: RunSplits[] = [];
  let i = 0;
  for (let k = 0; k < 40; k++) out.push(syntheticRun(2450, 8 * 60_000 + k * 1000, i++));
  for (let k = 0; k < 40; k++) out.push(syntheticRun(950, 14 * 60_000 + k * 1000, i++));
  for (let k = 0; k < 5; k++) out.push(syntheticRun(1550, 11 * 60_000 + k * 1000, i++));
  return out;
}

describe("band selection", () => {
  const banded = buildBandedWinProbModels(syntheticCorpus());

  it("separates fast bands from slow ones", () => {
    const fast = banded.bands["2400–2699"];
    const slow = banded.bands["900–1199"];
    expect(fast).toBeDefined();
    expect(slow).toBeDefined();
    expect(fast!.overall.meanFinal).toBeLessThan(slow!.overall.meanFinal);
    expect(banded.global.overall.meanFinal).toBeGreaterThan(fast!.overall.meanFinal);
    expect(banded.global.overall.meanFinal).toBeLessThan(slow!.overall.meanFinal);
  });

  it("uses a band model when the band is well sampled", () => {
    const hit = modelForElo(banded, 2450);
    expect(hit.fellBack).toBe(false);
    expect(hit.band).toBe("2400–2699");
    expect(hit.model.overall.n).toBe(40);
  });

  it("falls back to the pooled model for a thin band", () => {
    const hit = modelForElo(banded, 1550);
    expect(banded.bands["1500–1799"]!.overall.n).toBe(5); // present, but under the threshold
    expect(hit.fellBack).toBe(true);
    expect(hit.band).toBe("all");
    expect(hit.model).toBe(banded.global);
  });

  it("falls back for unknown bands and for missing ratings", () => {
    const unknown = modelForElo(banded, 9000);
    expect(unknown.fellBack).toBe(true);
    expect(unknown.model).toBe(banded.global);

    const placement = modelForElo(banded, null);
    expect(placement.fellBack).toBe(true);
    expect(placement.model).toBe(banded.global);
  });
});
