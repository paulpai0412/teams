// Parent-only packet preparation. No launches, mission/Goal writes or new tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateWork } from "./work-contract.mjs";
import {
  snapshot,
  acceptanceReference,
  saveEvidenceJson,
} from "./host-evidence.mjs";

export function prepareGoalRequest(input, requestRef) {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    "request required",
  );
  assert.ok(path.isAbsolute(requestRef), "absolute saved packet path required");
  assert.ok(
    Number.isInteger(input.attempt) && input.attempt >= 1 && input.attempt <= 4,
    "Attempt must be 1..4",
  );
  for (const field of ['taskId', 'phase'])
    assert.ok(typeof input[field] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(input[field]), 'Invalid ' + field);
  const request = Object.fromEntries(
    [
      "goalId",
      "taskId",
      "phase",
      "attempt",
      "agent",
      "task",
      "cwd",
      "sourceState",
    ].map((key) => [key, input[key]]),
  );
  if (input.sourcePaths !== undefined) {
    assert.ok(Array.isArray(input.sourcePaths) && input.sourcePaths.length > 0 && input.sourcePaths.length <= 200 && input.sourcePaths.every(x => typeof x === 'string' && x.trim()), 'bounded sourcePaths required');
    request.sourcePaths = input.sourcePaths;
  }
  if (input.work !== undefined) request.work = validateWork(input.agent, input.work);
  if (input.retry !== undefined) {
    assert.ok(input.retry && typeof input.retry === 'object', 'retry explanation required');
    assert.deepEqual(Object.keys(input.retry).sort(), ['evidence', 'reason'], 'retry needs reason and evidence');
    for (const field of ['reason', 'evidence'])
      assert.ok(typeof input.retry[field] === 'string' && input.retry[field].trim() && input.retry[field].length <= 1024, 'bounded retry ' + field + ' required');
    request.retry = input.retry;
  }
  if (input.checks !== undefined) {
    assert.ok(input.work, 'legacy checks must be moved into work.checks');
    assert.deepEqual(input.checks, input.work.checks, 'conflicting checks');
  }
  if (input.timeoutMs !== undefined) {
    assert.ok(
      Number.isSafeInteger(input.timeoutMs) &&
        input.timeoutMs > 0 &&
        input.timeoutMs <= 2147483647,
      "explicit native-compatible timeout required",
    );
    request.timeoutMs = input.timeoutMs;
  }
  for (const [key, value] of Object.entries(request)) {
    if (key !== "attempt" && key !== "timeoutMs" && key !== "work" && key !== "retry" && key !== "sourcePaths")
      assert.ok(typeof value === "string" && value.trim(), "missing " + key);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(request)) <= 64 * 1024,
    "packet must be at most 64 KiB",
  );
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  return {
    ...request,
    goalStatus: input.goalStatus,
    taskStatus: input.taskStatus,
    requestDigest,
    requestRef,
  };
}

export async function prepareGoalDispatch(input, requestRef) {
  assert.ok(
    typeof input.missionId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.missionId),
    "explicit mission id required",
  );
  assert.ok(
    input.goalStatus === "active" && input.taskStatus === "pending",
    "fresh active/pending snapshot required",
  );
  assert.ok(input.timeoutMs !== undefined, "parent must choose timeoutMs");
  assert.ok(Number.isInteger(input.attempt) && input.attempt >= 1 && input.attempt <= 4, 'Attempt must be 1..4');
  validateWork(input.agent, input.work);
  prepareGoalRequest({...input, sourceState: 'preflight-only'}, requestRef);
  const { prepareHandoff } = await import('./handoff-contract.mjs');
  await prepareHandoff({
    agent: input.agent, cwd: input.cwd, task: input.task,
    sourceState: 'preflight-only', output: 'goal-steps/preflight.md',
    timeoutMs: input.timeoutMs, criteria: input.work.criteria,
    checks: input.work.checks, work: input.work,
  });
  const source = snapshot(input.cwd, input.sourcePaths);
  for (const scope of input.sourcePaths) {
    const root = path.resolve(input.cwd, scope);
    assert.ok(
      requestRef !== root && !requestRef.startsWith(root + path.sep),
      "saved packet must be outside source scope",
    );
  }
  const request = prepareGoalRequest(
    { ...input, sourceState: "sha256:" + source.digest },
    requestRef,
  );
  const { requestDigest, requestRef: _originalRef, ...packet } = request;
  const packetPath = requestRef + "." + requestDigest + ".request.json";
  request.requestRef = packetPath;
  const binding = { goalId: request.goalId, cwd: request.cwd };
  const setupScript = [
    "const binding = " + JSON.stringify(binding) + ";",
    'const existing = await state.get("teamGoalBinding");',
    'if (existing && (existing.goalId !== binding.goalId || existing.cwd !== binding.cwd)) throw new Error("Mission binding mismatch");',
    'const active = await state.get("teamGoalActiveStep");',
    'if (active !== undefined && active !== null) throw new Error("Reconcile active intent before preparation");',
    'await state.set("teamGoalRequest", ' + JSON.stringify(request) + ");",
    'if (!existing) await state.set("teamGoalBinding", binding);',
    'return {status:"prepared", requestDigest:' +
      JSON.stringify(request.requestDigest) +
      "};",
  ].join("\n");
  const setupPath = requestRef + "." + request.requestDigest + ".workflow.txt";
  const common = {
    missionId: input.missionId,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    globalConcurrencyLimit: 1,
    maxSubagentSpawnsPerRun: 1,
  };
  return {
    packet,
    packetPath,
    setupScript,
    setupPath,
    setupArgs: { ...common, workflowScriptPath: setupPath, async: false },
    dispatchArgs: {
      ...common,
      workflowScriptPath: new URL("./goal-task-step.js", import.meta.url)
        .pathname,
      async: true,
      context: "fresh",
      extensionBindings: {
        "pi-goal-x.team-hold/1": {
          goalId: request.goalId,
          taskId: request.taskId,
          cwd: request.cwd,
        },
      },
    },
    sourceDigest: source.digest,
    requestDigest: request.requestDigest,
    ...(input.acceptanceContract
      ? {
          verificationContract: acceptanceReference(
            path.resolve(input.cwd, input.acceptanceContract),
            {
              cwd: request.cwd,
              goalId: request.goalId,
              taskId: request.taskId,
            },
          ),
        }
      : {}),
  };
}

if (process.argv[1] === import.meta.filename) {
  try {
    const dispatch = process.argv[2] === "--dispatch";
    assert.equal(
      process.argv.length,
      dispatch ? 4 : 3,
      "usage: goal-request.mjs [--dispatch] /absolute/saved-request.json",
    );
    const file = fs.realpathSync(process.argv[dispatch ? 3 : 2]);
    const stat = fs.statSync(file);
    assert.ok(
      stat.isFile() && stat.size <= 70 * 1024,
      "bounded regular packet file required",
    );
    const input = JSON.parse(fs.readFileSync(file, "utf8"));
    if (dispatch) {
      const { packet, packetPath, setupScript, setupPath, ...prepared } =
        await prepareGoalDispatch(input, file);
      try {
        saveEvidenceJson(packetPath, packet);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.equal(
          fs.realpathSync(packetPath),
          packetPath,
          "packet cannot be a symlink",
        );
        const saved = JSON.parse(fs.readFileSync(packetPath, "utf8"));
        assert.equal(
          prepareGoalRequest(saved, packetPath).requestDigest,
          prepared.requestDigest,
          "saved effective packet changed",
        );
        assert.equal(saved.goalStatus, packet.goalStatus);
        assert.equal(saved.taskStatus, packet.taskStatus);
      }
      try {
        fs.writeFileSync(setupPath, setupScript, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.equal(
          fs.lstatSync(setupPath).isSymbolicLink(),
          false,
          "setup script cannot be a symlink",
        );
        assert.equal(
          fs.readFileSync(setupPath, "utf8"),
          setupScript,
          "existing setup script changed",
        );
      }
      console.log(JSON.stringify(prepared, null, 2));
    } else
      console.log(JSON.stringify(prepareGoalRequest(input, file), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
