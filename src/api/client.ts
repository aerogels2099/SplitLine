import type { Envelope } from "../shared/types.js";

export const PRIMARY_BASE = "https://api.mcsrranked.com";
export const STATUS_BASE = "https://status.mcsrranked.com";

/** The published ceiling is 500 requests per ten minutes; this leaves headroom. */
const WINDOW_MS = 10 * 60 * 1000;
const BUDGET = 450;
const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;
const MAX_CACHE_ENTRIES = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

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
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An unconsumed body holds its connection until it is garbage collected. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}

export class RankedClient {
  private readonly baseUrl: string;
  private readonly privateKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private sent: number[] = [];
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private cache = new Map<string, CacheEntry>();
  private inFlightByUrl = new Map<string, Promise<unknown>>();

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? PRIMARY_BASE;
    this.privateKey = opts.privateKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? realSleep;
  }

  budgetUsed(): number {
    this.pruneWindow();
    return this.sent.length;
  }

  budgetRemaining(): number {
    return Math.max(0, BUDGET - this.budgetUsed());
  }

  cacheSize(): number {
    return this.cache.size;
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
        throw new RateBudgetError(waitMs);
      }
      await this.sleep(Math.max(waitMs, 50));
      this.pruneWindow();
    }
  }

  async get<T>(
    path: string,
    opts: { ttlMs?: number; baseUrl?: string; withKey?: boolean } = {},
  ): Promise<T> {
    const base = opts.baseUrl ?? this.baseUrl;
    const url = base + path;
    const ttl = opts.ttlMs ?? 0;

    if (ttl > 0) {
      const hit = this.cacheGet<T>(url);
      if (hit !== undefined) return hit;
    }

    return this.coalesce(url, ttl, async () => {
      await this.acquireSlot();
      try {
        return await this.request<T>(url, path, opts.withKey === true);
      } finally {
        this.releaseSlot();
      }
    });
  }

  private coalesce<T>(url: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlightByUrl.get(url);
    if (pending) return pending as Promise<T>;

    const p = run()
      .then((value) => {
        this.cacheSet(url, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlightByUrl.delete(url);
      });
    this.inFlightByUrl.set(url, p as Promise<unknown>);
    p.catch(() => {});
    return p;
  }

  private cacheGet<T>(url: string): T | undefined {
    const hit = this.cache.get(url);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.cache.delete(url);
      return undefined;
    }
    return hit.value as T;
  }

  private cacheSet(url: string, value: unknown, ttlMs: number) {
    if (ttlMs <= 0) return;
    this.cache.set(url, { expires: Date.now() + ttlMs, value });
    if (this.cache.size > MAX_CACHE_ENTRIES) this.evict();
  }

  private evict() {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expires <= now) this.cache.delete(k);
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  async getRaw<T>(
    path: string,
    opts: { ttlMs?: number; baseUrl?: string } = {},
  ): Promise<T> {
    const base = opts.baseUrl ?? this.baseUrl;
    const url = base + path;
    const ttl = opts.ttlMs ?? 0;
    if (ttl > 0) {
      const hit = this.cacheGet<T>(url);
      if (hit !== undefined) return hit;
    }
    return this.coalesce(url, ttl, async () => {
      await this.acquireSlot();
      try {
        return await this.requestRaw<T>(url, path);
      } finally {
        this.releaseSlot();
      }
    });
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status >= 500 || res.status === 429) {
          await discard(res);
          lastError = new ApiError(`server error ${res.status}`, res.status, path);
          continue;
        }
        if (!res.ok) {
          await discard(res);
          throw new ApiError(`request failed ${res.status}`, res.status, path);
        }
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
    let backoffMs = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (backoffMs > 0) await this.sleep(backoffMs);
      backoffMs = 1000 * 2 ** attempt + Math.random() * 250;
      await this.waitForBudget();
      this.sent.push(Date.now());

      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        lastError = err;
        continue;
      }

      if (res.status === 429) {
        await discard(res);
        const retryAfter = Number(res.headers.get("retry-after"));
        backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000;
        lastError = new ApiError("rate limited", 429, path);
        continue;
      }
      if (res.status >= 500) {
        await discard(res);
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
