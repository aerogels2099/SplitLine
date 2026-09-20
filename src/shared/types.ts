import type { EpochSeconds, Millis } from "./brand.js";

export interface SuccessEnvelope<T> {
  status: "success";
  data: T;
}
export interface ErrorEnvelope {
  status: "error";
  data: string | Record<string, unknown> | null;
}
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Numbered in the order casual, ranked, private, event. */
export type MatchType = 1 | 2 | 3 | 4;

export interface UserProfile {
  uuid: string; // the API returns these without dashes
  nickname: string;
  roleType: number;
  /** Unrated until the player has finished their placement matches. */
  eloRate: number | null;
  eloRank: number | null;
  country: string | null;
}

export interface Achievement {
  id: string;
  date: EpochSeconds;
  data: string[];
  level: number;
  /** Absent for achievements that do not have levels. */
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

export interface MatchSeed {
  /** Every field here is empty unless the match ran on a filtered seed. */
  id: string | null;
  overworld: string | null;
  nether: string | null;
  endTowers: number[];
  variations: string[];
}

export interface MatchResult {
  /** No winner is recorded when the match was drawn. */
  uuid: string | null;
  time: Millis;
}

export interface MatchRank {
  season: number | null;
  allTime: number | null;
}

export interface MatchChange {
  uuid: string;
  /** Neither figure is reported for placement games. */
  change: number | null;
  eloRate: number | null;
}

export interface MatchVod {
  uuid: string;
  url: string;
  /** When the recording began; the gap to the match time is the offset into it. */
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
  /** Missing from the published documentation; confirmed against live responses in July 2026. */
  gameMode?: string | null;
  date: EpochSeconds;
  players: UserProfile[];
  spectators: UserProfile[];
  seed?: MatchSeed | null;
  result: MatchResult;
  forfeited: boolean;
  /** Marks a synthetic entry simulating rank decay rather than a game that was played. */
  decayed: boolean;
  rank: MatchRank;
  changes: MatchChange[];
  vod?: MatchVod[];
  /** The fields below come back only when a single match is fetched by id, never in a list. */
  completions?: CompletionEntry[];
  timelines?: TimelineEntry[];
  tag?: string | null;
  replayExist?: boolean;
  beginner: boolean;
  botSource: string | null;
  /** Missing from the published documentation; confirmed against live responses in July 2026. */
  seedType?: string | null;
  bastionType?: string | null;
}

export type VersusResultMap = Record<string, number>;

export interface VersusStats {
  players: UserProfile[];
  results: { ranked: VersusResultMap; casual: VersusResultMap };
  changes: Record<string, number>;
}

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

export interface StatusHeartbeat {
  /** Numbered in the order down, up, pending, maintenance. */
  status: 0 | 1 | 2 | 3;
  time: string; // written out as text rather than a timestamp
  msg: string;
  ping: number | null;
}

export interface StatusHeartbeatResponse {
  heartbeatList: Record<string, StatusHeartbeat[]>;
  uptimeList: Record<string, number>;
}
