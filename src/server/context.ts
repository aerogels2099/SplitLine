import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import { continueBackfill, fetchPlayerDetails, ingestPlayer } from "../ingest/backfill.js";
import { buildGameHistory, labelRun } from "../analysis/history.js";
import { extractRunSplits } from "../analysis/splits.js";
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

  constructor(dbPath: string, privateKey: string | null) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient({ privateKey }));
  }

  /** Runs `job` once per uuid, clearing the slot when it settles. */
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
    // 0 only when the player has no ranked games at all, so no season matches.
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
