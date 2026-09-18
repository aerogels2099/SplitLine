import type { RankedApi } from "../api/endpoints.js";
import type { Store } from "../db/db.js";
import type { MatchInfo, UserDetails } from "../shared/types.js";

export interface PlayerIngestResult {
  user: UserDetails;
  matchesFetched: number;
  matchesStored: number;
}

/** Decayed matches are stored and flagged; timelines are fetched separately. */
export async function ingestPlayer(
  store: Store,
  api: RankedApi,
  identifier: string,
  opts: { maxMatches?: number; season?: number } = {},
): Promise<PlayerIngestResult> {
  const maxMatches = opts.maxMatches ?? 300;

  const [user, firstPage] = await Promise.all([
    api.getUser(identifier),
    api.getUserMatches(identifier, { count: 100, season: opts.season }),
  ]);
  store.upsertPlayer(user);

  // Paginate backward until a page comes back short. [] is the terminator,
  // not an error.
  const all: MatchInfo[] = [...firstPage];
  let last = firstPage;
  while (all.length < maxMatches && last.length === 100) {
    last = await api.getUserMatches(identifier, {
      count: 100,
      before: all[all.length - 1]!.id,
      season: opts.season,
    });
    all.push(...last);
  }
  const stored = store.upsertMatches(all);

  return { user, matchesFetched: all.length, matchesStored: stored };
}

export async function fetchPlayerDetails(
  store: Store,
  api: RankedApi,
  uuid: string,
  detailTarget = 40,
): Promise<number> {
  const wanted = store
    .getMatchesForPlayer(uuid, { type: 2, limit: detailTarget * 2 })
    .filter((m) => !m.decayed)
    .slice(0, detailTarget)
    .filter((m) => !store.hasDetail(m.id));

  let fetched = 0;
  const CHUNK = 8;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const details = await Promise.all(chunk.map((m) => api.getMatch(m.id)));
    for (const d of details) {
      store.upsertDetail(d);
      fetched++;
    }
  }
  return fetched;
}

export interface CrawlResult {
  pagesFetched: number;
  matchesStored: number;
}

export async function crawlMatches(
  store: Store,
  api: RankedApi,
  opts: { pages?: number; fromOldest?: boolean } = {},
): Promise<CrawlResult> {
  const pages = opts.pages ?? 5;
  let before = opts.fromOldest ? (store.oldestMatchId() ?? undefined) : undefined;
  let stored = 0;
  let fetched = 0;
  for (let i = 0; i < pages; i++) {
    const page = await api.getMatches({ count: 100, type: 2, before });
    fetched++;
    if (page.length === 0) break;
    stored += store.upsertMatches(page);
    before = page[page.length - 1]!.id;
    if (page.length < 100) break;
  }
  return { pagesFetched: fetched, matchesStored: stored };
}

export async function fetchCorpusDetails(
  store: Store,
  api: RankedApi,
  opts: { budget?: number } = {},
): Promise<number> {
  const budget = opts.budget ?? 50;
  const candidates = store
    .getAllMatches({ type: 2, limit: 2000 })
    .filter((m) => !m.decayed && !m.forfeited && m.result.uuid !== null)
    .filter((m) => !store.hasDetail(m.id))
    .slice(0, budget);

  let fetched = 0;
  const CHUNK = 8;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const details = await Promise.all(chunk.map((m) => api.getMatch(m.id)));
    for (const d of details) {
      store.upsertDetail(d);
      fetched++;
    }
  }
  return fetched;
}
