import { describe, expect, it } from "vitest";
import { extractAllRuns } from "../src/analysis/splits.js";
import { buildBandedWinProbModels } from "../src/analysis/winprob.js";
import { LiveTracker } from "../src/server/live.js";
import { asMillis } from "../src/shared/brand.js";
import type { PublicLiveData } from "../src/shared/types.js";
import { liveData, matchDetails } from "./helpers.js";

const banded = buildBandedWinProbModels(extractAllRuns(matchDetails()));
const later = (data: PublicLiveData, ms: number): PublicLiveData => ({
  ...data,
  liveMatches: data.liveMatches.map((m) => ({ ...m, currentTime: asMillis(Number(m.currentTime) + ms) })),
});

describe("tracking live matches across polls", () => {
  it("starts each match's history at the first poll that sees it", () => {
    const view = new LiveTracker().update(liveData(), banded);
    expect(view.online).toBe(liveData().players);
    expect(view.matches).toHaveLength(liveData().liveMatches.length);
    for (const m of view.matches) {
      expect(m.history).toEqual([{ t: m.currentTimeMs, pA: m.players[0].winProb }]);
    }
  });

  it("adds a point each time the clock moves, and none for a repeated snapshot", () => {
    const tracker = new LiveTracker();
    tracker.update(liveData(), banded);
    tracker.update(liveData(), banded);
    const view = tracker.update(later(liveData(), 10_000), banded);
    for (const m of view.matches) {
      expect(m.history.map((p) => p.t)).toEqual([m.currentTimeMs - 10_000, m.currentTimeMs]);
    }
  });

  it("drops a match once it leaves the live list", () => {
    const tracker = new LiveTracker();
    const data = liveData();
    tracker.update(data, banded);
    const view = tracker.update({ ...data, liveMatches: data.liveMatches.slice(1) }, banded);
    expect(view.matches).toHaveLength(data.liveMatches.length - 1);
  });

  it("starts over when the same two players begin a new match", () => {
    const tracker = new LiveTracker();
    tracker.update(later(liveData(), 60_000), banded);
    const view = tracker.update(liveData(), banded);
    for (const m of view.matches) {
      expect(m.history).toEqual([{ t: m.currentTimeMs, pA: m.players[0].winProb }]);
    }
  });

  it("keeps the history on one player's side whichever order the API lists them in", () => {
    const tracker = new LiveTracker();
    const first = tracker.update(liveData(), banded);
    const moved = later(liveData(), 10_000);
    const flipped = {
      ...moved,
      liveMatches: moved.liveMatches.map((m) => ({ ...m, players: [...m.players].reverse() })),
    };
    const view = tracker.update(flipped, banded);
    for (const m of view.matches) {
      const before = first.matches.find((x) => x.key === m.key)!;
      expect(m.players[0].uuid).toBe(before.players[0].uuid);
      expect(m.history).toHaveLength(2);
    }
  });
});
