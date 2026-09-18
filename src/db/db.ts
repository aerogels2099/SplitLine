/**
 * SQLite storage (node:sqlite, no native deps). Matches are immutable, so
 * writes are INSERT OR IGNORE and re-ingesting is idempotent.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowEpochSeconds } from "../shared/brand.js";
import type { MatchInfo, UserDetails } from "../shared/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- matches

  upsertMatches(matches: MatchInfo[]): number {
    const insertMatch = this.db.prepare(
      `INSERT OR IGNORE INTO matches
       (id, season, type, date, forfeited, decayed, winner_uuid, result_time,
        seed_type, bastion_type, category, tag, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPlayer = this.db.prepare(
      `INSERT OR IGNORE INTO match_players
       (match_id, uuid, nickname, elo_rate, elo_change, elo_after)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    this.db.exec("BEGIN");
    try {
      for (const m of matches) {
        const res = insertMatch.run(
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
          JSON.stringify(m),
        );
        if (res.changes > 0) added++;
        for (const p of m.players) {
          const change = m.changes.find((c) => c.uuid === p.uuid);
          insertPlayer.run(
            m.id,
            p.uuid,
            p.nickname,
            p.eloRate,
            change?.change ?? null,
            change?.eloRate ?? null,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }

  upsertDetail(detail: MatchInfo) {
    this.upsertMatches([detail]);
    this.db
      .prepare(`INSERT OR REPLACE INTO match_details (id, fetched_at, data) VALUES (?, ?, ?)`)
      .run(detail.id, nowEpochSeconds(), JSON.stringify(detail));
  }

  hasDetail(matchId: number): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM match_details WHERE id = ?`).get(matchId) !== undefined
    );
  }

  getDetail(matchId: number): MatchInfo | null {
    const row = this.db.prepare(`SELECT data FROM match_details WHERE id = ?`).get(matchId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as MatchInfo) : null;
  }

  /** All stored details, optionally restricted to one player's matches. */
  getDetails(opts: { uuid?: string; season?: number; limit?: number } = {}): MatchInfo[] {
    let sql = `SELECT d.data FROM match_details d JOIN matches m ON m.id = d.id`;
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
    const rows = this.db.prepare(sql).all(...args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MatchInfo);
  }

  detailCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM match_details`).get() as { n: number };
    return row.n;
  }

  matchCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM matches`).get() as { n: number };
    return row.n;
  }

  getMatchesForPlayer(uuid: string, opts: { season?: number; type?: number; limit?: number } = {}): MatchInfo[] {
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
    const rows = this.db.prepare(sql).all(...args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MatchInfo);
  }

  getAllMatches(opts: { season?: number; type?: number; limit?: number } = {}): MatchInfo[] {
    let sql = `SELECT data FROM matches`;
    const where: string[] = [];
    const args: number[] = [];
    if (opts.season !== undefined) {
      where.push(`season = ?`);
      args.push(opts.season);
    }
    if (opts.type !== undefined) {
      where.push(`type = ?`);
      args.push(opts.type);
    }
    if (where.length > 0) sql += ` WHERE ` + where.join(" AND ");
    sql += ` ORDER BY date DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      args.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MatchInfo);
  }

  oldestMatchId(): number | null {
    const row = this.db.prepare(`SELECT MIN(id) AS id FROM matches`).get() as { id: number | null };
    return row.id;
  }

  // ---------------------------------------------------------------- players

  upsertPlayer(user: UserDetails) {
    this.db
      .prepare(
        `INSERT INTO players (uuid, nickname, last_ingest, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET nickname = excluded.nickname,
           last_ingest = excluded.last_ingest, data = excluded.data`,
      )
      .run(user.uuid, user.nickname, nowEpochSeconds(), JSON.stringify(user));
  }

  getPlayer(identifier: string): { user: UserDetails; lastIngest: number } | null {
    const norm = identifier.replace(/-/g, "");
    const row = this.db
      .prepare(
        `SELECT data, last_ingest FROM players
         WHERE uuid = ? OR nickname = ? COLLATE NOCASE`,
      )
      .get(norm, identifier) as { data: string; last_ingest: number | null } | undefined;
    if (!row || !row.data) return null;
    return { user: JSON.parse(row.data) as UserDetails, lastIngest: row.last_ingest ?? 0 };
  }
}
