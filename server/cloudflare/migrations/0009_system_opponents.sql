-- Login-disabled system identities reuse account/entry references in immutable tickets.
CREATE TABLE system_opponents (
  owner TEXT PRIMARY KEY REFERENCES accounts(id),
  tournament TEXT NOT NULL REFERENCES tournaments(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  seed_key TEXT,
  UNIQUE(tournament,seed_key)
);
CREATE INDEX system_opponents_tournament ON system_opponents(tournament,enabled);
CREATE TABLE system_defaults (key TEXT PRIMARY KEY);
UPDATE schema_meta SET version=9 WHERE id=1;
