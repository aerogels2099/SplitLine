import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import { fetchPlayerDetails, ingestPlayer, ingestSeason } from "../ingest/backfill.js";
import { buildGameHistory, labelRun } from "../analysis/history.js";
import { buildBandedDistributions, comparePacing, type SplitDistribution } from "../analysis/pacing.js";
import { bastionOf, overworldOf, performanceByBastion, performanceByOverworld } from "../analysis/seeds.js";
import { extractRunSplits, type RunSplits } from "../analysis/splits.js";
import { buildBandedWinProbModels, type BandedWinProbModel } from "../analysis/winprob.js";
import { nowEpochSeconds } from "../shared/brand.js";
import type { UserDetails } from "../shared/types.js";

const INGEST_STALE_SECONDS = 10 * 60;
const SEASON_MAX_TRIES = 3;
const SEASON_RETRY_BASE_MS = 30_000;
const CORPUS_REFRESH_MS = 60_000;

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;
  private ingesting = new Map<string, Promise<UserDetails>>();
  private detailJobs = new Map<string, Promise<number>>();
  private seasonJobs = new Map<string, Promise<number>>();
  private seasonFailures = new Map<string, { tries: number; nextAt: number }>();
  // Where each season leaves the first page, so its walk does not fetch that page again.
  private seasonResume = new Map<string, number>();
  private corpus: {
    version: number;
    builtAt: number;
    runs: RunSplits[];
    banded: Record<string, SplitDistribution[]>;
    winProb: BandedWinProbModel | null;
  } | null = null;

  constructor(dbPath: string, privateKey: string | null) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient({ privateKey }));
  }

  private startJob(map: Map<string, Promise<number>>, uuid: string, job: () => Promise<number>) {
    if (map.has(uuid)) return;
    const p = job().finally(() => map.delete(uuid));
    p.catch(() => {});
    map.set(uuid, p);
  }

  async ensurePlayer(identifier: string): Promise<UserDetails> {
    const cached = this.store.getPlayer(identifier);
    if (cached && nowEpochSeconds() - cached.lastIngest < INGEST_STALE_SECONDS) {
      return cached.user;
    }
    // By uuid when known, so a nickname and a uuid lookup share one ingest.
    const key = cached?.user.uuid ?? identifier.toLowerCase();
    let pending = this.ingesting.get(key);
    if (!pending) {
      pending = ingestPlayer(this.store, this.api, identifier).then((r) => {
        for (const [season, id] of Object.entries(r.seasonCursors)) {
          this.seasonResume.set(`${r.user.uuid}:${season}`, id);
        }
        this.startJob(this.detailJobs, r.user.uuid, () =>
          fetchPlayerDetails(this.store, this.api, r.user.uuid),
        );
        return r.user;
      });
      this.ingesting.set(key, pending);
      pending.finally(() => this.ingesting.delete(key)).catch(() => {});
    }
    // A known player is served from the store while the refresh runs behind it.
    return cached ? cached.user : pending;
  }

  private refreshing(uuid: string): boolean {
    return this.ingesting.has(uuid) || this.detailJobs.has(uuid);
  }

  private async seasonsFor(identifier: string, uuid: string): Promise<number[]> {
    const played = this.store.playedSeasons(uuid);
    if (played.length > 0) return played;
    try {
      const summary = await this.api.getUserSeasons(identifier);
      const seasons = Object.keys(summary.seasonResults).map(Number);
      this.store.setPlayedSeasons(uuid, seasons);
      return this.store.playedSeasons(uuid);
    } catch {
      return this.store.seasonsForPlayer(uuid);
    }
  }

  /** True once the season will not change: stored, never played, or given up on. */
  private ensureSeason(identifier: string, uuid: string, season: number): boolean {
    if (this.store.isSeasonIngested(uuid, season)) return true;
    const known = this.store.playedSeasons(uuid);
    if (known.length > 0 && !known.includes(season)) return true;
    const key = `${uuid}:${season}`;
    if (this.seasonJobs.has(key)) return false;

    const failed = this.seasonFailures.get(key);
    if (failed) {
      if (failed.tries >= SEASON_MAX_TRIES) return true;
      if (Date.now() < failed.nextAt) return false;
    }

    const before = this.seasonResume.get(key);
    this.seasonResume.delete(key);
    const p = ingestSeason(this.store, this.api, identifier, uuid, season, { before })
      .then((n) => {
        this.seasonFailures.delete(key);
        return n;
      })
      .catch((err: unknown) => {
        const tries = (this.seasonFailures.get(key)?.tries ?? 0) + 1;
        this.seasonFailures.set(key, {
          tries,
          nextAt: Date.now() + SEASON_RETRY_BASE_MS * 2 ** (tries - 1),
        });
        throw err;
      })
      .finally(() => this.seasonJobs.delete(key));
    p.catch(() => {});
    this.seasonJobs.set(key, p);
    return false;
  }

  async playerHistory(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = await this.seasonsFor(identifier, user.uuid);
    const active = season ?? seasons[0] ?? 0;
    const settled = this.ensureSeason(identifier, user.uuid, active);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });
    return {
      user,
      seasons,
      season: active,
      games: buildGameHistory(matches, user.uuid),
      complete: settled && !this.ingesting.has(user.uuid),
    };
  }

  private peerCorpus() {
    const version = this.store.detailCount();
    // Rebuilt at most once a minute while details are still arriving.
    const held = this.corpus;
    if (!held || (held.version !== version && Date.now() - held.builtAt >= CORPUS_REFRESH_MS)) {
      const runs = this.store.getRuns({ limit: 2000 });
      this.corpus = {
        version,
        builtAt: Date.now(),
        runs,
        banded: buildBandedDistributions(runs),
        winProb: null,
      };
    }
    return this.corpus!;
  }

  winProbModels(): BandedWinProbModel {
    const corpus = this.peerCorpus();
    corpus.winProb ??= buildBandedWinProbModels(corpus.runs);
    return corpus.winProb;
  }

  async playerAnalysis(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = await this.seasonsFor(identifier, user.uuid);
    const active = season ?? seasons[0] ?? 0;
    const settled = this.ensureSeason(identifier, user.uuid, active);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });

    const corpus = this.peerCorpus();
    const mine = this.store.getPlayerRuns(user.uuid, active);

    return {
      user,
      seasons,
      season: active,
      runCount: mine.length,
      corpusRunCount: corpus.runs.length,
      comparison: comparePacing(mine, corpus.runs),
      bandedDistributions: corpus.banded,
      byBastion: performanceByBastion(matches, user.uuid),
      byOverworld: performanceByOverworld(matches, user.uuid),
      complete: settled && !this.refreshing(user.uuid),
    };
  }

  async gameSplits(identifier: string, matchId: number) {
    const user = this.store.getPlayer(identifier)?.user ?? (await this.ensurePlayer(identifier));
    let detail = this.store.getDetail(matchId);
    if (!detail) {
      detail = await this.api.getMatch(matchId);
      this.store.upsertDetail(detail);
    }
    const order = [user.uuid, ...detail.players.map((p) => p.uuid).filter((u) => u !== user.uuid)];
    const runs = order
      .map((u) => extractRunSplits(detail, u))
      .filter((r) => r !== null)
      .map(labelRun);
    return {
      matchId,
      runs,
      bastion: bastionOf(detail),
      overworld: overworldOf(detail),
    };
  }
}
