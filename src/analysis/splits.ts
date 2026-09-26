/** Reconstructs the shape of a run from the event timeline of a single match. */
import { asMillis, type EpochSeconds, type Millis } from "../shared/brand.js";
import type { MatchInfo, TimelineEntry } from "../shared/types.js";

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
export const RESET_EVENT = "projectelo.timeline.reset";

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
  eloAtMatch: number | null;
  finished: boolean;
  won: boolean;
  draw: boolean;
  forfeited: boolean;
  deaths: number;
  resets: number;
  splits: Record<MilestoneKey, Millis | null>;
  segments: Record<SegmentKey, Millis | null>;
  eventTimes: Record<string, Millis>;
  matchTime: Millis;
}

export function extractRunSplits(detail: MatchInfo, uuid: string): RunSplits | null {
  if (!detail.timelines?.length || detail.decayed) return null;
  const player = detail.players.find((p) => p.uuid === uuid);
  if (!player) return null;
  return runFrom(detail, uuid, player.nickname, detail.timelines.filter((t) => t.uuid === uuid));
}

function runFrom(
  detail: MatchInfo,
  uuid: string,
  nickname: string,
  events: TimelineEntry[],
): RunSplits {
  const lastReset = events
    .filter((t) => t.type === RESET_EVENT)
    .reduce((max, t) => Math.max(max, t.time), -1);
  const live = events.filter((t) => t.time > lastReset);

  const eventTimes: Record<string, Millis> = {};
  for (const t of live) {
    if (milestoneForEvent(t.type) === null) continue;
    const prev = eventTimes[t.type];
    if (prev === undefined || t.time < prev) eventTimes[t.type] = asMillis(t.time);
  }

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
    segments[s.key] =
      from !== null && to !== null && to >= from ? asMillis(to - (from as number)) : null;
  }

  const change = detail.changes.find((c) => c.uuid === uuid);
  return {
    matchId: detail.id,
    date: detail.date,
    uuid,
    nickname,
    eloAtMatch: change?.eloRate ?? null,
    finished: completion !== undefined,
    won: detail.result.uuid === uuid,
    draw: detail.result.uuid === null,
    forfeited: detail.forfeited,
    deaths: live.filter((t) => DEATH_EVENTS.has(t.type)).length,
    resets: events.filter((t) => t.type === RESET_EVENT).length,
    splits,
    segments,
    eventTimes,
    matchTime: detail.result.time,
  };
}

export function extractAllRuns(details: MatchInfo[]): RunSplits[] {
  const runs: RunSplits[] = [];
  for (const d of details) {
    if (!d.timelines?.length || d.decayed) continue;
    // Grouped once per match rather than rescanned for each player.
    const byUuid = new Map<string, TimelineEntry[]>();
    for (const t of d.timelines) {
      const arr = byUuid.get(t.uuid);
      if (arr) arr.push(t);
      else byUuid.set(t.uuid, [t]);
    }
    for (const p of d.players) {
      const events = byUuid.get(p.uuid);
      if (events) runs.push(runFrom(d, p.uuid, p.nickname, events));
    }
  }
  return runs;
}
