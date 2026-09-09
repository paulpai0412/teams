import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const source=readFileSync(process.argv[2] ?? '/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-team-hold.ts','utf8');
const {GoalTeamHold,inspectGoalTeamRunStatus,goalTeamRunBlockReason}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const root=mkdtempSync(join(tmpdir(),'hold-regression-'));
const previous=process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT=root;
try {
 for(const target of ['/child','/parent']) {
  const goal={id:'goal',status:'active',autoContinue:true,currentTaskId:'task'};
  const entries=[]; const dir=join(root,'async-subagent-runs','run');mkdirSync(dir,{recursive:true});
  let status={runId:'run',sessionId:'session',cwd:target,toolCallId:'call',completionOwnerId:'owner',state:'running'};
  const save=()=>writeFileSync(join(dir,'status.json'),JSON.stringify(status));save();
  const deps={sessionId:()=> 'session',cwd:()=>'/parent',goal:()=>goal,append:e=>entries.push(e),readStatus:inspectGoalTeamRunStatus};
  const hold=new GoalTeamHold(deps);
  const input={async:true,cwd:target,extensionBindings:{'pi-goal-x.team-hold/1':{goalId:'goal',taskId:'task',cwd:target}}};
  assert.equal(hold.beginToolCall({toolName:'subagent',toolCallId:'call',input}),true,'same/cross cwd begin');
  assert.equal(await hold.completeToolResult({toolName:'subagent',toolCallId:'call',details:{runId:'run',asyncId:'run',asyncDir:dir}}),true,'native status bound');
  assert.equal(hold.current().ownerCwd,'/parent');assert.equal(hold.current().cwd,target);
  assert.equal(hold.shouldHold({cwd:'/parent'},goal),true);
  assert.match(await goalTeamRunBlockReason(entries,'goal','/parent'),/still active/);
  const restored=new GoalTeamHold(deps);assert.equal(await restored.recover(entries),true);
  const wrongOwner=new GoalTeamHold({...deps,cwd:()=>'/other'});assert.equal(await wrongOwner.recover([...entries]),false);
  status={...status,cwd:'/forged'};save();assert.equal((await inspectGoalTeamRunStatus(hold.current())).kind,'unknown');
  status={...status,cwd:target,state:'complete'};save();
  assert.equal(await hold.onNativeCompletion({...status,completionOwnerId:'wrong'}),false);
  assert.equal(await hold.onNativeCompletion(status),true);
  assert.equal(await goalTeamRunBlockReason(entries,'goal','/parent'),null);
  assert.equal(hold.shouldHold({cwd:'/parent'},goal),false);
  const mismatch=new GoalTeamHold(deps);input.cwd='/unmatched';
  assert.equal(mismatch.beginToolCall({toolName:'subagent',toolCallId:'call',input}),false);
 }
 console.log('PASS hold: same/cross cwd begin, native bind, owner/execution identity, hold, completion gate, recovery, forged owner/status, completion, mismatch rejection');
} finally {if(previous===undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;else process.env.PI_SUBAGENTS_TEMP_ROOT=previous;rmSync(root,{recursive:true,force:true});}
