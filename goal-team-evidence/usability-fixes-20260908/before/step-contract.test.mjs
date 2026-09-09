import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { prepareGoalRequest } from '../../goal-request.mjs';
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const runStep=new AsyncFunction('state','runs',fs.readFileSync(new URL('../../goal-task-step.js',import.meta.url),'utf8'));
const input={goalId:'g',taskId:'t',phase:'review',attempt:1,agent:'team.reviewer',task:'Inspect once.',cwd:'/fixture',sourceState:'sha256:fixed',goalStatus:'active',taskStatus:'pending',
 work:{kind:'review',criteria:['C1: correct parsing'],checks:[]}};
function fixture(){ const data={teamGoalBinding:{goalId:'g',cwd:'/fixture'},teamGoalRequest:prepareGoalRequest(input,'/fixture/packet.json')};
 return {data,state:{get:async k=>data[k],set:async(k,v)=>{data[k]=structuredClone(v);}}}; }
function report(extra={}) {return {verdict:'pass',goalId:'g',taskId:'t',inputSourceState:'sha256:fixed',sourceState:'sha256:fixed',evidence:['file:report.md'],residualRisks:[],
 criterionResults:[{criterion:'C1: correct parsing',status:'met',entrypoint:'parser',observed:'checked invalid input',evidence:['file:report.md']}],...extra};}
test('work/checks reach the child and summary-only cannot pass a contracted review',async()=>{
 const f=fixture(); let args;
 const {criterionResults,...summary}=report();
 const result=await runStep(f.state,{run:async(k,a)=>{args=a;return {ok:true,runId:'child',structuredOutput:summary};}});
 assert.equal(result.status,'blocked');
 assert.ok(args.outputSchema.required.includes('criterionResults'));
 assert.match(args.task,/C1: correct parsing/);
 assert.match(args.task,/review/);
});
test('renaming phases cannot reset the per-task role admission ceiling',async()=>{
 const f=fixture(); let launches=0;
 const runs={run:async()=>{launches++;return {ok:true,runId:'child-'+launches,structuredOutput:report()};}};
 for(let n=1;n<=3;n++){
   f.data.teamGoalRequest=prepareGoalRequest({...input,phase:'renamed-'+n,retry:{reason:'new evidence needs independent review',evidence:'file:delta-'+n}},'/fixture/packet-'+n+'.json');
   assert.equal((await runStep(f.state,runs)).status,'reported');
   f.data.teamGoalActiveStep=null;
 }
 f.data.teamGoalRequest=prepareGoalRequest({...input,phase:'another-new-name',retry:{reason:'new evidence',evidence:'file:delta-4'}},'/fixture/packet-4.json');
 await assert.rejects(runStep(f.state,runs),/admission limit/);
 assert.equal(launches,3);
});
test('failed execution keeps a captured product report distinct, never accepts it',async()=>{
 const f=fixture();
 const result=await runStep(f.state,{run:async()=>({ok:false,runId:'child',structuredOutput:report()})});
 assert.equal(result.status,'blocked');
 assert.deepEqual(result.record.outcomes,{execution:'failed',reportDelivery:'captured',product:'pass'});
});
test('missing report cannot trigger another same-source launch after clearing active marker',async()=>{
 const f=fixture(); let launches=0;
 const runs={run:async()=>{launches++;return {ok:false,runId:'child'};}};
 const first=await runStep(f.state,runs);
 assert.equal(first.record.outcomes.reportDelivery,'missing');
 f.data.teamGoalActiveStep=null;
 f.data.teamGoalRequest=prepareGoalRequest({...input,phase:'format-retry',retry:{reason:'report missing',evidence:'file:original.log'}},'/fixture/format.json');
 await assert.rejects(runStep(f.state,runs),/Repair report only/);
 assert.equal(launches,1);
});
test('new same-role admission requires a diagnosed reason',async()=>{
 const f=fixture(); const runs={run:async()=>({ok:true,runId:'child',structuredOutput:report()})};
 await runStep(f.state,runs); f.data.teamGoalActiveStep=null;
 f.data.teamGoalRequest=prepareGoalRequest({...input,phase:'next'},'/fixture/next.json');
 await assert.rejects(runStep(f.state,runs),/diagnosed reason/);
});
test('missing, foreign, duplicate and unobserved criteria never pass',async()=>{
 for(const rows of [[],[...report().criterionResults,...report().criterionResults],
   [{...report().criterionResults[0],criterion:'different'}],
   [{...report().criterionResults[0],status:'indeterminate',evidence:[]}],
   [{...report().criterionResults[0],evidence:[]}]]){
   const f=fixture();
   const result=await runStep(f.state,{run:async()=>({ok:true,runId:'child',structuredOutput:report({criterionResults:rows})})});
   assert.equal(result.status,'blocked');
 }
});
test('static review cannot pass on a different final source binding',async()=>{
 const f=fixture();
 const result=await runStep(f.state,{run:async()=>({ok:true,runId:'child',structuredOutput:report({sourceState:'sha256:other'})})});
 assert.equal(result.status,'blocked');
});
test('declared execution command is retained once in the actual child task',async()=>{
 const f=fixture(); let task;
 f.data.teamGoalRequest=prepareGoalRequest({...input,agent:'team.verifier',work:{kind:'mechanical',criteria:input.work.criteria,checks:[{command:'node fixed-check.mjs',location:'child-safe'}]}},'/fixture/check.json');
 const result=await runStep(f.state,{run:async(k,args)=>{task=args.task;return {ok:true,runId:'child',structuredOutput:report()};}});
 assert.equal(result.status,'reported');
 assert.equal(task.split('node fixed-check.mjs').length-1,1);
 assert.equal(task.split(input.work.criteria[0]).length-1,1);
 assert.ok(Buffer.byteLength(task)<2000,'small work must not expand into a full repeated transcript');
});
test('matched criterion observations can pass without running browser in static role',async()=>{
 const f=fixture();
 const result=await runStep(f.state,{run:async()=>({ok:true,runId:'child',structuredOutput:report()})});
 assert.equal(result.status,'reported');
});
