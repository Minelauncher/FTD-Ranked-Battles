-- Optional recovery email; existing accounts, fleets, matches and credentials remain intact.
ALTER TABLE accounts ADD COLUMN recovery_email TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at REAL;
ALTER TABLE accounts ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN password_reset_expires REAL;
CREATE INDEX accounts_recovery_email ON accounts(recovery_email) WHERE email_verified_at IS NOT NULL;
CREATE TABLE email_challenges (
 id TEXT PRIMARY KEY,
 owner TEXT REFERENCES accounts(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('link','recover')),
 email TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 auth_revision INTEGER NOT NULL,
 created REAL NOT NULL,
 expires REAL NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 consumed REAL
);
CREATE INDEX email_challenge_owner ON email_challenges(owner,purpose,created);
CREATE INDEX email_challenge_address ON email_challenges(email,created);
CREATE INDEX email_challenge_expiry ON email_challenges(expires);
CREATE TABLE email_send_budget(id TEXT PRIMARY KEY,created REAL NOT NULL);
CREATE INDEX email_send_budget_created ON email_send_budget(created);
CREATE TABLE email_recovery_grants (
 token_hash TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 accounts TEXT NOT NULL,
 expires REAL NOT NULL,
 consumed REAL
);
CREATE INDEX email_recovery_grant_expiry ON email_recovery_grants(expires);
CREATE TABLE email_request_windows(key TEXT PRIMARY KEY,last REAL NOT NULL);
UPDATE schema_meta SET version=22 WHERE id=1;
