import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {blueprintStore,routedBlueprintStore} from '../src/blueprint-store.js';
import {copyAndRoute,pruneCopy,objectRows,verifyObject} from '../tools/storage-copy.mjs';
import {checkStorageConfig} from '../tools/storage-config.mjs';
import {migrationStatements} from '../tools/migration-statements.mjs';
let mf,main,one,two;
const key=bytes=>'blueprints/'+createHash('sha256').update(bytes).digest('hex')+'.blueprint';
const env=writer=>({DB:main,BP_DB_01:one,BP_DB_02:two,BLUEPRINT_WRITE_DB:writer});
const client=db=>({query:async sql=>(await db.prepare(sql).all()).results,batch:async sql=>db.batch(sql.map(s=>db.prepare(s)))});
const move=(k,extra={})=>copyAndRoute({main:client(main),source:client(main),target:client(one),from:'DB',to:'BP_DB_01',key:k,...extra});
async function sql(db,file){
 const text=await readFile(new URL(file,import.meta.url),'utf8');
 await db.batch(text.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
}
before(async()=>{
 mf=new Miniflare({...convertV4MiniflareOptions({name:'storage',modules:true,script:'export default {fetch(){return new Response("ok")}}',
  compatibilityDate:'2026-10-22',d1Databases:{DB:'main',BP_DB_01:'one',BP_DB_02:'two'}})});
 main=await mf.getD1Database('DB');one=await mf.getD1Database('BP_DB_01');two=await mf.getD1Database('BP_DB_02');
 for(const db of [main,one,two])await sql(db,'../storage-migrations/0001_blueprints.sql');
 await main.exec('CREATE TABLE schema_meta(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO schema_meta VALUES(1,16);');
 await sql(main,'../migrations/0017_blueprint_locations.sql');
 await main.prepare(migrationStatements(await readFile(new URL('../migrations/0018_blueprint_cleanup.sql',import.meta.url),'utf8'))[0]).run();
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
 for(const db of [main,one,two])await db.prepare('DELETE FROM blueprint_objects').run();
 await main.prepare('DELETE FROM blueprint_locations').run();
 await main.prepare('DELETE FROM blueprint_lifecycle').run();
});
test('existing BP reads and writes stay in DB until a new writer is selected',async()=>{
 const bytes=Buffer.from('original'),k=key(bytes);await blueprintStore(main).put(k,bytes);
 const bucket=routedBlueprintStore({DB:main},main);
 assert.equal(await (await bucket.get(k)).text(),'original');
 await bucket.put(k,bytes);assert.equal(await main.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),0);
});
test('appending stores does not remap old BPs; new uploads follow the writer and survive fresh sessions',async()=>{
 const old=Buffer.from('old'),a=Buffer.from('one'),b=Buffer.from('two');await blueprintStore(main).put(key(old),old);
 await routedBlueprintStore(env('BP_DB_01'),main).put(key(a),a);
 const bucket=routedBlueprintStore(env('BP_DB_02'),main);await bucket.put(key(b),b);await bucket.put(key(old),old);await bucket.put(key(a),a);
 for(const [bytes,db] of [[old,main],[a,one],[b,two]]){
  assert.equal(await(await routedBlueprintStore(env('BP_DB_02'),main).get(key(bytes))).text(),bytes.toString());
  assert(await blueprintStore(db).head(key(bytes)));
 }
 assert.equal(await one.prepare('SELECT count(*) n FROM blueprint_objects').first('n'),1);
});
test('concurrent uploads choosing different stores publish one valid location',async()=>{
 const bytes=randomBytes(650000),k=key(bytes);
 await Promise.all([routedBlueprintStore(env('BP_DB_01'),main).put(k,bytes),routedBlueprintStore(env('BP_DB_02'),main).put(k,bytes)]);
 assert.equal(await main.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),1);
 assert.deepEqual(Buffer.from((await routedBlueprintStore(env('DB'),main).get(k)).body),bytes);
});
test('failed shard commit cannot publish a location; failed directory publication is retryable',async()=>{
 const bytes=Buffer.from('transaction test'),k=key(bytes),bucket=routedBlueprintStore(env('BP_DB_01'),main);
 await one.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON blueprint_chunks BEGIN SELECT RAISE(ABORT,'test'); END;");
 try{await assert.rejects(bucket.put(k,bytes));}finally{await one.exec('DROP TRIGGER fail_chunk;');}
 assert.equal(await main.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),0);
 assert.equal(await blueprintStore(one).head(k),null);
 await main.exec("CREATE TRIGGER fail_location BEFORE INSERT ON blueprint_locations BEGIN SELECT RAISE(ABORT,'test'); END;");
 try{await assert.rejects(bucket.put(k,bytes));}finally{await main.exec('DROP TRIGGER fail_location;');}
 assert(await blueprintStore(one).head(k));assert.equal(await bucket.head(k),null);
 await bucket.put(k,bytes);assert.equal(await(await bucket.get(k)).text(),bytes.toString());
});
test('missing binding, missing object and damaged shard never fall back to stale main data',async()=>{
 const bytes=Buffer.from('same hash'),k=key(bytes);await routedBlueprintStore(env('BP_DB_01'),main).put(k,bytes);
 await blueprintStore(main).put(k,bytes);
 await assert.rejects(routedBlueprintStore({DB:main},main).get(k),e=>e.status===503);
 await one.prepare('DELETE FROM blueprint_chunks').run();
 await assert.rejects(routedBlueprintStore(env('DB'),main).get(k),e=>e.status===503);
 await blueprintStore(one).delete(k);assert.equal(await routedBlueprintStore(env('DB'),main).get(k),null);
 assert.throws(()=>routedBlueprintStore(env('BP_DB_09'),main),e=>e.status===503);
});
test('verified migration preserves hash references and source until explicit delayed cleanup',async()=>{
 const bytes=randomBytes(1200000),k=key(bytes);await blueprintStore(main).put(k,bytes);
 const now=Date.now()/1000;await move(k,{now});
 assert.deepEqual(Buffer.from((await routedBlueprintStore(env('BP_DB_01'),main).get(k)).body),bytes);
 assert(await blueprintStore(main).head(k));assert.equal((await move(k)).status,'already-routed');
 const options={main:client(main),source:client(main),target:client(one),from:'DB',to:'BP_DB_01',key:k};
 await assert.rejects(pruneCopy({...options,now:now+10}),/24-hour/);
 await pruneCopy({...options,now:now+86401});assert.equal(await blueprintStore(main).head(k),null);
 assert.deepEqual(verifyObject(k,await objectRows(client(one),k)).bytes,bytes);
 await assert.rejects(copyAndRoute({...options,from:'BP_DB_01',to:'DB'}),/later BP/);
});
test('interrupted copy resumes and does not switch the directory before verification',async()=>{
 const bytes=randomBytes(80000),k=key(bytes);await blueprintStore(main).put(k,bytes);
 const target=client(one);
 await assert.rejects(move(k,{target:{...target,batch:async statements=>{await target.batch(statements.slice(0,2));throw Error('interrupt');}}}),/interrupt/);
 assert.equal(await main.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),0);
 await move(k);assert.deepEqual(verifyObject(k,await objectRows(target,k)).bytes,bytes);
});
test('corrupt destination and a moved directory are preserved instead of overwritten',async()=>{
 const bytes=Buffer.from('copy source'),k=key(bytes);await blueprintStore(main).put(k,bytes);await blueprintStore(one).put(k,bytes);
 await one.prepare("UPDATE blueprint_chunks SET data='AAAA' WHERE key=?").bind(k).run();
 await assert.rejects(move(k),/manual repair/);
 assert.equal(await main.prepare('SELECT count(*) n FROM blueprint_locations').first('n'),0);
 const target=client(two),originalBatch=target.batch;
 target.batch=async s=>{await originalBatch(s);await main.prepare('INSERT INTO blueprint_locations VALUES(?,?,?)').bind(k,'BP_DB_01',1).run();};
 await assert.rejects(move(k,{target,to:'BP_DB_02'}),/changed during copy/);
 assert.equal(await main.prepare('SELECT storage FROM blueprint_locations WHERE key=?').bind(k).first('storage'),'BP_DB_01');
});
test('configuration rejects paid-resource bindings, unknown writers, wrong migrations and duplicate DBs',()=>{
 const config={d1_databases:[{binding:'DB',database_id:'12345678-1234-1234-1234-123456789abc',database_name:'main',migrations_dir:'migrations'}]};
 assert.equal(checkStorageConfig(config),config);
 assert.throws(()=>checkStorageConfig({...config,r2_buckets:[{}]}));
 assert.throws(()=>checkStorageConfig({...config,vars:{BLUEPRINT_WRITE_DB:'BP_DB_01'}}));
 assert.throws(()=>checkStorageConfig({...config,d1_databases:[...config.d1_databases,{...config.d1_databases[0],binding:'BP_DB_01',migrations_dir:'storage-migrations'}]}));
 assert.throws(()=>checkStorageConfig({...config,d1_databases:[{...config.d1_databases[0],migrations_dir:'storage-migrations'}]}));
});
