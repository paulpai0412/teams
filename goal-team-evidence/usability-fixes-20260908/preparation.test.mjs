import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareGoalDispatch} from '../../goal-request.mjs';
function fixture(){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-ready-'));fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src','value.txt'),'fixture');return {cwd,input:{missionId:'fixture',goalId:'goal',taskId:'task',phase:'work',attempt:1,agent:'team.docs',task:'Run the approved check.',cwd,sourcePaths:['src'],timeoutMs:1000,goalStatus:'active',taskStatus:'pending',work:{kind:'implementation',criteria:['C1: documented check'],checks:[{command:'node check.mjs',location:'child-safe'}]}}};}
test('public API rejects no-shell execution exactly like CLI',async()=>{
 const {cwd,input}=fixture();try{let error;try{await prepareGoalDispatch(input,path.join(cwd,'packet.json'));}catch(e){error=e;}
 assert.match(error?.message??'',/shell/);
 assert.deepEqual(fs.readdirSync(cwd),['src']);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
test('declared missing skill blocks both API and CLI before artifacts',async()=>{
 const {cwd,input}=fixture();try{
 // A disposable project override proves readiness integration independent of host skill inventory.
 fs.mkdirSync(path.join(cwd,'.pi','agents'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi','agents','team.qa.md'),fs.readFileSync(new URL('../../../agents/team.qa.md',import.meta.url),'utf8').replace('skills: team-member, qa','skills: team-member, fixture-skill-that-does-not-exist'));
 const req={...input,agent:'team.qa',work:{kind:'scenarios',criteria:['C1: user scenario'],checks:[]}};
 let error;try{await prepareGoalDispatch(req,path.join(cwd,'packet.json'));}catch(e){error=e;}
 assert.match(error?.message??'',/readiness|role preflight/);
 const file=path.join(cwd,'input.json');fs.writeFileSync(file,JSON.stringify(req));
 const child=spawnSync(process.execPath,[new URL('../../goal-request.mjs',import.meta.url).pathname,'--dispatch',file],{encoding:'utf8',timeout:60000});
 assert.equal(child.status,1);assert.match(child.stderr,/readiness|role preflight/);
 assert.equal(fs.readdirSync(cwd).filter(x=>x.endsWith('.workflow.txt')||x.endsWith('.request.json')).length,0);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
