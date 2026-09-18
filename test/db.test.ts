import { describe, expect, it } from "vitest";
import { Store } from "../src/db/db.js";
import { matchDetails, userA, userAMatches } from "./helpers.js";

describe("sqlite store", () => {
  it("round-trips matches idempotently", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    const added = store.upsertMatches(matches);
    expect(added).toBe(matches.length);
    expect(store.upsertMatches(matches)).toBe(0);
    expect(store.matchCount()).toBe(matches.length);
    store.close();
  });

  it("indexes per-player and preserves full JSON", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    store.upsertMatches(matches);
    const uuid = userA().uuid;
    const mine = store.getMatchesForPlayer(uuid);
    expect(mine.length).toBe(matches.filter((m) => m.players.some((p) => p.uuid === uuid)).length);
    expect(mine[0]).toHaveProperty("changes");
    expect(mine[0]).toHaveProperty("result");
    store.close();
  });

  it("stores details separately and reports coverage", () => {
    const store = new Store(":memory:");
    const details = matchDetails();
    for (const d of details) store.upsertDetail(d);
    expect(store.detailCount()).toBe(details.length);
    expect(store.hasDetail(details[0]!.id)).toBe(true);
    expect(store.hasDetail(-1)).toBe(false);
    const roundTrip = store.getDetail(details[0]!.id)!;
    expect(roundTrip.timelines?.length).toBe(details[0]!.timelines?.length);
    const uuid = userA().uuid;
    const forPlayer = store.getDetails({ uuid });
    expect(forPlayer.length).toBeGreaterThan(0);
    store.close();
  });

  it("stores elo from changes[], never from players[].eloRate (gotcha 10)", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    store.upsertMatches(matches);
    const rows = store.db
      .prepare(`SELECT match_id, uuid, elo_rate, elo_change, elo_after FROM match_players`)
      .all() as {
      match_id: number;
      uuid: string;
      elo_rate: number | null;
      elo_change: number | null;
      elo_after: number | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);

    let sawDivergence = false;
    for (const row of rows) {
      const m = matches.find((x) => x.id === row.match_id)!;
      const change = m.changes.find((c) => c.uuid === row.uuid);
      // elo_rate is the PRE-match rating from changes[], not the live rating.
      expect(row.elo_rate).toBe(change?.eloRate ?? null);
      expect(row.elo_change).toBe(change?.change ?? null);
      expect(row.elo_after).toBe(
        row.elo_rate !== null && row.elo_change !== null ? row.elo_rate + row.elo_change : null,
      );
      const live = m.players.find((p) => p.uuid === row.uuid)?.eloRate ?? null;
      if (row.elo_rate !== null && live !== null && row.elo_rate !== live) sawDivergence = true;
    }
    // The bug this guards was invisible wherever the two happened to agree.
    expect(sawDivergence).toBe(true);
    store.close();
  });

  it("lists a player's seasons and newest match without parsing their history", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    store.upsertMatches(matches);
    const uuid = userA().uuid;

    const mine = matches.filter((m) => m.players.some((p) => p.uuid === uuid));
    const expected = [...new Set(mine.filter((m) => m.type === 2).map((m) => m.season))].sort(
      (a, b) => b - a,
    );
    expect(store.seasonsForPlayer(uuid)).toEqual(expected);

    const newest = store.newestMatchForPlayer(uuid)!;
    expect(newest.date).toBe(Math.max(...mine.map((m) => Number(m.date))));
    store.close();
  });

  it("picks detail candidates by column, excluding decayed and already-fetched", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    store.upsertMatches(matches);

    const all = store.detailCandidates({ window: 1000, limit: 1000 });
    expect(all.length).toBe(matches.filter((m) => m.type === 2 && !m.decayed).length);
    expect(all.some((id) => matches.find((m) => m.id === id)!.decayed)).toBe(false);

    for (const id of store.detailCandidates({ window: 1000, limit: 1000, completedOnly: true })) {
      const m = matches.find((x) => x.id === id)!;
      expect(m.forfeited).toBe(false);
      expect(m.result.uuid).not.toBeNull();
    }

    const details = matchDetails();
    store.upsertDetails(details);
    const after = store.detailCandidates({ window: 1000, limit: 1000 });
    for (const d of details) expect(after).not.toContain(d.id);

    expect(store.detailCandidates({ window: 1000, limit: 3 })).toHaveLength(3);
    store.close();
  });

  it("splits detail storage but round-trips the whole match", () => {
    const store = new Store(":memory:");
    const detail = matchDetails()[0]!;
    store.upsertDetails([detail]);

    const listRow = store.db.prepare(`SELECT data FROM matches WHERE id = ?`).get(detail.id) as {
      data: string;
    };
    const list = JSON.parse(listRow.data) as Record<string, unknown>;
    expect(list).not.toHaveProperty("timelines");
    expect(list).not.toHaveProperty("completions");

    expect(store.getDetail(detail.id)).toEqual(detail);
    store.close();
  });

  it("still reads details written before the storage split", () => {
    const store = new Store(":memory:");
    const detail = matchDetails()[0]!;
    store.upsertMatches([detail]);
    // Old format: match_details.data held the entire match. Merging it over
    // the list row must still reproduce the original object.
    store.db
      .prepare(`INSERT OR REPLACE INTO match_details (id, fetched_at, data) VALUES (?, ?, ?)`)
      .run(detail.id, 0, JSON.stringify(detail));
    expect(store.getDetail(detail.id)).toEqual(detail);
    store.close();
  });

  it("joins an open transaction instead of opening a second one", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    // SQLite rejects a nested BEGIN, and an unguarded rollback here would
    // discard the caller's work rather than the inner write's.
    store.db.exec("BEGIN");
    expect(() => store.upsertMatches(matches)).not.toThrow();
    store.db.exec("COMMIT");
    expect(store.matchCount()).toBe(matches.length);
    store.close();
  });

  it("stores players and resolves by uuid or nickname", () => {
    const store = new Store(":memory:");
    const user = userA();
    store.upsertPlayer(user);
    expect(store.getPlayer(user.uuid)?.user.nickname).toBe(user.nickname);
    expect(store.getPlayer(user.nickname.toUpperCase())?.user.uuid).toBe(user.uuid);
    expect(store.getPlayer("definitely-not-real")).toBeNull();
    store.close();
  });
});
