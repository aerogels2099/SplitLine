import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import { fetchPlayerDetails, ingestPlayer, ingestSeason } from "../ingest/backfill.js";
import { buildGameHistory, labelRun } from "../analysis/history.js";
import { buildBandedDistributions, comparePacing, type SplitDistribution } from "../analysis/pacing.js";
import { bastionOf, overworldOf, performanceByBastion, performanceByOverworld } from "../analysis/seeds.js";
import { extractAllRuns, extractRunSplits, type RunSplits } from "../analysis/splits.js";
import { nowEpochSeconds } from "../shared/brand.js";
import type { UserDetails } from "../shared/types.js";

const INGEST_STALE_SECONDS = 10 * 60;
/** A walk that keeps failing is abandoned rather than retried on every poll. */
const SEASON_MAX_TRIES = 3;
const SEASON_RETRY_BASE_MS = 30_000;

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;
  private ingesting = new Map<string, Promise<UserDetails>>();
  private detailJobs = new Map<string, Promise<number>>();
  /** Season walks currently running, one entry per player and season. */
  private seasonJobs = new Map<string, Promise<number>>();
  /** Failed walks, so a fast-polling client cannot restart one on every poll. */
  private seasonFailures = new Map<string, { tries: number; nextAt: number }>();
  /** The peer corpus is identical for every player, so it is built once. */
  private corpus: { version: number; runs: RunSplits[]; banded: Record<string, SplitDistribution[]> } | null = null;

  constructor(dbPath: string, privateKey: string | null) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient({ privateKey }));
  }

  /** Runs one job at a time per player, clearing the slot when it settles. */
  private startJob(map: Map<string, Promise<number>>, uuid: string, job: () => Promise<number>) {
    if (map.has(uuid)) return;
    const p = job().finally(() => map.delete(uuid));
    p.catch(() => {});
    map.set(uuid, p);
  }

  /** Concurrent requests for one player share a single ingest. */
  async ensurePlayer(identifier: string): Promise<UserDetails> {
    const cached = this.store.getPlayer(identifier);
    if (cached && nowEpochSeconds() - cached.lastIngest < INGEST_STALE_SECONDS) {
      return cached.user;
    }
    const key = identifier.toLowerCase();
    let pending = this.ingesting.get(key);
    if (!pending) {
      pending = ingestPlayer(this.store, this.api, identifier).then((r) => {
        this.startJob(this.detailJobs, r.user.uuid, () =>
          fetchPlayerDetails(this.store, this.api, r.user.uuid),
        );
        return r.user;
      });
      this.ingesting.set(key, pending);
      pending.finally(() => this.ingesting.delete(key)).catch(() => {});
    }
    return pending;
  }

  /** Seasons from the API, so the selector offers them all before any games are held. */
  private async seasonsFor(identifier: string, uuid: string): Promise<number[]> {
    const played = this.store.playedSeasons(uuid);
    if (played.length > 0) return played;
    try {
      const summary = await this.api.getUserSeasons(identifier);
      const seasons = Object.keys(summary.seasonResults).map(Number);
      this.store.setPlayedSeasons(uuid, seasons);
      return this.store.playedSeasons(uuid);
    } catch {
      // Fall back to whatever we hold rather than showing no seasons at all.
      return this.store.seasonsForPlayer(uuid);
    }
  }

  /** Walks a season in the background the first time it is asked for. */
  private ensureSeason(identifier: string, uuid: string, season: number): boolean {
    if (this.store.isSeasonIngested(uuid, season)) return true;
    // A season the player never appeared in has nothing to walk and would never
    // settle; only a missing season list is worth trying anyway.
    const known = this.store.playedSeasons(uuid);
    if (known.length > 0 && !known.includes(season)) return true;
    const key = `${uuid}:${season}`;
    if (this.seasonJobs.has(key)) return false;

    const failed = this.seasonFailures.get(key);
    if (failed) {
      // Given up; reported as settled so the client stops polling.
      if (failed.tries >= SEASON_MAX_TRIES) return true;
      if (Date.now() < failed.nextAt) return false;
    }

    const p = ingestSeason(this.store, this.api, identifier, uuid, season)
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
    // Zero only when the player has no ranked games at all, matching no season.
    const active = season ?? seasons[0] ?? 0;
    const settled = this.ensureSeason(identifier, user.uuid, active);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });
    return {
      user,
      seasons,
      season: active,
      games: buildGameHistory(matches, user.uuid),
      // Tells the client to re-ask rather than trust a partial season.
      complete: settled,
    };
  }

  /** Rebuilt only when a new detail lands, since every player shares it. */
  private peerCorpus() {
    const version = this.store.detailCount();
    if (this.corpus?.version !== version) {
      const runs = extractAllRuns(this.store.getDetails({ limit: 2000 }));
      this.corpus = { version, runs, banded: buildBandedDistributions(runs) };
    }
    return this.corpus;
  }

  /** Splits against peers in the same elo band, plus the record per seed archetype. */
  async playerAnalysis(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = await this.seasonsFor(identifier, user.uuid);
    const active = season ?? seasons[0] ?? 0;
    // The seed half is season-scoped, so it needs the same walk the games tab triggers.
    const settled = this.ensureSeason(identifier, user.uuid, active);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });

    const corpus = this.peerCorpus();
    // Queried by player rather than filtered from the corpus, whose date-ordered
    // window would drop older runs.
    const mine = extractAllRuns(this.store.getDetails({ uuid: user.uuid, season: active })).filter(
      (r) => r.uuid === user.uuid,
    );

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
      complete: settled,
    };
  }

  async gameSplits(identifier: string, matchId: number) {
    const user = await this.ensurePlayer(identifier);
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
