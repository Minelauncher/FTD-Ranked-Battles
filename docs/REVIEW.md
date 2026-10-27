# Architecture and review guide

## What runs where

1. FTD loads `src/Plugin.cs`. Harmony patches integrate native menus and spectator controls. The client runs inside the game process with its OS permissions.
2. `Client.cs`, `RankTransport.cs`, `ChatWire.cs` and the account/fleet/result clients communicate with the configured HTTPS/WebSocket service.
3. The Cloudflare Worker (`server/cloudflare/src/index.js`) handles authentication, submissions, event policy, matchmaking, admin requests and scheduled cleanup. D1 stores accounts, fleets, matches, event ratings and compressed blueprint chunks.
4. `chat-room.js` is a SQLite Durable Object for chat and active connections. The administrator browser UI is generated from the server modules, not a separate private frontend.
5. `email-recovery.js` creates limited-lived challenges and recovery grants. `account-mail.js` signs requests to the separate Apps Script relay. `Code.gs` checks the signature, timestamp, send ID, quota and recipient restrictions before calling MailApp.
6. `Battle.cs`, `BattleMaterials.cs` and `BattleOutcome.cs` launch and judge a battle on the participant's PC. `ResultClient.cs` persists/retries results; server result handling applies the rating transaction once.

## Trust boundaries and known limitations

- The server validates structure, authentication, limits and match ownership. It does not simulate or independently attest combat. A hostile client can lie about a locally simulated result; allowing mods does not solve this.
- The downloaded opponent blueprint is untrusted input to both this code and FTD's loader. Hash checking establishes file identity, not safety or fairness. Review recursive/subvehicle parsing, budgets and missing-block behavior.
- HTTPS protects transport, but the service operator and the email provider are separate trust parties. Public server source does not attest which code an operator is running.
- Local login tokens and fleet drafts are files, not a protected OS credential vault. Anyone with access to those files may be able to use the session.
- Native mod DLLs are not sandboxed. Review file operations, networking and patches before executing a build. This source repository does not assert malware-free or audited status.

## Useful review entry points

| Concern | Files |
| --- | --- |
| Password hashing, sessions, login throttling, admin reset | `server/cloudflare/src/auth.js`, `shared.js` |
| Recovery ownership, replay/concurrency, quotas | `email-recovery.js`, `account-mail.js`, `server/google-mail-relay/Code.gs` |
| Authorization and routing | `server/cloudflare/src/index.js`, `client-policy.js` |
| Result replay, surrender, expiry and two-sided ratings | `match-results.js`, `src/ResultClient.cs`, `MatchStorage.cs` |
| BP size/path/hash/recursive validation and cleanup races | `blueprint-inspector.js`, `blueprint-store.js`, `blueprint-cleanup.js`, `src/BlueprintBlocks.cs` |
| Local path boundaries, token persistence and temporary-file deletion | `src/ClientStorage.cs`, `MatchStorage.cs`, `FleetClient.cs` |
| Chat access, HTML handling, reconnect and rate limits | `chat.js`, `chat-room.js`, `chat-admin-ui.js`, `src/ChatWire.cs` |
| Native UI/patch scope and battle interference | `src/Plugin.cs`, `NativeUi.cs`, `ArenaUi.cs`, `InteractionGuard.cs`, `Spectator.cs` |
| Time-limit judging and fleet material accounting | `src/BattleMaterials.cs`, `BattleOutcome.cs`, `server/cloudflare/src/battle-outcome.js` |

## What the tests establish

The tests check specific input cases, storage behavior, API outcomes, concurrency and recovery paths. They are regression evidence for those cases. They do not establish resistance to all malicious input, prove physical determinism, verify every third-party mod, or replace independent review. The client was tested in-game on Windows; Linux/macOS native integration is not claimed.

Please separate confirmed defects (with a location and reproducer) from hypotheses. Independent findings can be tracked through Issues/PRs. No reviewer endorsements have been obtained as part of this publication.
