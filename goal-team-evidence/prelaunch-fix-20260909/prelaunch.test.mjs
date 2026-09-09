// Public helper -> native disposable mission state -> host/runtime acceptance.
// Only the model runner and its terminal status files are fixture boundaries.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from '../../../npm/node_modules/jiti/lib/jiti.mjs';
import {prepareGoalRequest} from '../../goal-request.mjs';
import {prepareGoalRecovery} from '../../goal-recovery.mjs';
import {runCheck, snapshot} from '../../host-evidence.mjs';
const {sealAcceptance,acceptanceReference,goalEvidenceBlockReason}=await import(process.env.AUDIT_ACCEPTANCE_MODULE ?? '../../host-evidence.mjs');
const jiti=createJiti(import.meta.url);
const {createMissionWorkflowState}=await jiti.import('../../../npm/node_modules/pi-subagents/src/missions/workflow-state.ts');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const execute=new AsyncFunction('state','runs',fs.readFileSync(new URL('../../goal-task-step.js',import.meta.url),'utf8'));
const json=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-audit-fix-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src/value.js'),'export const value = 1;\n');
 const missionDir=path.join(cwd,'missions'), statePath=path.join(missionDir,'mission','state.json');
 const state=createMissionWorkflowState({missionDir},'mission');
 state.set('teamGoalBinding',{goalId:'goal',cwd});
 const base={goalId:'goal',taskId:'task',phase:'work',attempt:1,agent:'team.implementer',task:'Fixture source change, no real child.',cwd,sourcePaths:['src'],goalStatus:'active',taskStatus:'pending',timeoutMs:1000,work:{kind:'implementation',criteria:['C1: correct result'],checks:[]}};
 function packet(extra={}) {
  const input=prepareGoalRequest({...base,sourceState:'sha256:'+snapshot(cwd,['src']).digest,...extra},path.join(cwd,'packet-'+(extra.phase??base.phase)+'.json'));
  json(input.requestRef,input);state.set('teamGoalRequest',input);return input;
 }
 function report(input,verdict='pass') {return {ok:true,runId:'child-'+input.phase,structuredOutput:{verdict,goalId:'goal',taskId:'task',inputSourceState:input.sourceState,sourceState:input.sourceState,evidence:['fixture'],residualRisks:[],criterionResults:input.work.criteria.map(criterion=>({criterion,status:verdict==='pass'?'met':'not_met',entrypoint:'fixture',observed:'fixture only',evidence:['fixture']}))}};}
 function check(name='check',exit=0) {
  const input={cwd,sourcePaths:['src'],argv:[process.execPath,'-e','process.exit('+exit+')'],timeoutMs:1000};
  const receipt=path.join(cwd,name+'.json');runCheck(input,receipt);return {check:input,receipt};
 }
 function recovery(input,action,proof,extra={}) {
  const key=input.taskId+'.'+input.phase+'.'+input.attempt;
  const recordKey='goal-step.'+key,record=state.get(recordKey);
  const dir=path.join(cwd,'native-'+input.phase);fs.mkdirSync(dir,{recursive:true});
  const statusPath=path.join(dir,'status.json');
  json(statusPath,{mode:'workflow',cwd,state:'complete',runId:'workflow-'+key,steps:[{workflowKey:key,agent:input.agent,runId:record.runId??'child-'+input.phase,status:'completed'}]});
  json(path.join(dir,'mission.json'),{missionId:'mission',projectRoot:cwd,missionDir});
  return prepareGoalRecovery({statusPath,recordKey,action,reason:'parent inspected fixture terminal effects and outcome',...proof,...extra});
 }
 function seal(proof) {
  const contract=path.join(cwd,'contract.json'),observations=path.join(cwd,'observations.json');
  json(contract,{version:'team-evidence/1',cwd,goalId:'goal',taskId:'task',mission:{id:'mission',statePath},criteria:['C1: correct result'],checks:[{id:'check',input:proof.check}],requiredEvidence:[],decision:'decision.json'});
  json(observations,{checks:{check:path.basename(proof.receipt)},criterionResults:[{criterion:'C1: correct result',status:'met',entrypoint:'fixture CLI',observed:'fixture only',evidence:['check:check']}]});
  const accepted=sealAcceptance(contract,observations);
  const goal={id:'goal',taskList:{tasks:[{id:'task',status:'pending',verificationContract:acceptanceReference(contract)}]}};
  assert.equal(goalEvidenceBlockReason(goal,cwd,'task'),null,'actual Goal evidence consumer must accept the same recovered record');
  return accepted;
 }
 return {cwd,state,base,packet,report,check,recovery,seal};
}
function noLaunchRecovery(f,input,proof,statusPatch={}) {
 const dir=path.join(f.cwd,'native-no-launch');fs.mkdirSync(dir,{recursive:true});
 const statusPath=path.join(dir,'status.json');
 json(statusPath,{mode:'workflow',cwd:f.cwd,state:'failed',steps:[],...statusPatch});
 json(path.join(dir,'mission.json'),{missionId:'mission',projectRoot:f.cwd,missionDir:path.join(f.cwd,'missions')});
 const prepared=prepareGoalRecovery({statusPath,recordKey:'goal-step.task.work.1',action:'continue',reason:'terminal pre-launch persistence failure',...proof});
 fs.writeFileSync(new URL('./no-launch.workflow.txt',import.meta.url),prepared.setupScript);
 return prepared;
}
for (const failedKey of ['goal-admissions.task.team.implementer','teamGoalActiveStep']) {
 test('recover pre-launch write failure at '+failedKey,async t=>{
  const f=fixture(t),input=f.packet(),proof=f.check();let launches=0;
  const failure=new Error('injected storage error');
  const state={get:k=>f.state.get(k),set:(k,v)=>{if(k===failedKey) throw failure;return f.state.set(k,v);}};
  await assert.rejects(execute(state,{run:async()=>{launches++;return f.report(input);}}),e=>e===failure);
  assert.equal(launches,0);
  const original=f.state.get('goal-step.task.work.1');
  assert.equal(original.status,'unlaunched');
  const prepared=noLaunchRecovery(f,input,proof);
  await new AsyncFunction('state',prepared.setupScript)(f.state);
  assert.deepEqual({...f.state.get('goal-step.task.work.1'),recovery:undefined},{...original,recovery:undefined});
  assert.equal(f.seal(proof).status,'verified');
  assert.equal((await execute(f.state,{run:async()=>{launches++;}})).status,'reconcile');
  assert.equal(launches,0,'same key is never replayed');
  const next=f.packet({phase:'next'});
  assert.equal((await execute(f.state,{run:async()=>{launches++;return f.report(next);}})).status,'reported');
  assert.equal(launches,1);
 });
}
test('real native state capacity failure retains a smaller positive no-launch proof',async t=>{
 const f=fixture(t),input=f.packet(),proof=f.check();let launches=0;
 const prospective={...JSON.parse(fs.readFileSync(f.state.path,'utf8')),padding:'',
  'goal-step.task.work.1':{version:2,requestDigest:input.requestDigest,requestRef:input.requestRef,status:'dispatching'}};
 f.state.set('padding','x'.repeat(256*1024-Buffer.byteLength(JSON.stringify(prospective,null,2))));
 await assert.rejects(execute(f.state,{run:async()=>{launches++;}}),/256 KiB/);
 assert.equal(launches,0);
 assert.equal(f.state.get('goal-step.task.work.1').status,'unlaunched');
 // Free only this test's disposable padding, not history or admission counters.
 f.state.set('padding','');
 const prepared=noLaunchRecovery(f,input,proof);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 assert.equal(f.seal(proof).status,'verified');
});
test('marker write committed then threw still proves no launch',async t=>{
 const f=fixture(t),input=f.packet(),proof=f.check();let launches=0;
 const state={get:k=>f.state.get(k),set:(k,v)=>{f.state.set(k,v);if(k==='teamGoalActiveStep') throw new Error('after commit');}};
 await assert.rejects(execute(state,{run:async()=>{launches++;}}),/after commit/);
 assert.equal(launches,0);
 const prepared=noLaunchRecovery(f,input,proof);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 assert.equal(f.state.get('teamGoalActiveStep'),null);
 assert.equal(f.seal(proof).status,'verified');
});
test('failed proof save preserves the original error and remains unknown',async t=>{
 const f=fixture(t),input=f.packet(),proof=f.check(),failure=new Error('budget failed');let launches=0;
 const state={get:k=>f.state.get(k),set:(k,v)=>{
  if(k==='goal-admissions.task.team.implementer') throw failure;
  if(v?.status==='unlaunched') throw new Error('proof save failed');
  return f.state.set(k,v);
 }};
 await assert.rejects(execute(state,{run:async()=>{launches++;}}),e=>e===failure);
 assert.equal(launches,0);
 assert.equal(f.state.get('goal-step.task.work.1').status,'dispatching');
 assert.throws(()=>noLaunchRecovery(f,input,proof),/unique native child identity/);
});
test('an attempted launch cannot use empty native steps as no-launch proof',async t=>{
 const f=fixture(t),input=f.packet(),proof=f.check();let launches=0;
 await assert.rejects(execute(f.state,{run:async()=>{launches++;throw new Error('transport');}}),/transport/);
 assert.equal(launches,1);
 assert.throws(()=>noLaunchRecovery(f,input,proof),/unique native child identity/);
 const prepared=f.recovery(input,'continue',proof);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 const record=f.state.get('goal-step.task.work.1');
 f.state.set('goal-step.task.work.1',{...record,recovery:{...record.recovery,noLaunch:true}});
 assert.throws(()=>f.seal(proof),/unresolved retained step/);
 f.packet({phase:'next'});
 await assert.rejects(execute(f.state,{run:async()=>assert.fail('must not launch')}),/parent recovery required/);
});
test('no-launch recovery rejects missing, active, conflicting or stale evidence',async t=>{
 const f=fixture(t),input=f.packet(),proof=f.check();
 const state={get:k=>f.state.get(k),set:(k,v)=>{if(k==='teamGoalActiveStep') throw new Error('marker');return f.state.set(k,v);}};
 await assert.rejects(execute(state,{run:async()=>assert.fail('must not launch')}),/marker/);
 for(const patch of [{steps:undefined},{state:'running'},{steps:[{workflowKey:'task.work.1',agent:input.agent,runId:'unexpected',status:'completed'}]}])
  assert.throws(()=>noLaunchRecovery(f,input,proof,patch));
 const prepared=noLaunchRecovery(f,input,proof);
 f.state.set('teamGoalActiveStep','goal-step.other.work.1');
 await assert.rejects(new AsyncFunction('state',prepared.setupScript)(f.state),/Another active intent/);
 f.state.set('teamGoalActiveStep',null);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 const record=f.state.get('goal-step.task.work.1');
 for(const patch of [{noLaunch:false},{childRunId:'unexpected'},{requestDigest:'a'.repeat(64)},{action:'report-only'}]) {
  f.state.set('goal-step.task.work.1',{...record,recovery:{...record.recovery,...patch}});
  assert.throws(()=>f.seal(proof),/unresolved retained step/);
 }
 f.state.set('goal-step.task.work.1',record);
 fs.appendFileSync(path.join(f.cwd,'src/value.js'),'// source changed\n');
 assert.throws(()=>noLaunchRecovery(f,input,proof),/source/i);
});
