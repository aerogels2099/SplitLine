import type { EpochSeconds } from "../shared/brand.js";
import type { MatchInfo } from "../shared/types.js";
import { eloExpectedScore } from "./stats.js";

/** Gaps between a player's games cluster at 10–15 minutes and thin out sharply past 30. */
export const SESSION_GAP_SECONDS = 30 * 60;
const MAX_POSITION = 8;
const MAX_STREAK = 3;
const MIN_BUCKET_GAMES = 30;
/** Each player gets a dozen rows, so a 95% interval would flag one in twenty by chance alone. */
const Z = 2.576;

export interface SessionGame {
  matchId: number;
  date: EpochSeconds;
  position: number;
  lossStreak: number;
  score: number;
  expected: number | null;
  forfeitedByPlayer: boolean;
  eloChange: number | null;
}

export interface Session {
  start: EpochSeconds;
  end: EpochSeconds;
  games: SessionGame[];
  wins: number;
  losses: number;
  draws: number;
  forfeits: number;
  eloChange: number;
}

export function splitSessions(matches: MatchInfo[], uuid: string): Session[] {
  const games = matches
    .filter((m) => m.type === 2 && !m.decayed && m.players.some((p) => p.uuid === uuid))
    .sort((a, b) => a.date - b.date || a.id - b.id);
  const out: Session[] = [];
  let current: Session | null = null;
  for (const m of games) {
    if (!current || m.date - current.end > SESSION_GAP_SECONDS) {
      current = { start: m.date, end: m.date, games: [], wins: 0, losses: 0, draws: 0, forfeits: 0, eloChange: 0 };
      out.push(current);
    }
    const mine = m.changes.find((c) => c.uuid === uuid);
    const theirs = m.changes.find((c) => c.uuid !== uuid);
    const score = m.result.uuid === null ? 0.5 : m.result.uuid === uuid ? 1 : 0;
    const last = current.games.at(-1);
    const game: SessionGame = {
      matchId: m.id,
      date: m.date,
      position: current.games.length + 1,
      lossStreak: last ? (last.score === 0 ? last.lossStreak + 1 : 0) : 0,
      score,
      expected:
        mine?.eloRate != null && theirs?.eloRate != null ? eloExpectedScore(mine.eloRate, theirs.eloRate) : null,
      forfeitedByPlayer: m.forfeited && score === 0,
      eloChange: mine?.change ?? null,
    };
    current.games.push(game);
    current.end = m.date;
    if (score === 1) current.wins++;
    else if (score === 0) current.losses++;
    else current.draws++;
    if (game.forfeitedByPlayer) current.forfeits++;
    current.eloChange += game.eloChange ?? 0;
  }
  return out;
}

interface Residual {
  rated: number;
  value: number;
  se: number;
}

function residual(games: SessionGame[]): Residual {
  const rated = games.filter((g) => g.expected !== null);
  let gap = 0;
  let variance = 0;
  for (const g of rated) {
    gap += g.score - g.expected!;
    variance += g.expected! * (1 - g.expected!);
  }
  return {
    rated: rated.length,
    value: rated.length > 0 ? gap / rated.length : 0,
    se: rated.length > 0 ? Math.sqrt(variance) / rated.length : 0,
  };
}

export interface Bucket {
  label: string;
  games: number;
  forfeitRate: number;
  rated: number;
  /** Against the player's own usual result versus Elo, so a rising player's lead doesn't hide a drop. */
  relative: number;
  low: number;
  high: number;
  thin: boolean;
}

function bucket(label: string, games: SessionGame[], baseline: number): Bucket {
  const r = residual(games);
  const relative = r.value - baseline;
  return {
    label,
    games: games.length,
    forfeitRate: games.length > 0 ? games.filter((g) => g.forfeitedByPlayer).length / games.length : 0,
    rated: r.rated,
    relative,
    low: relative - Z * r.se,
    high: relative + Z * r.se,
    thin: r.rated < MIN_BUCKET_GAMES,
  };
}

export interface SessionReport {
  sessions: Session[];
  baseline: number;
  byPosition: Bucket[];
  afterLosses: Bucket[];
  dropFrom: number | null;
}

export function sessionReport(matches: MatchInfo[], uuid: string): SessionReport {
  const sessions = splitSessions(matches, uuid);
  const games = sessions.flatMap((s) => s.games);
  const baseline = residual(games).value;
  const byPosition = Array.from({ length: MAX_POSITION }, (_, i) => {
    const n = i + 1;
    const last = n === MAX_POSITION;
    return bucket(last ? `${n}+` : `${n}`, games.filter((g) => (last ? g.position >= n : g.position === n)), baseline);
  });
  const afterLosses = Array.from({ length: MAX_STREAK + 1 }, (_, k) => {
    const last = k === MAX_STREAK;
    return bucket(last ? `${k}+` : `${k}`, games.filter((g) => (last ? g.lossStreak >= k : g.lossStreak === k)), baseline);
  });
  let dropFrom: number | null = null;
  let strongest = -Z;
  for (let n = 2; n <= MAX_POSITION; n++) {
    const later = residual(games.filter((g) => g.position >= n));
    const earlier = residual(games.filter((g) => g.position < n));
    if (later.rated < MIN_BUCKET_GAMES || earlier.rated < MIN_BUCKET_GAMES) continue;
    const z = (later.value - earlier.value) / Math.hypot(later.se, earlier.se);
    if (z < strongest) {
      strongest = z;
      dropFrom = n;
    }
  }
  return { sessions, baseline, byPosition, afterLosses, dropFrom };
}
