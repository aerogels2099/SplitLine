-- SplitLine local cache. Matches are immutable, so rows are written once.
-- `date` columns are epoch SECONDS; `*_time` columns are MILLISECONDS.

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY,        -- API match id
  season       INTEGER NOT NULL,
  type         INTEGER NOT NULL,           -- 1 casual, 2 ranked, 3 private, 4 event
  date         INTEGER NOT NULL,           -- epoch seconds
  forfeited    INTEGER NOT NULL,           -- 0/1
  decayed      INTEGER NOT NULL,           -- 0/1: synthetic decay entry, not a real game
  winner_uuid  TEXT,                       -- NULL on draw
  result_time  INTEGER NOT NULL,           -- milliseconds
  seed_type    TEXT,
  bastion_type TEXT,
  category     TEXT,
  tag          TEXT,
  data         TEXT NOT NULL               -- full MatchInfo JSON (list-level fields)
);

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date);
CREATE INDEX IF NOT EXISTS idx_matches_season_type ON matches(season, type);

-- Advanced fields exist only on GET /matches/{id}, so they are stored here.
CREATE TABLE IF NOT EXISTS match_details (
  id         INTEGER PRIMARY KEY REFERENCES matches(id),
  fetched_at INTEGER NOT NULL,             -- epoch seconds
  data       TEXT NOT NULL                 -- full MatchInfo JSON incl. timelines
);

-- One row per (match, player) for fast per-player match queries.
CREATE TABLE IF NOT EXISTS match_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  uuid       TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  elo_rate   INTEGER,                      -- elo at match time (NULL in placements)
  elo_change INTEGER,                      -- NULL in placements
  elo_after  INTEGER,
  PRIMARY KEY (match_id, uuid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_match_players_uuid ON match_players(uuid, match_id);

CREATE TABLE IF NOT EXISTS players (
  uuid        TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL,
  last_ingest INTEGER,                     -- epoch seconds of last successful ingest
  data        TEXT                         -- full UserDetails JSON
);

CREATE INDEX IF NOT EXISTS idx_players_nickname ON players(nickname COLLATE NOCASE);
