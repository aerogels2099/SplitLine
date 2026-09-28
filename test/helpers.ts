import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Leaderboard,
  MatchInfo,
  PublicLiveData,
  SuccessEnvelope,
  UserDetails,
  VersusStats,
  WeeklyRace,
} from "../src/shared/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixture<T>(name: string): T {
  const body = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as SuccessEnvelope<T>;
  if (body.status !== "success") throw new Error(`fixture ${name} is not a success envelope`);
  return body.data;
}

export const userA = () => loadFixture<UserDetails>("user-a.json");
export const userB = () => loadFixture<UserDetails>("user-b.json");
export const userAMatches = () => loadFixture<MatchInfo[]>("user-a-matches.json");
export const userAMatchesP2 = () => loadFixture<MatchInfo[]>("user-a-matches-p2.json");
export const userBMatches = () => loadFixture<MatchInfo[]>("user-b-matches.json");
export const matchDetails = () => loadFixture<MatchInfo[]>("match-details.json");
export const recentMatches = () => loadFixture<MatchInfo[]>("recent-matches.json");
export const versusMatches = () => loadFixture<MatchInfo[]>("versus-matches.json");
export const versus = () => loadFixture<VersusStats>("versus.json");
export const weeklyRace = () => loadFixture<WeeklyRace>("weekly-race.json");
export const liveData = () => loadFixture<PublicLiveData>("live.json");
export const leaderboard = () => loadFixture<Leaderboard>("leaderboard.json");
