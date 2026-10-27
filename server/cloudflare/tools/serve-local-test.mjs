import { migrationStatements } from './migration-statements.mjs';
// Isolated local fixture for FTD integration and manual UI checks. Never deployed.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { root } from './common.mjs';
if (process.argv.length !== 3) throw Error('Usage: node tools/serve-local-test.mjs <new-test-directory>');
const directory = path.resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const adminToken = randomBytes(32).toString('hex');
const mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'game-test', host: '127.0.0.1', port: 0, modulesRoot: path.join(root, 'src'),
  modules: ['index.js','activity-admin.js','activity-admin-ui.js','chat.js','chat-room.js','chat-admin-ui.js','storage-admin.js','storage-admin-ui.js','blueprint-cleanup.js','match-results.js','blueprint-store.js','battle-outcome.js','account-mail.js','email-recovery.js','auth.js','shared.js','tournaments.js','system-opponents.js','campaign-presets.js','opponent-admin.js','client-policy.js','admin-page.js','blueprint-inspector.js','block-bans.js','block-catalog.js','battlefields.js','battlefield-maps.js','map-picker.js'].map(file => ({ type: 'ESModule', path: path.join(root, 'src', file) })),
  compatibilityDate: '2026-10-22', d1Databases: { DB: 'game-test' }, durableObjects: { CHAT: { className: 'RankedChat', useSQLite: true } },
  bindings: { CHAT_ENABLED: 'true', AUTH_PEPPER: 'isolated-test-pepper-never-use-in-production-2026', REGISTRATION_OPEN: 'true', DEFAULT_OPPONENTS: 'false', MAX_ACCOUNTS: '10', ADMIN_TOKEN: adminToken } }), resourcePersistencePath: path.join(directory, 'local-cloudflare') });
const db = await mf.getD1Database('DB');
for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
  const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
  await db.batch(migrationStatements(sql).map(s => db.prepare(s)));
}
const url = (await mf.ready).origin;
await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ server: url, adminToken }), { flag: 'wx' });
const mod = path.join(directory, 'SaveData/From The Depths/Mods/RankedBattles');
await mkdir(mod, { recursive: true });
await writeFile(path.join(mod, 'client.json'), JSON.stringify({ Server: url, Name: 'Fleet Test Captain', Language: 'ko', Connections: {} }), { flag: 'wx' });
await writeFile(path.join(directory, 'fixture-ready'), url);
console.log('Local fleet test server: ' + url);
await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
await mf.dispose();
