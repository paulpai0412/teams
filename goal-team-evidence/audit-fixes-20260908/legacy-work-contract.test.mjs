import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = new URL('../../goal-request.mjs', import.meta.url).pathname;
const base = { missionId:'fixture', goalId:'goal', taskId:'task', phase:'qa', attempt:1,
  agent:'team.qa', task:'Inspect the assigned criterion only.', goalStatus:'active', taskStatus:'pending',
  timeoutMs:1000, sourcePaths:['src'] };
function invoke(overrides) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-work-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'fixture.txt'), 'source');
    const file=path.join(cwd, 'request.json');
    fs.writeFileSync(file, JSON.stringify({...base,cwd,...overrides}));
    const result=spawnSync(process.execPath,[cli,'--dispatch',file],{encoding:'utf8'});
    const artifacts=fs.readdirSync(cwd).filter(x=>x.endsWith('.workflow.txt')||x.endsWith('.request.json'));
    return {...result,artifacts};
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
}
test('new dispatch requires an explicit responsibility instead of silently dropping work',()=>{
  const result=invoke({});
  assert.equal(result.status,1);
  assert.match(result.stderr,/work contract required/);
  assert.deepEqual(result.artifacts,[]);
});
test('effective no-shell profile cannot receive an execution command',()=>{
  const result=invoke({agent:'team.docs',work:{kind:'implementation',criteria:['DOC-1: documented command runs'],checks:[{command:'node check.mjs',location:'child-safe'}]}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/shell/);
  assert.deepEqual(result.artifacts,[]);
});
test('capable verifier prepares explicit browser checks without executing them',()=>{
  const result=invoke({agent:'team.verifier',work:{kind:'browser',criteria:['UI-1: keyboard flip works'],checks:[{command:'node existing-browser-check.mjs',location:'isolated-only',resource:'/approved/scratch'}]}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.artifacts.length,2);
});
test('parent-only checks and undeclared browser execution fail before dispatch',()=>{
  for(const checks of [[],[{command:'node check.mjs',location:'parent-only'}]]){
    const result=invoke({agent:'team.verifier',work:{kind:'browser',criteria:['UI-1: keyboard flip works'],checks}});
    assert.equal(result.status,1);
    assert.deepEqual(result.artifacts,[]);
  }
});
test('browser work cannot be assigned to static QA even with no command declared',()=>{
  const result=invoke({work:{kind:'browser',criteria:['UI-1: keyboard flip works'],checks:[]}});
  assert.equal(result.status,1,'must reject before producing a launch packet');
  assert.match(result.stderr,/responsibility|browser/);
  assert.deepEqual(result.artifacts,[]);
});
