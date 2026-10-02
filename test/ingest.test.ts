import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import type { RankedApi, MatchListParams } from "../src/api/endpoints.js";
import { Store } from "../src/db/db.js";
import { crawlMatches, fetchCorpusDetails, ingestPlayer, ingestSeason } from "../src/ingest/backfill.js";
import type { MatchInfo, UserDetails } from "../src/shared/types.js";
import { recentMatches, userA, userAMatches } from "./helpers.js";

function fakeApi(opts: { user: UserDetails; pages?: MatchInfo[][]; seasons?: number[] }) {
  const calls: { method: string; params?: MatchListParams }[] = [];
  const pages = [...(opts.pages ?? [])];
  const api = {
    async getUser() {
      calls.push({ method: "getUser" });
      return opts.user;
    },
    async getUserMatches(_id: string, params: MatchListParams = {}) {
      calls.push({ method: "getUserMatches", params });
      return pages.shift() ?? [];
    },
    async getUserSeasons() {
      calls.push({ method: "getUserSeasons" });
      const seasonResults: Record<string, unknown> = {};
      for (const n of opts.seasons ?? []) seasonResults[String(n)] = {};
      return { ...opts.user, seasonResults };
    },
  };
  return { api: api as unknown as RankedApi, calls };
}

const withLastRanked = (u: UserDetails, lastRanked: number): UserDetails => ({
  ...u,
  timestamp: { ...u.timestamp, lastRanked: lastRanked as UserDetails["timestamp"]["lastRanked"] },
});

/** Answers like the API: newest first, `after` and `before` bounding an exclusive range. */
function rangeApi(user: UserDetails, server: MatchInfo[], failOnCall?: number) {
  const calls: MatchListParams[] = [];
  const api = {
    async getUser() {
      return user;
    },
    async getUserMatches(_id: string, params: MatchListParams = {}) {
      calls.push(params);
      if (calls.length === failOnCall) throw new Error("upstream down");
      return server
        .filter((m) => m.id > (params.after ?? -Infinity) && m.id < (params.before ?? Infinity))
        .sort((a, b) => b.id - a.id)
        .slice(0, params.count ?? 20);
    },
    async getUserSeasons() {
      return { ...user, seasonResults: {} };
    },
  };
  return { api: api as unknown as RankedApi, calls };
}

describe("ingestPlayer", () => {
  const ranked = userAMatches().filter((m) => m.type === 2);
  const newestOf = (ms: MatchInfo[]) => ms.reduce((a, b) => (b.id > a.id ? b : a));
  const make = (id: number): MatchInfo => ({
    ...ranked[0]!,
    id,
    date: (1700000000 + id) as MatchInfo["date"],
  });

  it("spends one request when the profile shows nothing new", async () => {
    const store = new Store(":memory:");
    const user = userA();
    store.upsertPlayer(user);
    store.upsertMatches(ranked);
    const newest = newestOf(ranked);
    store.advanceIngestCursor(user.uuid, newest.id);

    // The last-ranked timestamp equals the newest stored match's date: nothing to fetch.
    const { api, calls } = fakeApi({ user: withLastRanked(user, newest.date) });
    const r = await ingestPlayer(store, api, user.nickname);

    expect(r.mode).toBe("skipped");
    expect(r.complete).toBe(true);
    expect(r.matchesFetched).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["getUser"]);
    store.close();
  });

  it("fetches only the delta with the `after` cursor when new games exist", async () => {
    const store = new Store(":memory:");
    const user = userA();
    store.upsertPlayer(user);
    // Withhold the newest match so there is exactly one game to catch up on.
    const sorted = [...ranked].sort((a, b) => b.date - a.date);
    const missing = sorted[0]!;
    store.upsertMatches(sorted.slice(1));
    const newest = newestOf(sorted.slice(1));
    store.advanceIngestCursor(user.uuid, newest.id);

    const { api, calls } = fakeApi({
      user: withLastRanked(user, missing.date),
      pages: [[missing]],
    });
    const r = await ingestPlayer(store, api, user.nickname);

    expect(r.mode).toBe("incremental");
    expect(r.complete).toBe(true);
    expect(r.matchesStored).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params?.after).toBe(newest.id);
    expect(calls[1]!.params?.before).toBeUndefined();
    expect(store.ingestCursor(user.uuid)?.id).toBe(missing.id);
    store.close();
  });

  it("resumes from its own cursor, not a newer game the corpus crawl stored", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const server = Array.from({ length: 10 }, (_, i) => make(1000 + i));
    store.upsertPlayer(user);
    store.upsertMatches(server.slice(0, 7));
    store.advanceIngestCursor(user.uuid, 1006);
    // The crawl caught only the newest of the three games played since.
    store.upsertMatches([server[9]!]);

    const { api, calls } = rangeApi(withLastRanked(user, server[9]!.date), server);
    const r = await ingestPlayer(store, api, user.nickname);

    expect(r.mode).toBe("incremental");
    expect(calls[0]!.after).toBe(1006);
    const held = new Set(store.getMatchesForPlayer(user.uuid).map((m) => m.id));
    expect(server.filter((m) => !held.has(m.id))).toEqual([]);
    expect(store.ingestCursor(user.uuid)?.id).toBe(1009);
    store.close();
  });

  it("walks a gap of more than one page down to the cursor", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const server = Array.from({ length: 251 }, (_, i) => make(1000 + i));
    store.upsertPlayer(user);
    store.upsertMatches([server[0]!]);
    store.advanceIngestCursor(user.uuid, 1000);

    const { api, calls } = rangeApi(withLastRanked(user, server[250]!.date), server);
    const r = await ingestPlayer(store, api, user.nickname);

    expect(r.mode).toBe("incremental");
    expect(r.matchesStored).toBe(250);
    expect(calls.map((c) => [c.after, c.before])).toEqual([
      [1000, undefined],
      [1000, 1151],
      [1000, 1051],
    ]);
    expect(store.getMatchesForPlayer(user.uuid)).toHaveLength(251);
    expect(store.ingestCursor(user.uuid)?.id).toBe(1250);
    store.close();
  });

  it("keeps the old cursor when the walk fails partway, so the gap is retried", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const server = Array.from({ length: 251 }, (_, i) => make(1000 + i));
    store.upsertPlayer(user);
    store.upsertMatches([server[0]!]);
    store.advanceIngestCursor(user.uuid, 1000);

    const { api } = rangeApi(withLastRanked(user, server[250]!.date), server, 2);
    await expect(ingestPlayer(store, api, user.nickname)).rejects.toThrow("upstream down");
    expect(store.ingestCursor(user.uuid)?.id).toBe(1000);
    store.close();
  });

  it("starts over when a known nickname now belongs to someone else", async () => {
    const store = new Store(":memory:");
    const user = userA();
    store.upsertPlayer(user);
    store.upsertMatches(ranked);
    store.advanceIngestCursor(user.uuid, newestOf(ranked).id);

    const newcomer = { ...user, uuid: "f".repeat(32) };
    const { api } = fakeApi({ user: newcomer, pages: [[]] });
    const r = await ingestPlayer(store, api, user.nickname);

    expect(r.mode).toBe("first-page");
    expect(r.user.uuid).toBe(newcomer.uuid);
    expect(store.ingestCursor(user.uuid)?.id).toBe(newestOf(ranked).id);
    store.close();
  });

  it("returns after the first page and reports a cursor for the rest", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const full = Array.from({ length: 100 }, (_, i) => ({
      ...ranked[0]!,
      id: 900000 + i,
      date: (1700000000 + i) as MatchInfo["date"],
    }));
    const { api, calls } = fakeApi({ user, pages: [full], seasons: [10, 11, 12] });

    const r = await ingestPlayer(store, api, user.nickname);
    expect(r.mode).toBe("first-page");
    expect(r.complete).toBe(false);
    expect(r.cursor).toBe(full[full.length - 1]!.id);
    // Profile, season list and one page, all in parallel.
    expect(calls).toHaveLength(3);
    expect(store.playedSeasons(user.uuid)).toEqual([12, 11, 10]);
    expect(calls[1]!.params?.type).toBe(2);
    const season = full[0]!.season;
    expect(r.seasonCursors[season]).toBe(Math.min(...full.map((m) => m.id)));
    store.close();
  });

  it("gives each season in the first page its own resume point", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const page = Array.from({ length: 100 }, (_, i) => ({
      ...ranked[0]!,
      id: 900000 - i,
      season: i < 60 ? 12 : 11,
      date: (1700000000 - i) as MatchInfo["date"],
    }));
    const { api } = fakeApi({ user, pages: [page] });
    const r = await ingestPlayer(store, api, user.nickname);
    expect(r.seasonCursors).toEqual({ 12: 900000 - 59, 11: 900000 - 99 });
    store.close();
  });

  it("marks a short first page complete, with no cursor", async () => {
    const store = new Store(":memory:");
    const user = userA();
    const { api } = fakeApi({ user, pages: [ranked.slice(0, 20)] });
    const r = await ingestPlayer(store, api, user.nickname);
    expect(r.complete).toBe(true);
    expect(r.cursor).toBeNull();
    expect(store.ingestCursor(user.uuid)?.id).toBe(newestOf(ranked.slice(0, 20)).id);
    store.close();
  });
});

describe("ingestSeason", () => {
  const ranked = userAMatches().filter((m) => m.type === 2);
  const page = (n: number, base: number, season: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...ranked[0]!,
      id: base + i,
      season,
      date: (1700000000 + base + i) as MatchInfo["date"],
    }));

  it("walks a season past the old 300 cap and marks it stored", async () => {
    const store = new Store(":memory:");
    const pages = [page(100, 900000, 7), page(100, 800000, 7), page(100, 700000, 7), page(40, 600000, 7)];
    const { api, calls } = fakeApi({ user: userA(), pages });
    // The season list is recorded at ingest; marking only updates those rows.
    store.setPlayedSeasons("uuid-x", [7]);

    const stored = await ingestSeason(store, api, "x", "uuid-x", 7);
    expect(stored).toBe(340);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.params?.season === 7)).toBe(true);
    expect(calls[0]!.params?.before).toBeUndefined();
    expect(calls[1]!.params?.before).toBe(pages[0]![99]!.id);
    expect(store.isSeasonIngested("uuid-x", 7)).toBe(true);
    store.close();
  });

  it("resumes below a page the caller already stored", async () => {
    const store = new Store(":memory:");
    const { api, calls } = fakeApi({ user: userA(), pages: [page(30, 700000, 7)] });
    store.setPlayedSeasons("uuid-x", [7]);
    await ingestSeason(store, api, "x", "uuid-x", 7, { before: 800000 });
    expect(calls[0]!.params?.before).toBe(800000);
    expect(store.isSeasonIngested("uuid-x", 7)).toBe(true);
    store.close();
  });

  it("always starts from the newest, ignoring rows already held", async () => {
    const store = new Store(":memory:");
    const first = page(100, 900000, 7);
    const uuid = first[0]!.players[0]!.uuid;
    store.upsertMatches(first);

    const { api, calls } = fakeApi({ user: userA(), pages: [page(20, 800000, 7)] });
    await ingestSeason(store, api, "x", uuid, 7);
    expect(calls[0]!.params?.before).toBeUndefined();
    store.close();
  });

  it("does not skip games above a slice the corpus crawl left behind", async () => {
    const store = new Store(":memory:");
    const uuid = ranked[0]!.players[0]!.uuid;
    const make = (id: number) => ({ ...ranked[0]!, id, season: 7, date: (1700000000 + id) as MatchInfo["date"] });

    // The global crawl caught games 140-150 of this player's season.
    store.upsertMatches(Array.from({ length: 11 }, (_, i) => make(140 + i)));
    // The API still holds 100-199 for that season.
    const server = Array.from({ length: 100 }, (_, i) => make(199 - i));

    const api = {
      async getUserMatches(_id: string, params: MatchListParams = {}) {
        const before = params.before ?? Infinity;
        return server.filter((m) => m.id < before).slice(0, 100);
      },
    } as unknown as RankedApi;

    await ingestSeason(store, api, "x", uuid, 7);

    const held = new Set(
      store.getMatchesForPlayer(uuid, { type: 2, season: 7 }).map((m) => m.id),
    );
    // Resuming below the slice would have skipped 151-199 for good.
    expect(server.filter((m) => !held.has(m.id))).toEqual([]);
    store.close();
  });

  it("only marks a season stored once the walk has run", () => {
    const store = new Store(":memory:");
    // Marking a season must not invent a row; the played-season list is the API's.
    store.markSeasonIngested("uuid-y", 9);
    expect(store.playedSeasons("uuid-y")).toEqual([]);
    expect(store.isSeasonIngested("uuid-y", 9)).toBe(false);

    store.setPlayedSeasons("uuid-y", [9, 8]);
    expect(store.playedSeasons("uuid-y")).toEqual([9, 8]);
    store.markSeasonIngested("uuid-y", 9);
    expect(store.isSeasonIngested("uuid-y", 9)).toBe(true);
    expect(store.isSeasonIngested("uuid-y", 8)).toBe(false);
    store.close();
  });
});

function crawlApi(pages: MatchInfo[][]) {
  const calls: { method: string; params?: MatchListParams; id?: number }[] = [];
  const queue = [...pages];
  const all = pages.flat();
  const api = {
    async getMatches(params: MatchListParams = {}) {
      calls.push({ method: "getMatches", params });
      return queue.shift() ?? [];
    },
    async getMatch(id: number) {
      calls.push({ method: "getMatch", id });
      return { ...all.find((m) => m.id === id)!, timelines: [] };
    },
  };
  return { api: api as unknown as RankedApi, calls };
}

describe("corpus crawl", () => {
  const page = recentMatches();

  it("stores the newest ranked pages, following the cursor until a short page", async () => {
    const store = new Store(":memory:");
    const older = page.slice(0, 10).map((m, i) => ({ ...m, id: page.at(-1)!.id - 1 - i }));
    const { api, calls } = crawlApi([page, older]);
    const r = await crawlMatches(store, api, { pages: 5 });
    expect(calls.map((c) => c.params?.before)).toEqual([undefined, page.at(-1)!.id]);
    expect(calls.every((c) => c.params?.type === 2 && c.params?.count === 100)).toBe(true);
    expect(r.pagesFetched).toBe(2);
    expect(store.matchCount()).toBe(page.length + older.length);
    store.close();
  });

  it("stops at the page limit even when more pages exist", async () => {
    const store = new Store(":memory:");
    const { api, calls } = crawlApi([page, page]);
    await crawlMatches(store, api, { pages: 1 });
    expect(calls).toHaveLength(1);
    store.close();
  });

  it("fetches timelines for the newest completed games it does not hold yet", async () => {
    const store = new Store(":memory:");
    store.upsertMatches(page);
    const completed = page.filter((m) => !m.forfeited && m.result.uuid !== null);
    const held = completed[0]!;
    store.upsertDetails([{ ...held, timelines: [] }]);

    const { api, calls } = crawlApi([page]);
    expect(await fetchCorpusDetails(store, api, { budget: 5 })).toBe(5);

    const ids = calls.map((c) => c.id!);
    const byId = new Map(page.map((m) => [m.id, m]));
    for (const id of ids) {
      expect(byId.get(id)!.forfeited).toBe(false);
      expect(byId.get(id)!.result.uuid).not.toBeNull();
    }
    expect(ids).not.toContain(held.id);
    const oldestFetched = Math.min(...ids.map((id) => byId.get(id)!.date));
    const skipped = completed.filter((m) => m !== held && !ids.includes(m.id));
    expect(skipped.every((m) => m.date <= oldestFetched)).toBe(true);
    expect(store.detailCount()).toBe(6);
    store.close();
  });

  it("starts the next detail fetch as soon as any of the four in flight lands", async () => {
    const store = new Store(":memory:");
    store.upsertMatches(page);
    const started: number[] = [];
    const pending = new Map<number, () => void>();
    const api = {
      getMatch(id: number) {
        started.push(id);
        return new Promise<MatchInfo>((resolve) =>
          pending.set(id, () => resolve({ ...page.find((m) => m.id === id)!, timelines: [] })),
        );
      },
    } as unknown as RankedApi;
    const settle = (id: number) => {
      pending.get(id)!();
      pending.delete(id);
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    const run = fetchCorpusDetails(store, api, { budget: 6 });
    await tick();
    expect(started).toHaveLength(4);
    settle(started[0]!);
    await tick();
    expect(started).toHaveLength(5);
    while (pending.size > 0) {
      for (const id of [...pending.keys()]) settle(id);
      await tick();
    }
    expect(await run).toBe(6);
    store.close();
  });

  it("stops asking for a match the API has no detail for, but retries transient failures", async () => {
    const store = new Store(":memory:");
    store.upsertMatches(page);
    const [goneId, flakyId] = store.detailCandidates({ window: 2000, limit: 2, completedOnly: true });
    const asked: number[] = [];
    const api = {
      async getMatch(id: number) {
        asked.push(id);
        if (id === goneId) throw new ApiError("no data", 400, `/matches/${id}`);
        if (id === flakyId) throw new ApiError("server error 502", 502, `/matches/${id}`);
        return { ...page.find((m) => m.id === id)!, timelines: [] };
      },
    } as unknown as RankedApi;
    const unavailable = new Set<number>();

    expect(await fetchCorpusDetails(store, api, { budget: 3, unavailable })).toBe(1);
    expect([...unavailable]).toEqual([goneId]);

    asked.length = 0;
    await fetchCorpusDetails(store, api, { budget: 3, unavailable });
    expect(asked).not.toContain(goneId);
    expect(asked).toContain(flakyId);
    // The place the missing match held goes to the next candidate.
    expect(asked).toHaveLength(3);
    store.close();
  });
});
