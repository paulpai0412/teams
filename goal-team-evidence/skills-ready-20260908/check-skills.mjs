// Zero-model public preparation/role checks; no browser or child execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareGoalDispatch} from '../../goal-request.mjs';
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-skills-'));
try {
 fs.writeFileSync(path.join(cwd,'source.js'),'export const fixture = true;\n');
 const health=spawnSync(process.execPath,[new URL('../../check-config.mjs',import.meta.url).pathname,'--roles-only',cwd],{encoding:'utf8',timeout:60000,env:{...process.env,PI_OFFLINE:'1',PI_MEMORY_EXIT_SUMMARY:'off'}});
 assert.equal(health.status,0,health.stderr);const report=JSON.parse(health.stdout);
 assert.equal(report.status,'PASS');assert.equal(report.roles.length,14);
 const expected={'team.docs':['docs-generator'],'team.e2e':['browser-automation'],'team.release':['supply-chain-security'],'team.security':['code-audit','llm-security','supply-chain-security']};
 let cases=0;
 for(const [agent,skills] of Object.entries(expected)){
  const role=report.roles.find(x=>x.name===agent);assert.ok(role);
  for(const name of skills){const resolved=role.skills.find(x=>x.name===name);assert.ok(resolved,name);assert.equal(resolved.path,path.resolve(import.meta.dirname,'../../../skills',name,'SKILL.md'));}
  assert.equal(role.tools.includes('bash'),agent==='team.e2e');
  const input={missionId:'fixture',goalId:'fixture',taskId:'fixture',phase:'prepare',attempt:1,agent,task:'Fixture preparation only; never execute.',cwd,sourcePaths:['source.js'],timeoutMs:1000,goalStatus:'active',taskStatus:'pending',work:{kind:agent==='team.security'?'review':agent==='team.e2e'?'browser':'implementation',criteria:['C1: approved fixture scope'],checks:agent==='team.e2e'?[{command:'node never-execute-fixture.mjs',location:'child-safe'}]:[]}};
  const prepared=await prepareGoalDispatch(input,path.join(cwd,agent+'.json'));assert.ok(prepared.dispatchArgs);cases++;
  if(['team.docs','team.release'].includes(agent)){
   await assert.rejects(prepareGoalDispatch({...input,work:{...input.work,checks:[{command:'node never-execute-fixture.mjs',location:'child-safe'}]}},path.join(cwd,'bad.json')),/shell/);cases++;
  }
 }
 for(const selected of ['team.e3e','team.e2e,team.e2e']){
  const denied=spawnSync(process.execPath,[new URL('../../check-config.mjs',import.meta.url).pathname,'--roles-only','--roles='+selected,cwd],{encoding:'utf8',timeout:60000,env:{...process.env,PI_OFFLINE:'1',PI_MEMORY_EXIT_SUMMARY:'off'}});
  assert.equal(denied.status,1);assert.match(denied.stderr,/unknown team role|unique canonical/);cases++;
 }
 assert.deepEqual(fs.readdirSync(cwd),['source.js'],'API must not execute commands or write launch artifacts');
 console.log(JSON.stringify({status:'PASS',roles:14,cases,realChildren:0,browserRuns:0,scope:'resolver and public preparation only; no model-behavior certification'},null,2));
} finally {fs.rmSync(cwd,{recursive:true,force:true});}
