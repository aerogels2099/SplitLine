/**
 * TypeScript mirrors of the MCSR Ranked API schemas. openapi.yaml is the
 * source of truth.
 */
import type { EpochSeconds, Millis } from "./brand.js";

// ---------------------------------------------------------------- envelope

export interface SuccessEnvelope<T> {
  status: "success";
  data: T;
}
export interface ErrorEnvelope {
  status: "error";
  data: string | Record<string, unknown> | null;
}
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

// ------------------------------------------------------------------ users

/** 1 casual, 2 ranked, 3 private, 4 event. */
export type MatchType = 1 | 2 | 3 | 4;

export interface UserProfile {
  uuid: string; // no dashes
  nickname: string;
  roleType: number;
  /** null until placement matches finish */
  eloRate: number | null;
  eloRank: number | null;
  country: string | null;
}

export interface Achievement {
  id: string;
  date: EpochSeconds;
  data: string[];
  level: number;
  /** null for non-leveling achievements */
  value: number | null;
  goal: number | null;
}

export interface RankedCasualStat {
  ranked: number | null;
  casual: number | null;
}
export type StatisticCategoryMap = Record<string, RankedCasualStat>;

export interface UserConnection {
  id: string;
  name: string;
}

export interface SeasonStanding {
  eloRate: number;
  eloRank: number | null;
  phasePoint: number;
}

export interface SeasonPhaseResult {
  phase: number;
  eloRate: number;
  eloRank: number;
  point: number;
}

export interface SeasonResultDetailed {
  last: SeasonStanding;
  highest: number;
  lowest: number;
  phases: SeasonPhaseResult[];
}

export interface WeeklyRaceResult {
  id: number;
  time: Millis;
  rank: number;
}

export interface UserDetails extends UserProfile {
  achievements: { display: Achievement[]; total: Achievement[] };
  timestamp: {
    firstOnline: EpochSeconds;
    lastOnline: EpochSeconds;
    lastRanked: EpochSeconds;
    nextDecay: EpochSeconds | null;
  };
  statistics: { season: StatisticCategoryMap; total: StatisticCategoryMap };
  connections: Record<string, UserConnection>;
  seasonResult: SeasonResultDetailed | null;
  weeklyRaces: WeeklyRaceResult[];
}

export interface UserSeasonSummary extends UserProfile {
  seasonResults: Record<string, SeasonResultDetailed>;
}

// ---------------------------------------------------------------- matches

export interface MatchSeed {
  /** All fields null / [] when the seed is not filtered (gotcha 7). */
  id: string | null;
  overworld: string | null;
  nether: string | null;
  endTowers: number[];
  variations: string[];
}

export interface MatchResult {
  /** null on a draw (gotcha 6) */
  uuid: string | null;
  time: Millis;
}

export interface MatchRank {
  season: number | null;
  allTime: number | null;
}

export interface MatchChange {
  uuid: string;
  /** null on placement games (gotcha 4) */
  change: number | null;
  eloRate: number | null;
}

export interface MatchVod {
  uuid: string;
  url: string;
  /** VOD offset for a moment = match.date - vod.startsAt (gotcha 9) */
  startsAt: EpochSeconds;
}

export interface CompletionEntry {
  uuid: string;
  time: Millis;
}

export interface TimelineEntry {
  uuid: string;
  time: Millis;
  type: string;
}

export interface MatchInfo {
  id: number;
  type: MatchType;
  season: number;
  category?: string | null;
  /** Undocumented in HTML docs; verified against live responses 2026-07. */
  gameMode?: string | null;
  date: EpochSeconds;
  players: UserProfile[];
  spectators: UserProfile[];
  seed?: MatchSeed | null;
  result: MatchResult;
  forfeited: boolean;
  /** true = synthetic decay match, not a real game (gotcha 2) */
  decayed: boolean;
  rank: MatchRank;
  changes: MatchChange[];
  vod?: MatchVod[];
  /** Advanced fields below only exist on /matches/{id} (gotcha 5). */
  completions?: CompletionEntry[];
  timelines?: TimelineEntry[];
  tag?: string | null;
  replayExist?: boolean;
  beginner: boolean;
  botSource: string | null;
  /** Undocumented in HTML docs; verified against live responses 2026-07. */
  seedType?: string | null;
  bastionType?: string | null;
}

// ----------------------------------------------------------------- versus

export type VersusResultMap = Record<string, number>;

export interface VersusStats {
  players: UserProfile[];
  results: { ranked: VersusResultMap; casual: VersusResultMap };
  changes: Record<string, number>;
}

// ------------------------------------------------------------------- live

export type LiveStatus = "idle" | "counting" | "generate" | "ready" | "running" | "done";

export interface UserLiveData {
  lastId: number | null;
  type: MatchType;
  status: LiveStatus;
  time: Millis;
  players: UserProfile[];
  spectators: UserProfile[];
  timelines: TimelineEntry[];
  completions: CompletionEntry[];
}

export interface LiveTimelineSnapshot {
  time: Millis;
  type: string;
}

export interface LiveMatchPlayerData {
  liveUrl: string | null;
  timeline: LiveTimelineSnapshot | null;
}

export interface LiveMatch {
  currentTime: Millis;
  players: UserProfile[];
  data: Record<string, LiveMatchPlayerData>;
}

export interface PublicLiveData {
  players: number;
  liveMatches: LiveMatch[];
}

// ----------------------------------------------------------- leaderboards

export interface LeaderboardSeason {
  startsAt: EpochSeconds;
  endsAt: EpochSeconds;
  number: number;
}

export interface UserProfileWithSeasonResult extends UserProfile {
  seasonResult: SeasonStanding;
}

export interface Leaderboard {
  season: LeaderboardSeason;
  users: UserProfileWithSeasonResult[];
}

export interface PhaseInfo {
  endsAt: EpochSeconds | null;
  number: number | null;
  season: number;
}

export interface UserProfileWithPredictedPoints extends UserProfileWithSeasonResult {
  predPhasePoint: number;
}

export interface PhaseLeaderboard {
  phase: PhaseInfo;
  users: UserProfileWithPredictedPoints[];
}

export interface RecordLeaderboardEntry {
  rank: number;
  id: number;
  season: number;
  date: EpochSeconds;
  time: Millis;
  user: UserProfile;
  seed: MatchSeed;
}

// ------------------------------------------------------------ weekly race

export interface WeeklyRaceSeed {
  overworld: string;
  nether: string;
  theEnd: string;
  rng: string;
  flags: number;
}

export interface WeeklyRaceEntry {
  rank: number;
  player: UserProfile;
  time: Millis;
  replayExist: boolean;
}

export interface WeeklyRace {
  id: number;
  seed: WeeklyRaceSeed;
  endsAt: EpochSeconds;
  leaderboard: WeeklyRaceEntry[];
}

// ----------------------------------------------------------------- status

export interface StatusHeartbeat {
  /** 0 down, 1 up, 2 pending, 3 maintenance */
  status: 0 | 1 | 2 | 3;
  time: string; // "YYYY-MM-DD HH:mm:ss"
  msg: string;
  ping: number | null;
}

export interface StatusHeartbeatResponse {
  heartbeatList: Record<string, StatusHeartbeat[]>;
  uptimeList: Record<string, number>;
}
