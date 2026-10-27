-- Preserve the old deadline while separating composition changes from formation edits.
ALTER TABLE tournament_entries ADD COLUMN composition_key TEXT NOT NULL DEFAULT '';
ALTER TABLE tournament_entries ADD COLUMN composition_updated REAL NOT NULL DEFAULT 0;
UPDATE tournament_entries SET composition_updated=updated,
  composition_key=(SELECT group_concat(hash, ',') FROM (
    SELECT json_extract(value, '$.hash') AS hash
    FROM json_each(tournament_entries.fleet, '$.units') ORDER BY hash
  ));
UPDATE schema_meta SET version=8 WHERE id=1;
