import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkedResult,resultPolicy} from '../src/battle-outcome.js';
const cases=JSON.parse(await readFile(new URL('./material-outcomes.json',import.meta.url),'utf8'));
const ticket={resultPolicy,duration:600};
const balance=([vehicle,supply])=>({vehicle,supply,total:Math.round((vehicle+supply)*1000)/1000});
for(const c of cases)test('material decision: '+c.name,()=>{
 const body={score:c.score,outcome:{kind:c.kind,remaining:c.health,eliminated:c.gone,seconds:c.seconds,
  materials:c.values.map((v,i)=>balance(c.gone[i]?[0,0]:v))}};
 assert.deepEqual(checkedResult(ticket,body),body);
});
test('material result rejects missing, nonfinite, negative, excess precision, wrong totals and health-only victory',()=>{
 const good={score:1,outcome:{kind:'judgment',remaining:[.1,.9],eliminated:[false,false],seconds:600,materials:[balance([50000,100]),balance([20000,200])]}};
 for(const materials of [undefined,[],[good.outcome.materials[0]],
  [{vehicle:NaN,supply:100,total:50100},good.outcome.materials[1]],
  [{vehicle:50000,supply:-1,total:49999},good.outcome.materials[1]],
  [{vehicle:50000,supply:100,total:99999},good.outcome.materials[1]],
  [{vehicle:50000.0001,supply:100,total:50100},good.outcome.materials[1]]])
   assert.throws(()=>checkedResult(ticket,{...good,outcome:{...good.outcome,materials}}),e=>e.status===400);
 assert.throws(()=>checkedResult(ticket,{...good,score:0}),e=>e.status===400);
 assert.throws(()=>checkedResult(ticket,{...good,outcome:{...good.outcome,seconds:599.999}}),e=>e.status===400);
 assert.throws(()=>checkedResult({duration:600,resultPolicy:'total-health-v1'},good),e=>e.status===400);
});
