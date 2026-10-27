import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {storageOrder} from './storage-config.mjs';
const validKey=key=>/^blueprints\/[a-f0-9]{64}\.blueprint$/.test(key);
export const sqlValue=v=>typeof v==='number'&&Number.isFinite(v)?String(v):typeof v==='string'?"'"+v.replaceAll("'","''")+"'":(()=>{throw Error('Unsupported SQL value');})();
const digest=b=>createHash('sha256').update(b).digest('hex');
async function hold(main,key,now){
 if(!validKey(key))throw Error('Invalid BP key');
 const hash=key.slice(11,-10);
 const rows=await main.query(`INSERT INTO blueprint_lifecycle(hash,unused_since,hold_until)
 VALUES(${sqlValue(hash)},${now},${now+86400}) ON CONFLICT(hash) DO UPDATE SET hold_until=max(hold_until,excluded.hold_until)
 WHERE state='ready' RETURNING generation`);
 if(!rows.length)throw Error('BP is being cleaned up or was deleted; upload it again first');
 return `EXISTS(SELECT 1 FROM blueprint_lifecycle WHERE hash=${sqlValue(hash)} AND state='ready' AND generation=${rows[0].generation})`;
}
export async function objectRows(db,key){
 if(!validKey(key))throw Error('Invalid BP key');
 return db.query(`SELECT o.size,o.compressed_size,o.parts,c.part,c.data FROM blueprint_objects o LEFT JOIN blueprint_chunks c ON c.key=o.key WHERE o.key=${sqlValue(key)} ORDER BY c.part`);
}
export function verifyObject(key,rows){
 if(!validKey(key)||!rows.length)throw Error('Missing BP object: '+key);
 const m=rows[0];
 if(!Number.isInteger(m.size)||m.size<1||m.size>8388608||rows.length!==m.parts||rows.some((r,i)=>r.part!==i||typeof r.data!=='string'))throw Error('Incomplete BP: '+key);
 const compressed=Buffer.concat(rows.map(r=>Buffer.from(r.data,'base64')));
 if(compressed.length!==m.compressed_size)throw Error('Invalid compressed BP size: '+key);
 const bytes=gunzipSync(compressed,{maxOutputLength:8388608});
 if(bytes.length!==m.size||digest(bytes)!==key.slice(11,-10))throw Error('BP checksum mismatch: '+key);
 return {size:m.size,compressed,bytes};
}
export async function location(main,key){
 const rows=await main.query(`SELECT storage,updated FROM blueprint_locations WHERE key=${sqlValue(key)}`);
 return rows[0]??{storage:'DB',updated:0};
}
export async function copyAndRoute({main,source,target,from,to,key,now=Date.now()/1000}){
 if(storageOrder(to)<=storageOrder(from))throw Error('Move only to a later BP database; locations never move backwards.');
 const held=await hold(main,key,now);
 const current=await location(main,key);
 if(current.storage===to){verifyObject(key,await objectRows(target,key));return {key,status:'already-routed'};}
 if(current.storage!==from)throw Error('BP location changed before copy: '+key);
 const original=verifyObject(key,await objectRows(source,key)), parts=[];
 for(let offset=0;offset<original.compressed.length;offset+=32768)parts.push(original.compressed.subarray(offset,offset+32768).toString('base64'));
 const existing=await objectRows(target,key);
 let ready=false;
 if(existing.length){
  try{verifyObject(key,existing);ready=true;}catch{
   // A disrupted CLI import can resume only if every existing byte matches
   // the intended copy. Never overwrite an unrelated/corrupt destination.
   const m=existing[0];
   if(m.size!==original.size||m.compressed_size!==original.compressed.length||m.parts!==parts.length||
      existing.some(r=>r.part!==null&&r.data!==parts[r.part]))throw Error('Destination needs manual repair: '+key);
  }
 }
 if(!ready){
  await target.batch([
   `INSERT INTO blueprint_objects(key,size,compressed_size,parts) VALUES(${sqlValue(key)},${original.size},${original.compressed.length},${parts.length}) ON CONFLICT(key) DO NOTHING`,
   ...parts.map((data,i)=>`INSERT INTO blueprint_chunks(key,part,data) VALUES(${sqlValue(key)},${i},${sqlValue(data)}) ON CONFLICT(key,part) DO NOTHING`)
  ]);
 }
 verifyObject(key,await objectRows(target,key));
 // Copy verified, then compare-and-swap the directory. Existing matches keep
 // the same immutable hash and fetch through the new location automatically.
 const changed=await main.query(`INSERT INTO blueprint_locations(key,storage,updated)
 SELECT ${sqlValue(key)},${sqlValue(to)},${now}
 WHERE coalesce((SELECT storage FROM blueprint_locations WHERE key=${sqlValue(key)}),'DB')=${sqlValue(from)} AND ${held}
 ON CONFLICT(key) DO UPDATE SET storage=excluded.storage,updated=excluded.updated
 WHERE blueprint_locations.storage=${sqlValue(from)} AND ${held} RETURNING storage`);
 if(changed.length!==1)throw Error('Location changed during copy; both copies retained: '+key);
 return {key,status:'copied-and-routed',bytes:original.size};
}
export async function pruneCopy({main,source,target,from,to,key,now=Date.now()/1000,graceSeconds=86400}){
 if(storageOrder(to)<=storageOrder(from))throw Error('Cannot prune the active/original copy');
 await hold(main,key,now);
 const current=await location(main,key);
 if(current.storage!==to||now-current.updated<graceSeconds)throw Error('Location changed or 24-hour rollback window is not over');
 verifyObject(key,await objectRows(target,key));
 // Supported moves are forward-only, so a concurrent migration cannot make
 // this old source authoritative again. A failed cleanup retains extra bytes.
 await source.batch([`DELETE FROM blueprint_objects WHERE key=${sqlValue(key)}`]);
 return {key,status:'old-copy-pruned'};
}
