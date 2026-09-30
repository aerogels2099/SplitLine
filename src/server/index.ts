import Fastify from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, RateBudgetError } from "../api/client.js";
import { AppContext } from "./context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.SPLITLINE_DB ?? join(ROOT, "data", "splitline.db");

const ctx = new AppContext(DB_PATH);
const app = Fastify({ logger: { level: "info" } });

// Before the routes: each route keeps only the hooks registered ahead of it.
await app.register(fastifyCompress, { threshold: 1024 });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) {
    // The API answers 400 when there is no data, often with no message at all.
    if (err.httpStatus === 400) {
      reply.code(404).send({ error: "not found", source: "mcsr-ranked-api" });
      return;
    }
    reply.code(err.httpStatus === 429 ? 503 : 502).send({ error: err.message, source: "mcsr-ranked-api" });
    return;
  }
  if (err instanceof RateBudgetError) {
    reply.code(503).send({ error: err.message, retryInMs: err.retryInMs });
    return;
  }
  app.log.error(err);
  reply.code(500).send({ error: "internal error" });
});

function intParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

app.get("/api/health", async (_req, reply) => {
  reply.header("cache-control", "no-store");
  return {
    ok: true,
    budgetUsed: ctx.api.client.budgetUsed(),
    cachedResponses: ctx.api.client.cacheSize(),
    matches: ctx.store.matchCount(),
    details: ctx.store.detailCount(),
  };
});

app.get("/api/status", async () => ctx.api.getStatus());

app.get("/api/overview", async (_req, reply) => {
  // Matches the cache lifetimes the API layer uses upstream.
  reply.header("cache-control", "public, max-age=30");
  const [leaderboard, live, weekly] = await Promise.all([
    ctx.api.getLeaderboard(),
    ctx.api.getLive().catch(() => null),
    ctx.api.getWeeklyRace().catch(() => null),
  ]);
  return {
    season: leaderboard.season,
    top: leaderboard.users.slice(0, 20),
    playersOnline: live?.players ?? null,
    liveMatchCount: live?.liveMatches.length ?? null,
    weekly: weekly
      ? {
          id: weekly.id,
          endsAt: weekly.endsAt,
          podium: weekly.leaderboard.slice(0, 3),
          entrants: weekly.leaderboard.length,
        }
      : null,
  };
});

app.get("/api/leaderboard", async (req, reply) => {
  const { season, country } = req.query as { season?: string; country?: string };
  reply.header("cache-control", "public, max-age=30");
  // Season zero means the current season, so a missing one must be told apart from it.
  return ctx.api.getLeaderboard(intParam(season), country);
});

app.get("/api/record-leaderboard", async (req, reply) => {
  const { season, distinct } = req.query as { season?: string; distinct?: string };
  reply.header("cache-control", "public, max-age=30");
  return ctx.api.getRecordLeaderboard(
    intParam(season),
    distinct !== undefined ? distinct !== "false" : undefined,
  );
});

app.get("/api/players/:id/history", async (req) => {
  const { season } = req.query as { season?: string };
  return ctx.playerHistory((req.params as { id: string }).id, intParam(season));
});

app.get("/api/players/:id/analysis", async (req, reply) => {
  const { season } = req.query as { season?: string };
  const analysis = await ctx.playerAnalysis((req.params as { id: string }).id, intParam(season));
  reply.header("cache-control", analysis.complete ? "public, max-age=30" : "no-store");
  return analysis;
});

app.get("/api/players/:id/games/:matchId", async (req, reply) => {
  const p = req.params as { id: string; matchId: string };
  const matchId = intParam(p.matchId);
  if (matchId === undefined || matchId <= 0) {
    return reply.code(400).send({ error: "matchId must be a positive integer" });
  }
  return ctx.gameSplits(p.id, matchId);
});

app.get("/api/players/:id/versus/:other", async (req, reply) => {
  const p = req.params as { id: string; other: string };
  const view = await ctx.matchup(p.id, p.other);
  if (!view) return reply.code(400).send({ error: "a player cannot be matched against themselves" });
  reply.header("cache-control", view.complete ? "public, max-age=30" : "no-store");
  return view;
});

const dist = join(ROOT, "web", "dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, {
    root: dist,
    // The entry page must revalidate, or a deploy never reaches the client.
    setHeaders(res, path) {
      const immutable = path.includes(`${sep}assets${sep}`);
      res.setHeader(
        "cache-control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
}

let stopCrawl = () => {};
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    stopCrawl();
    app
      .close()
      .finally(() => {
        ctx.store.close();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  app.log.info(`SplitLine on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
  stopCrawl = ctx.startCorpusCrawl((err) => app.log.warn({ err }, "corpus crawl failed"));
} catch (err) {
  app.log.error(err, "failed to start");
  process.exit(1);
}
