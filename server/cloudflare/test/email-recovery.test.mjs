import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from '../tools/migration-statements.mjs';
import worker from '../src/index.js';
import {sendAccountMail} from '../src/account-mail.js';
import {createRelay,relaySecret,relayUrl} from './google-relay-fixture.mjs';
let mf,db,env,mail=[],rejectMail=false,sequence=0,beforeMailReturn=null;
let relay;
const originalFetch=globalThis.fetch;
const root=fileURLToPath(new URL('..',import.meta.url));
const password='test-only-password-2026';
before(async()=>{
 const directory=path.resolve(root,'../../.runtime/email-tests-'+randomUUID());await mkdir(directory,{recursive:true});
 mf=new Miniflare({...convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local-test")}}',compatibilityDate:'2026-10-22',d1Databases:{DB:'email-local-test'}}),resourcePersistencePath:directory});
 db=await mf.getD1Database('DB');
 for(const name of (await readdir(path.join(root,'migrations'))).filter(f=>f.endsWith('.sql')).sort())
  await db.batch(migrationStatements(await readFile(path.join(root,'migrations',name),'utf8')).map(s=>db.prepare(s)));
 env={DB:db,AUTH_PEPPER:'isolated-email-test-pepper-never-use-in-production',REGISTRATION_OPEN:'true',DEFAULT_OPPONENTS:'false',MAX_ACCOUNTS:'1000',
  EMAIL_RECOVERY_ENABLED:'true',EMAIL_RELAY_URL:relayUrl,EMAIL_RELAY_SECRET:relaySecret};
 // No real email is sent. Any unexpected outbound request fails the test.
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,relayUrl);assert.equal(options.redirect,'manual');
  if(rejectMail)return new Response('rejected',{status:503});
  const result=relay.post(JSON.parse(options.body));if(beforeMailReturn)await beforeMailReturn();return Response.json(result);
 };
});
after(async()=>{globalThis.fetch=originalFetch;if(mf)await mf.dispose();});
beforeEach(async()=>{
 relay=createRelay();mail=relay.mail;rejectMail=false;beforeMailReturn=null;
 await db.batch(['DELETE FROM email_recovery_grants','DELETE FROM email_request_windows','DELETE FROM email_send_budget','DELETE FROM email_challenges','DELETE FROM auth_attempts','DELETE FROM accounts'].map(s=>db.prepare(s)));
});
async function api(path,body={},session=null,status=200,environment=env){
 const r=await worker.fetch(new Request('https://rank.test'+path,{method:path==='/me'?'GET':'POST',headers:{'Content-Type':'application/json',
  'X-FTD-Rank-Version':'0.7.5','X-FTD-Rank-Protocol':'1',...(session?{Authorization:'Bearer '+session.token}:{})},...(path==='/me'?{}:{body:JSON.stringify(body)})}),environment);
 const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;
}
const register=()=>api('/auth/register',{username:'email_user_'+(++sequence),nickname:'Email User '+sequence,password});
const latestCode=()=>mail.at(-1).body.match(/^\d{8}$/m)?.[0];
async function allowRequest(){await db.batch([db.prepare('DELETE FROM email_request_windows'),db.prepare('UPDATE email_challenges SET created=created-61')]);}
async function link(a,email){const start=await api('/auth/email/request',{email,password},a);return api('/auth/email/verify',{email,challengeId:start.challengeId,code:latestCode()},a);}
async function recover(email){await allowRequest();const start=await api('/auth/recovery/request',{email});return api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:latestCode()});}

test('existing accounts link and replace email only after current password and verification',async()=>{
 const a=await register();assert.equal(a.auth.recoveryEmail,null);
 await api('/auth/email/request',{email:'first@example.com',password:'wrong-password'},a,401);assert.equal(mail.length,0);
 const first=await link(a,'first@example.com');assert.equal(first.auth.recoveryEmail,'first@example.com');assert(first.auth.emailVerified);
 await allowRequest();const change=await api('/auth/email/request',{email:'second@example.com',password},a),correct=latestCode();
 assert.equal((await api('/me',{},a)).auth.recoveryEmail,'first@example.com');
 await api('/auth/email/verify',{email:'second@example.com',challengeId:change.challengeId,code:correct==='00000000'?'00000001':'00000000'},a,400);
 assert.equal((await api('/me',{},a)).auth.recoveryEmail,'first@example.com');
 await api('/auth/email/verify',{email:'second@example.com',challengeId:change.challengeId,code:correct},a);
 assert.equal((await api('/me',{},a)).auth.recoveryEmail,'second@example.com');
 await allowRequest();const sentBefore=mail.length;await api('/auth/recovery/request',{email:'first@example.com'});assert.equal(mail.length,sentBefore);
 const rows=JSON.stringify((await db.prepare('SELECT * FROM email_challenges').all()).results);assert(!rows.includes(correct));
});
test('account finding reveals usernames only after verifying the linked email',async()=>{
 const a=await register(),b=await register(),email='shared@example.com';
 await link(a,email);await allowRequest();await link(b,email);await allowRequest();
 const start=await api('/auth/recovery/request',{email});assert.deepEqual(Object.keys(start).sort(),['challengeId','expiresIn','sent']);
 assert.equal(mail.at(-1).to,email);assert(!mail.at(-1).body.includes(a.auth.username));
 const granted=await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:latestCode()});
 assert.deepEqual(granted.accounts.map(x=>x.username).sort(),[a.auth.username,b.auth.username].sort());
 await api('/auth/recovery/reset',{email,recoveryToken:granted.recoveryToken,accountId:'someone-else'},null,400);
 const before=mail.length;await api('/auth/recovery/request',{email:'unregistered@example.com'});assert.equal(mail.length,before);
 await api('/auth/recovery/request',{email:'unregistered@example.com'},null,429);
});
test('verified recovery sends a temporary password, revokes old login, and requires a new password',async()=>{
 const a=await register(),email='reset@example.com';await link(a,email);const grant=await recover(email);
 const result=await api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id});
 assert.deepEqual(result,{reset:true,temporaryPasswordSent:true});assert.equal(mail.at(-1).to,email);
 const temporary=mail.at(-1).body.match(/^[a-f0-9]{32}$/m)?.[0];assert(temporary);
 assert(!JSON.stringify(await db.prepare('SELECT * FROM accounts').first()).includes(temporary));
 await api('/me',{},a,401);
 await api('/auth/login',{username:a.auth.username,password},null,401);
 const login=await api('/auth/login',{username:a.auth.username,password:temporary});assert(login.auth.passwordResetRequired);
 assert((await api('/me',{},login)).auth.passwordResetRequired);
 await api('/tournaments/standard-100k/matches',{},login,403);
 await api('/auth/password',{password:temporary,newPassword:temporary},login,400);
 const changed=await api('/auth/password',{password:temporary,newPassword:'new-private-password'},login);assert.equal(changed.auth.passwordResetRequired,false);
 await api('/me',{},login,401);await api('/me',{},changed);
 await api('/auth/login',{username:a.auth.username,password:'new-private-password'});
 await api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id},null,400);
});
test('bad, expired, replayed and cross-address codes cannot grant recovery',async()=>{
 const a=await register(),email='code@example.com';await link(a,email);await allowRequest();
 let start=await api('/auth/recovery/request',{email}),correct=latestCode(),wrong=correct==='00000000'?'00000001':'00000000';
 await api('/auth/recovery/verify',{email:'different@example.com',challengeId:start.challengeId,code:correct},null,400);
 for(let i=0;i<5;i++)await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:wrong},null,400);
 await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:correct},null,400);
 await allowRequest();start=await api('/auth/recovery/request',{email});correct=latestCode();
 await db.prepare('UPDATE email_challenges SET expires=0 WHERE id=?').bind(start.challengeId).run();
 await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:correct},null,400);
 await allowRequest();start=await api('/auth/recovery/request',{email});correct=latestCode();
 const granted=await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:correct});
 await api('/auth/recovery/verify',{email,challengeId:start.challengeId,code:correct},null,400);
 await db.prepare('UPDATE email_recovery_grants SET expires=0').run();
 await api('/auth/recovery/reset',{email,recoveryToken:granted.recoveryToken,accountId:a.account.id},null,400);
});
test('provider failure and concurrent credential changes never overwrite a working password',async()=>{
 const a=await register(),email='failure@example.com';await link(a,email);let grant=await recover(email);
 rejectMail=true;await api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id},null,503);
 await api('/me',{},a);assert.equal((await db.prepare('SELECT password_reset_required FROM accounts').first()).password_reset_required,0);
 rejectMail=false;grant=await recover(email);
 const changed=await api('/auth/password',{password,newPassword:'changed-before-reset'},a);
 const before=mail.length;await api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id},null,409);
 assert.equal(mail.length,before);await api('/me',{},changed);
});
test('only one concurrent reset can consume a recovery grant',async()=>{
 const a=await register(),email='race@example.com';await link(a,email);const grant=await recover(email),before=mail.length;
 const request=()=>worker.fetch(new Request('https://rank.test/auth/recovery/reset',{method:'POST',headers:{'Content-Type':'application/json','X-FTD-Rank-Version':'0.7.5','X-FTD-Rank-Protocol':'1'},
  body:JSON.stringify({email,recoveryToken:grant.recoveryToken,accountId:a.account.id})}),env);
 const responses=await Promise.all([request(),request()]);assert.equal(responses.filter(r=>r.status===200).length,1);
 assert.equal(mail.length,before+1);assert(responses.some(r=>[400,409].includes(r.status)));
});
test('a delayed accepted email cannot overwrite a newer password',async()=>{
 const a=await register(),email='delayed@example.com';await link(a,email);const grant=await recover(email);
 let started,release;const sending=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{release=resolve;});
 beforeMailReturn=async()=>{started();await hold;};
 const reset=api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id},null,409);
 await sending;
 try {const changed=await api('/auth/password',{password,newPassword:'newer-private-password'},a);await api('/me',{},changed);}
 finally {beforeMailReturn=null;release();}
 await reset;await api('/auth/login',{username:a.auth.username,password:'newer-private-password'});
});
test('temporary credentials expire without preventing another email recovery',async()=>{
 const a=await register(),email='expired-password@example.com';await link(a,email);const grant=await recover(email);
 await api('/auth/recovery/reset',{email,recoveryToken:grant.recoveryToken,accountId:a.account.id});
 const temporary=mail.at(-1).body.match(/^[a-f0-9]{32}$/m)[0];
 await db.prepare('UPDATE accounts SET password_reset_expires=0 WHERE id=?').bind(a.account.id).run();
 const rejected=await api('/auth/login',{username:a.auth.username,password:temporary},null,401);assert.equal(rejected.error,'Recovery.ExpiredPassword');
 const again=await recover(email);assert.equal(again.accounts[0].id,a.account.id);
});
test('free service has a hard rolling 80-send ceiling and fails closed without configuration',async()=>{
 await api('/auth/recovery/request',{email:'anything@example.com'},null,503,{...env,EMAIL_RECOVERY_ENABLED:'false'});
 const timestamp=Date.now()/1000;
 await db.batch(Array.from({length:79},(_,i)=>db.prepare('INSERT INTO email_send_budget VALUES(?,?)').bind('quota-'+i,timestamp)));
 const results=await Promise.allSettled([sendAccountMail(env,db,'one@example.com','Test','Text'),sendAccountMail(env,db,'two@example.com','Test','Text')]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,429);
 assert.equal(mail.length,1);assert.equal((await db.prepare('SELECT count(*) n FROM email_send_budget').first()).n,80);
});
