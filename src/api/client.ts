/**
 * The single HTTP gateway for SplitLine: rate limiting, retries, envelope
 * unwrapping and short-lived caching. Never call fetch() against the Ranked
 * API anywhere else.
 */
import type { Envelope } from "../shared/types.js";

export const PRIMARY_BASE = "https://api.mcsrranked.com";
export const STATUS_BASE = "https://status.mcsrranked.com";

/** Hard API limit is 500 req / 10 min; stay under it with headroom. */
const WINDOW_MS = 10 * 60 * 1000;
const BUDGET = 450;
const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly path: string,
    public readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RateBudgetError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`local rate budget exhausted; retry in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = "RateBudgetError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

export interface ClientOptions {
  baseUrl?: string;
  privateKey?: string | null;
  fetchImpl?: typeof fetch;
  /** For tests: skip real sleeps. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RankedClient {
  private readonly baseUrl: string;
  private readonly privateKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of requests sent in the current sliding window. */
  private sent: number[] = [];
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private cache = new Map<string, CacheEntry>();

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? PRIMARY_BASE;
    this.privateKey = opts.privateKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? realSleep;
  }

  /** Requests spent in the current 10-minute window. */
  budgetUsed(): number {
    this.pruneWindow();
    return this.sent.length;
  }

  budgetRemaining(): number {
    return Math.max(0, BUDGET - this.budgetUsed());
  }

  private pruneWindow() {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0]! < cutoff) this.sent.shift();
  }

  private async acquireSlot(): Promise<void> {
    while (this.inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
  }

  private releaseSlot() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async waitForBudget(): Promise<void> {
    this.pruneWindow();
    while (this.sent.length >= BUDGET) {
      const oldest = this.sent[0]!;
      const waitMs = oldest + WINDOW_MS - Date.now() + 50;
      if (waitMs > 60_000) {
        // Don't silently stall callers for minutes; let them decide.
        throw new RateBudgetError(waitMs);
      }
      await this.sleep(Math.max(waitMs, 50));
      this.pruneWindow();
    }
  }

  /**
   * GET `path` and unwrap the {status,data} envelope. `ttlMs` caches
   * successful responses: 0 for live endpoints, Infinity for immutable ones.
   */
  async get<T>(
    path: string,
    opts: { ttlMs?: number; baseUrl?: string; withKey?: boolean } = {},
  ): Promise<T> {
    const base = opts.baseUrl ?? this.baseUrl;
    const url = base + path;
    const ttl = opts.ttlMs ?? 0;

    if (ttl > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }

    await this.acquireSlot();
    try {
      const value = await this.request<T>(url, path, opts.withKey === true);
      if (ttl > 0) {
        this.cache.set(url, { expires: Date.now() + ttl, value });
        if (this.cache.size > 5000) this.evictExpired();
      }
      return value;
    } finally {
      this.releaseSlot();
    }
  }

  /** GET a JSON endpoint that does not use the {status,data} envelope. */
  async getRaw<T>(
    path: string,
    opts: { ttlMs?: number; baseUrl?: string } = {},
  ): Promise<T> {
    const base = opts.baseUrl ?? this.baseUrl;
    const url = base + path;
    const ttl = opts.ttlMs ?? 0;
    if (ttl > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }
    await this.acquireSlot();
    try {
      const value = await this.requestRaw<T>(url, path);
      if (ttl > 0) this.cache.set(url, { expires: Date.now() + ttl, value });
      return value;
    } finally {
      this.releaseSlot();
    }
  }

  private async requestRaw<T>(url: string, path: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1));
      await this.waitForBudget();
      this.sent.push(Date.now());
      try {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": "SplitLine/0.1" },
        });
        if (res.status >= 500 || res.status === 429) {
          lastError = new ApiError(`server error ${res.status}`, res.status, path);
          continue;
        }
        if (!res.ok) throw new ApiError(`request failed ${res.status}`, res.status, path);
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof ApiError && err.httpStatus > 0 && err.httpStatus < 500) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ApiError("request failed after retries", 0, path);
  }

  private evictExpired() {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expires <= now) this.cache.delete(k);
    }
  }

  private async request<T>(url: string, path: string, withKey: boolean): Promise<T> {
    const headers: Record<string, string> = {
      "User-Agent": "SplitLine/0.1 (analytics; contact via MCSR Ranked Discord)",
    };
    if (withKey) {
      if (!this.privateKey) {
        throw new ApiError("endpoint requires MCSR_PRIVATE_KEY", 401, path);
      }
      headers["Private-Key"] = this.privateKey;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await this.sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
      }
      await this.waitForBudget();
      this.sent.push(Date.now());

      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers });
      } catch (err) {
        lastError = err; // network error: retry
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000);
        lastError = new ApiError("rate limited", 429, path);
        continue;
      }
      if (res.status >= 500) {
        lastError = new ApiError(`server error ${res.status}`, res.status, path);
        continue;
      }

      let body: Envelope<T>;
      try {
        body = (await res.json()) as Envelope<T>;
      } catch {
        lastError = new ApiError("invalid JSON response", res.status, path);
        continue;
      }

      if (body.status === "success") return body.data;
      // 400 = no data, 401 = wrong params — not retryable.
      throw new ApiError(
        typeof body.data === "string" ? body.data : `request failed (${res.status})`,
        res.status,
        path,
        body.data,
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new ApiError("request failed after retries", 0, path);
  }
}
