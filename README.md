# Ranked Battles for From the Depths

Submit a fleet, arrange its formation, and fight fleets submitted by other players without requiring both players to be online. Battles run in the player's FTD process. A Cloudflare service handles accounts, fleet storage, matchmaking, event ratings and chat.

[Steam Workshop](https://steamcommunity.com/sharedfiles/filedetails/?id=3826036832) · [Build and test](docs/BUILD.md) · [Architecture and review guide](docs/REVIEW.md) · [Data handling](docs/DATA.md)

## Review status

This project was developed with substantial AI coding assistance. This is a public source snapshot for inspection, issue reports and independent review. **No independent security audit or peer-review approval is claimed.** Passing automated tests is not proof that a mod is safe or free of defects.

The snapshot covers client **0.7.7**, Cloudflare service **0.9.6**, database schema **22**, and the Google Apps Script email relay. Runtime client, server and relay source files are copied unchanged from the release workspace. Build metadata has been made portable. [Snapshot hashes](docs/source-snapshot.json) and [release file hashes](docs/release-0.7.7.json) describe the relationship; they are maintainer-provided evidence, not an independent attestation or a guarantee about a remotely running service.

## Included

| Directory | Contents |
| --- | --- |
| `src/` | Entire RankedBattles client implementation, including Harmony patches, UI, downloads, storage, account flow and battle handling |
| `assets/` | English/Korean/Japanese strings, flags and terrain overview images embedded by the client |
| `server/cloudflare/src/` | Entire Worker and Durable Object implementation, including the admin UI |
| `server/cloudflare/migrations/` | Main D1 schema and migration history |
| `server/cloudflare/storage-migrations/` | Additional blueprint-storage database schema |
| `server/cloudflare/test/` | Server tests with synthetic fixtures |
| `server/google-mail-relay/` | Complete Apps Script relay source and send-only permission manifest |
| `tests/` | Client unit tests and native FTD integration probes |
| `tools/` | Localization and Workshop publishing/verification source |

Excluded: credentials, production configuration and database contents, users' blueprints, mail contents, player profiles, operational logs/backups, compiled game assemblies and unrelated faction-war experiments. The retired Python server prototype is not used by the published service and is not part of this snapshot. Campaign starter blueprints come from a legally installed copy of FTD; user uploads and campaign blueprint files are not redistributed here.

## Build and validate

Client: .NET SDK 10, your installed FTD 4.3.4.1 managed assemblies, and Harmony 2.4.2. Server: Node.js 22+ and dependencies pinned by `pnpm-lock.yaml`. The detailed commands in [BUILD.md](docs/BUILD.md) run locally without administrator credentials or production deployment.

```powershell
./Build.ps1 -GameManaged '/path/to/From_The_Depths_Data/Managed' -HarmonyPath '/path/to/0Harmony.dll'
./tools/Test-Source.ps1 -GameManaged '/path/to/From_The_Depths_Data/Managed'
```

```sh
cd server/cloudflare
pnpm install --frozen-lockfile
pnpm test
pnpm run build
node tools/check-admin-bundle.mjs
```

The module runs with the permissions of the game process; it is not a sandbox. Ranked results are submitted by participating clients. Mods are allowed and the ranking service does not prove vanilla combat or prevent a modified client from fabricating results. See [REVIEW.md](docs/REVIEW.md) for concrete entry points and trust boundaries.

## Feedback

Please use Issues for reproducible bugs and code-review findings. Include the commit, file/line and steps to reproduce; do not post passwords, tokens, verification codes, private emails, database dumps or private blueprints. See [SECURITY.md](SECURITY.md).

No project-wide open-source license has been selected yet. This publication makes the source available for review; do not assume an MIT/Apache grant. Third-party components and FTD-derived data retain their respective ownership and terms; see [THIRD-PARTY.md](THIRD-PARTY.md).
