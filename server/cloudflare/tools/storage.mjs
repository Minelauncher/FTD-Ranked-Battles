// Remote storage administration. Mutations require an explicit --apply.
import {parseArgs} from 'node:util';
import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {root,productionConfig,productionPath,wrangler} from './common.mjs';
import {checkStorageConfig,storageOrder} from './storage-config.mjs';
import {storageBinding} from '../src/blueprint-store.js';
import {backup} from './backup.mjs';
import {cliDatabase} from './storage-d1.mjs';
import {copyAndRoute,pruneCopy,sqlValue} from './storage-copy.mjs';
const {values:v,positionals}=parseArgs({allowPositionals:true,options:{name:{type:'string'},binding:{type:'string'},
 from:{type:'string'},to:{type:'string'},limit:{type:'string',default:'20'},apply:{type:'boolean',default:false}}});
const command=positionals[0],config=await productionConfig();
if(positionals.length!==1||!['status','add','writer','move','prune'].includes(command))
 throw Error('Usage: node tools/storage.mjs status | add --name NAME | writer --binding BP_DB_01 | move --from DB --to BP_DB_01 | prune --from DB [--limit 20] [--apply]');
const original=await readFile(productionPath,'utf8');
await mkdir(path.join(root,'backups'),{recursive:true});
function bound(name){const d=config.d1_databases.find(d=>d.binding===name);if(!d)throw Error('Unbound database: '+name);return d;}
async function published(name){
 const manifest=JSON.parse(await readFile(path.join(root,'storage-deployment.json'),'utf8'));
 for(const binding of ['DB',name])if(!manifest.databases.some(d=>d.binding===binding&&d.database_id===bound(binding).database_id))
  throw Error('Deploy the added binding before activating or moving data: node tools/deploy.mjs');
 return manifest;
}
async function saveConfig(next){
 checkStorageConfig(next);
 if(await readFile(productionPath,'utf8')!==original)throw Error('Configuration changed concurrently; reload before saving');
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 await writeFile(path.join(root,'backups/storage-config-'+stamp+'.json'),original,{flag:'wx'});
 const temporary=productionPath+'.next';await writeFile(temporary,JSON.stringify(next,null,2)+'\n');await rename(temporary,productionPath);
}
if(command==='status'){
 const main=cliDatabase('DB'),routes=await main.query('SELECT storage,count(*) AS objects FROM blueprint_locations GROUP BY storage');
 const databases=[];
 for(const d of config.d1_databases){
  const info=JSON.parse(await wrangler(['d1','info',d.database_name,'--config',productionPath,'--json'],true));
  const [objects]=await cliDatabase(d.binding).query('SELECT count(*) AS objects,coalesce(sum(size),0) AS originalBytes,coalesce(sum(compressed_size),0) AS gzipBytes FROM blueprint_objects');
  databases.push({binding:d.binding,name:d.database_name,bytes:info.database_size,freePlanLimitBytes:500000000,
    nearCapacity:info.database_size>=450000000,...objects});
 }
 const lifecycle=await main.query('SELECT state,count(*) AS blueprints FROM blueprint_lifecycle GROUP BY state');
 const [lastRun]=await main.query('SELECT lease_until,last_finished,last_deleted FROM blueprint_gc_runs WHERE id=1');
 console.log(JSON.stringify({writer:config.vars?.BLUEPRINT_WRITE_DB??'DB',databases,routes,
  cleanup:{enabled:config.vars?.BLUEPRINT_CLEANUP==='true',graceHours:24,lifecycle,lastRun},
  note:'D1 daily read/write allowances are shared by all databases in the account.'},null,2));
}else if(command==='add'){
 if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v.name??''))throw Error('Use --name with 3-63 lowercase letters, digits or hyphens');
 if(config.d1_databases.some(d=>d.database_name===v.name))throw Error('Database is already configured');
 const index=Math.max(...config.d1_databases.map(d=>storageOrder(d.binding)))+1;
 if(index>9)throw Error('Free layout already uses all 9 additional BP database slots');
 const binding='BP_DB_'+String(index).padStart(2,'0');
 if(!v.apply){console.log(JSON.stringify({action:'create-and-bind',name:v.name,binding,writerUnchanged:true,next:'Add --apply, then run node tools/deploy.mjs.'}));}
 else{
  let databases=JSON.parse(await wrangler(['d1','list','--config',productionPath,'--json'],true));
  if(databases.length>10)throw Error('Account exceeds the Free-plan database count; inspect the account plan first');
  let found=databases.find(d=>d.name===v.name);
  if(!found){
   if(databases.length>=10)throw Error('Account already has 10 databases; do not upgrade or create more on the Free plan');
   await wrangler(['d1','create',v.name,'--location','apac','--config',productionPath,'--update-config=false'],true);
   databases=JSON.parse(await wrangler(['d1','list','--config',productionPath,'--json'],true));found=databases.find(d=>d.name===v.name);
  }
  if(!found)throw Error('Creation outcome unknown; rerun with the same name to recover it');
  const next=structuredClone(config);next.d1_databases.push({binding,database_name:v.name,database_id:found.uuid,migrations_dir:'storage-migrations'});checkStorageConfig(next);
  const pending=path.join(root,'wrangler.storage-pending.json');await writeFile(pending,JSON.stringify(next,null,2));
  try{
   const tables=await cliDatabase(binding,pending).query("SELECT name FROM sqlite_master WHERE type='table'");
   if(tables.some(t=>!['_cf_KV','sqlite_sequence','d1_migrations','blueprint_objects','blueprint_chunks'].includes(t.name)))throw Error('Existing database contains unrelated tables; refusing to attach it');
   await wrangler(['d1','migrations','apply',binding,'--remote','--config',pending]);
   await cliDatabase(binding,pending).query('SELECT count(*) AS objects FROM blueprint_objects');
   await saveConfig(next);
  }finally{await unlink(pending);}
  console.log('Added '+binding+'. Writer unchanged. Deploy it with: node tools/deploy.mjs');
 }
}else if(command==='writer'){
 bound(v.binding);await published(v.binding);
 if(!v.apply)console.log('Set new uploads to '+v.binding+' with --apply, then deploy. Existing BP locations remain unchanged.');
 else{
  await cliDatabase(v.binding).query('SELECT count(*) AS objects FROM blueprint_objects');
  const next=structuredClone(config);next.vars={...next.vars,BLUEPRINT_WRITE_DB:v.binding};await saveConfig(next);
  console.log('Writer configured: '+v.binding+'. Activate with: node tools/deploy.mjs');
 }
}else{
 if(!storageBinding(v.from))throw Error('Valid --from required');bound(v.from);const deployed=await published(v.from);
 const limit=Number(v.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('--limit must be 1..100');
 const main=cliDatabase('DB'),source=cliDatabase(v.from);
 let items;
 if(command==='move'){
  if(!storageBinding(v.to)||storageOrder(v.to)<=storageOrder(v.from))throw Error('--to must be a later BP database');bound(v.to);await published(v.to);
  items=await main.query(`SELECT 'blueprints/'||b.hash||'.blueprint' AS key FROM blueprints b
   JOIN blueprint_lifecycle life ON life.hash=b.hash AND life.state='ready'
   LEFT JOIN blueprint_locations l ON l.key='blueprints/'||b.hash||'.blueprint'
   WHERE coalesce(l.storage,'DB')=${sqlValue(v.from)} ORDER BY b.hash LIMIT ${limit}`);
 }else{
  if((config.vars?.BLUEPRINT_WRITE_DB??'DB')===v.from||deployed.writer===v.from)throw Error('Switch and deploy the writer away from this database before pruning');
  const cutoff=Date.now()/1000-86400;
  // Source enumeration keeps repeat cleanup from selecting already-deleted rows.
  const copies=await source.query('SELECT key FROM blueprint_objects ORDER BY key');
  const candidates=await main.query(`SELECT key,storage FROM blueprint_locations WHERE storage<>${sqlValue(v.from)} AND updated<=${cutoff} ORDER BY key`);
  const keys=new Set(copies.map(r=>r.key));items=candidates.filter(r=>keys.has(r.key)&&storageOrder(r.storage)>storageOrder(v.from)).slice(0,limit);
  for(const item of items){bound(item.storage);await published(item.storage);}
 }
 if(!v.apply)console.log(JSON.stringify({action:command,from:v.from,to:v.to,count:items.length,keys:items.map(i=>i.key),next:'Add --apply to execute; move retains the old copies for at least 24 hours.'},null,2));
 else if(!items.length)console.log('No eligible BPs.');
 else{
  await backup();const results=[];
  for(const item of items){
   const to=command==='move'?v.to:item.storage,target=cliDatabase(to);
   const options={main,source,target,from:v.from,to,key:item.key};
   const result=await(command==='move'?copyAndRoute(options):pruneCopy(options));results.push(result);console.log(JSON.stringify(result));
  }
  const file=path.join(root,'backups','storage-'+command+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  await writeFile(file,JSON.stringify({from:v.from,to:v.to,results},null,2));console.log('Saved report: '+file);
 }
}
