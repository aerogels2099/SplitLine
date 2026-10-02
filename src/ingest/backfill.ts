import { ApiError } from "../api/client.js";
import type { MatchListParams, RankedApi } from "../api/endpoints.js";
import type { Store } from "../db/db.js";
import type { MatchType, UserDetails } from "../shared/types.js";

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
  const cursor = known ? store.ingestCursor(known.user.uuid) : null;

  if (known && cursor) {
    const user = await api.getUser(identifier);
    store.upsertPlayer(user);

    // A nickname that has passed to another player starts that player from scratch.
    if (user.uuid === known.user.uuid) {
      // lastRanked equals the newest ranked game's date, so nothing newer means nothing to fetch.
      if (user.timestamp.lastRanked <= cursor.date) {
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

      // `after` alone returns the newest page, so a longer gap is walked down to the cursor.
      let before: number | undefined;
      let newest = cursor.id;
      let fetched = 0;
      let stored = 0;
      for (;;) {
        const page = await api.getUserMatches(identifier, {
          count: PAGE,
          after: cursor.id,
          before,
          type,
          season: opts.season,
        });
        fetched += page.length;
        stored += store.upsertMatches(page);
        newest = Math.max(newest, ...page.map((m) => m.id));
        if (page.length < PAGE) break;
        before = page[page.length - 1]!.id;
      }
      // Only once the whole gap is stored, so a walk that fails retries it from the old cursor.
      store.advanceIngestCursor(user.uuid, newest);
      return {
        user,
        matchesFetched: fetched,
        matchesStored: stored,
        mode: "incremental",
        complete: true,
        cursor: null,
        seasonCursors: {},
      };
    }
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
  if (firstPage.length > 0) {
    store.advanceIngestCursor(user.uuid, Math.max(...firstPage.map((m) => m.id)));
  }
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

/** `before` must follow a fully stored page; resuming below a crawled slice skips the games above it. */
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
const WORKERS = 4;

/** Records matches the API has no detail for, since a retry won't change that. */
async function fetchDetails(
  store: Store,
  api: RankedApi,
  ids: number[],
  unavailable?: Set<number>,
): Promise<number> {
  let next = 0;
  let fetched = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        store.upsertDetail(await api.getMatch(id));
        fetched++;
      } catch (err) {
        if (err instanceof ApiError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429) {
          unavailable?.add(id);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker));
  return fetched;
}

/** Over-asks by the number skipped, so unavailable matches don't shrink the batch. */
function candidates(
  store: Store,
  opts: Parameters<Store["detailCandidates"]>[0],
  unavailable: Set<number> = new Set(),
): number[] {
  return store
    .detailCandidates({ ...opts, limit: opts.limit + unavailable.size })
    .filter((id) => !unavailable.has(id))
    .slice(0, opts.limit);
}

export async function fetchPlayerDetails(
  store: Store,
  api: RankedApi,
  uuid: string,
  opts: { target?: number; unavailable?: Set<number> } = {},
): Promise<number> {
  const target = opts.target ?? 40;
  const ids = candidates(store, { uuid, window: target * 2, limit: target }, opts.unavailable);
  return fetchDetails(store, api, ids, opts.unavailable);
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
  opts: { budget?: number; unavailable?: Set<number> } = {},
): Promise<number> {
  const ids = candidates(
    store,
    { window: 2000, limit: opts.budget ?? 50, completedOnly: true },
    opts.unavailable,
  );
  return fetchDetails(store, api, ids, opts.unavailable);
}
