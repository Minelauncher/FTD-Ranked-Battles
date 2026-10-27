import {ApiError,encoder,json,now,randomId,readJson,sha256} from './shared.js';
import {account,authInfo,credentials,session,mac,throttle,verifyCurrentPassword} from './auth.js';
import {requireRecovery,sendAccountMail} from './account-mail.js';
const routes=new Set(['/auth/email/request','/auth/email/verify','/auth/recovery/request','/auth/recovery/verify','/auth/recovery/reset']);
function email(value){
 const result=typeof value==='string'?value.trim().toLowerCase():'';
 if(result.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(result))throw new ApiError(400,'Recovery.InvalidEmail');
 return result;
}
const bearer=r=>(r.headers.get('Authorization')||'').replace(/^Bearer /,'');
const code=()=>String(new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0)%100000000).padStart(8,'0');
const codeHash=(env,id,value)=>mac(env,'email-code-v1:'+id+':'+value);

export async function recoveryRoute(request,env,db,path){
 if(!routes.has(path))return null;
 if(request.method!=='POST')throw new ApiError(405,'Recovery.InvalidRequest');
 const url=new URL(request.url);
 if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new ApiError(400,'Recovery.InvalidRequest');
 requireRecovery(env);
 const data=await readJson(request,4096),link=path.startsWith('/auth/email/'),verify=path.endsWith('/verify'),reset=path.endsWith('/reset');
 const own=link?await account(db,bearer(request)):null;
 const target=email(data.email),name=link?own.username:target;
 await throttle(request,env,db,name,path);
 const purpose=link?'link':'recover',timestamp=now();
 if(reset)return resetFromGrant(data,env,db,target,timestamp);
 if(!verify){
  // Linking/replacing recovery email requires the current password as well as the session.
  if(link)await verifyCurrentPassword(env,own,data.password);
  // Apply the same one-minute response budget even for unregistered addresses.
  // Repeated requests must not reveal whether an email is linked.
  const requestKey=await mac(env,'email-request:'+target);
  await db.prepare('DELETE FROM email_request_windows WHERE last<?').bind(timestamp-86400).run();
  const window=await db.prepare(`INSERT INTO email_request_windows(key,last) VALUES(?,?) ON CONFLICT(key)
   DO UPDATE SET last=excluded.last WHERE email_request_windows.last<=? RETURNING key`).bind(requestKey,timestamp,timestamp-60).all();
  if(!window.results.length)throw new ApiError(429,'Recovery.Wait');
  const a=own || await db.prepare(`SELECT id FROM accounts WHERE recovery_email=? AND email_verified_at IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM system_opponents WHERE owner=accounts.id) LIMIT 1`).bind(target).first();
  const id=randomId(),value=code();
  // Identical public response for unknown account/email combinations.
  if(!a)return json({challengeId:id,sent:true,expiresIn:600});
  await db.prepare('DELETE FROM email_challenges WHERE expires<?').bind(timestamp-86400).run();
  const inserted=await db.prepare(`INSERT INTO email_challenges(id,owner,purpose,email,code_hash,auth_revision,created,expires)
   SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM email_challenges WHERE email=? AND created>?) RETURNING id`)
   .bind(id,link?a.id:null,purpose,target,await codeHash(env,id,value),link?a.auth_revision:0,timestamp,timestamp+600,target,timestamp-60).all();
  if(!inserted.results.length)throw new ApiError(429,'Recovery.Wait');
  try{await sendAccountMail(env,db,target,'Ranked Battles — verification code',
   `Your Ranked Battles ${link?'email verification':'account recovery'} code is:\n\n${value}\n\nIt expires in 10 minutes. Never share this code. If you did not request it, ignore this email.`);}
  catch(error){await db.prepare('DELETE FROM email_challenges WHERE id=?').bind(id).run();throw error;}
  return json({challengeId:id,sent:true,expiresIn:600});
 }
 if(!/^[a-f0-9]{32}$/.test(data.challengeId)||typeof data.code!=='string'||!/^\d{8}$/.test(data.code))throw new ApiError(400,'Recovery.InvalidCode');
 // Count attempts atomically before checking the code, and bind to account, purpose and email.
 const attempts=await db.prepare(`UPDATE email_challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND email=?
  AND consumed IS NULL AND expires>? AND attempts<5 AND (?='recover' OR owner=?) RETURNING *`)
  .bind(data.challengeId,purpose,target,timestamp,purpose,own?.id??'').all();
 const challenge=attempts.results[0];
 if(!challenge || (link && challenge.owner!==own.id) || challenge.code_hash!==await codeHash(env,challenge.id,data.code))throw new ApiError(400,'Recovery.InvalidCode');
 const claimed=await db.prepare(`UPDATE email_challenges SET consumed=? WHERE id=? AND consumed IS NULL
  AND (?='recover' OR EXISTS(SELECT 1 FROM accounts WHERE id=email_challenges.owner AND auth_revision=email_challenges.auth_revision)) RETURNING *`)
  .bind(timestamp,challenge.id,purpose).all();
 if(!claimed.results.length)throw new ApiError(409,'Recovery.Stale');
 if(link){
  const updated=await db.prepare(`UPDATE accounts SET recovery_email=?,email_verified_at=?,auth_revision=auth_revision+1
   WHERE id=? AND auth_revision=? AND token_hash=? RETURNING *`).bind(target,timestamp,own.id,challenge.auth_revision,own.token_hash).all();
  if(!updated.results.length)throw new ApiError(409,'Recovery.Stale');
  return json({verified:true,auth:authInfo(updated.results[0])});
 }
 const accounts=(await db.prepare(`SELECT id,username,name,auth_revision FROM accounts WHERE recovery_email=? AND email_verified_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM system_opponents WHERE owner=accounts.id) ORDER BY username LIMIT 1000`).bind(target).all()).results;
 const recoveryToken=randomId()+randomId(),digest=await sha256(encoder.encode(recoveryToken));
 await db.prepare('DELETE FROM email_recovery_grants WHERE expires<?').bind(timestamp).run();
 await db.prepare('INSERT INTO email_recovery_grants(token_hash,email,accounts,expires) VALUES(?,?,?,?)')
  .bind(digest,target,JSON.stringify(accounts),timestamp+300).run();
 return json({verified:true,recoveryToken,expiresIn:300,accounts:accounts.map(a=>({id:a.id,username:a.username,nickname:a.name}))});
}
async function resetFromGrant(data,env,db,target,timestamp){
 if(typeof data.recoveryToken!=='string'||! /^[a-f0-9]{64}$/.test(data.recoveryToken)||typeof data.accountId!=='string')throw new ApiError(400,'Recovery.InvalidCode');
 const digest=await sha256(encoder.encode(data.recoveryToken));
 const grant=await db.prepare('SELECT * FROM email_recovery_grants WHERE token_hash=? AND email=? AND consumed IS NULL AND expires>?').bind(digest,target,timestamp).first();
 const chosen=grant && JSON.parse(grant.accounts).find(a=>a.id===data.accountId);
 if(!chosen)throw new ApiError(400,'Recovery.InvalidCode');
 const claim=await db.prepare(`UPDATE email_recovery_grants SET consumed=? WHERE token_hash=? AND consumed IS NULL
  AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND auth_revision=? AND recovery_email=? AND email_verified_at IS NOT NULL) RETURNING token_hash`)
  .bind(timestamp,digest,chosen.id,chosen.auth_revision,target).all();
 if(!claim.results.length)throw new ApiError(409,'Recovery.Stale');
 const temporaryPassword=randomId(),c=await credentials(env,temporaryPassword),s=await session();
 // Do not change the working password if the provider rejects/fails the send.
 // CAS below also prevents a delayed response from overwriting a concurrent password/email change.
 await sendAccountMail(env,db,target,'Ranked Battles — temporary password',
  `Your Ranked Battles username: ${chosen.username}\n\nYour temporary password is:\n\n${temporaryPassword}\n\nSign in within 24 hours and choose a new password. Your previous sessions will be signed out. Never share this password.`);
 const changed=await db.prepare(`UPDATE accounts SET password_salt=?,password_hash=?,password_reset_required=1,password_reset_expires=?,
  token_hash=?,token_expires=0,auth_revision=auth_revision+1 WHERE id=? AND auth_revision=? AND recovery_email=? RETURNING id`)
  .bind(c.salt,c.hash,timestamp+86400,s.hash,chosen.id,chosen.auth_revision,target).all();
 if(!changed.results.length)throw new ApiError(409,'Recovery.Stale');
 const loginKey=await mac(env,`rate:/auth/login:user:${chosen.username}`);
 await db.prepare('DELETE FROM auth_attempts WHERE key=?').bind(loginKey).run();
 return json({reset:true,temporaryPasswordSent:true});
}
