# Snapshot validation — 2026-10-27

Maintainer-run checks on the separate public source checkout, Windows / Node 24 / .NET 10 / installed FTD 4.3.4.1 references:

- Client Release build: zero warnings and zero errors.
- Six client checks passed: ClientStorage, FleetEditing, BattleOutcome, Languages (508 entries in three languages), KeyBindings and BlockInspector (11 shared fixtures plus nested bans/depth bounds).
- Cloudflare/relay suite: 183 tests passed, zero failed/skipped.
- Wrangler deployment dry run: build passed; no cloud deployment performed.
- Built administrator UI: initialization, handled errors and request timeout checks passed.
- Public file allowlist and known local credential-value scan: no matches; production credentials/state and user files excluded.
- 74 client/server/relay runtime source/resource files matched the source snapshot hashes byte-for-byte.

Packaging changes relative to the original workspace: portable GameManaged/HarmonyPath build properties; a standalone six-suite test runner; self-hosted idle checks use the operator's RANKED_ADMIN_URL; build/review/data documentation; source-only CI. The old BlockInspector regression assumed Korean error text despite the current English default; it now checks the blueprint/block/count in all three selected languages. Runtime mod/service logic was not changed for publication.

Initial runs encountered sandbox restrictions on temporary-file renames and loopback connections. The affected checks were rerun with access to their local test resources and passed. No live accounts, real messages, production matches or database contents were used by these checks.

Native FTD UI integration had passed in the release workspace before 0.7.7 publication; this publication run rebuilt the mod and ran the six source checks above. It did not repeat all gameplay scenarios or establish Linux/macOS game support.

These are maintainer test results, not an independent audit or peer-review approval. CI does not have proprietary game assemblies and therefore runs the server suite and game-independent storage tests only.
