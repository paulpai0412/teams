import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareGoalRequest} from '../../goal-request.mjs';
import {runCheck} from '../../host-evidence.mjs';
import {prepareGoalRecovery} from '../../goal-recovery.mjs';
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const execute=new AsyncFunction('state','runs',fs.readFileSync(new URL('../../goal-task-step.js',import.meta.url),'utf8'));
function fixture(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-recovery-'));
 fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src','value.txt'),'fixture');
 const sourcePaths=['src'];const check={cwd,sourcePaths,argv:[process.execPath,'-e','console.log("fixture recovery evidence")'],timeoutMs:1000};
 const receipt=path.join(cwd,'check.json');runCheck(check,receipt);
 const req=prepareGoalRequest({goalId:'goal',taskId:'task',phase:'review',attempt:1,agent:'team.reviewer',task:'Review fixture',cwd,sourceState:'sha256:initial',sourcePaths,goalStatus:'active',taskStatus:'pending',work:{kind:'review',criteria:['C1: correct'],checks:[]}},path.join(cwd,'request.json'));
 fs.writeFileSync(req.requestRef,JSON.stringify(req));
 const recordKey='goal-step.task.review.1';const record={version:2,requestRef:req.requestRef,requestDigest:req.requestDigest,status:'blocked',outcomes:{execution:'unknown',reportDelivery:'unknown',product:'unknown'}};
 const state={teamGoalBinding:{goalId:'goal',cwd},teamGoalActiveStep:recordKey,[recordKey]:record};
 const missionDir=path.join(cwd,'missions');fs.mkdirSync(path.join(missionDir,'mission'),{recursive:true});const statePath=path.join(missionDir,'mission','state.json');fs.writeFileSync(statePath,JSON.stringify(state));
 const statusPath=path.join(cwd,'status.json');const status={mode:'workflow',cwd,state:'failed',runId:'workflow-id',steps:[{workflowKey:'task.review.1',agent:'team.reviewer',runId:'child-id',status:'failed'}]};fs.writeFileSync(statusPath,JSON.stringify(status));fs.writeFileSync(path.join(cwd,'mission.json'),JSON.stringify({missionId:'mission',projectRoot:cwd,missionDir}));
 return {cwd,state,statePath,status,statusPath,recordKey,record,input:{statusPath,recordKey,action:'retry',reason:'fixture diagnosed failure; no outstanding effects',check,receipt},save(){fs.writeFileSync(statePath,JSON.stringify(state));fs.writeFileSync(statusPath,JSON.stringify(status));}};
}
test('terminal native receipt + fresh host check produces zero-launch guarded recovery',async()=>{const f=fixture();try{
 const prepared=prepareGoalRecovery(f.input);let launches=0;
 fs.writeFileSync(new URL('./recovery.workflow.txt',import.meta.url),prepared.setupScript);
 const state={get:async k=>f.state[k],set:async(k,v)=>{f.state[k]=structuredClone(v)}};
 const out=await new AsyncFunction('state','runs',prepared.setupScript)(state,{run:async()=>{launches++}});
 assert.equal(out.status,'reconciled');assert.equal(launches,0);assert.equal(f.state.teamGoalActiveStep,null);
 assert.equal(f.state[f.recordKey].status,'blocked');assert.equal(f.state[f.recordKey].outcomes.execution,'unknown');
 assert.equal(f.state[f.recordKey].recovery.childRunId,'child-id');
 assert.equal(f.state[f.recordKey].recovery.action,'retry');
 // Replay after the record write/marker-clear boundary must be harmless.
 f.state.teamGoalActiveStep=f.recordKey;
 await new AsyncFunction('state',prepared.setupScript)(state);
 assert.equal(f.state.teamGoalActiveStep,null);assert.equal(launches,0);
 const req=JSON.parse(fs.readFileSync(f.record.requestRef));
 f.state.teamGoalRequest=prepareGoalRequest({...req,phase:'retry',attempt:2,sourceState:prepared.recovery.sourceState},path.join(f.cwd,'next.json'));
 f.state['goal-admissions.task.team.reviewer']={version:2,repairs:0,lastRecord:f.recordKey};
 const runs={run:async()=>{launches++;return {ok:false,runId:'retry-child'}}};
 await execute(state,runs);await execute(state,runs);
 assert.equal(launches,1);assert.equal(f.state['goal-admissions.task.team.reviewer'].repairs,1);
 assert.equal(f.state[f.recordKey].outcomes.execution,'unknown');
 }finally{fs.rmSync(f.cwd,{recursive:true,force:true});}});
test('active native child, foreign identity, stale source, changed record all fail closed',async()=>{const f=fixture();try{
 f.status.steps[0].status='running';f.save();assert.throws(()=>prepareGoalRecovery(f.input),/terminal/);
 f.status.steps[0].status='failed';f.status.steps[0].agent='team.qa';f.save();assert.throws(()=>prepareGoalRecovery(f.input),/identity/);
 f.status.steps[0].agent='team.reviewer';f.save();const prepared=prepareGoalRecovery(f.input);
 f.state[f.recordKey].error='changed';await assert.rejects(new AsyncFunction('state',prepared.setupScript)({get:async k=>f.state[k],set:async()=>{throw new Error('must not write')}}),/changed/);
 fs.writeFileSync(path.join(f.cwd,'src','value.txt'),'changed');assert.throws(()=>prepareGoalRecovery(f.input),/source changed/);
 }finally{fs.rmSync(f.cwd,{recursive:true,force:true});}});
test('captured pass without product rejection cannot retry; report-only never authorizes replay',async()=>{const f=fixture();try{
 f.record.outcomes={execution:'failed',reportDelivery:'captured',product:'pass'};f.save();assert.throws(()=>prepareGoalRecovery(f.input),/captured/);
 const prepared=prepareGoalRecovery({...f.input,action:'report-only'});const state={get:async k=>f.state[k],set:async(k,v)=>{f.state[k]=v}};
 await new AsyncFunction('state',prepared.setupScript)(state);
 const req=JSON.parse(fs.readFileSync(f.record.requestRef));f.state.teamGoalRequest=prepareGoalRequest({...req,phase:'report-fix',sourceState:f.state[f.recordKey].recovery.sourceState},path.join(f.cwd,'next.json'));
 f.state['goal-admissions.task.team.reviewer']={version:2,repairs:0,lastRecord:f.recordKey};
 await assert.rejects(execute(state,{run:async()=>{throw new Error('must not launch')}}),/Report-only never authorizes/);
 }finally{fs.rmSync(f.cwd,{recursive:true,force:true});}});
