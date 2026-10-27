-- Additive upgrade: existing accounts, BP references and receipts are preserved.
CREATE UNIQUE INDEX one_pending_match_per_owner ON matches(owner) WHERE status = 'pending';
CREATE INDEX owner_history ON matches(owner, status, created DESC);
CREATE INDEX ranked_accounts ON accounts(rating DESC, id);
CREATE INDEX eligible_opponents ON accounts(rating, id) WHERE bp_hash IS NOT NULL;
CREATE INDEX matches_owner_bp ON matches(owner_hash);
CREATE INDEX matches_opponent_bp ON matches(opponent_hash);
CREATE INDEX accounts_bp ON accounts(bp_hash);
UPDATE schema_meta SET version = 2 WHERE id = 1;
