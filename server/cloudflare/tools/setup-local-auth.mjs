// Local development only; never uploads a secret or changes existing credentials.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './common.mjs';
const file = path.join(root, '.dev.vars');
let content = '';
try { content = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (/^AUTH_PEPPER\s*=/m.test(content)) {
  console.log('Existing local AUTH_PEPPER preserved.');
} else {
  await writeFile(file, content + '\nAUTH_PEPPER="' + randomBytes(32).toString('hex') + '"\n', { mode: 0o600 });
  console.log('Created local AUTH_PEPPER in .dev.vars. Keep this file private and backed up with the local DB.');
}
