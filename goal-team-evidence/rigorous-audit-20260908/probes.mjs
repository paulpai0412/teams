// Audit-only counterexamples. All mutations stay in owned scratch; runs.run is a stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareGoalRequest, prepareGoalDispatch} from '../../goal-request.mjs';
import {prepareGoalRecovery} from '../../goal-recovery.mjs';
import {prepareHandoff} from '../../handoff-contract.mjs';
import {runCheck, sealAcceptance} from '../../host-evidence.mjs';
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const execute = new AsyncFunction('state', 'runs', fs.readFileSync(new URL('../../goal-task-step.js', import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-rigorous-audit-'));
const findings = [];
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/value.js'), 'export const value = 1;\n');
  const base = {goalId:'goal', taskId:'task', phase:'work', attempt:1, agent:'team.implementer', task:'Audit fixture only. No real child.', cwd, sourcePaths:['src'], sourceState:'sha256:initial', goalStatus:'active', taskStatus:'pending', timeoutMs:1000, work:{kind:'implementation', criteria:['C1: expected value'], checks:[]}};
  const statePath = path.join(cwd, 'missions', 'audit', 'state.json'); fs.mkdirSync(path.dirname(statePath), {recursive:true});
  const data = {teamGoalBinding:{goalId:'goal', cwd}};
  const state = {get:async key=>data[key], set:async(key,value)=>{data[key]=structuredClone(value); json(statePath,data);}};
  function packet(extra={}) {
    const input = prepareGoalRequest({...base,...extra}, path.join(cwd, 'request-'+(extra.phase??base.phase)+'.json'));
    json(input.requestRef,input); data.teamGoalRequest=input; json(statePath,data); return input;
  }
  return {cwd,base,data,state,statePath,packet};
}
function pass(input) {
  return {ok:true,runId:'fixture-child-'+input.phase,structuredOutput:{verdict:'pass',goalId:input.goalId,taskId:input.taskId,inputSourceState:input.sourceState,sourceState:input.sourceState,evidence:['fixture only'],residualRisks:[],criterionResults:input.work.criteria.map(criterion=>({criterion,status:'met',entrypoint:'fixture',observed:'fixture only',evidence:['fixture only']}))}};
}
function acceptance(f) {
  const check = {cwd:f.cwd,sourcePaths:['src'],argv:[process.execPath,'--check','src/value.js'],timeoutMs:1000};
  const receipt = path.join(f.cwd,'check.json'); runCheck(check,receipt);
  const contract = {version:'team-evidence/1',cwd:f.cwd,goalId:'goal',taskId:'task',mission:{id:'audit',statePath:f.statePath},criteria:['C1: expected value'],checks:[{id:'syntax',input:check}],requiredEvidence:[],decision:'decision.json'};
  const contractFile=path.join(f.cwd,'contract.json'); json(contractFile,contract);
  const observationsFile=path.join(f.cwd,'observations.json'); json(observationsFile,{checks:{syntax:'check.json'},criterionResults:[{criterion:'C1: expected value',status:'met',entrypoint:'fixture syntax checker',observed:'fixture only, not product acceptance',evidence:['check:syntax']}]});
  return {check,receipt,contractFile,observationsFile};
}
function nativeReceipt(f,key,record) {
  const statusPath=path.join(f.cwd,'status.json');
  json(statusPath,{mode:'workflow',cwd:f.cwd,state:'failed',runId:'fixture-workflow',steps:[{workflowKey:key,agent:f.base.agent,runId:record.runId??'fixture-child-work',status:'failed'}]});
  json(path.join(f.cwd,'mission.json'),{missionId:'audit',projectRoot:f.cwd,missionDir:path.join(f.cwd,'missions')});
  return statusPath;
}
try {
  // Normal writer self-pass followed by HOST rejection is the documented routine flow.
  const f=fixture('host-rejected-repairs'); let launches=0;
  for(let round=0;round<=4;round++) {
    fs.writeFileSync(path.join(f.cwd,'src/value.js'),'export const value = '+round+';\n');
    const prepared=await prepareGoalDispatch({...f.base,missionId:'audit',phase:'repair-'+round,...(round?{retry:{reason:'host rejected previous candidate; repair same C1',evidence:'fixture:host-failure-'+(round-1)}}:{})},path.join(f.cwd,'raw-'+round+'.json'));
    json(prepared.packetPath,prepared.packet);
    await new AsyncFunction('state',prepared.setupScript)(f.state);
    const input=f.data.teamGoalRequest;
    const result=await execute(f.state,{run:async()=>{launches++;return pass(input);}});
    assert.equal(result.status,'reported');
    await f.state.set('teamGoalActiveStep',null);
    // Parent's failing command is actual, not a real product test.
    const failed=runCheck({cwd:f.cwd,sourcePaths:['src'],argv:[process.execPath,'-e','process.exit(1)'],timeoutMs:1000},path.join(f.cwd,'host-failed-'+round+'.json'));
    assert.equal(failed.status,'failed');
  }
  assert.equal(launches,5); assert.equal(f.data['goal-admissions.task.team.implementer'].repairs,0);
  findings.push({id:'F1',case:'initial + FOUR explicitly identified host-rejected implementation repairs',observed:{stubLaunches:launches,repairs:0},expected:'fourth repair refused, successes alone must not be treated as final product acceptance'});

  // A throw without runId is explicitly supported by the recovery producer.
  const r=fixture('recovered-throw'); r.packet();
  await assert.rejects(execute(r.state,{run:async()=>{throw new Error('fixture transport error');}}),/transport/);
  const recordKey='goal-step.task.work.1'; const original=structuredClone(r.data[recordKey]);
  const a=acceptance(r); const statusPath=nativeReceipt(r,'task.work.1',original);
  const recovered=prepareGoalRecovery({statusPath,recordKey,action:'continue',reason:'fixture parent has inspected terminal child and effects',check:a.check,receipt:a.receipt});
  assert.equal((await new AsyncFunction('state',recovered.setupScript)(r.state)).status,'reconciled');
  assert.equal(r.data.teamGoalActiveStep,null); assert.equal(r.data[recordKey].recovery.childRunId,'fixture-child-work');
  let error; try {sealAcceptance(a.contractFile,a.observationsFile);} catch(e) {error=e.message;}
  assert.match(error??'',/unresolved retained step/);
  findings.push({id:'F2a',case:'recovery continue succeeds, then final host acceptance',observed:error,originalStatus:r.data[recordKey].status,originalRunId:r.data[recordKey].runId??null,recoveryChildRunId:r.data[recordKey].recovery.childRunId});

  // Converse: historical failure has no recovery but acceptance treats it settled.
  const u=fixture('unrecovered-failure'); const input=u.packet();
  await execute(u.state,{run:async()=>({...pass(input),ok:false})});
  await u.state.set('teamGoalActiveStep',null); // documented prerequisite violation being tested
  assert.equal(u.data[recordKey].recovery,undefined);
  const ua=acceptance(u); const accepted=sealAcceptance(ua.contractFile,ua.observationsFile);
  assert.equal(accepted.status,'verified');
  findings.push({id:'F2b',case:'unrecovered blocked record with runId, active marker cleared',observed:accepted.status,limitation:'parent state is trusted; this is a consistency hole, not an adversarial security bypass'});

  // Report-only and next normal role step share a role ledger: prove continuation block.
  const p=fixture('report-only-next-slice'); const pi=p.packet();
  await execute(p.state,{run:async()=>({...pass(pi),ok:false})}); const pa=acceptance(p);
  const ps=nativeReceipt(p,'task.work.1',p.data[recordKey]);
  const pr=prepareGoalRecovery({statusPath:ps,recordKey,action:'report-only',reason:'preserved captured pass; only delivery repaired by parent',check:pa.check,receipt:pa.receipt});
  await new AsyncFunction('state',pr.setupScript)(p.state);
  p.packet({phase:'different-feature',sourceState:pr.recovery.sourceState,work:{kind:'implementation',criteria:['C2: separate approved feature'],checks:[]}});
  let nextCalls=0; let pe;try {await execute(p.state,{run:async()=>{nextCalls++;return {};}});}catch(e){pe=e.message;}
  assert.equal(nextCalls,0);assert.match(pe??'',/recovery required/);
  findings.push({id:'F3',case:'report-only recovery then distinct C2 work by same task/role',observed:pe,nextStubLaunches:nextCalls,qualification:'requires a second explicit continue recovery, not necessarily unsafe; no documented report-only-to-resolved finalization'});

  // Supported Goal preparation accepts invalid native step identity, failing later.
  const v=fixture('invalid-step-identity');
  const prepared=await prepareGoalDispatch({...v.base,missionId:'audit',taskId:'invalid task id',phase:'work'},path.join(v.cwd,'raw.json'));
  await new AsyncFunction('state',prepared.setupScript)(v.state);
  await assert.rejects(execute(v.state,{run:async()=>{throw new Error('must not run');}}),/Invalid taskId/);
  findings.push({id:'F4',case:'invalid taskId passes public dispatch preparation and state setup',observed:'step helper rejects only after setup'});

  // Ordinary handoff does not share Goal readiness; do not call this undocumented magic.
  const o=fixture('ordinary-readiness'); fs.mkdirSync(path.join(o.cwd,'.pi','agents'),{recursive:true});
  fs.writeFileSync(path.join(o.cwd,'.pi','agents','team.qa.md'),fs.readFileSync(new URL('../../../agents/team.qa.md',import.meta.url),'utf8').replace('skills: team-member, qa','skills: team-member, audit-missing-skill'));
  const request={agent:'team.qa',cwd:o.cwd,task:'Inspect scenarios only.',sourceState:'fixture',criteria:['C1'],checks:[],output:'handoff.md',timeoutMs:1000,work:{kind:'scenarios',criteria:['C1'],checks:[]}};
  assert.ok((await prepareHandoff(request)).args);
  await assert.rejects(prepareGoalDispatch({...o.base,...request,missionId:'audit'},path.join(o.cwd,'goal.json')),/readiness/);
  findings.push({id:'F5',case:'same missing-skill role ordinary handoff vs Goal public preparation',observed:{ordinary:'prepared',goal:'rejected'},qualification:'ordinary path docs require separate check-config; helper parity is not enforced'});
  console.log(JSON.stringify({mode:'offline counterexamples, no model/child/live state',findings},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
