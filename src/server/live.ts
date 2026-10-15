import { scoreLiveMatch, type BandedWinProbModel, type LiveScore } from "../analysis/winprob.js";
import type { PublicLiveData } from "../shared/types.js";

export interface LivePoint {
  t: number;
  pA: number;
}

export interface LiveMatchView extends LiveScore {
  key: string;
  history: LivePoint[];
}

export interface LiveView {
  online: number;
  matches: LiveMatchView[];
}

export class LiveTracker {
  private matches = new Map<string, LiveMatchView>();

  update(data: PublicLiveData, banded: BandedWinProbModel): LiveView {
    const next = new Map<string, LiveMatchView>();
    for (const m of data.liveMatches) {
      const players = [...m.players].sort((x, y) => (x.uuid < y.uuid ? -1 : 1));
      const score = scoreLiveMatch(banded, { ...m, players });
      if (!score) continue;
      const key = players.map((p) => p.uuid).join(":");
      const held = this.matches.get(key);
      const history = held && score.currentTimeMs >= held.currentTimeMs ? held.history : [];
      if (score.currentTimeMs > (history.at(-1)?.t ?? -1)) {
        history.push({ t: score.currentTimeMs, pA: score.players[0].winProb });
      }
      next.set(key, { key, ...score, history });
    }
    this.matches = next;
    return { online: data.players, matches: [...next.values()] };
  }
}
