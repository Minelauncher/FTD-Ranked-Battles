import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import { root, productionConfig, productionPath, runNode, wrangler } from './common.mjs';
import { backup } from './backup.mjs';

const dryRun = process.argv.includes('--dry-run');
const requireIdle = process.argv.includes('--require-idle');
if (process.argv.slice(2).some(a => !['--dry-run','--require-idle'].includes(a))) throw new Error('Usage: node tools/deploy.mjs [--dry-run] [--require-idle]');
const config = !dryRun ? await productionConfig() : null;
await runNode(['--check', 'src/index.js']);
await runNode(['--test', '--test-concurrency=1', 'test/*.test.mjs']);
await wrangler(['deploy', '--dry-run', '--outdir', path.join(root, 'dist'), '--config', dryRun ? 'wrangler.jsonc' : productionPath]);
await runNode(['tools/check-admin-bundle.mjs']);
if (dryRun) {
  console.log('Local validation complete. No cloud resources or data changed.');
} else {
  let previous;
  try{previous=JSON.parse(await readFile(path.join(root,'storage-deployment.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const old of previous?.databases??[]){
    const current=config.d1_databases.find(d=>d.binding===old.binding);
    if(current&&current.database_id!==old.database_id)throw Error('A published binding cannot be reassigned to another DB: '+old.binding);
  }
  const writer=config.vars?.BLUEPRINT_WRITE_DB??'DB';
  if(writer!=='DB'&&!previous?.databases.some(d=>d.binding===writer&&d.database_id===config.d1_databases.find(n=>n.binding===writer)?.database_id))
    throw Error('Publish the added binding with the old writer first, then activate it in a second deployment.');
  const secrets = JSON.parse(await wrangler(['secret', 'list', '--config', productionPath], true));
  if (!secrets.some(s => s.name === 'AUTH_PEPPER')) throw new Error('Set AUTH_PEPPER with wrangler secret put before deployment. See AUTH.txt.');
  // Abort on any backup/migration failure; never publish code against a partial upgrade.
  await backup();
  // Never remove a binding still referenced by the main directory.
  const tables=JSON.parse(await wrangler(['d1','execute','DB','--remote','--config',productionPath,'--command',"SELECT name FROM sqlite_master WHERE type='table' AND name='blueprint_locations'",'--json'],true));
  if(tables[0].results.length){
    const locations=JSON.parse(await wrangler(['d1','execute','DB','--remote','--config',productionPath,'--command','SELECT DISTINCT storage FROM blueprint_locations','--json'],true));
    for(const row of locations[0].results)if(!config.d1_databases.some(d=>d.binding===row.storage))throw Error('Missing referenced BP binding: '+row.storage);
  }
  if(requireIdle){
    const {ADMIN_TOKEN}=JSON.parse(await readFile(path.join(root,'.env.production-secrets.json'),'utf8'));
    const service=new URL(process.env.RANKED_ADMIN_URL || (()=>{throw Error('Set RANKED_ADMIN_URL to your own HTTPS Worker')})());
    if(service.protocol!=='https:'||service.username||service.password)throw Error('Invalid RANKED_ADMIN_URL');
    const response=await fetch(new URL('/admin/activity',service),{
      headers:{Authorization:'Bearer '+ADMIN_TOKEN},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('Could not verify idle window before migration.');
    const activity=await response.json();
    if(!activity.presence?.available || activity.presence.accounts!==0 || activity.summary?.pendingMatches!==0)
      throw new Error('Players or pending matches appeared. No migrations or code deployment performed.');
    console.log('Idle window verified immediately before migration.');
  }
  for(const db of config.d1_databases) await wrangler(['d1', 'migrations', 'apply', db.binding, '--remote', '--config', productionPath]);
  await wrangler(['deploy', '--config', productionPath]);
  await writeFile(path.join(root,'storage-deployment.json'),JSON.stringify({created:new Date().toISOString(),databases:config.d1_databases,
    writer:config.vars?.BLUEPRINT_WRITE_DB??'DB'},null,2));
  console.log('Deployed. Open the printed HTTPS URL /health, then set that URL in the game connection tab.');
}
