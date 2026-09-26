import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRunSplits, type RunSplits } from "../analysis/splits.js";
import { nowEpochSeconds } from "../shared/brand.js";
import type { CompletionEntry, MatchInfo, TimelineEntry, UserDetails } from "../shared/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bumped when stored rows, not just table definitions, need rewriting. */
const SCHEMA_VERSION = 4;

const INSERT_MATCH = `INSERT OR IGNORE INTO matches
   (id, season, type, date, forfeited, decayed, winner_uuid, result_time,
    seed_type, bastion_type, category, tag, data)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_PLAYER = `INSERT OR IGNORE INTO match_players
   (match_id, uuid, nickname, elo_rate, elo_change, elo_after)
   VALUES (?, ?, ?, ?, ?, ?)`;

/** The extra fields only a single-match fetch returns. */
interface AdvancedFields {
  completions?: CompletionEntry[];
  timelines?: TimelineEntry[];
  replayExist?: boolean;
}

/** Splits a match so each half is stored once; merging them reproduces it. */
function splitAdvanced(m: MatchInfo): { list: MatchInfo; advanced: AdvancedFields } {
  const { completions, timelines, replayExist, ...list } = m;
  const advanced: AdvancedFields = {};
  if (completions !== undefined) advanced.completions = completions;
  if (timelines !== undefined) advanced.timelines = timelines;
  if (replayExist !== undefined) advanced.replayExist = replayExist;
  return { list: list as MatchInfo, advanced };
}

export class Store {
  readonly db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  constructor(path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
    // Without this a second writer gives up at once instead of waiting its turn.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
    // An older cache may still carry an index this project no longer creates.
    this.db.exec("DROP INDEX IF EXISTS idx_matches_type_date");
    this.migrate();
    this.optimize();
  }

  private optimize() {
    this.db.exec("PRAGMA analysis_limit = 400;");
    this.db.exec("PRAGMA optimize;");
  }

  close() {
    this.optimize();
    this.statements.clear();
    this.db.close();
  }

  /** Cached by statement text, so values must be bound, never pasted in. */
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Re-entrant: the database refuses a transaction opened inside another. */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Rewrites rows whose contents, not shape, are wrong. */
  private migrate() {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const from = row.user_version;
    if (from >= SCHEMA_VERSION) return;
    const matches =
      from < 2 ? (this.db.prepare("SELECT data FROM matches").all() as { data: string }[]) : [];
    const details = from < 4 ? this.getDetails() : [];
    this.tx(() => {
      if (from < 2) {
        this.db.exec("DELETE FROM match_players");
        for (const r of matches) this.insertPlayers(JSON.parse(r.data) as MatchInfo);
      }
      // Older season rows could skip games or be invented outright, so they are rebuilt.
      if (from < 3) this.db.exec("DELETE FROM player_seasons");
      if (from < 4) {
        this.db.exec("DELETE FROM runs");
        for (const d of details) this.insertRuns(d);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  /** Ratings come from the per-match change record, not the player summary's current one. */
  private insertPlayers(m: MatchInfo) {
    const insert = this.stmt(INSERT_PLAYER);
    for (const p of m.players) {
      const change = m.changes.find((c) => c.uuid === p.uuid);
      const before = change?.eloRate ?? null;
      const delta = change?.change ?? null;
      insert.run(
        m.id,
        p.uuid,
        p.nickname,
        before,
        delta,
        before !== null && delta !== null ? before + delta : null,
      );
    }
  }

  /** Writes the list-level rows. The caller owns the transaction. */
  private insertMatches(matches: MatchInfo[]): number {
    const insert = this.stmt(INSERT_MATCH);
    let added = 0;
    for (const m of matches) {
      const { list } = splitAdvanced(m);
      const res = insert.run(
        m.id,
        m.season,
        m.type,
        m.date,
        m.forfeited ? 1 : 0,
        m.decayed ? 1 : 0,
        m.result.uuid,
        m.result.time,
        m.seedType ?? m.seed?.overworld ?? null,
        m.bastionType ?? m.seed?.nether ?? null,
        m.category ?? null,
        m.tag ?? null,
        JSON.stringify(list),
      );
      if (res.changes > 0) added++;
      this.insertPlayers(m);
    }
    return added;
  }

  upsertMatches(matches: MatchInfo[]): number {
    return this.tx(() => this.insertMatches(matches));
  }

  /** Stores a batch of details and their list-level rows in one transaction. */
  upsertDetails(details: MatchInfo[]) {
    const insert = this.stmt(
      `INSERT OR REPLACE INTO match_details (id, fetched_at, data) VALUES (?, ?, ?)`,
    );
    const now = nowEpochSeconds();
    this.tx(() => {
      this.insertMatches(details);
      for (const d of details) {
        insert.run(d.id, now, JSON.stringify(splitAdvanced(d).advanced));
        this.insertRuns(d);
      }
    });
  }

  private insertRuns(detail: MatchInfo) {
    const insert = this.stmt(
      `INSERT OR REPLACE INTO runs (match_id, uuid, season, date, data) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of detail.players) {
      const run = extractRunSplits(detail, p.uuid);
      if (run) insert.run(detail.id, p.uuid, detail.season, detail.date, JSON.stringify(run));
    }
  }

  getRuns(opts: { limit: number }): RunSplits[] {
    const rows = this.stmt(
      `SELECT data FROM runs WHERE match_id IN (
         SELECT m.id FROM match_details d JOIN matches m ON m.id = d.id
         ORDER BY m.date DESC LIMIT ?)
       ORDER BY date DESC`,
    ).all(opts.limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as RunSplits);
  }

  getPlayerRuns(uuid: string, season?: number): RunSplits[] {
    const rows = (
      season === undefined
        ? this.stmt(`SELECT data FROM runs WHERE uuid = ? ORDER BY date DESC`).all(uuid)
        : this.stmt(`SELECT data FROM runs WHERE uuid = ? AND season = ? ORDER BY date DESC`).all(
            uuid,
            season,
          )
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as RunSplits);
  }

  upsertDetail(detail: MatchInfo) {
    this.upsertDetails([detail]);
  }

  hasDetail(matchId: number): boolean {
    return this.stmt(`SELECT 1 FROM match_details WHERE id = ?`).get(matchId) !== undefined;
  }

  /** Detail fields go on last, so rows written before the split still load. */
  private mergeDetail(row: { list: string | null; adv: string }): MatchInfo {
    const list = row.list ? (JSON.parse(row.list) as MatchInfo) : ({} as MatchInfo);
    return { ...list, ...(JSON.parse(row.adv) as AdvancedFields) };
  }

  getDetail(matchId: number): MatchInfo | null {
    const row = this.stmt(
      `SELECT m.data AS list, d.data AS adv FROM match_details d
       LEFT JOIN matches m ON m.id = d.id WHERE d.id = ?`,
    ).get(matchId) as { list: string | null; adv: string } | undefined;
    return row ? this.mergeDetail(row) : null;
  }

  getDetails(opts: { uuid?: string; season?: number; limit?: number } = {}): MatchInfo[] {
    let sql = `SELECT m.data AS list, d.data AS adv FROM match_details d
               JOIN matches m ON m.id = d.id`;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.uuid) {
      sql += ` JOIN match_players p ON p.match_id = d.id`;
      where.push(`p.uuid = ?`);
      args.push(opts.uuid);
    }
    if (opts.season !== undefined) {
      where.push(`m.season = ?`);
      args.push(opts.season);
    }
    if (where.length > 0) sql += ` WHERE ` + where.join(" AND ");
    sql += ` ORDER BY m.date DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      args.push(opts.limit);
    }
    const rows = this.stmt(sql).all(...args) as { list: string | null; adv: string }[];
    return rows.map((r) => this.mergeDetail(r));
  }

  /** Recent ranked matches whose timelines have not been fetched yet. */
  detailCandidates(opts: {
    uuid?: string;
    window: number;
    limit: number;
    completedOnly?: boolean;
  }): number[] {
    const args: (string | number)[] = [];
    let inner = `SELECT m.id, m.date, m.decayed, m.forfeited, m.winner_uuid FROM matches m`;
    if (opts.uuid) {
      inner += ` JOIN match_players p ON p.match_id = m.id WHERE m.type = 2 AND p.uuid = ?`;
      args.push(opts.uuid);
    } else {
      inner += ` WHERE m.type = 2`;
    }
    inner += ` ORDER BY m.date DESC LIMIT ?`;
    args.push(opts.window);

    let sql = `SELECT x.id FROM (${inner}) x
               LEFT JOIN match_details d ON d.id = x.id
               WHERE d.id IS NULL AND x.decayed = 0`;
    if (opts.completedOnly) sql += ` AND x.forfeited = 0 AND x.winner_uuid IS NOT NULL`;
    sql += ` ORDER BY x.date DESC LIMIT ?`;
    args.push(opts.limit);

    return (this.stmt(sql).all(...args) as { id: number }[]).map((r) => r.id);
  }

  detailCount(): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM match_details`).get() as { n: number };
    return row.n;
  }

  matchCount(): number {
    const row = this.stmt(`SELECT COUNT(*) AS n FROM matches`).get() as { n: number };
    return row.n;
  }

  seasonsForPlayer(uuid: string): number[] {
    const rows = this.stmt(
      `SELECT DISTINCT m.season AS season FROM matches m
       JOIN match_players p ON p.match_id = m.id
       WHERE p.uuid = ? AND m.type = 2 ORDER BY m.season DESC`,
    ).all(uuid) as { season: number }[];
    return rows.map((r) => r.season);
  }

  /** The newest stored match: ingest's staleness check and starting point. */
  newestMatchForPlayer(uuid: string): { id: number; date: number } | null {
    const row = this.stmt(
      `SELECT m.id AS id, m.date AS date FROM matches m
       JOIN match_players p ON p.match_id = m.id
       WHERE p.uuid = ? ORDER BY m.date DESC, m.id DESC LIMIT 1`,
    ).get(uuid) as { id: number; date: number } | undefined;
    return row ?? null;
  }

  getMatchesForPlayer(
    uuid: string,
    opts: { season?: number; type?: number; limit?: number } = {},
  ): MatchInfo[] {
    let sql = `SELECT m.data FROM matches m JOIN match_players p ON p.match_id = m.id WHERE p.uuid = ?`;
    const args: (string | number)[] = [uuid];
    if (opts.season !== undefined) {
      sql += ` AND m.season = ?`;
      args.push(opts.season);
    }
    if (opts.type !== undefined) {
      sql += ` AND m.type = ?`;
      args.push(opts.type);
    }
    sql += ` ORDER BY m.date DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      args.push(opts.limit);
    }
    const rows = this.stmt(sql).all(...args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MatchInfo);
  }

  /** Scoped by type: a cursor from another type would skip unfetched matches. */
  oldestMatchId(type?: number): number | null {
    const row =
      type === undefined
        ? (this.stmt(`SELECT MIN(id) AS id FROM matches`).get() as { id: number | null })
        : (this.stmt(`SELECT MIN(id) AS id FROM matches WHERE type = ?`).get(type) as {
            id: number | null;
          });
    return row.id;
  }

  upsertPlayer(user: UserDetails) {
    this.stmt(
      `INSERT INTO players (uuid, nickname, last_ingest, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET nickname = excluded.nickname,
         last_ingest = excluded.last_ingest, data = excluded.data`,
    ).run(user.uuid, user.nickname, nowEpochSeconds(), JSON.stringify(user));
  }

  /** Records the seasons the API reports the player has appeared in. */
  setPlayedSeasons(uuid: string, seasons: number[]) {
    const insert = this.stmt(
      `INSERT OR IGNORE INTO player_seasons (uuid, season, ingested_at) VALUES (?, ?, NULL)`,
    );
    this.tx(() => {
      for (const season of seasons) insert.run(uuid, season);
    });
  }

  /** Seasons the API reports, newest first; empty until a profile is ingested. */
  playedSeasons(uuid: string): number[] {
    const rows = this.stmt(
      `SELECT season FROM player_seasons WHERE uuid = ? ORDER BY season DESC`,
    ).all(uuid) as { season: number }[];
    return rows.map((r) => r.season);
  }

  isSeasonIngested(uuid: string, season: number): boolean {
    const row = this.stmt(
      `SELECT ingested_at FROM player_seasons WHERE uuid = ? AND season = ?`,
    ).get(uuid, season) as { ingested_at: number | null } | undefined;
    return row?.ingested_at != null;
  }

  /** Updates only: an insert would make a walked season look like a played one. */
  markSeasonIngested(uuid: string, season: number) {
    this.stmt(
      `UPDATE player_seasons SET ingested_at = ? WHERE uuid = ? AND season = ?`,
    ).run(nowEpochSeconds(), uuid, season);
  }

  getPlayer(identifier: string): { user: UserDetails; lastIngest: number } | null {
    const norm = identifier.replace(/-/g, "");
    const row = this.stmt(
      `SELECT data, last_ingest FROM players
       WHERE uuid = ? OR nickname = ? COLLATE NOCASE`,
    ).get(norm, identifier) as { data: string; last_ingest: number | null } | undefined;
    if (!row || !row.data) return null;
    return { user: JSON.parse(row.data) as UserDetails, lastIngest: row.last_ingest ?? 0 };
  }
}
