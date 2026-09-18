/** SplitLine HTTP server. The web frontend (Vite) proxies /api here. */
import Fastify from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, RateBudgetError } from "../api/client.js";
import { AppContext } from "./context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.SPLITLINE_DB ?? join(ROOT, "data", "splitline.db");
const PRIVATE_KEY = process.env.MCSR_PRIVATE_KEY || null;

const ctx = new AppContext(DB_PATH, PRIVATE_KEY);
const app = Fastify({ logger: { level: "info" } });

// Must be registered before the routes: a route snapshots its hook chain at
// registration, so a later plugin adds no onSend hook.
await app.register(fastifyCompress, { threshold: 1024 });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) {
    const code = err.httpStatus === 400 ? 404 : err.httpStatus === 429 ? 503 : 502;
    reply.code(code).send({ error: err.message, source: "mcsr-ranked-api" });
    return;
  }
  if (err instanceof RateBudgetError) {
    reply.code(503).send({ error: err.message, retryInMs: err.retryInMs });
    return;
  }
  app.log.error(err);
  reply.code(500).send({ error: "internal error" });
});

app.get("/api/health", async () => ({
  ok: true,
  budgetUsed: ctx.api.client.budgetUsed(),
  matches: ctx.store.matchCount(),
  details: ctx.store.detailCount(),
}));

app.get("/api/status", async () => ctx.api.getStatus());

app.get("/api/overview", async () => {
  const [leaderboard, live, weekly] = await Promise.all([
    ctx.api.getLeaderboard(),
    ctx.api.getLive(),
    ctx.api.getWeeklyRace(),
  ]);
  return {
    season: leaderboard.season,
    top: leaderboard.users.slice(0, 20),
    playersOnline: live.players,
    liveMatchCount: live.liveMatches.length,
    weekly: {
      id: weekly.id,
      endsAt: weekly.endsAt,
      podium: weekly.leaderboard.slice(0, 3),
      entrants: weekly.leaderboard.length,
    },
  };
});

app.get("/api/leaderboard", async (req) => {
  const { season, country } = req.query as { season?: string; country?: string };
  return ctx.api.getLeaderboard(season ? Number(season) : undefined, country);
});

app.get("/api/record-leaderboard", async (req) => {
  const { season, distinct } = req.query as { season?: string; distinct?: string };
  return ctx.api.getRecordLeaderboard(
    season !== undefined ? Number(season) : undefined,
    distinct !== undefined ? distinct !== "false" : undefined,
  );
});

// ------------------------------------------------- static frontend (build)

const dist = join(ROOT, "web", "dist");
if (existsSync(dist)) {
  app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
}

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`SplitLine on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
});
