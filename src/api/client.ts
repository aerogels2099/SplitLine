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
/** Past this, the caller is told when to come back rather than kept waiting. */
const MAX_WAIT_MS = 60_000;
const HEADERS = { "User-Agent": "SplitLine/0.1 (analytics; contact via MCSR Ranked Discord)" };

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
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private sent: number[] = [];
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private cache = new Map<string, CacheEntry>();
  private inFlightByUrl = new Map<string, Promise<unknown>>();

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? PRIMARY_BASE;
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
      if (waitMs > MAX_WAIT_MS) {
        throw new RateBudgetError(waitMs);
      }
      await this.sleep(Math.max(waitMs, 50));
      this.pruneWindow();
    }
  }

  get<T>(path: string, opts: { ttlMs?: number; baseUrl?: string } = {}): Promise<T> {
    return this.load<T>(path, opts, true);
  }

  /** For hosts that answer without the `{ status, data }` envelope. */
  getRaw<T>(path: string, opts: { ttlMs?: number; baseUrl?: string } = {}): Promise<T> {
    return this.load<T>(path, opts, false);
  }

  private async load<T>(
    path: string,
    opts: { ttlMs?: number; baseUrl?: string },
    unwrap: boolean,
  ): Promise<T> {
    const url = (opts.baseUrl ?? this.baseUrl) + path;
    const ttl = opts.ttlMs ?? 0;
    if (ttl > 0) {
      const hit = this.cacheGet<T>(url);
      if (hit !== undefined) return hit;
    }
    return this.coalesce(url, ttl, () => this.request<T>(url, path, unwrap));
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

  private async request<T>(url: string, path: string, unwrap: boolean): Promise<T> {
    let lastError: unknown = null;
    let waitMs = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Waited out without a slot, so a request backing off doesn't stall the rest.
      if (waitMs > 0) await this.sleep(waitMs);
      waitMs = 1000 * 2 ** attempt + Math.random() * 250;
      await this.acquireSlot();
      try {
        await this.waitForBudget();
        this.sent.push(Date.now());

        let res: Response;
        try {
          res = await this.fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err) {
          lastError = err;
          continue;
        }

        if (res.status === 429) {
          await discard(res);
          const retryAfter = Number(res.headers.get("retry-after"));
          waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000;
          if (waitMs > MAX_WAIT_MS) throw new RateBudgetError(waitMs);
          lastError = new ApiError("rate limited", 429, path);
          continue;
        }
        if (res.status >= 500) {
          await discard(res);
          lastError = new ApiError(`server error ${res.status}`, res.status, path);
          continue;
        }
        if (!unwrap && !res.ok) {
          await discard(res);
          throw new ApiError(`request failed ${res.status}`, res.status, path);
        }

        let body: unknown;
        try {
          body = await res.json();
        } catch {
          lastError = new ApiError("invalid JSON response", res.status, path);
          continue;
        }
        if (!unwrap) return body as T;

        const envelope = body as Envelope<T>;
        if (envelope.status === "success") return envelope.data;
        throw new ApiError(
          typeof envelope.data === "string" ? envelope.data : `request failed (${res.status})`,
          res.status,
          path,
          envelope.data,
        );
      } finally {
        this.releaseSlot();
      }
    }
    // Network failures too, so callers see every upstream failure as an ApiError.
    if (lastError instanceof ApiError) throw lastError;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ApiError(`request failed: ${reason}`, 0, path);
  }
}
