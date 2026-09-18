import { describe, expect, it } from "vitest";
import { Store } from "../src/db/db.js";
import { matchDetails, userA, userAMatches } from "./helpers.js";

describe("sqlite store", () => {
  it("round-trips matches idempotently", () => {
    const store = new Store(":memory:");
    const matches = userAMatches();
    const added = store.upsertMatches(matches);
    expect(added).toBe(matches.length);
    // Re-ingesting the same page adds nothing (matches are immutable).
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
