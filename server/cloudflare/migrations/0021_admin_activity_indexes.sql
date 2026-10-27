-- Read-only activity pagination; existing fleets, matches and ratings are preserved.
CREATE INDEX admin_recent_matches ON matches(created DESC,id DESC);
CREATE INDEX admin_event_matches ON matches(tournament,created DESC,id DESC);
UPDATE schema_meta SET version=21 WHERE id=1;
