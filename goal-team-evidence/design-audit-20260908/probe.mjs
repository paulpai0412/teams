// Read-only audit of installed integration; all mutable fixtures are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from '/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs';
const modules = '/home/timmypai/.pi/agent/npm/node_modules';
const jiti = createJiti(import.meta.url);
const { GoalTeamHold, inspectGoalTeamRunStatus } = await jiti.import(path.join(modules, 'pi-goal-x/extensions/goal-team-hold.ts'));
const { createMissionWorkflowState } = await jiti.import(path.join(modules, 'pi-subagents/src/missions/workflow-state.ts'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'team-design-audit-'));
process.env.PI_SUBAGENTS_TEMP_ROOT = scratch;
try {
  const goal = { id: 'audit-goal', currentTaskId: 't1', status: 'active', autoContinue: true };
  const runId = 'audit-run';
  const asyncDir = path.join(scratch, 'async-subagent-runs', runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  const statusFile = path.join(asyncDir, 'status.json');
  const status = { runId, sessionId: 'audit-session', cwd: scratch, toolCallId: 'audit-call', completionOwnerId: 'audit-owner', state: 'running' };
  fs.writeFileSync(statusFile, JSON.stringify(status));
  const entries = [];
  const hold = new GoalTeamHold({ sessionId: () => status.sessionId, cwd: () => scratch, goal: () => goal, append: entry => entries.push(entry), readStatus: inspectGoalTeamRunStatus });
  assert.equal(hold.beginToolCall({ toolName: 'subagent', toolCallId: status.toolCallId, input: { async: true, extensionBindings: { 'pi-goal-x.team-hold/1': { goalId: goal.id, taskId: goal.currentTaskId, cwd: scratch } } } }), true);
  assert.equal(await hold.completeToolResult({ toolName: 'subagent', toolCallId: status.toolCallId, details: { runId, asyncId: runId, asyncDir } }), true);
  // Completion arrives while the required status observation is unavailable.
  fs.unlinkSync(statusFile);
  assert.equal(await hold.onNativeCompletion({ ...status, state: 'complete' }), false);
  fs.writeFileSync(statusFile, JSON.stringify({ ...status, state: 'complete' }));
  const observation = await inspectGoalTeamRunStatus(hold.current());
  assert.equal(observation.kind, 'terminal');
  assert.equal(hold.shouldHold({ cwd: scratch }, goal), true);
  console.log(JSON.stringify({ case: 'completion-status-unavailable', nativeStatusAfterRecovery: observation.kind, stillHeld: true, limitation: 'Isolated fault injection, not evidence of a live occurrence; explicit reload recovery or context invalidation is outside this probe.' }));

  // Execute the real Goal helper with the real mission state store, fake child results.
  const state = createMissionWorkflowState({ missionDir: path.join(scratch, 'missions') }, 'audit-mission');
  state.set('teamGoalBinding', { goalId: goal.id, cwd: scratch });
  const body = fs.readFileSync('/home/timmypai/.pi/agent/teams/goal-task-step.js', 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const helper = new AsyncFunction('state', 'runs', body);
  let completed = 0;
  let failure = '';
  for (let n = 1; n <= 50; n++) {
    const input = { goalId: goal.id, taskId: 't' + n, phase: 'review', attempt: 1, agent: 'team.reviewer', task: 'x'.repeat(8192), cwd: scratch, sourceState: 'fixture-source', goalStatus: 'active', taskStatus: 'pending' };
    try {
      state.set('teamGoalRequest', input);
      const result = await helper(state, { run: async () => ({ ok: true, runId: 'fake-child-' + n, artifactPaths: [], structuredOutput: { verdict: 'pass', goalId: goal.id, taskId: input.taskId, inputSourceState: input.sourceState, sourceState: input.sourceState, evidence: ['fixture-only'], residualRisks: [] } }) });
      assert.equal(result.status, 'reported');
      state.set('teamGoalActiveStep', null);
      completed++;
    } catch (error) { failure = error.message; break; }
  }
  assert.match(failure, /256 KiB/);
  console.log(JSON.stringify({ case: 'goal-step-state-growth', packetBytes: 8192, completedSteps: completed, failedStep: completed + 1, error: failure, activeMarker: state.get('teamGoalActiveStep'), limitation: 'Synthetic 8 KiB packets, real installed helper/store, zero actual children; not a measured production workload.' }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
