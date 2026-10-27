import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRelay,signed,relaySecret,relayUrl} from './google-relay-fixture.mjs';
import {sendAccountMail,recoveryAvailable} from '../src/account-mail.js';

test('relay has send-only permission and never adds identity or tracking fields',async()=>{
 const relay=createRelay(),request=signed({name:'Community Services',body:'An account code only'}),result=relay.post(request);
 assert.equal(result.ok,true);assert.equal(result.id,JSON.parse(request.payload).id);
 assert.deepEqual(Object.keys(relay.mail[0]).sort(),['body','name','subject','to']);
 assert.equal(relay.mail[0].body,'An account code only');assert.equal(relay.mail[0].name,'Community Services');
 assert.equal(relay.authorize(),99);assert.equal(relay.mail.length,1);
 const manifest=JSON.parse(await readFile(new URL('../../google-mail-relay/appsscript.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/script.send_mail']);
});

test('unsigned, altered, expired, future, malformed and multi-recipient mail is rejected',()=>{
 const relay=createRelay(),valid=signed();
 assert.equal(relay.post({...valid,signature:'00'.repeat(32)}).code,'unauthorized');
 assert.equal(relay.post({...valid,payload:valid.payload.replace('test@example.com','other@example.com')}).code,'unauthorized');
 for(const change of [{at:0},{at:Math.floor(Date.now()/1000)+60},{to:'one@example.com,two@example.com'},
  {subject:'hello\r\nBcc: other@example.com'},{name:'bad\nheader'},{body:'x'.repeat(16001)}])assert.equal(relay.post(signed(change)).ok,false);
 assert.equal(relay.post('x'.repeat(24001)).ok,false);
 assert.equal(relay.post('{bad json').ok,false);
 assert.equal(createRelay({RELAY_ENABLED:'false'}).post(valid).code,'disabled');
 assert.equal(relay.mail.length,0);
});

test('test deployment cannot send to arbitrary recipients or accidentally enable production',()=>{
 const relay=createRelay({PRODUCTION_ENABLED:'false'});
 assert.equal(relay.post(signed()).code,'test_only');
 relay.props.set('TEST_RECIPIENT','test@example.com');
 assert.equal(relay.post(signed({to:'other@example.com'})).code,'test_only');
 assert.equal(relay.post(signed()).ok,true);assert.equal(relay.mail.length,1);
});

test('replayed and ambiguously failed mail is never sent again and the lock is released',()=>{
 const relay=createRelay(),request=signed();
 assert.equal(relay.post(request).ok,true);assert.equal(relay.post(request).code,'duplicate');assert.equal(relay.mail.length,1);
 const ambiguous=signed();relay.throwAfterSend=true;
 assert.equal(relay.post(ambiguous).code,'send_failed');assert.equal(relay.locked,false);
 relay.throwAfterSend=false;assert.equal(relay.post(ambiguous).code,'duplicate');assert.equal(relay.mail.length,2);
 relay.locked=true;assert.equal(relay.post(signed()).code,'busy');assert.equal(relay.mail.length,2);
});

test('relay enforces both rolling 80-send budget and actual Google quota',()=>{
 const relay=createRelay();for(let i=0;i<80;i++)assert.equal(relay.post(signed()).ok,true);
 assert.equal(relay.post(signed()).code,'daily_limit');assert.equal(relay.mail.length,80);
 const expired=JSON.parse(relay.props.get('MAIL_STATE'));expired.forEach(x=>x[1]-=86401);relay.props.set('MAIL_STATE',JSON.stringify(expired));
 relay.quota=0;assert.equal(relay.post(signed()).code,'daily_limit');
 relay.quota=1;assert.equal(relay.post(signed()).ok,true);assert.equal(relay.mail.length,81);
});

const env={EMAIL_RECOVERY_ENABLED:'true',EMAIL_RELAY_URL:relayUrl,EMAIL_RELAY_SECRET:relaySecret};
const db={prepare(){return {bind(){return this;},async run(){},async all(){return {results:[{id:'reserved'}]};}};}};
test('Worker follows only Google receipt redirects without forwarding signed credentials',async()=>{
 const original=globalThis.fetch,relay=createRelay();let result,calls=0;
 try{
  globalThis.fetch=async(url,options)=>{
   calls++;
   if(calls===1){assert.equal(url,relayUrl);assert.equal(options.method,'POST');result=relay.post(JSON.parse(options.body));return new Response(null,{status:302,headers:{Location:'https://script.googleusercontent.com/macros/echo?receipt=test'}});}
   assert.equal(url,'https://script.googleusercontent.com/macros/echo?receipt=test');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
   assert.deepEqual(options.headers,{Accept:'application/json'});assert.equal(options.redirect,'manual');return Response.json(result);
  };
  await sendAccountMail(env,db,'test@example.com','Verify','12345678');assert.equal(calls,2);assert.equal(relay.mail.length,1);
 }finally{globalThis.fetch=original;}
});

test('Worker rejects wrong destinations, login HTML, wrong receipts and provider quota',async()=>{
 assert.equal(recoveryAvailable({...env,EMAIL_RELAY_URL:'https://attacker.invalid/exec'}),false);
 assert.equal(recoveryAvailable({...env,EMAIL_RELAY_URL:relayUrl+'?secret=unsafe'}),false);
 const original=globalThis.fetch;
 try{
  for(const location of ['https://attacker.invalid/steal','https://accounts.google.com/login','http://script.googleusercontent.com/echo']){
   let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{Location:location}});};
   await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===503);assert.equal(calls,1);
  }
  globalThis.fetch=async()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}});
  await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===503);
  let redirects=0;globalThis.fetch=async()=>{redirects++;return new Response(null,{status:302,headers:{Location:'https://script.googleusercontent.com/echo'}});};
  await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===503);assert.equal(redirects,2);
  globalThis.fetch=async()=>Response.json({ok:true,id:'wrong'});
  await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===503);
  globalThis.fetch=async()=>Response.json({ok:true,oversize:'x'.repeat(5000)});
  await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===503);
  globalThis.fetch=async(url,options)=>Response.json({ok:false,id:JSON.parse(JSON.parse(options.body).payload).id,code:'daily_limit'});
  await assert.rejects(()=>sendAccountMail(env,db,'test@example.com','Verify','code'),e=>e.status===429);
 }finally{globalThis.fetch=original;}
});
