// Execute the browser script emitted by Wrangler, not just the original sources.
// A syntax-only check misses bundler helpers captured by Function.toString().
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Script,createContext} from 'node:vm';
import {root} from './common.mjs';

const {default:worker}=await import(pathToFileURL(path.join(root,'dist/index.js')));
const db={prepare(sql){
  assert.equal(sql,'SELECT version FROM schema_meta WHERE id=1');
  return {async first(){return {version:22};}};
}};
const response=await worker.fetch(new Request('https://admin.test/admin'),{DB:{withSession(){return db;}}});
assert.equal(response.status,200);
const html=await response.text(),script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script,'Missing administrator browser script');
const elements=new Map();
for(const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
  elements.set(match[2],{tagName:match[1].toUpperCase(),value:'',textContent:'',disabled:false,hidden:false,style:{},
    addEventListener(){},setAttribute(){},replaceChildren(){},append(){}});
}
const get=id=>{assert(elements.has(id),'Unknown DOM element: '+id);return elements.get(id);};
const document={getElementById:get,addEventListener(){},querySelectorAll(selector){
  if(selector==='button')return [...elements.values()].filter(e=>e.tagName==='BUTTON');
  if(selector==='#opEditor input,#opEditor select,#opList,#opNewName,#list')
    return ['opList','opNewName','list'].map(get);
  throw Error('Unexpected selector in runtime smoke check: '+selector);
}};
let fetchImpl=async()=>{throw Error('Unexpected request during initialization');};
const timers=new Map();let timerId=0,expireImmediately=false;
const context=createContext({document,window:{addEventListener(){}},console,AbortController,
  fetch:(...args)=>fetchImpl(...args),setInterval(){},
  setTimeout(fn,delay){assert.equal(delay,15000);const id=++timerId;timers.set(id,fn);
    if(expireImmediately)queueMicrotask(()=>{if(timers.has(id))fn();});return id;},
  clearTimeout(id){timers.delete(id);},structuredClone,URL,Blob,TextEncoder,TextDecoder});
const execute=code=>new Script(code).runInContext(context,{timeout:2000});
new Script(script,{filename:'bundled-admin-browser.js'}).runInContext(context,{timeout:2000});
for(const id of ['load','opLoad','activityRefresh','storageRefresh','chatLoad','chatRecent'])
  assert.equal(typeof get(id).onclick,'function','Missing initialized handler: '+id);
assert.equal(execute('typeof activityUi.load'),'function');
assert.equal(execute('typeof storageUi.loadOverview'),'function');

await execute('run(async()=>{throw Error("Simulated render error")})');
assert.equal(get('message').textContent,'Simulated render error');
assert.equal(get('load').disabled,false);assert.equal(get('token').disabled,false);
assert.equal(execute('busy'),false);

await execute('(()=>{const sync=activityUi.sync;activityUi.sync=()=>{activityUi.sync=sync;throw Error("Simulated control error")};return run(async()=>{throw Error("Must not start request")})})()');
assert.equal(get('message').textContent,'Simulated control error');
assert.equal(get('load').disabled,false);assert.equal(get('token').disabled,false);
assert.equal(execute('busy'),false);

fetchImpl=async()=>({ok:false,status:403,async json(){return {error:'Administrator authentication required'};}});
await get('load').onclick();
assert.equal(get('message').textContent,'Administrator authentication required');
assert.equal(get('load').disabled,false);assert.equal(get('token').disabled,false);
assert.equal(timers.size,0);

// A stalled request (including its response body) must release the interface.
expireImmediately=true;
fetchImpl=async(_url,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});
await get('load').onclick();
assert.match(get('message').textContent,/15초/);
assert.equal(get('load').disabled,false);assert.equal(get('token').disabled,false);
assert.equal(execute('busy'),false);assert.equal(timers.size,0);

fetchImpl=async(_url,{signal})=>({ok:true,async json(){
  if(signal.aborted)throw signal.reason;
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
}});
await execute('run(()=>api("/admin/test","PUT",{}))');
assert.match(get('message').textContent,/변경이 반영되었는지/);
assert.equal(get('load').disabled,false);assert.equal(get('token').disabled,false);
assert.equal(execute('busy'),false);assert.equal(timers.size,0);

// Keep these options explicit in both deployment paths: inline functions must
// retain their identifiers without depending on helpers in the Worker scope.
for(const file of ['wrangler.jsonc','wrangler.production.json']){
  let config;try{config=JSON.parse(await readFile(path.join(root,file),'utf8'));}
  catch(error){if(file==='wrangler.production.json'&&error.code==='ENOENT')continue;throw error;}
  assert.equal(config.keep_names,false,file+' must disable keep_names');
  assert.equal(config.minify,false,file+' must disable minification');
}
console.log('PASS bundled admin: all modules initialize; errors and 15-second timeouts release controls.');
