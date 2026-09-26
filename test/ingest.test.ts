import { describe, expect, it } from "vitest";
import type { RankedApi, MatchListParams } from "../src/api/endpoints.js";
import { Store } from "../src/db/db.js";
import { ingestPlayer, ingestSeason } from "../src/ingest/backfill.js";
import type { MatchInfo, UserDetails } from "../src/shared/types.js";
import { userA, userAMatches } from "./helpers.js";

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

describe("ingestPlayer", () => {
  const ranked = userAMatches().filter((m) => m.type === 2);

  it("spends one request when the profile shows nothing new", async () => {
    const store = new Store(":memory:");
    const user = userA();
    store.upsertPlayer(user);
    store.upsertMatches(ranked);
    const newest = store.newestMatchForPlayer(user.uuid)!;

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
    const newest = store.newestMatchForPlayer(user.uuid)!;

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
