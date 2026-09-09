// Read-only production audit; disposable fixtures, zero real child/model launches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareGoalRequest,prepareGoalDispatch} from '../../../goal-request.mjs';
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const step=new AsyncFunction('state','runs',fs.readFileSync(new URL('../../../goal-task-step.js',import.meta.url),'utf8'));
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-audit-'));
const base={goalId:'fixture',taskId:'task',phase:'review',attempt:1,agent:'team.reviewer',task:'Bounded fixture only',cwd,sourceState:'sha256:fixture',goalStatus:'active',taskStatus:'pending',missionId:'fixture',sourcePaths:['src'],timeoutMs:1000,work:{kind:'review',criteria:['C1: reviewed'],checks:[]}};
const results=[];
function fixture(){const data={teamGoalBinding:{goalId:base.goalId,cwd}};return {data,state:{get:async k=>data[k],set:async(k,v)=>{data[k]=structuredClone(v)}}};}
function report(input){return {verdict:'pass',goalId:input.goalId,taskId:input.taskId,inputSourceState:input.sourceState,sourceState:input.sourceState,evidence:['fixture log'],residualRisks:[],criterionResults:input.work.criteria.map(criterion=>({criterion,status:'met',entrypoint:'fixture',observed:'fixture only',evidence:['fixture log']}))};}
try {
 fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src','source.txt'),'fixture');
 // Public imported API generates a dispatch packet despite no-shell role.
 const docs={...base,agent:'team.docs',work:{kind:'implementation',criteria:['C1: check runs'],checks:[{command:'node check.mjs',location:'child-safe'}]}};
 const prepared=prepareGoalDispatch(docs,path.join(cwd,'docs.json'));
 const f=fixture(); await new AsyncFunction('state',prepared.setupScript)(f.state);let calls=0;
 const result=await step(f.state,{run:async()=>{calls++;return {ok:true,runId:'fake',structuredOutput:report(f.data.teamGoalRequest)}}});
 results.push({case:'imported preparation bypasses effective shell preflight',fakeLaunches:calls,status:result.status});
 // Official CLI itself does not integrate selected-role skill readiness.
 fs.writeFileSync(path.join(cwd,'e2e.json'),JSON.stringify({...base,agent:'team.e2e',work:{kind:'browser',criteria:['C1: browser flow'],checks:[{command:'node browser.mjs',location:'child-safe'}]}}));
 const cli=spawnSync(process.execPath,[new URL('../../../goal-request.mjs',import.meta.url).pathname,'--dispatch',path.join(cwd,'e2e.json')],{encoding:'utf8'});
 results.push({case:'CLI prepares e2e despite current declared missing browser skill',exit:cli.status,hasDispatchArgs:cli.status===0&&!!JSON.parse(cli.stdout).dispatchArgs,stderr:cli.stderr});
 // Three successful slices consume all admissions, even before any failure.
 const slices=fixture();let n=0,error=null;
 for(let i=1;i<=4;i++){
  slices.data.teamGoalRequest=prepareGoalRequest({...base,phase:'slice-'+i,sourceState:'sha256:source-'+i,retry:{reason:'review the next completed slice',evidence:'file:slice-'+i}},path.join(cwd,'slice-'+i+'.json'));
  try {await step(slices.state,{run:async()=>{n++;return {ok:true,runId:'fake-'+n,structuredOutput:report(slices.data.teamGoalRequest)}}}); slices.data.teamGoalActiveStep=null;}catch(e){error=e.message;break;}
 }
 results.push({case:'four legitimate successful slice reviews',fakeLaunches:n,fourthRejected:error});
 // A captured valid report does not prohibit repeating work for finalization only.
 const capture=fixture();let repeats=0;
 capture.data.teamGoalRequest=prepareGoalRequest(base,path.join(cwd,'capture.json'));
 await step(capture.state,{run:async()=>{repeats++;return {ok:false,runId:'failed-fixture',structuredOutput:report(capture.data.teamGoalRequest)}}});
 capture.data.teamGoalActiveStep=null;
 capture.data.teamGoalRequest=prepareGoalRequest({...base,phase:'report-fix',retry:{reason:'repair report finalization only',evidence:'file:captured-report'}},path.join(cwd,'capture-next.json'));
 const again=await step(capture.state,{run:async()=>{repeats++;return {ok:true,runId:'second-fixture',structuredOutput:report(capture.data.teamGoalRequest)}}});
 results.push({case:'same-source captured report failure reruns work',fakeLaunches:repeats,status:again.status});
 // Native exceptions do not pass through the new outcome classification block.
 const thrown=fixture();thrown.data.teamGoalRequest=prepareGoalRequest(base,path.join(cwd,'throw.json'));
 try{await step(thrown.state,{run:async()=>{throw new Error('fixture WebSocket failure after captured report')}});}catch{}
 results.push({case:'thrown native failure classification',record:thrown.data['goal-step.task.review.1']});
 console.log(JSON.stringify({modelCalls:0,realChildLaunches:0,results},null,2));
} finally {fs.rmSync(cwd,{recursive:true,force:true});}
