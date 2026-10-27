import {readFileSync} from 'node:fs';
import {createHmac,randomBytes} from 'node:crypto';
import vm from 'node:vm';
export const relaySecret='ab'.repeat(32);
export const relayUrl='https://script.google.com/macros/s/local-test-deployment-00000000/exec';
const source=readFileSync(new URL('../../google-mail-relay/Code.gs',import.meta.url),'utf8');
export function signed(message,secret=relaySecret){
 const payload=JSON.stringify({v:1,id:randomBytes(16).toString('hex'),at:Math.floor(Date.now()/1000),to:'test@example.com',subject:'Account verification',body:'Test-only content',name:'Community Services',...message});
 return {payload,signature:createHmac('sha256',secret).update(payload).digest('hex')};
}
export function createRelay(properties={}){
 const props=new Map(Object.entries({RELAY_ENABLED:'true',RELAY_SECRET:relaySecret,PRODUCTION_ENABLED:'true',...properties}));
 const state={props,mail:[],quota:100,locked:false,throwAfterSend:false};
 const sandbox={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)??null,setProperty:(k,v)=>props.set(k,v)})},
  ContentService:{MimeType:{JSON:'application/json'},createTextOutput:body=>({body,setMimeType(){return this;}})},
  Utilities:{Charset:{UTF_8:'UTF-8'},computeHmacSha256Signature:(payload,secret)=>Array.from(createHmac('sha256',secret).update(payload).digest(),b=>b>127?b-256:b)},
  MailApp:{getRemainingDailyQuota:()=>state.quota,sendEmail:message=>{state.mail.push(JSON.parse(JSON.stringify(message)));state.quota--;if(state.throwAfterSend)throw new Error('simulated ambiguous send');}},
  LockService:{getScriptLock:()=>({tryLock:()=>{if(state.locked)return false;state.locked=true;return true;},releaseLock:()=>{state.locked=false;}})}};
 vm.createContext(sandbox);vm.runInContext(source,sandbox,{timeout:1000});
 state.post=envelope=>JSON.parse(sandbox.doPost({postData:{contents:typeof envelope==='string'?envelope:JSON.stringify(envelope)}}).body);
 state.authorize=()=>sandbox.authorizeMail();
 return state;
}
