-- Date columns hold epoch seconds; duration columns hold milliseconds.

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY,        -- match id as issued by the API
  season       INTEGER NOT NULL,
  type         INTEGER NOT NULL,           -- numbered casual, ranked, private, event
  date         INTEGER NOT NULL,           -- epoch seconds
  forfeited    INTEGER NOT NULL,
  decayed      INTEGER NOT NULL,           -- a synthetic rank-decay entry, not a game
  winner_uuid  TEXT,                       -- empty when the match was drawn
  result_time  INTEGER NOT NULL,           -- milliseconds
  seed_type    TEXT,
  bastion_type TEXT,
  category     TEXT,
  tag          TEXT,
  data         TEXT NOT NULL               -- the match record, without the detail-only fields
);

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date);
CREATE INDEX IF NOT EXISTS idx_matches_season_type ON matches(season, type);

-- The detail-only fields come back only when a match is fetched by id, so they
-- live here and nothing else does. The rest of the match is stored once, in the
-- matches table, and reads merge the two halves.
CREATE TABLE IF NOT EXISTS match_details (
  id         INTEGER PRIMARY KEY REFERENCES matches(id),
  fetched_at INTEGER NOT NULL,             -- epoch seconds
  data       TEXT NOT NULL                 -- the detail-only fields
);

-- Both rating columns come from the per-match change record, never from the
-- player summary, which always reports their current rating instead.
CREATE TABLE IF NOT EXISTS match_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  uuid       TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  elo_rate   INTEGER,                      -- the rating going into the match; empty in placements
  elo_change INTEGER,                      -- empty in placements
  elo_after  INTEGER,
  PRIMARY KEY (match_id, uuid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_match_players_uuid ON match_players(uuid, match_id);

CREATE TABLE IF NOT EXISTS players (
  uuid        TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL,
  last_ingest INTEGER,                     -- epoch seconds of the last successful ingest
  data        TEXT                         -- the full player record
);

CREATE INDEX IF NOT EXISTS idx_players_nickname ON players(nickname COLLATE NOCASE);
