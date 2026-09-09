// Parent-only reconciliation preparation. Reads native receipts; never launches,
// executes checks, mutates a mission or promotes a failed product to pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareGoalRequest} from './goal-request.mjs';
import {verifyCheck, goalStepSettled, evidenceDigest} from './host-evidence.mjs';
function readJson(file) {
  assert.ok(path.isAbsolute(file), 'absolute evidence path required');
  assert.equal(fs.realpathSync(file), file, 'canonical evidence path required');
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size <= 1024 * 1024, 'bounded regular evidence file required');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function prepareGoalRecovery(input) {
  assert.ok(['report-only', 'continue', 'retry'].includes(input.action), 'explicit recovery action required');
  assert.ok(typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 1024, 'bounded diagnosed reason required');
  const native = readJson(input.statusPath);
  assert.ok(native.mode === 'workflow' && ['complete', 'failed', 'stopped', 'cancelled'].includes(native.state), 'native workflow must be terminal');
  const mission = readJson(path.join(path.dirname(input.statusPath), 'mission.json'));
  assert.match(mission.missionId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.equal(native.cwd, mission.projectRoot, 'native mission cwd mismatch');
  const saved = readJson(path.join(mission.missionDir, mission.missionId, 'state.json'));
  const record = saved[input.recordKey];
  assert.ok(record && ['dispatching', 'blocked', 'reported'].includes(record.status), 'retained step record required');
  const request = prepareGoalRequest(readJson(record.requestRef), record.requestRef);
  assert.equal(request.requestDigest, record.requestDigest, 'saved request changed');
  assert.deepEqual(saved.teamGoalBinding, {goalId: request.goalId, cwd: request.cwd}, 'goal binding mismatch');
  assert.equal(request.cwd, native.cwd, 'request cwd mismatch');
  const key = request.taskId + '.' + request.phase + '.' + request.attempt;
  assert.equal(input.recordKey, 'goal-step.' + key, 'record key mismatch');
  const steps = native.steps?.filter(step => step.workflowKey === key);
  assert.ok(steps?.length === 1 && steps[0].agent === request.agent && typeof steps[0].runId === 'string' && steps[0].runId.trim(), 'unique native child identity required');
  const child = steps[0];
  assert.ok(['completed', 'failed', 'stopped', 'cancelled'].includes(child.status), 'native child must be terminal');
  if (record.runId) assert.equal(child.runId, record.runId, 'native run identity mismatch');
  if (input.action === 'retry' && record.outcomes?.product === 'pass')
    assert.ok(typeof input.rejection === 'string' && input.rejection.trim(), 'captured pass requires separate parent product-rejection evidence, never repeat work just for a report');
  const rejection = input.rejection === undefined ? {} : {
    rejectionRef: input.rejection, rejectionDigest: evidenceDigest(input.rejection),
  };
  assert.ok(input.action === 'retry' || input.rejection === undefined, 'rejection evidence belongs to an explicit retry decision');
  assert.equal(input.check.cwd, request.cwd, 'check cwd mismatch');
  assert.ok(request.sourcePaths, 'legacy packet has no source scope; parent migration required');
  assert.deepEqual(input.check.sourcePaths, request.sourcePaths, 'cannot narrow original source scope');
  const checked = verifyCheck(input.check, input.receipt);
  const recovery = {
    action: input.action, reason: input.reason, requestDigest: record.requestDigest, ...rejection,
    nativeStatusRef: input.statusPath, nativeDigest: digest(native), childRunId: child.runId,
    hostReceiptRef: input.receipt, hostReceiptDigest: digest(readJson(input.receipt)),
    sourceState: 'sha256:' + checked.sourceDigest,
  };
  assert.ok(goalStepSettled({...record, recovery}), 'recovery must be consumable by final acceptance');
  // Host-verified preparation, same single-owner discipline as goal-request.
  // Keep all original outcome/error fields. Reconciliation is a separate decision.
  const setupScript = [
    'const key = ' + JSON.stringify(input.recordKey) + ';',
    'const expected = ' + JSON.stringify(record) + ';',
    'const next = {...expected, recovery: ' + JSON.stringify(recovery) + '};',
    'const existing = await state.get(key);',
    'if (JSON.stringify(existing) !== JSON.stringify(expected) && JSON.stringify(existing) !== JSON.stringify(next)) throw new Error("Step changed since recovery preparation");',
    'const binding = await state.get("teamGoalBinding");',
    'if (JSON.stringify(binding) !== ' + JSON.stringify(JSON.stringify(saved.teamGoalBinding)) + ') throw new Error("Goal binding changed");',
    'const active = await state.get("teamGoalActiveStep");',
    'if (active != null && active !== key) throw new Error("Another active intent must be reconciled first");',
    'await state.set(key, next);',
    'if (active === key) await state.set("teamGoalActiveStep", null);',
    'return {status:"reconciled", recordKey:key, action:' + JSON.stringify(input.action) + '};',
  ].join('\n');
  return {missionId: mission.missionId, cwd: request.cwd, setupScript, recovery};
}
if (process.argv[1] === import.meta.filename) {
  try {
    assert.equal(process.argv.length, 3, 'usage: goal-recovery.mjs /absolute/recovery-input.json');
    const file = fs.realpathSync(process.argv[2]);
    const prepared = prepareGoalRecovery(readJson(file));
    const setupPath = file + '.' + digest(prepared) + '.workflow.txt';
    try { fs.writeFileSync(setupPath, prepared.setupScript, {flag: 'wx', mode: 0o600}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(fs.realpathSync(setupPath), setupPath, 'canonical recovery script required');
      assert.equal(fs.readFileSync(setupPath, 'utf8'), prepared.setupScript, 'recovery script changed');
    }
    console.log(JSON.stringify({recovery: prepared.recovery, setupArgs: {
      missionId: prepared.missionId, cwd: prepared.cwd, workflowScriptPath: setupPath,
      async: false, timeoutMs: 30000, globalConcurrencyLimit: 1, maxSubagentSpawnsPerRun: 1,
    }}, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
