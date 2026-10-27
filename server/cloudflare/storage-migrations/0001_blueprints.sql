-- BP-only database. No accounts, ratings, or tournament migrations belong here.
CREATE TABLE blueprint_objects (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
  compressed_size INTEGER NOT NULL CHECK(compressed_size BETWEEN 1 AND 8454144),
  parts INTEGER NOT NULL CHECK(parts BETWEEN 1 AND 257)
);
CREATE TABLE blueprint_chunks (
  key TEXT NOT NULL REFERENCES blueprint_objects(key) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 256),
  data TEXT NOT NULL CHECK(length(data) BETWEEN 1 AND 699052),
  PRIMARY KEY(key,part)
);
