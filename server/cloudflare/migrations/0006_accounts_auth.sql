-- Add credentials without changing existing account IDs, ratings or fleet references.
ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN password_salt TEXT;
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN recovery_hash TEXT;
ALTER TABLE accounts ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN token_expires INTEGER;
CREATE UNIQUE INDEX accounts_username ON accounts(username) WHERE username IS NOT NULL;
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE INDEX auth_attempts_window ON auth_attempts(window);
UPDATE client_policy SET minimum_version='0.5.0',revision=revision+1
 WHERE minimum_version IN ('0.4.0','0.4.1','0.4.2','0.4.3');
UPDATE schema_meta SET version=6 WHERE id=1;
