import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";
import {
  crawlMatches,
  fetchCorpusDetails,
  fetchPlayerDetails,
  ingestPlayer,
  ingestSeason,
} from "../ingest/backfill.js";
import { buildGameHistory, labelRun } from "../analysis/history.js";
import { H2H_SEASONS, headToHeadFromVersus, predictMatchup, type MatchupSide } from "../analysis/matchup.js";
import {
  buildBandedDistributions,
  buildSplitDistributions,
  comparePacing,
  type SplitDistribution,
} from "../analysis/pacing.js";
import { bastionOf, overworldOf, performanceByBastion, performanceByOverworld } from "../analysis/seeds.js";
import { sessionReport } from "../analysis/sessions.js";
import { extractRunSplits, type RunSplits } from "../analysis/splits.js";
import { buildBandedWinProbModels, modelForElo, type BandedWinProbModel } from "../analysis/winprob.js";
import { nowEpochSeconds } from "../shared/brand.js";
import { LiveTracker, type LiveView } from "./live.js";
import type { UserDetails } from "../shared/types.js";

const INGEST_STALE_SECONDS = 10 * 60;
const SEASON_MAX_TRIES = 3;
const SEASON_RETRY_BASE_MS = 30_000;
const CORPUS_REFRESH_MS = 60_000;
const CORPUS_MATCHES = 5000;
const CRAWL_FIRST_MS = 2 * 60_000;
const CRAWL_EVERY_MS = 30 * 60_000;
const CRAWL_DETAILS = 25;
const CRAWL_MIN_BUDGET = 300;
const LIVE_REFRESH_MS = 10_000;

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;
  private ingesting = new Map<string, Promise<UserDetails>>();
  private detailJobs = new Map<string, Promise<number>>();
  private seasonJobs = new Map<string, Promise<number>>();
  private seasonFailures = new Map<string, { tries: number; nextAt: number }>();
  // Where each season leaves the first page, so its walk does not fetch that page again.
  private seasonResume = new Map<string, number>();
  private unavailableDetails = new Set<number>();
  private live = new LiveTracker();
  private liveView: { at: number; view: Promise<LiveView> } | null = null;
  private corpus: {
    version: number;
    builtAt: number;
    runs: RunSplits[];
    banded: Record<string, SplitDistribution[]>;
    pooled: SplitDistribution[] | null;
    winProb: BandedWinProbModel | null;
  } | null = null;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient());
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
    const key = cached?.user.uuid ?? identifier.replace(/-/g, "").toLowerCase();
    let pending = this.ingesting.get(key);
    if (!pending) {
      pending = ingestPlayer(this.store, this.api, identifier).then((r) => {
        for (const [season, id] of Object.entries(r.seasonCursors)) {
          this.seasonResume.set(`${r.user.uuid}:${season}`, id);
        }
        this.startJob(this.detailJobs, r.user.uuid, () =>
          fetchPlayerDetails(this.store, this.api, r.user.uuid, {
            unavailable: this.unavailableDetails,
          }),
        );
        return r.user;
      });
      this.ingesting.set(key, pending);
      pending.finally(() => this.ingesting.delete(key)).catch(() => {});
    }
    // A known player is served from the store while the refresh runs behind it.
    return cached ? cached.user : pending;
  }

  /** So peers and models reflect ranked play at large, not just looked-up players. */
  startCorpusCrawl(onError: (err: unknown) => void): () => void {
    let running = false;
    const tick = async () => {
      if (running || this.api.client.budgetRemaining() < CRAWL_MIN_BUDGET) return;
      running = true;
      try {
        await crawlMatches(this.store, this.api, { pages: 1 });
        await fetchCorpusDetails(this.store, this.api, {
          budget: CRAWL_DETAILS,
          unavailable: this.unavailableDetails,
        });
      } catch (err) {
        onError(err);
      } finally {
        running = false;
      }
    };
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      void tick();
      every = setInterval(() => void tick(), CRAWL_EVERY_MS);
    }, CRAWL_FIRST_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
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
    const version = this.store.detailVersion();
    // Rebuilt at most once a minute while details are still arriving.
    const held = this.corpus;
    if (!held || (held.version !== version && Date.now() - held.builtAt >= CORPUS_REFRESH_MS)) {
      const runs = this.store.getRuns({ limit: CORPUS_MATCHES });
      this.corpus = {
        version,
        builtAt: Date.now(),
        runs,
        banded: buildBandedDistributions(runs),
        pooled: null,
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

  liveMatches(): Promise<LiveView> {
    const held = this.liveView;
    if (held && Date.now() - held.at < LIVE_REFRESH_MS) return held.view;
    const view = this.api.getLive().then((data) => this.live.update(data, this.winProbModels()));
    this.liveView = { at: Date.now(), view };
    view.catch(() => {
      if (this.liveView?.view === view) this.liveView = null;
    });
    return view;
  }

  async playerSessions(identifier: string, season?: number) {
    const user = await this.ensurePlayer(identifier);
    const seasons = await this.seasonsFor(identifier, user.uuid);
    const active = season ?? seasons[0] ?? 0;
    const settled = this.ensureSeason(identifier, user.uuid, active);
    const matches = this.store.getMatchesForPlayer(user.uuid, { type: 2, season: active });
    return {
      user,
      seasons,
      season: active,
      ...sessionReport(matches, user.uuid),
      complete: settled && !this.refreshing(user.uuid),
    };
  }

  async matchup(identifierA: string, identifierB: string) {
    const [userA, userB] = await Promise.all([
      this.ensurePlayer(identifierA),
      this.ensurePlayer(identifierB),
    ]);
    if (userA.uuid === userB.uuid) return null;

    const [playedA, playedB] = await Promise.all([
      this.seasonsFor(identifierA, userA.uuid),
      this.seasonsFor(identifierB, userB.uuid),
    ]);
    const latest = Math.max(0, ...playedA, ...playedB);
    const seasons = Array.from({ length: H2H_SEASONS }, (_, i) => latest - i).filter((s) => s > 0);

    let settled = true;
    for (const season of seasons) {
      settled = this.ensureSeason(identifierA, userA.uuid, season) && settled;
      settled = this.ensureSeason(identifierB, userB.uuid, season) && settled;
    }

    const versus = await Promise.all(
      seasons.map((season) => this.api.getVersus(userA.uuid, userB.uuid, season)),
    );

    const corpus = this.peerCorpus();
    const banded = this.winProbModels();
    const side = (user: UserDetails): MatchupSide => {
      const lookup = modelForElo(banded, user.eloRate);
      return {
        uuid: user.uuid,
        nickname: user.nickname,
        elo: user.eloRate,
        matches: seasons.flatMap((season) =>
          this.store.getMatchesForPlayer(user.uuid, { type: 2, season }),
        ),
        model: lookup.model,
        // The pooled "all" model has no banded splits.
        splits: corpus.banded[lookup.band] ?? (corpus.pooled ??= buildSplitDistributions(corpus.runs)),
        band: lookup.band,
      };
    };

    return {
      ...predictMatchup(side(userA), side(userB), headToHeadFromVersus(versus, userA.uuid, userB.uuid)),
      seasons,
      complete: settled && !this.refreshing(userA.uuid) && !this.refreshing(userB.uuid),
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
