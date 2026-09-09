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
test('a terminal reconciled throw can be accepted without rewriting its failed history',async t=>{
 const f=fixture(t),input=f.packet();
 await assert.rejects(execute(f.state,{run:async()=>{throw new Error('fixture transport');}}),/transport/);
 const original=f.state.get('goal-step.task.work.1'),proof=f.check();
 const prepared=f.recovery(input,'continue',proof);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 const record=f.state.get('goal-step.task.work.1');
 assert.equal(record.recovery.childRunId,'child-work');
 assert.deepEqual({...record,recovery:undefined},{...original,recovery:undefined});
 assert.equal(f.seal(proof).status,'verified');
});
test('unreconciled failure with a runId cannot pass merely by clearing the marker',async t=>{
 const f=fixture(t),input=f.packet();
 await execute(f.state,{run:async()=>({...f.report(input),ok:false})});
 f.state.set('teamGoalActiveStep',null);
 assert.throws(()=>f.seal(f.check()),/unresolved retained step/);
});
test('writer self-pass does not authorize another same-role step without parent disposition',async t=>{
 const f=fixture(t),input=f.packet();
 await execute(f.state,{run:async()=>f.report(input)});
 f.state.set('teamGoalActiveStep',null);
 f.check('host-rejected',1);
 const next=f.packet({phase:'repair'});let calls=0;
 await assert.rejects(execute(f.state,{run:async()=>{calls++;return f.report(next);}}),/parent recovery required/);
 assert.equal(calls,0);
});
test('host-rejected writer passes consume three repairs, never a fourth',async t=>{
 const f=fixture(t),safe=f.check('safety');let launches=0;
 for(let round=0;round<4;round++) {
  const input=f.packet({phase:'repair-'+round});
  assert.equal((await execute(f.state,{run:async()=>{launches++;return f.report(input);}})).status,'reported');
  const rejected=f.check('rejected-'+round,1);
  const prepared=f.recovery(input,'retry',safe,{rejection:rejected.receipt});
  await new AsyncFunction('state',prepared.setupScript)(f.state);
 }
 const next=f.packet({phase:'fourth-repair'});
 await assert.rejects(execute(f.state,{run:async()=>{launches++;return f.report(next);}}),/repair limit/);
 assert.equal(launches,4);
 assert.equal(f.state.get('goal-admissions.task.team.implementer').repairs,3);
});
test('four parent-accepted slices continue without spending repair budget',async t=>{
 const f=fixture(t),safe=f.check('safety');
 for(let n=0;n<4;n++) {
  const input=f.packet({phase:'slice-'+n});
  assert.equal((await execute(f.state,{run:async()=>f.report(input)})).status,'reported');
  const prepared=f.recovery(input,'continue',safe);
  await new AsyncFunction('state',prepared.setupScript)(f.state);
 }
 assert.equal(f.state.get('goal-admissions.task.team.implementer').repairs,0);
 assert.equal(f.seal(safe).status,'verified');
});
test('report-only cannot replay work; explicit continue after report resolution permits the next slice',async t=>{
 const f=fixture(t),input=f.packet(),safe=f.check('safety');
 await execute(f.state,{run:async()=>({...f.report(input),ok:false})});
 assert.throws(()=>f.recovery(input,'retry',safe),/captured pass/);
 const reportOnly=f.recovery(input,'report-only',safe);
 await new AsyncFunction('state',reportOnly.setupScript)(f.state);
 const next=f.packet({phase:'next',work:{kind:'implementation',criteria:['C2: next slice'],checks:[]}});
 let launches=0;const runs={run:async()=>{launches++;return f.report(next);}};
 await assert.rejects(execute(f.state,runs),/finish report handling.*continue recovery/);
 assert.equal(launches,0);
 // The parent has now finished report handling, using the same still-fresh check.
 const resolved=f.recovery(input,'continue',safe);
 await new AsyncFunction('state',resolved.setupScript)(f.state);
 assert.equal((await execute(f.state,runs)).status,'reported');
 assert.equal(launches,1);
 assert.equal(f.state.get('goal-admissions.task.team.implementer').repairs,0);
});
test('a declared repair cannot borrow a free continue decision or an empty rejection',async t=>{
 const f=fixture(t),input=f.packet(),safe=f.check('safety');
 await execute(f.state,{run:async()=>f.report(input)});
 const empty=path.join(f.cwd,'empty.md');fs.writeFileSync(empty,'');
 assert.throws(()=>f.recovery(input,'retry',safe,{rejection:empty}),/empty evidence/);
 const resolved=f.recovery(input,'continue',safe);
 await new AsyncFunction('state',resolved.setupScript)(f.state);
 const next=f.packet({phase:'repair',retry:{reason:'fix rejected C1',evidence:'fixture'}});
 await assert.rejects(execute(f.state,{run:async()=>f.report(next)}),/Declared repair requires/);
});
test('terminal launch with a failed final record save can be recovered and accepted',async t=>{
 const f=fixture(t),input=f.packet(),safe=f.check('safety');
 const failingState={get:key=>f.state.get(key),set:(key,value)=>{
  if(key==='goal-step.task.work.1' && value.status==='reported') throw new Error('fixture final save failed');
  return f.state.set(key,value);
 }};
 await assert.rejects(execute(failingState,{run:async()=>f.report(input)}),/final save failed/);
 assert.equal(f.state.get('goal-step.task.work.1').status,'dispatching');
 const resolved=f.recovery(input,'continue',safe);
 await new AsyncFunction('state',resolved.setupScript)(f.state);
 assert.equal(f.seal(safe).status,'verified');
 assert.equal(f.state.get('goal-step.task.work.1').status,'dispatching');
});
test('fifty reconciled successful slices fit native state without rerunning the host check',async t=>{
 const f=fixture(t),safe=f.check('one-safety-check');
 const before=fs.statSync(safe.receipt).mtimeMs;
 for(let n=0;n<50;n++) {
  const input=f.packet({phase:'slice-'+n});
  await execute(f.state,{run:async()=>f.report(input)});
  const prepared=f.recovery(input,'continue',safe);
  await new AsyncFunction('state',prepared.setupScript)(f.state);
 }
 assert.equal(fs.statSync(safe.receipt).mtimeMs,before);
 assert.equal(f.state.get('goal-admissions.task.team.implementer').repairs,0);
 assert.equal(f.seal(safe).status,'verified');
 const bytes=fs.statSync(f.state.path).size;
 assert.ok(bytes<80*1024,'history must retain bounded references, not repeated reports');
 t.diagnostic('50 reconciled slices: '+bytes+' bytes; one host check receipt reused');
});
test('recovery with a foreign request or child identity cannot settle execution',async t=>{
 const f=fixture(t),input=f.packet();
 await execute(f.state,{run:async()=>({...f.report(input),ok:false})});
 const proof=f.check(),prepared=f.recovery(input,'continue',proof);
 await new AsyncFunction('state',prepared.setupScript)(f.state);
 const record=f.state.get('goal-step.task.work.1');
 for(const patch of [{requestDigest:'a'.repeat(64)},{childRunId:'foreign'},{hostReceiptDigest:''}]) {
  f.state.set('goal-step.task.work.1',{...record,recovery:{...record.recovery,...patch}});
  assert.throws(()=>f.seal(proof),/unresolved retained step/);
 }
 f.state.set('goal-step.task.work.1',record);
 assert.equal(f.seal(proof).status,'verified');
});
