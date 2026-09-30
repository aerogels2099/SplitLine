import { describe, expect, it, vi } from "vitest";
import { ApiError, RankedClient } from "../src/api/client.js";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ status: "success", data }), { status: 200 });
const err = (status: number, data: unknown = "nope") =>
  new Response(JSON.stringify({ status: "error", data }), { status });

const noSleep = () => Promise.resolve();

describe("RankedClient", () => {
  it("unwraps the success envelope", async () => {
    const fetchImpl = vi.fn(async () => ok({ hello: 1 }));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/x")).resolves.toEqual({ hello: 1 });
  });

  it("throws ApiError on error envelopes without retrying", async () => {
    const fetchImpl = vi.fn(async () => err(400, "User is not exists."));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/users/nobody")).rejects.toThrowError(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(ok([1, 2, 3]));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/matches")).resolves.toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a request that hangs past its deadline", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      });
    const fetchImpl = vi.fn().mockImplementationOnce(hang).mockResolvedValueOnce(ok("late"));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    const signals: AbortSignal[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const ctl = new AbortController();
      signals.push(ctl.signal);
      queueMicrotask(() => ctl.abort(new DOMException("timed out", "TimeoutError")));
      return ctl.signal;
    });
    await expect(c.get("/matches")).resolves.toBe("late");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    timeout.mockRestore();
  });

  it("gives up after max retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/matches")).rejects.toThrowError(/server error/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // the first attempt plus three retries
  });

  it("caches responses for ttlMs and tracks the request budget", async () => {
    const fetchImpl = vi.fn(async () => ok("cached"));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await c.get("/leaderboard", { ttlMs: 60_000 });
    await c.get("/leaderboard", { ttlMs: 60_000 });
    await c.get("/leaderboard", { ttlMs: 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.budgetUsed()).toBe(1);
  });

  it("sleeps once per 429, honouring retry-after instead of adding to it", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(ok("done"));
    const c = new RankedClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(c.get("/matches")).resolves.toBe("done");
    expect(sleeps).toEqual([2000]);
  });

  it("drops expired entries, so the cache does not grow across TTL cycles", async () => {
    const fetchImpl = vi.fn(async () => ok("v"));
    const c = new RankedClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    await c.get("/leaderboard", { ttlMs: 1 });
    expect(c.cacheSize()).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    await c.get("/leaderboard", { ttlMs: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(c.cacheSize()).toBe(1);
  });

  it("does not cache when ttlMs is 0", async () => {
    const fetchImpl = vi.fn(async () => ok("live"));
    const c = new RankedClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });
    await c.get("/matches/1", { ttlMs: 0 });
    await c.get("/matches/1", { ttlMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(c.cacheSize()).toBe(0);
  });

  it("shares one upstream request between concurrent callers", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => resolvers.push(r)));
    const c = new RankedClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noSleep,
    });

    const both = Promise.all([c.get("/matches/1"), c.get("/matches/1")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolvers[0]!(ok("shared"));
    await expect(both).resolves.toEqual(["shared", "shared"]);

    // The in-flight entry is cleared once settled, so a later call is fresh.
    const third = c.get("/matches/1");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolvers[1]!(ok("again"));
    await expect(third).resolves.toBe("again");
  });
});
