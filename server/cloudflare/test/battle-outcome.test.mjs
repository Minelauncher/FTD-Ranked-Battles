import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkedResult, healthPolicy as resultPolicy } from '../src/battle-outcome.js';

const cases = JSON.parse(await readFile(new URL('./health-outcomes.json', import.meta.url), 'utf8'));
for (const c of cases) test('shared outcome: ' + c.name, () => {
  const ticket = { duration: 600, ...(c.judgment ? { resultPolicy } : {}) };
  const body = { score: c.score, outcome: { kind: c.kind, remaining: c.health, eliminated: c.gone, seconds: c.seconds } };
  assert.deepEqual(checkedResult(ticket, body), body);
});
test('judgment rejects missing evidence, early timeout, invalid values and conflicting results', () => {
  const ticket = { duration: 600, resultPolicy }, good = { score: 1,
    outcome: { kind: 'judgment', remaining: [.65,.6], eliminated: [false,false], seconds: 600 } };
  for (const outcome of [null, {...good.outcome, seconds: 599.999}, {...good.outcome, seconds: 606},
    {...good.outcome, remaining: [NaN,.5]}, {...good.outcome, remaining: [1.01,.5]},
    {...good.outcome, remaining: [.5]}, {...good.outcome, eliminated: [0,0]}, {...good.outcome, kind: 'elimination'}])
    assert.throws(() => checkedResult(ticket, {...good, outcome}), e => e.status === 400);
  assert.throws(() => checkedResult(ticket, {...good, score: .5}), e => e.status === 400);
  assert.deepEqual(checkedResult({duration:600}, {score:.5}), {score:.5});
});
