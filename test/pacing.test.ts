import { describe, expect, it } from "vitest";
import {
  buildBandedDistributions,
  buildSplitDistributions,
  comparePacing,
  eloBand,
} from "../src/analysis/pacing.js";
import { extractAllRuns } from "../src/analysis/splits.js";
import { matchDetails, userA } from "./helpers.js";

describe("pacing analysis", () => {
  const runs = extractAllRuns(matchDetails());
  const uuid = userA().uuid;

  it("assigns elo bands", () => {
    expect(eloBand(null)).toBe("placement");
    expect(eloBand(0)).toBe("0–299");
    expect(eloBand(1250)).toBe("1200–1499");
    expect(eloBand(2622)).toBe("2400–2699");
  });

  it("builds monotone percentile distributions", () => {
    const dists = buildSplitDistributions(runs);
    expect(dists.length).toBeGreaterThan(0);
    for (const d of dists) {
      expect(d.p10).toBeLessThanOrEqual(d.p25);
      expect(d.p25).toBeLessThanOrEqual(d.p50);
      expect(d.p50).toBeLessThanOrEqual(d.p75);
      expect(d.p75).toBeLessThanOrEqual(d.p90);
      expect(d.count).toBeGreaterThan(0);
    }
    const byKey = new Map(dists.map((d) => [d.key, d]));
    const ne = byKey.get("nether_enter");
    const ee = byKey.get("end_enter");
    if (ne && ee) expect(ee.p50).toBeGreaterThan(ne.p50);
  });

  it("groups distributions by elo band", () => {
    const banded = buildBandedDistributions(runs);
    const bands = Object.keys(banded);
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) expect(banded[b]!.length).toBeGreaterThan(0);
  });

  it("compares a player against band peers and excludes their own runs", () => {
    const mine = runs.filter((r) => r.uuid === uuid);
    expect(mine.length).toBeGreaterThan(0);
    const cmp = comparePacing(mine, runs);
    expect(cmp.segments.length).toBe(7);
    for (const s of cmp.segments) {
      if (s.playerMedian !== null && s.peerMedian !== null) {
        expect(s.deltaMs).toBeCloseTo(s.playerMedian - s.peerMedian, 6);
      }
    }
  });
});
