import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from '../tools/migration-statements.mjs';
import {RankedChat} from '../src/chat-room.js';
import {sha256,encoder} from '../src/shared.js';
const WebSocket=createRequire(import.meta.resolve('miniflare'))('ws');
const root=path.resolve(import.meta.dirname,'..'),sockets=[];
let mf,db,origin;
async function api(route,method='GET',body,token='viewer-test-admin'){
  const response=await mf.dispatchFetch(origin+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-FTD-Rank-Version':'0.7.2','X-FTD-Rank-Protocol':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
async function connect(route,headers={Origin:origin}){
  const ws=new WebSocket(origin.replace('http:','ws:')+route,{headers}),queue=[],waiters=[];sockets.push(ws);
  ws.on('message',raw=>{const message=JSON.parse(raw.toString());const waiter=waiters.shift();if(waiter)waiter(message);else queue.push(message);});
  const status=await new Promise((resolve,reject)=>{ws.once('open',()=>resolve(101));ws.on('error',reject);ws.once('unexpected-response',(_,r)=>{r.resume();r.on('end',()=>resolve(r.statusCode));});});
  return {status,ws,send:message=>ws.send(JSON.stringify(message)),async next(type){
    for(let i=0;i<30;i++){
      const m=queue.length?queue.shift():await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing '+type)),5000);waiters.push(value=>{clearTimeout(timer);resolve(value);});});
      if(m.type===type)return m;
    }throw Error('Missing '+type);
  }};
}
async function ticket(){const r=await api('/admin/chat/ticket','POST',{});assert.equal(r.status,200);assert.match(r.data.ticket,/^[a-f0-9]{64}$/);return r.data.ticket;}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({name:'chat-viewer-test',modulesRoot:path.join(root,'src'),modules:['index.js',...(await readdir(path.join(root,'src'))).filter(f=>f.endsWith('.js')&&f!=='index.js')].map(f=>({type:'ESModule',path:path.join(root,'src',f)})),compatibilityDate:'2026-10-22',
    d1Databases:{DB:'viewer-test'},durableObjects:{CHAT:{className:'RankedChat',useSQLite:true}},bindings:{ADMIN_TOKEN:'viewer-test-admin',AUTH_PEPPER:'viewer-local-only-pepper-2026-never-production',REGISTRATION_OPEN:'true',DEFAULT_OPPONENTS:'false',CHAT_ENABLED:'true'}}));
  origin=(await mf.ready).origin;db=await mf.getD1Database('DB');
  for(const f of (await readdir(path.join(root,'migrations'))).sort())await db.batch(migrationStatements(await readFile(path.join(root,'migrations',f),'utf8')).map(s=>db.prepare(s)));
});
after(async()=>{for(const ws of sockets)try{ws.close();}catch{}await mf?.dispose();});

test('viewer tickets require admin authentication, same-origin upgrade, and single use',async()=>{
  assert.equal((await api('/admin/chat/ticket','POST',{},'invalid')).status,403);
  assert.equal((await api('/admin/chat/ticket')).status,404);
  assert.equal((await connect('/admin/chat/socket?ticket='+'a'.repeat(64))).status,401);
  const token=await ticket(),route='/admin/chat/socket?ticket='+token;
  assert.equal((await connect(route,{})).status,403);
  assert.equal((await connect(route,{Origin:'https://attacker.test'})).status,403);
  const results=await Promise.all([connect(route),connect(route)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[101,401]);
  const viewer=results.find(r=>r.status===101),hello=await viewer.next('hello');
  assert.equal(hello.channel,'general');assert(hello.expires>Date.now()/1000);assert(!JSON.stringify(hello).includes('viewer-test-admin'));
  assert.equal((await api('/admin/activity')).data.presence.connections,0);
  const usage=(await api('/admin/chat/status')).data.usage;
  assert.equal(usage.connections,0);assert.equal(usage.viewers,1);
  viewer.ws.close();
});

test('administrator gets live private-channel messages, moderation and profile updates without participant privileges',async()=>{
  const registration=await api('/auth/register','POST',{username:'viewer_player',nickname:'Live Pilot',password:'test-password'});assert.equal(registration.status,200);const user=registration.data;
  const userSocket=await connect('/chat/socket',{Authorization:'Bearer '+user.token,'X-FTD-Rank-Version':'0.7.2','X-FTD-Rank-Protocol':'1'});assert.equal(userSocket.status,101);await userSocket.next('hello');
  const room={id:'room:viewer-private',name:'Private bracket',kind:'members',active:true,members:[user.account.id]};
  assert.equal((await api('/admin/chat/channels','PUT',room)).status,200);
  const viewer=await connect('/admin/chat/socket?ticket='+await ticket());await viewer.next('hello');
  const p=(await api('/admin/activity')).data.presence;assert.equal(p.accounts,1);assert.equal(p.connections,1);
  viewer.send({type:'join',channel:room.id});assert.equal((await viewer.next('history')).channel,room.id);
  userSocket.send({type:'join',channel:room.id});await userSocket.next('history');
  const body='日本語 · 한글 · <img src=x onerror=alert(1)>';
  userSocket.send({type:'send',channel:room.id,body,nonce:'b'.repeat(32)});
  const message=(await viewer.next('message')).message;assert.equal(message.body,body);assert.equal(message.name,'Live Pilot');await userSocket.next('ack');
  assert.equal((await api('/me/profile','PUT',{nicknameColor:'#66ccff'},user.token)).status,200);
  assert.equal((await viewer.next('profile')).nicknameColor,'#66CCFF');
  viewer.send({type:'send',channel:room.id,body:'must not be sent',nonce:'c'.repeat(32)});
  assert.equal((await viewer.next('error')).status,403);
  assert.equal((await api('/admin/chat/hide','PUT',{id:message.id,hidden:true})).status,200);
  const moderation=await viewer.next('moderation');assert.equal(moderation.id,message.id);assert.equal(moderation.hidden,true);
  assert.equal((await userSocket.next('history')).messages[0].body,'');
  viewer.send({type:'join',channel:room.id});let history=await viewer.next('history');assert.equal(history.messages[0].body,body);assert.equal(history.messages[0].hidden,1);
  let logs=(await api('/admin/chat/logs?channel='+room.id)).data.messages;assert.equal(logs.length,1);assert.equal(logs[0].body,body);
  let settings=(await api('/admin/chat/status')).data.settings;
  assert.equal((await api('/admin/chat/settings','PUT',{slowSeconds:30,dailyLimit:10000,expectedRevision:settings.revision})).status,200);assert.equal((await viewer.next('settings')).settings.slowSeconds,30);
  assert.equal((await api('/admin/chat/channels','PUT',{...room,members:[],active:false})).status,200);
  assert.equal((await viewer.next('channels')).channels.find(c=>c.id===room.id).active,0);
  viewer.send({type:'join',channel:room.id});history=await viewer.next('history');assert.equal(history.messages.length,1);
  viewer.send({type:'join',channel:'event:standard-100k'});assert.equal((await viewer.next('history')).channel,'event:standard-100k');
  viewer.send({type:'join',channel:'general'});await viewer.next('history');
  const notice=await api('/admin/chat/notice','POST',{channel:'general',body:'General message'});assert.equal(notice.status,200);
  assert.equal((await viewer.next('message')).message.body,'General message');
  viewer.ws.close();
  const reconnected=await connect('/admin/chat/socket?ticket='+await ticket());const hello=await reconnected.next('hello');
  assert.equal(hello.messages.at(-1).body,'General message');
  logs=(await api('/admin/chat/logs?channel='+room.id)).data.messages;assert.equal(logs[0].body,body);
  reconnected.ws.close();userSocket.ws.close();
});

test('expired tickets and credentials invalidated by key rotation never upgrade or receive data',async()=>{
  const room=Object.create(RankedChat.prototype);room.env={ADMIN_TOKEN:'new-key'};
  const credential=await sha256(encoder.encode('new-key')),url=new URL('https://chat.internal/viewer/socket?ticket='+'d'.repeat(64));
  let stored={expires:0,credential};room.rows=()=>[stored];
  await assert.rejects(room.viewerSocket(url),e=>e.status===401);
  stored={expires:Math.floor(Date.now()/1000)+60,credential:'old-key-hash'};
  await assert.rejects(room.viewerSocket(url),e=>e.status===401);
  await assert.rejects(room.authenticate({viewer:true,expires:Date.now()/1000+100,credential:'old-key-hash'}),e=>e.status===401);
  await assert.rejects(room.authenticate({viewer:true,expires:0,credential}),e=>e.status===401);
  await room.authenticate({viewer:true,expires:Date.now()/1000+100,credential});
  const peers=[{deserializeAttachment:()=>({viewer:true,checked:0})}];
  assert.equal(await room.authenticationSnapshot(peers,true),null,'Viewers must not query the player-account table');
});
