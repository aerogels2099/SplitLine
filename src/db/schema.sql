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

-- Holds only the fields a single-match fetch adds; the rest of the match is
-- stored once in the matches table, and reads merge the two halves.
CREATE TABLE IF NOT EXISTS match_details (
  id         INTEGER PRIMARY KEY REFERENCES matches(id),
  fetched_at INTEGER NOT NULL,             -- epoch seconds
  data       TEXT NOT NULL                 -- the detail-only fields
);

-- Both ratings come from the per-match change record, not the player summary.
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

-- One row per season the API says the player appeared in; a season counts as
-- stored only once its match list has been walked to the end.
CREATE TABLE IF NOT EXISTS player_seasons (
  uuid        TEXT NOT NULL,
  season      INTEGER NOT NULL,
  ingested_at INTEGER,                     -- epoch seconds; empty while the season is only partly stored
  PRIMARY KEY (uuid, season)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS runs (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  uuid     TEXT NOT NULL,
  season   INTEGER NOT NULL,
  date     INTEGER NOT NULL,
  data     TEXT NOT NULL,
  PRIMARY KEY (match_id, uuid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_runs_uuid_season ON runs(uuid, season);
