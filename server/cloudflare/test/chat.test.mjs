import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from '../tools/migration-statements.mjs';
import {Script} from 'node:vm';
import {createRequire} from 'node:module';
import {RankedChat} from '../src/chat-room.js';
const WebSocket=createRequire(import.meta.resolve('miniflare'))('ws');
const root=path.resolve(import.meta.dirname,'..'), sockets=[];
let mf,db,dir,a,b;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function closeAll(){for(const ws of sockets.splice(0))try{ws.close(1000,'test complete');}catch{}await delay(700);}
async function start(){
 mf=new Miniflare({...convertV4MiniflareOptions({name:'chat-test',modulesRoot:path.join(root,'src'),modules:['index.js',...(await readdir(path.join(root,'src'))).filter(f=>f.endsWith('.js')&&f!=='index.js')].map(f=>({type:'ESModule',path:path.join(root,'src',f)})),compatibilityDate:'2026-10-22',
 d1Databases:{DB:'chat-test'},durableObjects:{CHAT:{className:'RankedChat',useSQLite:true}},
 bindings:{AUTH_PEPPER:'local-chat-test-pepper-2026-never-production',ADMIN_TOKEN:'test-admin',REGISTRATION_OPEN:'true',DEFAULT_OPPONENTS:'false',CHAT_ENABLED:'true'}}),resourcePersistencePath:dir});
 db=await mf.getD1Database('DB');
}
async function api(route,method='GET',body,token='test-admin',version='0.7.0'){
 const r=await mf.dispatchFetch('https://rank.test'+route,{method,headers:{Authorization:'Bearer '+token,'X-FTD-Rank-Version':version,'X-FTD-Rank-Protocol':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:r.status,data:await r.json()};
}
async function connect(account,version='0.7.0',extra={}){
 const url=(await mf.ready).origin.replace('http:','ws:')+'/chat/socket';
 const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+account.token,'X-FTD-Rank-Version':version,'X-FTD-Rank-Protocol':'1',...extra}}),queue=[],waiters=[];sockets.push(ws);let channel='general';
 ws.on('message',raw=>{const data=JSON.parse(raw.toString());if(data.type==='hello'||data.type==='history')channel=data.channel;const w=waiters.shift();if(w)w(data);else queue.push(data);});
 const opened=await new Promise((resolve,reject)=>{ws.once('open',()=>resolve(null));ws.on('error',reject);ws.once('unexpected-response',(_,res)=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));});});
 if(opened)return opened;
 return {status:101,ws,send:value=>ws.send(JSON.stringify(value.type==='send'?{channel,...value}:value)),async next(type){
  for(let i=0;i<30;i++){const data=queue.length?queue.shift():await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No message '+type)),5000);waiters.push(m=>{clearTimeout(timer);resolve(m);});});if(data.type===type)return data;}throw Error('Message not found '+type);
 }};
}
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'ftd-chat-'));await start();
 for(const f of (await readdir(path.join(root,'migrations'))).sort())await db.batch(migrationStatements(await readFile(path.join(root,'migrations',f),'utf8')).map(s=>db.prepare(s)));
 a=(await api('/auth/register','POST',{username:'chatuser_a',nickname:'한글 日本語 Pilot',password:'test-password'})).data;
 b=(await api('/auth/register','POST',{username:'chatuser_b',nickname:'Chat B',password:'test-password'})).data;
 // Membership comes from an event submission, never simply from having an account.
 await db.prepare("INSERT INTO tournament_entries(tournament,owner,revision,fleet,fingerprint,updated,composition_key,composition_updated) VALUES('standard-100k',?,1,'{}','chat-fixture',0,'',0)").bind(a.account.id).run();
});

test('outgoing messages revalidate expired or revoked chat sessions',async()=>{
 const a=(await api('/auth/register','POST',{username:'chatrevoke',nickname:'Revoke Test',password:'test-password'})).data;
 const user=await db.prepare('SELECT auth_revision,token_expires FROM accounts WHERE id=?').bind(a.account.id).first();
 const room=Object.create(RankedChat.prototype);room.env={DB:db};
 let sent=0,closed=0,attachment={id:a.account.id,name:'Chat A',revision:user.auth_revision,expires:user.token_expires,version:'0.7.0',checked:0};
 const ws={deserializeAttachment:()=>({...attachment}),serializeAttachment:value=>{attachment=value;},send:()=>sent++,close:()=>closed++};
 await room.deliver(ws,{type:'settings'});assert.equal(sent,1);assert.equal(closed,0);
 attachment.expires=0;await room.deliver(ws,{type:'message'});assert.equal(sent,1);assert.equal(closed,1);
 attachment.expires=user.token_expires;attachment.checked=0;
 await db.prepare('UPDATE accounts SET auth_revision=auth_revision+1 WHERE id=?').bind(a.account.id).run();
 await room.deliver(ws,{type:'message'});assert.equal(sent,1);assert.equal(closed,2);
});
after(async()=>{await closeAll();await mf?.dispose();});

test('admin presence deduplicates accounts and excludes closed, revoked, outdated or expired sessions',async()=>{
 await closeAll();
 const c=(await api('/auth/register','POST',{username:'presence_a',nickname:'Presence A',password:'test-password'})).data;
 const d=(await api('/auth/register','POST',{username:'presence_b',nickname:'Presence B',password:'test-password'})).data;
 for(const user of [c,c,d]){const connection=await connect(user);await connection.next('hello');}
 const read=async()=>{const r=await api('/admin/activity');assert.equal(r.status,200);assert.equal(r.data.presence.available,true);return r.data.presence;};
 let p=await read();assert.equal(p.accounts,2);assert.equal(p.connections,3);
 await db.prepare('UPDATE accounts SET auth_revision=auth_revision+1 WHERE id=?').bind(d.account.id).run();
 p=await read();assert.equal(p.accounts,1);assert.equal(p.connections,2);
 await db.prepare("UPDATE client_policy SET minimum_version='0.7.1' WHERE id=1").run();
 p=await read();assert.equal(p.accounts,0);assert.equal(p.connections,0);
 await db.prepare("UPDATE client_policy SET minimum_version='0.6.10' WHERE id=1").run();
 await db.prepare('UPDATE accounts SET token_expires=0 WHERE id=?').bind(c.account.id).run();
 p=await read();assert.equal(p.accounts,0);
 await closeAll();p=await read();assert.equal(p.accounts,0);assert.equal(p.connections,0);
 assert.equal((await api('/admin/activity','GET',undefined,a.token)).status,403);
});

test('chat authentication, fan-out, private channels, durable cooldown, moderation and persistent logs',async()=>{
 assert.equal((await connect({token:'invalid'})).status,401);
 assert.equal((await connect(a,'0.6.16')).status,426);
 assert.equal((await api('/admin/chat/status','GET',undefined,a.token)).status,403);
 const aa=await connect(a,'0.7.0',{'X-Chat-Identity':JSON.stringify({id:'administrator',name:'Forged'})}),bb=await connect(b);
 const hello=await aa.next('hello'), otherHello=await bb.next('hello');assert.equal(hello.settings.slowSeconds,30);assert(hello.channels.some(c=>c.id==='event:standard-100k'));
 assert.deepEqual(otherHello.channels.map(c=>c.id),['general']);
 bb.send({type:'join',channel:'event:standard-100k'});assert.equal((await bb.next('error')).status,403);
 assert.equal((await api('/me/profile','PUT',{nicknameColor:'#66ccff'},a.token)).status,200);
 assert.equal((await bb.next('profile')).nicknameColor,'#66CCFF');
 const nonce='1'.repeat(32);aa.send({type:'send',nonce,body:'안녕 日本語 <b>plain text</b>'});
 const sent=await aa.next('message'),received=await bb.next('message');assert.equal(sent.message.owner,a.account.id);assert.equal(received.message.name,'한글 日本語 Pilot');assert.equal(received.message.nicknameColor,'#66CCFF');await aa.next('ack');
 aa.send({type:'search',query:'日本語'});const found=await aa.next('search');assert.equal(found.messages.length,1);assert.equal(found.messages[0].nicknameColor,'#66CCFF');assert.equal(found.scanned,1);assert.equal(found.nextBefore,null);
 aa.send({type:'search',query:'Chat A'});assert.equal((await aa.next('error')).status,429);
 aa.send({type:'send',nonce:'2'.repeat(32),body:'too soon'});const limited=await aa.next('error');assert.equal(limited.status,429);assert(limited.nextSend>limited.serverTime);
 aa.send({type:'join',channel:'event:standard-100k'});const joined=await aa.next('history');assert.equal(joined.channel,'event:standard-100k');
 await delay(550);aa.send({type:'send',nonce:'3'.repeat(32),body:'switch bypass'});assert.equal((await aa.next('error')).status,429);
 aa.ws.close(1000,'reconnect');await delay(600);const again=await connect(a);assert((await again.next('hello')).nextSend>hello.serverTime);
 again.send({type:'send',nonce,body:'안녕 日本語 <b>plain text</b>'});assert.equal((await again.next('ack')).id,sent.message.id);
 const privateRoom={id:'room:bracket32',name:'Bracket 32',kind:'members',active:true,members:[a.account.id]};
 assert.equal((await api('/admin/chat/channels','PUT',privateRoom)).status,200);
 await delay(550);bb.send({type:'join',channel:privateRoom.id});assert.equal((await bb.next('error')).status,403);
 again.send({type:'join',channel:privateRoom.id});assert.equal((await again.next('history')).channel,privateRoom.id);
 assert.equal((await api('/admin/chat/channels','PUT',{...privateRoom,members:[]})).status,200);assert.equal((await again.next('history')).channel,'general');
 again.send({type:'send',channel:privateRoom.id,nonce:'7'.repeat(32),body:'must never leak into general'});assert.equal((await again.next('error')).status,409);
 assert.equal((await api('/admin/chat/hide','PUT',{id:sent.message.id,hidden:true})).status,200);const hidden=await again.next('history');assert.equal(hidden.messages[0].body,'');
 const logs=await api('/admin/chat/logs?channel=general');assert.equal(logs.data.messages[0].body,sent.message.body);assert.equal(logs.data.messages[0].hidden,1);
 again.send({type:'search',query:'日本語'});assert.equal((await again.next('search')).messages.length,0);
 let state=(await api('/admin/chat/status')).data;assert.equal(state.retention,'indefinite');assert.equal(state.usage.messages,1);assert(state.usage.databaseBytes>0);
 assert.equal((await api('/admin/chat/settings','PUT',{slowSeconds:0,dailyLimit:2,expectedRevision:state.settings.revision})).status,200);
 assert.equal((await api('/admin/chat/settings','PUT',{slowSeconds:10,dailyLimit:2,expectedRevision:state.settings.revision})).status,409);
 assert.equal((await api('/admin/chat/mute','PUT',{owner:b.account.id,until:Math.floor(Date.now()/1000)+600,reason:'test'})).status,200);
 await delay(550);bb.send({type:'send',nonce:'4'.repeat(32),body:'muted'});assert.equal((await bb.next('error')).status,403);
 again.send({type:'send',nonce:'5'.repeat(32),body:'second'});await again.next('ack');
 await delay(550);again.send({type:'send',nonce:'6'.repeat(32),body:'daily full'});assert.equal((await again.next('error')).status,429);
 const page=await api('/admin/chat/logs?channel=general&limit=1');assert.equal(page.data.messages.length,1);assert(page.data.nextBefore);
 const older=await api('/admin/chat/logs?channel=general&before='+page.data.nextBefore);assert.equal(older.data.messages.length,1);
 const html=await(await mf.dispatchFetch('https://rank.test/admin')).text();new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);assert(html.includes('chatSlow'));assert(!html.includes('test-admin'));
 await closeAll();await mf.dispose();await start();
 state=(await api('/admin/chat/status')).data;assert.equal(state.usage.messages,2);assert.equal(state.settings.dailyLimit,2);
 assert.equal((await api('/admin/chat/logs?channel=general')).data.messages.length,2);
 // Search walks bounded batches across all retained history without a new full-text index.
 assert.equal((await api('/admin/chat/settings','PUT',{slowSeconds:30,dailyLimit:10000,expectedRevision:state.settings.revision})).status,200);
 assert.equal((await api('/admin/chat/channels','PUT',privateRoom)).status,200);
 for(let i=0;i<1005;i++){
  const result=await api('/admin/chat/notice','POST',{channel:privateRoom.id,body:i===0||i===1004?'검색 日本語 boundary':'filler '+i});assert.equal(result.status,200);
 }
 const searcher=await connect(a);await searcher.next('hello');searcher.send({type:'join',channel:privateRoom.id});await searcher.next('history');
 searcher.send({type:'search',query:'日本語'});let batch=await searcher.next('search');assert.equal(batch.scanned,1000);assert.equal(batch.messages.length,1);assert(batch.nextBefore);
 await delay(3050);searcher.send({type:'search',query:'日本語',before:batch.nextBefore});batch=await searcher.next('search');assert.equal(batch.scanned,5);assert.equal(batch.messages.length,1);assert.equal(batch.nextBefore,null);
 await delay(3050);searcher.send({type:'search',query:'announcement'});batch=await searcher.next('search');assert.equal(batch.messages.length,50);assert.equal(batch.scanned,50);assert(batch.nextBefore);
 const second=await connect(a);await second.next('hello');assert.equal((await connect(a)).status,429);
 assert.equal((await api('/admin/chat/notice','POST',{body:'bad\nline'})).status,400);
 assert.equal((await api('/admin/chat/notice','POST',{body:'😀'.repeat(301)})).status,400);
 console.log('PASS persisted messages, indefinite retention, account-wide cooldown, private channel ACL and moderation; SQLite bytes='+state.usage.databaseBytes);
});
