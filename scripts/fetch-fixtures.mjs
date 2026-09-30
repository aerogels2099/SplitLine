// Fetches real API responses into the test fixtures directory, about 20 requests.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "https://api.mcsrranked.com";
const OUT = join(import.meta.dirname, "..", "test", "fixtures");

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { "User-Agent": "SplitLine-fixtures/1.0" },
  });
  const body = await res.json();
  if (body.status !== "success") {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body.data).slice(0, 200)}`);
  }
  console.log(`ok  ${path}`);
  return body; // the whole envelope is checked in unchanged
}

async function save(name, body) {
  await writeFile(join(OUT, name), JSON.stringify(body, null, 1) + "\n");
}

await mkdir(OUT, { recursive: true });

const leaderboard = await get("/leaderboard");
await save("leaderboard.json", leaderboard);

const [a, b] = leaderboard.data.users.slice(0, 2).map((u) => u.nickname);
console.log(`players: ${a} vs ${b}`);

const userA = await get(`/users/${encodeURIComponent(a)}`);
await save("user-a.json", userA);
const matchesA = await get(`/users/${encodeURIComponent(a)}/matches?count=100&excludedecay=false`);
await save("user-a-matches.json", matchesA);

await save("user-b.json", await get(`/users/${encodeURIComponent(b)}`));
await save("user-b-matches.json", await get(`/users/${encodeURIComponent(b)}/matches?count=100`));

await save("versus.json", await get(`/users/${encodeURIComponent(a)}/versus/${encodeURIComponent(b)}`));
await save("versus-matches.json", await get(`/users/${encodeURIComponent(a)}/versus/${encodeURIComponent(b)}/matches?count=100`));

const pool = matchesA.data.filter((m) => m.type === 2 && !m.decayed);
const completed = pool.filter((m) => !m.forfeited && m.result.uuid !== null).slice(0, 9);
const forfeits = pool.filter((m) => m.forfeited).slice(0, 2);
const draws = pool.filter((m) => m.result.uuid === null).slice(0, 1);
const detailIds = [...completed, ...forfeits, ...draws].map((m) => m.id);
const details = [];
for (const id of detailIds) {
  details.push((await get(`/matches/${id}`)).data);
}
await save("match-details.json", { status: "success", data: details });

await save("recent-matches.json", await get("/matches?count=100&type=2"));

console.log("done");
