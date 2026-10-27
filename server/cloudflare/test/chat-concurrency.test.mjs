import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RankedChat} from '../src/chat-room.js';

const now=()=>Math.floor(Date.now()/1000);
function socket(id,checked=now()) {
  let attachment={id,name:id,channel:'general',checked,expires:now()+3600,revision:1,version:'0.7.1',tokens:8,lastAction:Date.now(),strikes:0};
  return {sent:[],closed:0,deserializeAttachment:()=>({...attachment}),serializeAttachment:a=>{attachment=a;},
    send(raw){this.sent.push(JSON.parse(raw));},close(){this.closed++;}};
}
// Delay the external profile notification so two sockets reach the same await.
function sendingRoom({slowSeconds=30,dailyLimit=10000}={}) {
  const room=Object.create(RankedChat.prototype), messages=[];
  room.channel=()=>({});room.settings=()=>({slowSeconds,dailyLimit,capacityBytes:800000000});
  room.latest=owner=>messages.filter(m=>m.owner===owner).at(-1)?.created??0;
  room.today=()=>({count:messages.length});room.size=()=>0;
  room.rows=(sql,...args)=>sql.includes('nonce=?')?messages.filter(m=>m.owner===args[0]&&m.nonce===args[1]):[];
  room.broadcast=async()=>{};
  let arrivals=0,release;const gate=new Promise(resolve=>release=resolve);
  room.syncProfile=async()=>{if(++arrivals===2)release();await gate;};
  room.append=(channel,owner,name,body,created,nonce)=>{if(messages.some(m=>m.owner===owner&&m.nonce===nonce))throw Error('UNIQUE(owner,nonce)');const m={id:messages.length+1,channel,owner,name,body,created,nonce};messages.push(m);return m;};
  return {room,messages};
}
const send=(room,ws,nonce,body='simultaneous message')=>room.handleMessage(ws,JSON.stringify({type:'send',channel:'general',nonce:nonce.repeat(32),body}));
test('simultaneous sockets cannot bypass the account-wide chat cooldown',async()=>{
  const {room,messages}=sendingRoom(),a=socket('same'),b=socket('same');
  await Promise.all([send(room,a,'a'),send(room,b,'b')]);
  assert.equal(messages.length,1);assert.equal([...a.sent,...b.sent].filter(m=>m.status===429).length,1);
});
test('simultaneous senders cannot exceed the shared daily chat allowance',async()=>{
  const {room,messages}=sendingRoom({slowSeconds:0,dailyLimit:1}),a=socket('a'),b=socket('b');
  await Promise.all([send(room,a,'a'),send(room,b,'b')]);
  assert.equal(messages.length,1);assert.equal([...a.sent,...b.sent].filter(m=>m.status===429).length,1);
});
test('simultaneous retries with the same nonce acknowledge one durable message',async()=>{
  const {room,messages}=sendingRoom(),a=socket('same'),b=socket('same');
  await Promise.all([send(room,a,'a'),send(room,b,'a')]);
  assert.equal(messages.length,1);assert.equal([...a.sent,...b.sent].filter(m=>m.type==='ack').length,2);
});
test('200 stale chat sessions receive a broadcast within a 50-query D1 budget',async()=>{
  const room=Object.create(RankedChat.prototype),peers=Array.from({length:200},(_,i)=>socket('user'+i,0));
  let queries=0;
  const user=id=>({id,name:id,nickname_color:null,auth_revision:1,token_expires:now()+3600});
  const check=()=>{assert(++queries<=50,'D1 query allowance exceeded');};
  const db={withSession(){return this;},prepare(sql){let args=[];return {
    bind(...values){args=values;return this;},
    async first(){check();return sql.includes('client_policy')?{minimum_version:'0.7.1',minimum_protocol:1,revision:1}:user(args[0]);},
    async all(){check();return {results:args.map(user)};}
  };}};
  room.env={DB:db};room.ctx={getWebSockets:()=>peers};room.channel=()=>({});
  await room.broadcast('general',{type:'message',message:{body:'hello'}});
  assert.equal(peers.filter(ws=>ws.sent.length===1).length,200);
  assert.equal(peers.reduce((sum,ws)=>sum+ws.closed,0),0);assert(queries<=4);
});
test('batched revalidation still rejects revoked, deleted, expired and outdated sessions',async()=>{
  const room=Object.create(RankedChat.prototype),peers=['good','revoked','deleted','expired','old'].map(id=>socket(id,0));
  peers[3].serializeAttachment({...peers[3].deserializeAttachment(),expires:0});
  peers[4].serializeAttachment({...peers[4].deserializeAttachment(),version:'0.6.16'});
  const db={withSession(){return this;},prepare(){let ids=[];return {
    bind(...values){ids=values;return this;},
    async first(){return {minimum_version:'0.7.1',minimum_protocol:1,revision:1};},
    async all(){return {results:ids.filter(id=>id!=='deleted').map(id=>({id,name:id,nickname_color:null,auth_revision:id==='revoked'?2:1,token_expires:now()+3600}))};}
  };}};
  room.env={DB:db};room.ctx={getWebSockets:()=>peers};room.channel=()=>({});
  await room.broadcast('general',{type:'message'});
  assert.equal(peers[0].sent.length,1);assert.equal(peers[0].closed,0);
  for(const ws of peers.slice(1)){assert.equal(ws.sent.length,0);assert.equal(ws.closed,1);}
});
test('event membership is refreshed before delivering to an existing subscription',async()=>{
  const room=Object.create(RankedChat.prototype),ws=socket('removed');let allowed=true;
  ws.serializeAttachment({...ws.deserializeAttachment(),channel:'event:cup'});
  room.ctx={getWebSockets:()=>[ws]};room.syncEvents=async()=>{allowed=false;};
  room.channel=()=>{if(!allowed)throw Error('Membership removed');};
  await room.broadcast('event:cup',{type:'message'});
  assert.equal(ws.sent.length,0);assert.equal(ws.closed,1);
});
