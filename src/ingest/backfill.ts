import type { MatchListParams, RankedApi } from "../api/endpoints.js";
import type { Store } from "../db/db.js";
import type { MatchInfo, MatchType, UserDetails } from "../shared/types.js";

/** A page is 100 matches, the most the API will return at once. */
const PAGE = 100;

/** The player page only ever renders ranked games. */
const DEFAULT_TYPE: MatchType = 2;

export type IngestMode = "skipped" | "incremental" | "first-page";

export interface PlayerIngestResult {
  user: UserDetails;
  matchesFetched: number;
  matchesStored: number;
  mode: IngestMode;
  /** False while older history is still missing; the cursor is where to resume. */
  complete: boolean;
  cursor: number | null;
  seasonCursors: Record<number, number>;
}

interface IngestOpts {
  season?: number;
  type?: MatchType;
}

/** Older pages are left to the background season walk. */
export async function ingestPlayer(
  store: Store,
  api: RankedApi,
  identifier: string,
  opts: IngestOpts = {},
): Promise<PlayerIngestResult> {
  const type = opts.type ?? DEFAULT_TYPE;
  const known = store.getPlayer(identifier);
  const newest = known ? store.newestMatchForPlayer(known.user.uuid) : null;

  if (newest) {
    const user = await api.getUser(identifier);
    store.upsertPlayer(user);

    // The profile's last-ranked timestamp is exactly the newest ranked match's
    // date, verified against live responses, so nothing newer means nothing to fetch.
    if (user.timestamp.lastRanked <= newest.date) {
      return {
        user,
        matchesFetched: 0,
        matchesStored: 0,
        mode: "skipped",
        complete: true,
        cursor: null,
        seasonCursors: {},
      };
    }

    const fresh = await api.getUserMatches(identifier, {
      count: PAGE,
      after: newest.id,
      type,
      season: opts.season,
    });
    const stored = store.upsertMatches(fresh);
    if (fresh.length < PAGE) {
      return {
        user,
        matchesFetched: fresh.length,
        matchesStored: stored,
        mode: "incremental",
        complete: true,
        cursor: null,
        seasonCursors: {},
      };
    }
    // A full page means the delta has a hole; fall through to a full walk.
  }

  const [user, firstPage, seasons] = await Promise.all([
    api.getUser(identifier),
    api.getUserMatches(identifier, { count: PAGE, type, season: opts.season }),
    api.getUserSeasons(identifier).catch(() => null),
  ]);
  store.upsertPlayer(user);
  if (seasons) {
    store.setPlayedSeasons(user.uuid, Object.keys(seasons.seasonResults).map(Number));
  }
  const stored = store.upsertMatches(firstPage);
  const complete = firstPage.length < PAGE;
  const seasonCursors: Record<number, number> = {};
  for (const m of firstPage) {
    const held = seasonCursors[m.season];
    if (held === undefined || m.id < held) seasonCursors[m.season] = m.id;
  }
  return {
    user,
    matchesFetched: firstPage.length,
    matchesStored: stored,
    mode: "first-page",
    complete,
    cursor: complete ? null : firstPage[firstPage.length - 1]!.id,
    seasonCursors,
  };
}

/**
 * Uncapped, or a heavy season would be cut short. `before` must follow a page stored
 * in full: resuming below a slice the corpus crawl left would skip everything above it.
 */
export async function ingestSeason(
  store: Store,
  api: RankedApi,
  identifier: string,
  uuid: string,
  season: number,
  opts: { type?: MatchType; before?: number } = {},
): Promise<number> {
  const params: MatchListParams = { count: PAGE, type: opts.type ?? DEFAULT_TYPE, season };
  let before: number | undefined = opts.before;
  let stored = 0;
  for (;;) {
    const page = await api.getUserMatches(identifier, { ...params, before });
    if (page.length === 0) break;
    stored += store.upsertMatches(page);
    before = page[page.length - 1]!.id;
    if (page.length < PAGE) break;
  }
  store.markSeasonIngested(uuid, season);
  return stored;
}

/** Below the client's concurrency limit, so background work leaves slots free. */
const CHUNK = 4;

async function fetchDetails(store: Store, api: RankedApi, ids: number[]): Promise<number> {
  let fetched = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const results = await Promise.allSettled(ids.slice(i, i + CHUNK).map((id) => api.getMatch(id)));
    const details = results
      .filter((r): r is PromiseFulfilledResult<MatchInfo> => r.status === "fulfilled")
      .map((r) => r.value);
    if (details.length > 0) store.upsertDetails(details);
    fetched += details.length;
  }
  return fetched;
}

export async function fetchPlayerDetails(
  store: Store,
  api: RankedApi,
  uuid: string,
  detailTarget = 40,
): Promise<number> {
  const ids = store.detailCandidates({
    uuid,
    window: detailTarget * 2,
    limit: detailTarget,
  });
  return fetchDetails(store, api, ids);
}

export interface CrawlResult {
  pagesFetched: number;
  matchesStored: number;
}

export async function crawlMatches(
  store: Store,
  api: RankedApi,
  opts: { pages?: number } = {},
): Promise<CrawlResult> {
  const pages = opts.pages ?? 5;
  let before: number | undefined;
  let stored = 0;
  let fetched = 0;
  for (let i = 0; i < pages; i++) {
    const page = await api.getMatches({ count: PAGE, type: 2, before });
    fetched++;
    if (page.length === 0) break;
    stored += store.upsertMatches(page);
    before = page[page.length - 1]!.id;
    if (page.length < PAGE) break;
  }
  return { pagesFetched: fetched, matchesStored: stored };
}

export async function fetchCorpusDetails(
  store: Store,
  api: RankedApi,
  opts: { budget?: number } = {},
): Promise<number> {
  const ids = store.detailCandidates({
    window: 2000,
    limit: opts.budget ?? 50,
    completedOnly: true,
  });
  return fetchDetails(store, api, ids);
}
