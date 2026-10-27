import {storageBinding} from '../src/blueprint-store.js';
export function checkStorageConfig(config) {
  if(config.r2_buckets?.length) throw Error('R2 is not allowed in this D1-only deployment.');
  const databases=config.d1_databases;
  if(!Array.isArray(databases)||databases.length<1||databases.length>10) throw Error('Use 1 main DB and at most 9 BP databases.');
  if(databases.filter(d=>d.binding==='DB').length!==1) throw Error('Exactly one main DB binding is required.');
  for(const d of databases){
    if(!storageBinding(d.binding)) throw Error('Invalid storage binding: '+d.binding);
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(d.database_id)||/^0{8}-/.test(d.database_id)) throw Error('Missing real D1 UUID: '+d.binding);
    if(d.migrations_dir!==(d.binding==='DB'?'migrations':'storage-migrations')) throw Error('Wrong migrations directory: '+d.binding);
  }
  for(const field of ['binding','database_id','database_name']) if(new Set(databases.map(d=>d[field])).size!==databases.length) throw Error('Duplicate D1 '+field);
  const writer=config.vars?.BLUEPRINT_WRITE_DB??'DB';
  if(!databases.some(d=>d.binding===writer)) throw Error('Write database is not bound: '+writer);
  return config;
}
export const storageOrder=name=>name==='DB'?0:Number(name.slice(-2));
