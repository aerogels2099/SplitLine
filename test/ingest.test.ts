import { describe, expect, it } from "vitest";
import type { RankedApi, MatchListParams } from "../src/api/endpoints.js";
import { Store } from "../src/db/db.js";
import { continueBackfill, ingestPlayer } from "../src/ingest/backfill.js";
import type { MatchInfo, UserDetails } from "../src/shared/types.js";
import { userA, userAMatches } from "./helpers.js";

/** Records every call so a test can assert how many round trips were spent. */
function fakeApi(opts: { user: UserDetails; pages?: MatchInfo[][] }) {
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

    // lastRanked is exactly the newest stored match's date: nothing to fetch.
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
    // The delta request must be anchored on the newest stored id, not a walk.
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
    const { api, calls } = fakeApi({ user, pages: [full] });

    const r = await ingestPlayer(store, api, user.nickname);
    expect(r.mode).toBe("first-page");
    expect(r.complete).toBe(false);
    expect(r.cursor).toBe(full[full.length - 1]!.id);
    // Only the profile and one page were awaited.
    expect(calls).toHaveLength(2);
    // The player page renders ranked games, so that is what gets fetched.
    expect(calls[1]!.params?.type).toBe(2);
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

describe("continueBackfill", () => {
  it("walks backward from the cursor until a short page ends it", async () => {
    const store = new Store(":memory:");
    const ranked = userAMatches().filter((m) => m.type === 2);
    const page = (n: number, base: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...ranked[0]!,
        id: base + i,
        date: (1700000000 + base + i) as MatchInfo["date"],
      }));
    const p2 = page(100, 800000);
    const p3 = page(30, 700000);
    const { api, calls } = fakeApi({ user: userA(), pages: [p2, p3] });

    const stored = await continueBackfill(store, api, "x", 900000);
    expect(stored).toBe(130);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params?.before).toBe(900000);
    expect(calls[1]!.params?.before).toBe(p2[p2.length - 1]!.id);
    store.close();
  });
});
