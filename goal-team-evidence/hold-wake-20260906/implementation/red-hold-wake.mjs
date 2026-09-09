import assert from 'node:assert/strict';
import path from 'node:path';
import {createJiti} from '/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs';

const root = '/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions';
const jiti = createJiti(import.meta.url);
const {GoalRuntime} = await jiti.import(path.join(root, 'goal-runtime.ts'));
const sent = [];
const runtime = new GoalRuntime({
  sendFollowUp: (_content, details) => sent.push(details),
  getGoal: () => goal,
  isActionable: (goalId) => goalId === goal.id && goal.status === 'active' && goal.autoContinue,
});
const goal = {
  id: 'fixture-goal', objective: 'fixture', status: 'active', autoContinue: true,
  usage: {tokensUsed: 0, activeSeconds: 0}, sisyphus: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  currentTaskId: 'task-1',
};
const ctx = {
  cwd: '/fixture', isIdle: () => true, hasPendingMessages: () => false,
  sessionManager: {getSessionId: () => 'session-1'},
};
runtime.bindTeamRun({version: 1, goalId: goal.id, taskId: 'task-1', sessionId: 'session-1', cwd: '/fixture', runId: 'run-1', asyncDir: '/fixture/run-1'});
runtime.queueContinuation(ctx, goal, true);
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(sent.length, 0, 'an active bound run must suppress an idle checkpoint');
console.log(JSON.stringify({status: 'PASS', sent: sent.length}));
