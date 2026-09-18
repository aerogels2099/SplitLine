/**
 * Reconstructs run structure from `timelines[]` on /matches/{id}.
 *
 * Verified 2026-07: timelines are ordered newest-first, milestones re-fire
 * after a run reset so only events after the last reset count, and deaths
 * appear as `projectelo.timeline.death*`.
 */
import { asMillis, type EpochSeconds, type Millis } from "../shared/brand.js";
import type { MatchInfo } from "../shared/types.js";

export const MILESTONES = [
  { key: "nether_enter", event: "story.enter_the_nether", label: "Nether Enter" },
  { key: "bastion", event: "nether.find_bastion", label: "Bastion" },
  { key: "fortress", event: "nether.find_fortress", label: "Fortress" },
  { key: "first_portal", event: "projectelo.timeline.blind_travel", label: "First Portal" },
  { key: "stronghold", event: "story.follow_ender_eye", label: "Stronghold" },
  { key: "end_enter", event: "story.enter_the_end", label: "End Enter" },
  { key: "finish", event: null, label: "Finish" },
] as const;

export type MilestoneKey = (typeof MILESTONES)[number]["key"];

export const SEGMENTS = [
  { key: "overworld", from: null, to: "nether_enter", label: "Overworld" },
  { key: "nether_to_bastion", from: "nether_enter", to: "bastion", label: "Nether → Bastion" },
  { key: "bastion_to_fortress", from: "bastion", to: "fortress", label: "Bastion → Fortress" },
  { key: "fortress_to_portal", from: "fortress", to: "first_portal", label: "Fortress → Portal" },
  { key: "portal_to_stronghold", from: "first_portal", to: "stronghold", label: "Portal → Stronghold" },
  { key: "stronghold_to_end", from: "stronghold", to: "end_enter", label: "Stronghold → End" },
  { key: "end_fight", from: "end_enter", to: "finish", label: "End Fight" },
] as const;

export type SegmentKey = (typeof SEGMENTS)[number]["key"];

const DEATH_EVENTS = new Set([
  "projectelo.timeline.death",
  "projectelo.timeline.death_spawnpoint",
]);
const RESET_EVENT = "projectelo.timeline.reset";

export function milestoneForEvent(type: string): MilestoneKey | null {
  switch (type) {
    case "story.enter_the_nether":
      return "nether_enter";
    case "nether.find_bastion":
    case "nether.loot_bastion":
    case "nether.obtain_crying_obsidian":
    case "nether.distract_piglin":
      return "bastion";
    case "nether.find_fortress":
    case "nether.obtain_blaze_rod":
      return "fortress";
    case "projectelo.timeline.blind_travel":
      return "first_portal";
    case "story.follow_ender_eye":
      return "stronghold";
    case "story.enter_the_end":
    case "end.root":
      return "end_enter";
    case "end.kill_dragon":
    case "projectelo.timeline.dragon_death":
      return "finish";
    default:
      return null;
  }
}

export interface RunSplits {
  matchId: number;
  date: EpochSeconds;
  uuid: string;
  nickname: string;
  /** Elo at match time — from changes[].eloRate (PRE-match), NOT players[].eloRate. */
  eloAtMatch: number | null;
  finished: boolean;
  won: boolean;
  draw: boolean;
  forfeited: boolean;
  deaths: number;
  resets: number;
  /** Cumulative time at each milestone; null when never reached. */
  splits: Record<MilestoneKey, Millis | null>;
  /** Durations between consecutive reached milestones; null when unknown. */
  segments: Record<SegmentKey, Millis | null>;
}

export function extractRunSplits(detail: MatchInfo, uuid: string): RunSplits | null {
  if (!detail.timelines || detail.decayed) return null;
  const player = detail.players.find((p) => p.uuid === uuid);
  if (!player) return null;

  const events = detail.timelines.filter((t) => t.uuid === uuid);
  const lastReset = events
    .filter((t) => t.type === RESET_EVENT)
    .reduce((max, t) => Math.max(max, t.time), -1);
  const live = events.filter((t) => t.time > lastReset);

  const splits = {} as Record<MilestoneKey, Millis | null>;
  for (const m of MILESTONES) {
    if (m.event === null) continue;
    let first: number | null = null;
    for (const t of live) {
      if (t.type === m.event && (first === null || t.time < first)) first = t.time;
    }
    splits[m.key] = first === null ? null : asMillis(first);
  }

  const completion = detail.completions?.find((c) => c.uuid === uuid);
  splits.finish = completion ? completion.time : null;

  const segments = {} as Record<SegmentKey, Millis | null>;
  for (const s of SEGMENTS) {
    const from = s.from === null ? 0 : (splits[s.from] ?? null);
    const to = splits[s.to] ?? null;
    // Negative duration means the route ordered milestones differently —
    // treat as unknown, not as data.
    segments[s.key] =
      from !== null && to !== null && to >= from ? asMillis(to - (from as number)) : null;
  }

  const change = detail.changes.find((c) => c.uuid === uuid);
  return {
    matchId: detail.id,
    date: detail.date,
    uuid,
    nickname: player.nickname,
    eloAtMatch: change?.eloRate ?? null,
    finished: completion !== undefined,
    won: detail.result.uuid === uuid,
    draw: detail.result.uuid === null,
    forfeited: detail.forfeited,
    deaths: live.filter((t) => DEATH_EVENTS.has(t.type)).length,
    resets: events.filter((t) => t.type === RESET_EVENT).length,
    splits,
    segments,
  };
}

export function extractAllRuns(details: MatchInfo[]): RunSplits[] {
  const runs: RunSplits[] = [];
  for (const d of details) {
    for (const p of d.players) {
      const r = extractRunSplits(d, p.uuid);
      if (r) runs.push(r);
    }
  }
  return runs;
}
