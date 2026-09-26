import { describe, expect, it } from "vitest";
import { extractAllRuns, extractRunSplits, milestoneForEvent, MILESTONES } from "../src/analysis/splits.js";
import { matchDetails, userA } from "./helpers.js";

describe("split extraction", () => {
  const details = matchDetails();

  it("extracts a full run for the winner of a completed match", () => {
    const completed = details.find((m) => !m.forfeited && m.result.uuid !== null)!;
    const run = extractRunSplits(completed, completed.result.uuid!)!;
    expect(run).not.toBeNull();
    expect(run.won).toBe(true);
    expect(run.finished).toBe(true);
    expect(run.splits.finish).toBe(completed.result.time);
    // Milestones must be reached in canonical order when all present.
    const order = MILESTONES.filter((m) => m.key !== "bastion" && m.key !== "fortress");
    const times = order.map((m) => run.splits[m.key]).filter((t) => t !== null) as number[];
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it("returns null for players not in the match and for list-level objects", () => {
    const m = details[0]!;
    expect(extractRunSplits(m, "not-a-player")).toBeNull();
    const listLevel = { ...m, timelines: undefined };
    expect(extractRunSplits(listLevel, m.players[0]!.uuid)).toBeNull();
  });

  it("treats an empty timelines array as absent, not as a run of nulls", () => {
    const m = details[0]!;
    // Endpoints that return lists answer with an empty list rather than an error.
    expect(extractRunSplits({ ...m, timelines: [] }, m.players[0]!.uuid)).toBeNull();
  });

  it("uses changes[].eloRate for elo at match time, not players[].eloRate", () => {
    const u = userA();
    for (const m of details) {
      const run = extractRunSplits(m, u.uuid);
      if (!run) continue;
      const change = m.changes.find((c) => c.uuid === u.uuid);
      expect(run.eloAtMatch).toBe(change?.eloRate ?? null);
    }
  });

  it("extracts runs for both players of every detail", () => {
    const runs = extractAllRuns(details);
    expect(runs.length).toBeGreaterThanOrEqual(details.length); // at least one run per match
    for (const r of runs) {
      // Cumulative splits never decrease relative to nether entry.
      if (r.splits.nether_enter !== null && r.splits.end_enter !== null) {
        expect(Number(r.splits.end_enter)).toBeGreaterThan(Number(r.splits.nether_enter));
      }
      for (const v of Object.values(r.segments)) {
        if (v !== null) expect(Number(v)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("maps live event types to milestones", () => {
    expect(milestoneForEvent("story.enter_the_nether")).toBe("nether_enter");
    expect(milestoneForEvent("nether.obtain_blaze_rod")).toBe("fortress");
    expect(milestoneForEvent("projectelo.timeline.blind_travel")).toBe("first_portal");
    expect(milestoneForEvent("end.kill_dragon")).toBe("finish");
    expect(milestoneForEvent("story.smelt_iron")).toBeNull();
  });
});

describe("event times", () => {
  const runs = extractAllRuns(matchDetails());

  it("records every mapped event, not just the milestone anchors", () => {
    const seen = new Set<string>();
    for (const r of runs) for (const k of Object.keys(r.eventTimes)) seen.add(k);
    expect(seen.has("nether.find_bastion")).toBe(true);
    expect(seen.has("nether.loot_bastion")).toBe(true);
    expect(seen.has("nether.obtain_crying_obsidian")).toBe(true);
    expect(seen.has("nether.obtain_blaze_rod")).toBe(true);
  });

  it("keeps unmapped advancement noise out", () => {
    for (const r of runs) {
      for (const k of Object.keys(r.eventTimes)) {
        expect(milestoneForEvent(k)).not.toBeNull();
      }
      expect(r.eventTimes["story.root"]).toBeUndefined();
      expect(r.eventTimes["story.smelt_iron"]).toBeUndefined();
    }
  });

  it("agrees with the milestone split on the anchor event", () => {
    const withBastion = runs.filter((r) => r.splits.bastion !== null);
    expect(withBastion.length).toBeGreaterThan(0);
    for (const r of withBastion) {
      expect(r.eventTimes["nether.find_bastion"]).toBe(r.splits.bastion);
    }
  });

  it("times an alias after the anchor it shares a milestone with", () => {
    const both = runs.filter(
      (r) =>
        r.eventTimes["nether.find_bastion"] !== undefined &&
        r.eventTimes["nether.obtain_crying_obsidian"] !== undefined,
    );
    expect(both.length).toBeGreaterThan(0);
    for (const r of both) {
      expect(r.eventTimes["nether.obtain_crying_obsidian"]!).toBeGreaterThanOrEqual(
        r.eventTimes["nether.find_bastion"]!,
      );
    }
  });
});
