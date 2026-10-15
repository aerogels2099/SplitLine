import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedApi } from "../src/api/endpoints.js";
import { AppContext } from "../src/server/context.js";
import { liveData, recentMatches } from "./helpers.js";

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
