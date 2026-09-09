import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {prepareGoalRequest} from '../../goal-request.mjs';
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const execute=new AsyncFunction('state','runs',fs.readFileSync(new URL('../../goal-task-step.js',import.meta.url),'utf8'));
const base={goalId:'goal',taskId:'task',phase:'review',attempt:1,agent:'team.reviewer',task:'Review the candidate.',cwd:'/fixture',sourceState:'sha256:one',goalStatus:'active',taskStatus:'pending',work:{kind:'review',criteria:['C1: correctness'],checks:[]}};
function fixture(){const data={teamGoalBinding:{goalId:'goal',cwd:'/fixture'}};return {data,state:{get:async k=>data[k],set:async(k,v)=>{data[k]=structuredClone(v)}}};}
function packet(f,n,extra={}){f.data.teamGoalRequest=prepareGoalRequest({...base,phase:'slice-'+n,...extra},'/fixture/input-'+n+'.json');}
function result(f){const input=f.data.teamGoalRequest;return {ok:true,runId:'child',structuredOutput:{verdict:'pass',goalId:'goal',taskId:'task',inputSourceState:input.sourceState,sourceState:input.sourceState,evidence:['fixture'],residualRisks:[],criterionResults:[{criterion:'C1: correctness',status:'met',entrypoint:'fixture',observed:'fixture',evidence:['fixture']}]}};}
test('same-phase ordinal accommodates initial work plus three repairs',()=>{
 const f=fixture();assert.doesNotThrow(()=>packet(f,1,{attempt:4}));
 assert.throws(()=>packet(f,1,{attempt:5}),/Attempt/);
});
test('four successful new candidate slices need no retry permission',async()=>{
 const f=fixture();let launches=0;const runs={run:async()=>{launches++;return result(f)}};
 for(let n=1;n<=4;n++){packet(f,n,{sourceState:'sha256:'+n});assert.equal((await execute(f.state,runs)).status,'reported');f.data.teamGoalActiveStep=null;}
 assert.equal(launches,4);
});
test('captured-report failure cannot relaunch with a free-text report-fix reason',async()=>{
 const f=fixture();packet(f,1);let launches=0;const runs={run:async()=>{launches++;return {...result(f),ok:false}}};
 await execute(f.state,runs);f.data.teamGoalActiveStep=null;
 packet(f,2,{retry:{reason:'repair report finalization only',evidence:'file:captured'}});
 await assert.rejects(execute(f.state,runs),/recovery|reconcil/i);assert.equal(launches,1);
});
test('bare recovery action without native/host provenance cannot authorize launch',async()=>{
 const f=fixture();packet(f,1);await execute(f.state,{run:async()=>({...result(f),ok:false})});
 f.data['goal-step.task.slice-1.1'].recovery={action:'continue',sourceState:base.sourceState};
 f.data.teamGoalActiveStep=null;packet(f,2);
 await assert.rejects(execute(f.state,{run:async()=>result(f)}),/recovery required/);
});
test('throw preserves unknown execution and error without promoting to product pass',async()=>{
 const f=fixture();packet(f,1);const error=new Error('fixture WebSocket failure');
 await assert.rejects(execute(f.state,{run:async()=>{throw error}}),/fixture WebSocket/);
 const record=f.data['goal-step.task.slice-1.1'];
 assert.deepEqual(record.outcomes,{execution:'unknown',reportDelivery:'unknown',product:'unknown'});
 assert.equal(record.error,'fixture WebSocket failure');assert.equal(record.status,'blocked');
 assert.equal(f.data.teamGoalActiveStep,'goal-step.task.slice-1.1');
});
