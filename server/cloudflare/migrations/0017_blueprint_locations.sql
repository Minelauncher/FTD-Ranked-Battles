-- The account/ladder DB retains the directory; BP bytes may live in another D1.
-- Unlisted hashes remain in DB, so existing fleets and pending tickets are unchanged.
CREATE TABLE blueprint_locations (
  key TEXT PRIMARY KEY,
  storage TEXT NOT NULL CHECK(storage='DB' OR storage GLOB 'BP_DB_0[1-9]'),
  updated REAL NOT NULL
);
CREATE INDEX blueprint_locations_storage ON blueprint_locations(storage,key);
UPDATE schema_meta SET version=17 WHERE id=1;
