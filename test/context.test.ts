import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedApi } from "../src/api/endpoints.js";
import { AppContext } from "../src/server/context.js";
import { liveData, recentMatches, userA, userAMatches } from "./helpers.js";

const MINUTE = 60_000;

function crawlingContext(budget: { remaining: number }) {
  const ctx = new AppContext(":memory:");
  const page = recentMatches();
  const calls: string[] = [];
  const api = {
    client: { budgetRemaining: () => budget.remaining },
    async getMatches() {
      calls.push("getMatches");
      return page;
    },
    async getMatch(id: number) {
      calls.push("getMatch");
      return { ...page.find((m) => m.id === id)!, timelines: [] };
    },
  };
  (ctx as unknown as { api: RankedApi }).api = api as unknown as RankedApi;
  return { ctx, calls };
}

describe("corpus crawl schedule", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits before the first crawl, then repeats every half hour", async () => {
    const { ctx, calls } = crawlingContext({ remaining: 450 });
    const stop = ctx.startCorpusCrawl(() => {});

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls.filter((c) => c === "getMatches")).toHaveLength(1);
    expect(calls.filter((c) => c === "getMatch")).toHaveLength(25);

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(calls.filter((c) => c === "getMatches")).toHaveLength(2);
    stop();
    ctx.store.close();
  });

  it("skips a crawl while player lookups are using the budget", async () => {
    const budget = { remaining: 120 };
    const { ctx, calls } = crawlingContext(budget);
    const stop = ctx.startCorpusCrawl(() => {});

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(calls).toEqual([]);

    budget.remaining = 450;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(calls.filter((c) => c === "getMatches")).toHaveLength(1);
    stop();
    ctx.store.close();
  });

  it("stops scheduling once stopped", async () => {
    const { ctx, calls } = crawlingContext({ remaining: 450 });
    ctx.startCorpusCrawl(() => {})();
    await vi.advanceTimersByTimeAsync(3 * 30 * MINUTE);
    expect(calls).toEqual([]);
    ctx.store.close();
  });

  it("reports a failed crawl without throwing", async () => {
    const { ctx } = crawlingContext({ remaining: 450 });
    const boom = new Error("upstream down");
    (ctx.api as unknown as { getMatches: () => Promise<never> }).getMatches = () => Promise.reject(boom);
    const errors: unknown[] = [];
    const stop = ctx.startCorpusCrawl((err) => errors.push(err));
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(errors).toEqual([boom]);
    stop();
    ctx.store.close();
  });
});

function liveContext(fail = { next: false }) {
  const ctx = new AppContext(":memory:");
  const calls = { count: 0 };
  const api = {
    async getLive() {
      calls.count++;
      if (fail.next) {
        fail.next = false;
        throw new Error("upstream down");
      }
      return liveData();
    },
  };
  (ctx as unknown as { api: RankedApi }).api = api as unknown as RankedApi;
  return { ctx, calls };
}

describe("live matches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks the API at most once every ten seconds however often it is polled", async () => {
    const { ctx, calls } = liveContext();
    await Promise.all([ctx.liveMatches(), ctx.liveMatches()]);
    await vi.advanceTimersByTimeAsync(9_000);
    await ctx.liveMatches();
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const view = await ctx.liveMatches();
    expect(calls.count).toBe(2);
    expect(view.matches).toHaveLength(liveData().liveMatches.length);
    ctx.store.close();
  });

  it("tries again on the next poll after a failure", async () => {
    const { ctx, calls } = liveContext({ next: true });
    await expect(ctx.liveMatches()).rejects.toThrow("upstream down");
    const view = await ctx.liveMatches();
    expect(calls.count).toBe(2);
    expect(view.matches.length).toBeGreaterThan(0);
    ctx.store.close();
  });
});

function staleContext(delayMs: number) {
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const ctx = new AppContext(":memory:");
  const user = userA();
  const ranked = userAMatches().filter((m) => m.type === 2);
  ctx.store.upsertPlayer(user);
  ctx.store.upsertMatches(ranked);
  ctx.store.setPlayedSeasons(user.uuid, [...new Set(ranked.map((m) => m.season))]);
  ctx.store.advanceIngestCursor(user.uuid, Math.max(...ranked.map((m) => m.id)));
  vi.setSystemTime(new Date("2026-10-01T12:20:00Z"));
  const newest = ranked.reduce((a, b) => (a.id > b.id ? a : b));
  const fresh = { ...newest, id: newest.id + 1, date: (newest.date + 600) as typeof newest.date };
  const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
  const api = {
    getUser: () => later({ ...user, timestamp: { ...user.timestamp, lastRanked: fresh.date } }),
    getUserMatches: async () => [fresh],
  };
  (ctx as unknown as { api: RankedApi }).api = api as unknown as RankedApi;
  const held = () => ctx.store.getMatchesForPlayer(user.uuid, { type: 2 }).some((m) => m.id === fresh.id);
  return { ctx, name: user.nickname, held };
}

describe("opening a player looked up before", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a quick refresh, so the page opens on the newest games", async () => {
    const { ctx, name, held } = staleContext(300);
    const opened = ctx.ensurePlayer(name).then(held);
    await vi.advanceTimersByTimeAsync(300);
    expect(await opened).toBe(true);
    ctx.store.close();
  });

  it("serves the stored games when the refresh is slow", async () => {
    const { ctx, name, held } = staleContext(5_000);
    const opened = ctx.ensurePlayer(name).then(held);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await opened).toBe(false);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(held()).toBe(true);
    ctx.store.close();
  });
});
