import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareGoalDispatch,prepareGoalRequest} from '../../goal-request.mjs';
import {prepareHandoff} from '../../handoff-contract.mjs';
function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-prepare-fix-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src/value.txt'),'fixture');
 const work={kind:'scenarios',criteria:['C1'],checks:[]};
 return {cwd,input:{missionId:'mission',goalId:'goal',taskId:'task',phase:'work',attempt:1,agent:'team.qa',task:'Inspect supplied scenario.',cwd,sourcePaths:['src'],sourceState:'fixture',timeoutMs:1000,goalStatus:'active',taskStatus:'pending',work}};
}
test('invalid taskId and phase are rejected at both preparation entrypoints',async t=>{
 const {cwd,input}=fixture(t);
 for(const field of ['taskId','phase']) for(const value of ['bad id','../escape','x'.repeat(49),'']) {
  const request={...input,[field]:value};
  assert.throws(()=>prepareGoalRequest(request,path.join(cwd,'raw.json')),new RegExp('Invalid '+field));
  await assert.rejects(prepareGoalDispatch(request,path.join(cwd,'raw.json')),new RegExp('Invalid '+field));
 }
 assert.deepEqual(fs.readdirSync(cwd),['src']);
});
test('ordinary and Goal preparation both reject the same missing-skill override',async t=>{
 const {cwd,input}=fixture(t);
 fs.mkdirSync(path.join(cwd,'.pi/agents'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi/agents/team.qa.md'),fs.readFileSync(new URL('../../../agents/team.qa.md',import.meta.url),'utf8').replace('skills: team-member, qa','skills: team-member, missing-audit-skill'));
 const ordinary={agent:input.agent,cwd,task:input.task,sourceState:'fixture',criteria:input.work.criteria,checks:[],work:input.work,output:'report.md',timeoutMs:1000};
 await assert.rejects(prepareHandoff(ordinary),/readiness preflight failed/);
 await assert.rejects(prepareGoalDispatch(input,path.join(cwd,'raw.json')),/readiness preflight failed/);
 assert.equal(fs.readdirSync(cwd).some(x=>x.endsWith('.workflow.txt')||x.endsWith('.request.json')),false);
});
