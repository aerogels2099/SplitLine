import { RankedClient, STATUS_BASE } from "./client.js";
import type {
  Leaderboard,
  MatchInfo,
  MatchType,
  PhaseLeaderboard,
  PublicLiveData,
  RecordLeaderboardEntry,
  StatusHeartbeatResponse,
  UserDetails,
  UserLiveData,
  UserSeasonSummary,
  VersusStats,
  WeeklyRace,
} from "../shared/types.js";

const MINUTE = 60_000;

export interface MatchListParams {
  before?: number;
  after?: number;
  sort?: "newest" | "oldest" | "fastest" | "slowest";
  count?: number; // 1..100, default 20
  type?: MatchType;
  season?: number;
  tag?: string;
  excludedecay?: boolean;
  includedecay?: boolean;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

const enc = encodeURIComponent;

export class RankedApi {
  constructor(readonly client: RankedClient) {}

  getUser(identifier: string, season?: number): Promise<UserDetails> {
    return this.client.get(`/users/${enc(identifier)}${qs({ season })}`, { ttlMs: MINUTE });
  }

  getUserMatches(identifier: string, params: MatchListParams = {}): Promise<MatchInfo[]> {
    const ttlMs = params.before !== undefined ? 10 * MINUTE : MINUTE;
    return this.client.get(`/users/${enc(identifier)}/matches${qs({ ...params })}`, { ttlMs });
  }

  getUserSeasons(identifier: string): Promise<UserSeasonSummary> {
    return this.client.get(`/users/${enc(identifier)}/seasons`, { ttlMs: 10 * MINUTE });
  }

  getUserLive(identifier: string): Promise<UserLiveData> {
    return this.client.get(`/users/${enc(identifier)}/live`, { ttlMs: 0, withKey: true });
  }

  getVersus(id1: string, id2: string, season?: number): Promise<VersusStats> {
    return this.client.get(`/users/${enc(id1)}/versus/${enc(id2)}${qs({ season })}`, {
      ttlMs: MINUTE,
    });
  }

  getVersusMatches(id1: string, id2: string, params: MatchListParams = {}): Promise<MatchInfo[]> {
    return this.client.get(`/users/${enc(id1)}/versus/${enc(id2)}/matches${qs({ ...params })}`, {
      ttlMs: MINUTE,
    });
  }

  getMatches(params: MatchListParams = {}): Promise<MatchInfo[]> {
    const ttlMs = params.before !== undefined ? 10 * MINUTE : 15_000;
    return this.client.get(`/matches${qs({ ...params })}`, { ttlMs });
  }

  getMatch(matchId: number): Promise<MatchInfo> {
    return this.client.get(`/matches/${matchId}`, { ttlMs: 0 });
  }

  getLive(): Promise<PublicLiveData> {
    return this.client.get(`/live`, { ttlMs: 5_000 });
  }

  getLeaderboard(season?: number, country?: string): Promise<Leaderboard> {
    return this.client.get(`/leaderboard${qs({ season, country })}`, { ttlMs: MINUTE });
  }

  getPhaseLeaderboard(season?: number, country?: string, predicted?: boolean): Promise<PhaseLeaderboard> {
    return this.client.get(`/phase-leaderboard${qs({ season, country, predicted })}`, {
      ttlMs: MINUTE,
    });
  }

  /** season 0 = current season; omit = all-time. */
  getRecordLeaderboard(season?: number, distinct?: boolean): Promise<RecordLeaderboardEntry[]> {
    return this.client.get(`/record-leaderboard${qs({ season, distinct })}`, { ttlMs: MINUTE });
  }

  getWeeklyRace(id?: number): Promise<WeeklyRace> {
    const path = id === undefined ? `/weekly-race` : `/weekly-race/${id}`;
    return this.client.get(path, { ttlMs: id === undefined ? MINUTE : 10 * MINUTE });
  }

  getStatus(): Promise<StatusHeartbeatResponse> {
    return this.client.getRaw(`/api/status-page/heartbeat/mcsrranked`, {
      baseUrl: STATUS_BASE,
      ttlMs: MINUTE,
    });
  }
}
