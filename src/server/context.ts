import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import { continueBackfill, fetchPlayerDetails, ingestPlayer } from "../ingest/backfill.js";
import { buildGameHistory, labelRun } from "../analysis/history.js";
import { buildBandedDistributions, comparePacing, type SplitDistribution } from "../analysis/pacing.js";
import { bastionOf, overworldOf, performanceByBastion, performanceByOverworld } from "../analysis/seeds.js";
import { extractAllRuns, extractRunSplits, type RunSplits } from "../analysis/splits.js";
import { nowEpochSeconds } from "../shared/brand.js";
import type { UserDetails } from "../shared/types.js";

const INGEST_STALE_SECONDS = 10 * 60;

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;
  private ingesting = new Map<string, Promise<UserDetails>>();
  private detailJobs = new Map<string, Promise<number>>();
  /** Players whose older history is still being walked in the background. */
  private backfillJobs = new Map<string, Promise<number>>();
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
        const uuid = r.user.uuid;
        // Older pages finish after the response, not inside it.
        if (!r.complete && r.cursor !== null) {
          const cursor = r.cursor;
          this.startJob(this.backfillJobs, uuid, () =>
            continueBackfill(this.store, this.api, identifier, cursor),
          );
        }
        this.startJob(this.detailJobs, uuid, () =>
          fetchPlayerDetails(this.store, this.api, uuid),
        );
        return r.user;
      });
      this.ingesting.set(key, pending);
      pending.finally(() => this.ingesting.delete(key)).catch(() => {});
    }
    return pending;
  }

  async playerHistory(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = this.store.seasonsForPlayer(user.uuid);
    // Falls back to zero only when the player has no ranked games at all, which matches no season.
    const active = season ?? seasons[0] ?? 0;
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });
    return {
      user,
      seasons,
      season: active,
      games: buildGameHistory(matches, user.uuid),
      // Tells the client to re-ask rather than trust a partial season.
      complete: !this.backfillJobs.has(user.uuid),
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

  /**
   * Pacing and seed performance for one player: their splits against peers in
   * the same elo band, and their record per seed archetype.
   */
  async playerAnalysis(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = this.store.seasonsForPlayer(user.uuid);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season });

    const corpus = this.peerCorpus();
    // Queried by uuid rather than filtered out of the corpus, whose window is
    // ordered by date across all players and would drop older runs.
    const mine = extractAllRuns(this.store.getDetails({ uuid: user.uuid, season })).filter(
      (r) => r.uuid === user.uuid,
    );

    return {
      user,
      seasons,
      season: season ?? null,
      runCount: mine.length,
      corpusRunCount: corpus.runs.length,
      comparison: comparePacing(mine, corpus.runs),
      bandedDistributions: corpus.banded,
      byBastion: performanceByBastion(matches, user.uuid),
      byOverworld: performanceByOverworld(matches, user.uuid),
      complete: !this.backfillJobs.has(user.uuid),
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
