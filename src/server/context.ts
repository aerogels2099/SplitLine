import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import { fetchPlayerDetails, ingestPlayer } from "../ingest/backfill.js";
import { buildGameHistory, labelRun, seasonsPlayed } from "../analysis/history.js";
import { extractRunSplits } from "../analysis/splits.js";
import { nowEpochSeconds } from "../shared/brand.js";
import type { UserDetails } from "../shared/types.js";

const INGEST_STALE_SECONDS = 10 * 60;

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;
  private ingesting = new Map<string, Promise<UserDetails>>();

  /** Keyed on the row count that feeds each value, so an ingest invalidates it. */
  private memoCache = new Map<string, { version: number; value: unknown }>();

  private memo<T>(key: string, version: number, compute: () => T): T {
    const hit = this.memoCache.get(key);
    if (hit && hit.version === version) return hit.value as T;
    const value = compute();
    this.memoCache.set(key, { version, value });
    return value;
  }

  constructor(dbPath: string, privateKey: string | null) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient({ privateKey }));
  }

  private rankedMatches(uuid: string) {
    return this.memo(`ranked:${uuid}`, this.store.matchCount(), () =>
      this.store.getMatchesForPlayer(uuid, { type: 2 }),
    );
  }

  private detailJobs = new Map<string, Promise<number>>();

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
        if (!this.detailJobs.has(uuid)) {
          const job = fetchPlayerDetails(this.store, this.api, uuid).finally(() =>
            this.detailJobs.delete(uuid),
          );
          job.catch(() => {});
          this.detailJobs.set(uuid, job);
        }
        return r.user;
      });
      this.ingesting.set(key, pending);
      pending.finally(() => this.ingesting.delete(key)).catch(() => {});
    }
    return pending;
  }

  async playerHistory(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const matches = this.rankedMatches(user.uuid);
    const seasons = seasonsPlayed(matches);
    // 0 only when the player has no ranked games at all, so no season matches.
    const active = season ?? seasons[0] ?? 0;
    return {
      user,
      seasons,
      season: active,
      games: buildGameHistory(matches, user.uuid, active),
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
    return { matchId, runs };
  }
}
