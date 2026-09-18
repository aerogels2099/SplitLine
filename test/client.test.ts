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

  it("gives up after max retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/matches")).rejects.toThrowError(/server error/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
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

  it("requires a private key for keyed endpoints", async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    const c = new RankedClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep });
    await expect(c.get("/users/x/live", { withKey: true })).rejects.toThrowError(/MCSR_PRIVATE_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the Private-Key header when configured", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Private-Key"]).toBe("secret");
      return ok({ status: "idle" });
    });
    const c = new RankedClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      privateKey: "secret",
      sleepImpl: noSleep,
    });
    await c.get("/users/x/live", { withKey: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
