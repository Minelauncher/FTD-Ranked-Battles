-- BP bytes live in R2. These immutable hashes keep pending matches reproducible
-- even after either account replaces its registered blueprint.
CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
INSERT INTO schema_meta VALUES (1, 1);
CREATE TABLE blueprints (
  hash TEXT PRIMARY KEY CHECK(length(hash) = 64),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
  created REAL NOT NULL
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1000 CHECK(rating >= 0),
  games INTEGER NOT NULL DEFAULT 0 CHECK(games >= 0),
  bp_hash TEXT REFERENCES blueprints(hash),
  bp_name TEXT,
  bp_updated REAL
);
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES accounts(id),
  opponent TEXT NOT NULL REFERENCES accounts(id),
  created REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'cancelled')),
  ticket TEXT NOT NULL CHECK(json_valid(ticket)),
  owner_hash TEXT NOT NULL REFERENCES blueprints(hash),
  opponent_hash TEXT NOT NULL REFERENCES blueprints(hash),
  score REAL CHECK(score IN (0, 0.5, 1)),
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
  CHECK(owner <> opponent),
  CHECK((status = 'completed' AND score IS NOT NULL AND receipt IS NOT NULL)
     OR (status <> 'completed' AND score IS NULL AND receipt IS NULL))
);
