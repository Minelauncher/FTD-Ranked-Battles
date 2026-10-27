-- BP originals are now gzip-compressed in D1; no R2 subscription is required.
-- Existing account, fleet, rating and match references remain unchanged.
CREATE TABLE IF NOT EXISTS blueprint_objects (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
  compressed_size INTEGER NOT NULL CHECK(compressed_size BETWEEN 1 AND 8454144),
  parts INTEGER NOT NULL CHECK(parts BETWEEN 1 AND 257)
);
CREATE TABLE IF NOT EXISTS blueprint_chunks (
  key TEXT NOT NULL REFERENCES blueprint_objects(key) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 256),
  data TEXT NOT NULL CHECK(length(data) BETWEEN 1 AND 699052),
  PRIMARY KEY(key,part)
);
UPDATE schema_meta SET version=12 WHERE id=1;
