import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {checkStorageConfig} from './storage-config.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const productionPath = path.join(root, 'wrangler.production.json');
export async function productionConfig() {
  let config;
  try { config = JSON.parse(await readFile(productionPath, 'utf8')); }
  catch { throw new Error('Run node tools/configure.mjs --database-id <D1 UUID> first.'); }
  const db = config.d1_databases?.find(d => d.binding === 'DB');
  if (!db || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(db.database_id) || /^0{8}-/.test(db.database_id))
    throw new Error('Production D1 binding is missing or still a placeholder.');
  if (config.r2_buckets?.length) throw new Error('This D1-only deployment must not include R2 bindings.');
  return checkStorageConfig(config);
}
export function runNode(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`Command failed (${code}): ${args[0]}`)));
  });
}
export const wrangler = (args, capture = false) => runNode([path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], capture);
