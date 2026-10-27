import {ApiError,encoder,now,randomId} from './shared.js';
const endpoint=/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const recoveryAvailable=env=>env.EMAIL_RECOVERY_ENABLED==='true' && endpoint.test(env.EMAIL_RELAY_URL??'') && /^[a-f0-9]{64}$/.test(env.EMAIL_RELAY_SECRET??'');
export function requireRecovery(env){if(!recoveryAvailable(env))throw new ApiError(503,'Recovery.Unavailable');}
async function signature(secret,payload){
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signed=await crypto.subtle.sign('HMAC',key,encoder.encode(payload));
 return Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,'0')).join('');
}
async function receipt(response){
 if(response.status!==200 || !response.headers.get('Content-Type')?.includes('application/json')){await response.body?.cancel();throw new Error('invalid relay response');}
 const reader=response.body?.getReader();if(!reader)throw new Error('missing relay response');
 const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)throw new Error('large relay response');chunks.push(value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
export async function sendAccountMail(env,db,email,subject,text){
 requireRecovery(env);
 const timestamp=now(),id=randomId();
 // A conservative hard ceiling below consumer MailApp's 100 recipients/day.
 // Failed or ambiguous attempts keep their reservation; no paid provider fallback.
 await db.prepare('DELETE FROM email_send_budget WHERE created<?').bind(timestamp-90000).run();
 const reserved=await db.prepare(`INSERT INTO email_send_budget(id,created)
  SELECT ?,? WHERE (SELECT count(*) FROM email_send_budget WHERE created>?)<80 RETURNING id`)
  .bind(id,timestamp,timestamp-86400).all();
 if(!reserved.results.length)throw new ApiError(429,'Recovery.DailyLimit');
 const payload=JSON.stringify({v:1,id,at:Math.floor(timestamp),to:email,subject,body:text,
  name:env.EMAIL_FROM_NAME?.trim() || 'Community Services'});
 let stage='request',httpStatus=null,contentType=null,relayCode=null;
 try{
  const signal=AbortSignal.timeout(20000);
  let response=await fetch(env.EMAIL_RELAY_URL,{method:'POST',redirect:'manual',signal,
   headers:{'Content-Type':'application/json','Accept':'application/json'},
   body:JSON.stringify({payload,signature:await signature(env.EMAIL_RELAY_SECRET,payload)})});
  // ContentService redirects to a one-time Google-hosted receipt. Never forward the body.
  if([302,303].includes(response.status)){
   stage='redirect';
   const location=response.headers.get('Location');await response.body?.cancel();
   const next=new URL(location??'');
   if(next.protocol!=='https:'||next.hostname!=='script.googleusercontent.com'||next.port||next.username||next.password)throw new Error('untrusted redirect');
   // Workers supports only follow/manual. A second redirect fails the receipt's 200 check.
   response=await fetch(next.href,{method:'GET',redirect:'manual',signal,headers:{Accept:'application/json'}});
  }
  stage='receipt';httpStatus=response.status;contentType=response.headers.get('Content-Type');
  const result=await receipt(response);relayCode=typeof result.code==='string'?result.code:null;
  if(result.id!==id)throw new Error('wrong receipt');
  if(result.ok!==true){if(result.code==='daily_limit')throw new ApiError(429,'Recovery.DailyLimit');throw new Error('relay rejected');}
 }catch(error){
  if(error instanceof ApiError && error.message==='Recovery.DailyLimit')throw error;
  const safeReasons=['invalid relay response','missing relay response','large relay response','untrusted redirect','wrong receipt','relay rejected'];
  console.warn('AccountMailFailure',JSON.stringify({stage,httpStatus,contentType,relayCode,reason:safeReasons.includes(error?.message)?error.message:error?.name??'Error'}));
  throw new ApiError(503,'Recovery.SendFailed');
 }
}
