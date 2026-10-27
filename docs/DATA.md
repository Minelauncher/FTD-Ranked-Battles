# Data handling in this snapshot

Read the implementation for exact behavior; this is a review map, not a claim of a completed privacy/security audit.

- Accounts use a private login username, public nickname and password. Email is optional. The service stores a random salt and a PBKDF2-SHA256 password derivation protected with an HMAC pepper; it does not store the submitted plaintext password as an account field. Passwords still pass through the client and server during authentication.
- The server stores session-token hashes. The client keeps its bearer token in local configuration to remain signed in. Treat that local file as a credential. Password forms and temporary recovery passwords are sensitive even when the account has no real name.
- Verified recovery emails are private account data. The mail provider receives recipient addresses and verification/recovery message bodies. Recovery can return linked usernames after code verification and send a limited-lived temporary password to the verified address.
- Blueprints and formations are uploaded for matchmaking and downloaded by matched opponents. They are not confidential from those opponents. Old unused BP objects are eligible for cleanup, while references used by active matches are retained.
- Nicknames, nickname colors, event ratings and match information are displayed to other participants. Chat messages are retained, and administrators can inspect/export them. Local blocking changes what a client displays; it does not erase the server log.
- Connection IP addresses reach the hosting provider. Authentication throttling derives HMAC keys from IP/username values; this does not imply that the hosting provider has no connection metadata or logs.
- The local mod stores settings, session state, fleet drafts, cached BP files and pending results. Match temporary files are cleaned up through bounded path logic. Review `ClientStorage.cs` and `MatchStorage.cs` for the exact retention and deletion paths.

No real names, postal addresses, telephone numbers or payment details are requested by the mod's account form. That reduces collection but does not make passwords, tokens, email addresses or private designs non-sensitive. Use a password unique to this service.
