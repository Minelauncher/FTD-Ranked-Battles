# Build and test

## Client

Prerequisites: .NET SDK 10, PowerShell 7 for the scripts, an installed copy of FTD (tested against 4.3.4.1), and Harmony 2.4.2 `0Harmony.dll` from the [upstream release](https://github.com/pardeike/Harmony/releases/tag/v2.4.2.0). Use the build compatible with Unity/Mono; the Workshop dependency's SHA-256 is recorded in `release-0.7.7.json`. Game DLLs and Harmony binaries are not committed to this repository.

`GameManaged` is the directory containing `Ftd.dll`, `Core.dll`, `UnityEngine.CoreModule.dll`, etc. Set it explicitly for a non-default installation or another OS. `HarmonyPath` is an absolute path to `0Harmony.dll`; alternatively place it in the ignored `lib/` directory.

```powershell
./Build.ps1 -GameManaged '/path/to/Managed' -HarmonyPath '/path/to/0Harmony.dll'
./tools/Test-Source.ps1 -GameManaged '/path/to/Managed'
```

For a DLL without packaging:

```sh
dotnet build src/RankedBattles.csproj -c Release -p:GameManaged=/path/to/Managed -p:HarmonyPath=/path/to/0Harmony.dll
```

Output: `src/bin/Release/netstandard2.1/RankedBattles.dll`; packaging produces `dist/RankedBattles/` and `dist/RankedBattles-0.7.7.zip`. Never package an installed mod directory: it can contain a player's login token and fleet drafts.

`Test-Source.ps1` runs storage, fleet editing, battle outcome, language/account form, key binding and blueprint inspection checks. It does not launch FTD, send email or contact the live service. The storage test can run without game assemblies:

```sh
dotnet run --project tests/ClientStorage/ClientStorage.csproj -c Release
```

### Native integration probes

`tests/*Probe` and `tests/WorkshopCapture` contain the native test plugins. These need FTD and, for several scenarios, campaign blueprint files from that installation. Historical `Test-*.ps1`, `Capture-Workshop.ps1` and export scripts describe the original Windows harness and its isolated profile layout. They are included for review; **they are not portable one-command tests** and expect a prepared `RankIsolationProbe/A` development profile outside this repository. Do not point that fixture at your personal save. No player profile or game files are supplied. The new account flow was exercised in a muted isolated game using a mocked transport before the Workshop release; reproducing that integration requires preparing an equivalent fixture.

## Server and relay

Use Node.js 22+ (maintainer checked on Node 24) and pnpm. Dependency versions are pinned in `pnpm-lock.yaml`; keep the lockfile. Wrangler's development build uses local D1/Durable Objects, not the live account.

```sh
cd server/cloudflare
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
node tools/check-admin-bundle.mjs
```

Tests use Miniflare, local databases and mocked mail. The Apps Script relay tests run the relay source with mocked Google services and do not send real mail.

For a local API:

```sh
node tools/setup-local-auth.mjs
pnpm db:local
pnpm dev
```

The setup creates a random `AUTH_PEPPER` in ignored `.dev.vars`. If testing administrator routes, add a random `ADMIN_TOKEN` there too. Email recovery remains disabled until deliberately configured. Local and hosted Workers have different quotas/behavior; local success alone does not prove production behavior.

## Self-hosting

Use your own Cloudflare account and D1 database. `tools/configure.mjs --database-id <your UUID>` creates an ignored `wrangler.production.json` from the placeholder template. Configure your own `AUTH_PEPPER` and `ADMIN_TOKEN` as Worker secrets. Preserve the pepper with the database: losing or changing it breaks credential verification. Review `tools/deploy.mjs` before using it; it validates, exports a backup, applies migrations and deploys to the configured account. The `--dry-run` path validates locally only.

`--require-idle` also requires `RANKED_ADMIN_URL` pointing to **your** HTTPS Worker and a private `.env.production-secrets.json` containing your admin token; it refuses unavailable presence or pending matches. No production identifiers or credentials are supplied.

For mail, deploy `server/google-mail-relay/Code.gs` and `appsscript.json` under your chosen send-only account. Set Script Properties `RELAY_SECRET` (64 random hex characters), `RELAY_ENABLED`, `TEST_RECIPIENT`, and initially `PRODUCTION_ENABLED=false`. Configure matching Worker secrets `EMAIL_RELAY_SECRET` and `EMAIL_RELAY_URL`, plus `EMAIL_RECOVERY_ENABLED=true` and an optional `EMAIL_FROM_NAME`. Only enable general recipients after checking your own deployment. Never commit these values. The relay caps reserved sends at 80 in a rolling 24-hour period and also checks Google's remaining quota.

The client's default service URL is in `src/Client.cs`. Change it to your own service when building a self-hosted variant. Tests and forks must not exercise the public service using fabricated accounts or results.

## Workshop tooling

`tools/WorkshopPublisher` and `tools/Publish-Workshop.ps1` are included for transparency. The publisher targets the existing owner/item and requires Steam, the game's Steamworks API, a private publishing profile and media/state files that are deliberately not included. It is not invoked by builds/tests or CI. Do not use the maintainer's item ID to publish your fork.

## Release comparison

`source-snapshot.json` records the original snapshot's file hashes. Runtime `.cs`, Worker `.js`, relay `.gs` and embedded assets remain unchanged; project/build files have portable path changes. `release-0.7.7.json` records the six files downloaded back from Steam after publication. Rebuilding elsewhere can change compiler/debug/path metadata, so byte-for-byte reproducibility is not claimed. Compare source and decompiled assemblies when investigating discrepancies; a published hash alone is not a security review.
