import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, productionPath } from './common.mjs';

const { values } = parseArgs({ options: {
  'database-id': { type: 'string' }, 'account-id': { type: 'string' },
  'database-name': { type: 'string', default: 'ftd-ranked' },
  name: { type: 'string', default: 'ftd-ranked' }, force: { type: 'boolean', default: false },
} });
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(values['database-id'] || '') || /^0{8}-/.test(values['database-id']))
  throw new Error('Supply the real D1 UUID using --database-id.');
for (const key of ['name', 'database-name'])
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values[key])) throw new Error(`Invalid ${key}. Use 3-63 lower-case letters, digits or hyphens.`);
if (values['account-id'] && !/^[a-f0-9]{32}$/i.test(values['account-id'])) throw new Error('Invalid account ID.');
const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.name = values.name;
config.d1_databases[0].database_id = values['database-id'];
config.d1_databases[0].database_name = values['database-name'];
if (values['account-id']) config.account_id = values['account-id'];
await writeFile(productionPath, JSON.stringify(config, null, 2) + '\n', { flag: values.force ? 'w' : 'wx' });
console.log('Created wrangler.production.json. No cloud resources were changed.');
