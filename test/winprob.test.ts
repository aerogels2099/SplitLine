import { describe, expect, it } from "vitest";
import { eloBand } from "../src/analysis/pacing.js";
import { extractAllRuns, type RunSplits } from "../src/analysis/splits.js";
import { asEpochSeconds, asMillis } from "../src/shared/brand.js";
import {
  buildBandedWinProbModels,
  buildWinProbModel,
  headToHeadWinProb,
  modelForElo,
  type LiveRunState,
  type WinProbModel,
  projectFinish,
  scoreLiveMatch,
} from "../src/analysis/winprob.js";
import { eloExpectedScore, mean } from "../src/analysis/stats.js";
import { liveData, matchDetails } from "./helpers.js";

describe("win probability model", () => {
  const runs = extractAllRuns(matchDetails());
  const model = buildWinProbModel(runs);
  const banded = buildBandedWinProbModels(runs);

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
    const side = (state: LiveRunState) => ({ model, state, elo: 1500 });
    const { pA } = headToHeadWinProb(side(ahead), side(behind), elapsed);
    expect(pA).toBeGreaterThan(0.5);
    const rev = headToHeadWinProb(side(behind), side(ahead), elapsed);
    expect(rev.pA).toBeLessThan(0.5);
  });

  it("falls back to the elo prior early in a run", () => {
    const blank = { lastEventType: null, lastEventTime: null };
    const early = headToHeadWinProb(
      { model, state: blank, elo: 1800 },
      { model, state: blank, elo: 1200 },
      30_000,
    );
    expect(early.pA).toBeGreaterThan(0.5);

    const even = headToHeadWinProb(
      { model, state: blank, elo: null },
      { model, state: blank, elo: null },
      30_000,
    );
    expect(even.pA).toBeCloseTo(0.5, 6);
  });

  it("scores real live matches with probabilities summing to 1", () => {
    for (const lm of liveData().liveMatches) {
      const scored = scoreLiveMatch(banded, lm);
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
    eventTimes: {},
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

  it("uses a thin band own model rather than a busier neighbour", () => {
    const hit = modelForElo(banded, 1550);
    expect(banded.bands["1500–1799"]!.overall.n).toBe(5);
    expect(hit.fellBack).toBe(false);
    expect(hit.band).toBe("1500–1799");
    expect(hit.model).toBe(banded.bands["1500–1799"]);
  });

  it("borrows the nearest band only when the band is absent entirely", () => {
    const unknown = modelForElo(banded, 9000);
    expect(banded.bands["9000–9299"]).toBeUndefined();
    expect(unknown.fellBack).toBe(true);
    expect(unknown.band).toBe("2400–2699");

    const placement = modelForElo(banded, null);
    expect(placement.fellBack).toBe(true);
    expect(placement.band).toBe("all");
    expect(placement.model).toBe(banded.global);
  });

});

describe("elo and pace are counted once each", () => {
  const paceModel = (meanFinalMs: number): WinProbModel => ({
    milestones: {
      bastion: { n: 50, meanRemaining: meanFinalMs * 0.65, sdRemaining: 60_000 },
    },
    events: {},
    overall: { n: 50, meanFinal: meanFinalMs, sdFinal: 90_000 },
  });
  const fast = paceModel(8 * 60_000);
  const slow = paceModel(13 * 60_000);
  const blank: LiveRunState = { lastEventType: null, lastEventTime: null };
  const bastionAt = (t: number): LiveRunState => ({
    lastEventType: "nether.find_bastion",
    lastEventTime: t,
  });

  it("returns the elo prior alone when neither runner has events", () => {
    const even = headToHeadWinProb(
      { model: fast, state: blank, elo: 1500 },
      { model: slow, state: blank, elo: 1500 },
      60_000,
    );
    expect(even.pA).toBeCloseTo(0.5, 7);

    const gap = headToHeadWinProb(
      { model: fast, state: blank, elo: 2400 },
      { model: slow, state: blank, elo: 1500 },
      60_000,
    );
    expect(gap.pA).toBeCloseTo(eloExpectedScore(2400, 1500), 7);
  });

  it("judges a split against the runner own band", () => {
    const against = (m: WinProbModel) =>
      headToHeadWinProb(
        { model: fast, state: bastionAt(3 * 60_000), elo: 1500 },
        { model: m, state: bastionAt(3 * 60_000), elo: 1500 },
        3 * 60_000,
      ).pA;

    expect(against(slow)).toBeLessThan(against(fast));
    expect(against(fast)).toBeCloseTo(0.5, 6);
  });

  it("credits a runner for beating their own band pace", () => {
    const ahead = headToHeadWinProb(
      { model: fast, state: bastionAt(2 * 60_000), elo: 1500 },
      { model: fast, state: bastionAt(4 * 60_000), elo: 1500 },
      4 * 60_000,
    );
    expect(ahead.pA).toBeGreaterThan(0.5);
  });
});

describe("alias events are timed on their own", () => {
  const ANCHOR = "nether.find_bastion";
  const ALIAS = "nether.obtain_crying_obsidian";

  function aliasRun(i: number): RunSplits {
    const base = syntheticRun(1850, 10 * 60_000, i);
    return {
      ...base,
      eventTimes: {
        [ANCHOR]: asMillis(2 * 60_000),
        [ALIAS]: asMillis(3 * 60_000),
      },
    };
  }

  const model = buildWinProbModel(Array.from({ length: 20 }, (_, i) => aliasRun(i)));

  it("fits a distribution for each reported event", () => {
    expect(model.events[ANCHOR]).toBeDefined();
    expect(model.events[ALIAS]).toBeDefined();
    expect(model.events[ANCHOR]!.meanRemaining).toBeCloseTo(8 * 60_000, 0);
    expect(model.events[ALIAS]!.meanRemaining).toBeCloseTo(7 * 60_000, 0);
  });

  it("projects a nearer finish for the later event at the same clock", () => {
    const at = 3 * 60_000;
    const anchor = projectFinish(model, { lastEventType: ANCHOR, lastEventTime: at }, at);
    const alias = projectFinish(model, { lastEventType: ALIAS, lastEventTime: at }, at);
    expect(alias.meanMs).toBeLessThan(anchor.meanMs);
    expect(anchor.meanMs - alias.meanMs).toBeCloseTo(60_000, -3);
    expect(alias.milestone).toBe("bastion");
  });

  it("falls back to the milestone when the event has no model of its own", () => {
    const bare: WinProbModel = { ...model, events: {} };
    const at = 3 * 60_000;
    const viaAlias = projectFinish(bare, { lastEventType: ALIAS, lastEventTime: at }, at);
    const viaAnchor = projectFinish(bare, { lastEventType: ANCHOR, lastEventTime: at }, at);
    expect(viaAlias.meanMs).toBe(viaAnchor.meanMs);
  });
});

describe("a pace-neutral run reads as the elo prior", () => {
  const runs = extractAllRuns(matchDetails());
  const banded = buildBandedWinProbModels(runs);
  const blank: LiveRunState = { lastEventType: null, lastEventTime: null };

  it("holds for every band the corpus produced, thin ones included", () => {
    const bands = Object.keys(banded.bands).filter((b) => b !== "placement");
    expect(bands.length).toBeGreaterThan(0);

    for (const band of bands) {
      const model = banded.bands[band]!;
      if (!model.milestones.nether_enter) continue;
      const reached = runs.filter(
        (r) =>
          eloBand(r.eloAtMatch) === band &&
          r.finished &&
          r.splits.finish !== null &&
          r.splits.nether_enter !== null,
      );
      if (reached.length < 2) continue;

      const typical = mean(reached.map((r) => Number(r.splits.nether_enter)));
      const elo = Number(band.split("–")[0]) + 100;
      const { pA } = headToHeadWinProb(
        { model, state: { lastEventType: "story.enter_the_nether", lastEventTime: typical }, elo },
        { model, state: blank, elo },
        typical,
      );
      expect(pA).toBeCloseTo(0.5, 6);
    }
  });
});
