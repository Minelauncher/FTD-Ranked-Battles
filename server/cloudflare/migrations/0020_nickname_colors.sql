ALTER TABLE accounts ADD COLUMN nickname_color TEXT CHECK(nickname_color IS NULL OR (length(nickname_color)=7 AND nickname_color GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'));
ALTER TABLE accounts ADD COLUMN color_updated REAL NOT NULL DEFAULT 0;
UPDATE schema_meta SET version=20 WHERE id=1;
