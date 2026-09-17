import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest, validateEvent } from "./contracts.mjs";
import { readEvidenceBytes } from "../host-evidence.mjs";

export function processStartTicks(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${processId}/stat`, "utf8");
    return stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return null;
  }
}

// Shared by Worker admission and leaf request reservations. Reuse the original
// L0 process/instance boundary; a pooled role must not outlive its admission.
export function assertLiveController(executionRoot, owner) {
  assert.ok(
    !fs.existsSync(path.join(executionRoot, "receipts/controller-ended.json")),
    "L0 session admission ended",
  );
  assert.match(
    owner?.instanceId ?? "",
    /^[a-f0-9-]{36}$/,
    "L0 instance admission unavailable",
  );
  assert.ok(
    owner?.ownerSessionId && /^\d+$/.test(owner.processStartedAtTicks ?? ""),
    "L0 process identity unavailable",
  );
  assert.equal(
    processStartTicks(owner.processId),
    owner.processStartedAtTicks,
    "L0 process is no longer the granted owner",
  );
}

// Foreground workflow children are sessions in the recorded host, not detached
// runners. This separate receipt never claims that the host process has exited.
function hostedWorkflowTerminal(status, launch) {
  const declared = launch.hostedWorkflow;
  assert.equal(declared?.version, 1, "hosted lifecycle declaration missing");
  assert.ok(
    Number.isSafeInteger(declared.pid) && declared.pid > 0,
    "hosted process identity missing",
  );
  assert.equal(status.pid, declared.pid, "hosted process identity changed");
  assert.equal(status.mode, "workflow", "hosted workflow mode changed");
  const inventory = status.workflowChildren;
  assert.equal(inventory?.version, 1, "hosted child inventory missing");
  assert.equal(
    inventory.workflowRunId,
    launch.runId,
    "hosted inventory run changed",
  );
  assert.equal(
    inventory.inventoryComplete,
    true,
    "hosted inventory incomplete",
  );
  const completion = status.state === "complete" ? "completed" : status.state;
  assert.equal(
    inventory.workflowState,
    completion,
    "hosted workflow still unresolved",
  );
  assert.equal(
    inventory.children?.length,
    launch.members.length,
    "hosted child count changed",
  );
  assert.equal(
    status.steps?.length,
    launch.members.length,
    "hosted step count changed",
  );
  const ids = new Set([launch.runId]);
  const children = launch.members.map((member) => {
    const matches = status.steps.filter(
      (step) => step.workflowKey === member.key,
    );
    assert.equal(
      matches.length,
      1,
      "hosted step identity missing or duplicated",
    );
    const step = matches[0];
    assert.equal(step.agent, member.role, "hosted role changed");
    assert.equal(step.async, false, "hosted child is not in-process");
    assert.match(step.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(!ids.has(step.runId), "hosted child identity reused");
    ids.add(step.runId);
    assert.ok(
      ["complete", "completed", "failed", "stopped", "rejected"].includes(
        step.status,
      ),
      "hosted child unresolved",
    );
    assert.ok(
      step.children === undefined ||
        (Array.isArray(step.children) && step.children.length === 0),
      "nested hosted children unsupported",
    );
    const rows = inventory.children.filter(
      (child) => child.childId === member.key,
    );
    assert.equal(
      rows.length,
      1,
      "hosted inventory identity missing or duplicated",
    );
    const child = rows[0];
    assert.equal(child.runId, step.runId, "hosted child run changed");
    assert.equal(child.agent, member.role, "hosted child agent changed");
    assert.equal(
      child.state,
      step.status === "complete" ? "completed" : step.status,
      "hosted child settlement changed",
    );
    return {
      key: member.key,
      runId: step.runId,
      agent: step.agent,
      state: child.state,
    };
  });
  return {
    version: 1,
    state: "settled",
    runId: launch.runId,
    pid: status.pid,
    owner: status.sessionId,
    inventoryDigest: digest({ completion, children }),
  };
}

// Preserve public SingleResult fields; status.steps is only a display projection.
export function nativeWorkflowResult(status, step) {
  const rows = status.workflow?.value?.filter(
    (row) => row.key === step.workflowKey,
  );
  assert.equal(rows?.length, 1, "native result key missing or duplicated");
  const row = rows[0];
  assert.equal(row.runId, step.runId, "native result run changed");
  assert.equal(row.nativeResults?.length, 1, "native single result missing");
  const result = row.nativeResults[0];
  assert.equal(result.index, 0, "native result index changed");
  assert.equal(result.agent, step.agent, "native result agent changed");
  assert.equal(
    result.sessionFile,
    step.sessionFile,
    "native result session changed",
  );
  for (const key of Object.keys(result)) {
    if (Object.hasOwn(step, key))
      assert.deepEqual(
        step[key],
        result[key],
        `native result ${key} projections disagree`,
      );
  }
  return { ...step, ...result };
}

// Cancellation uses the same durable launch/terminal records as dispatch, not a
// reconstructed controller's empty RAM counters. This is not a resume grant.
export function readRoleLifecycle(mailbox, contract, workerSessionId) {
  const plans = new Map(
    fs
      .readdirSync(path.join(mailbox.root, "receipts"))
      .filter((name) => name.startsWith("wave-plan-") && name.endsWith(".json"))
      .sort()
      .map((name) => [
        name.slice(10, -5),
        mailbox.readJson(`receipts/${name}`),
      ]),
  );
  assert.ok(
    plans.size <= contract.policy.maxRoleSpawnsPerTask,
    "role lifecycle inventory exceeds budget",
  );
  const rows = [];
  const eventIds = new Set(),
    sequences = new Set();
  for (const event of mailbox.listEvents()) {
    validateEvent(event);
    assert.equal(
      event.executionId,
      contract.identity.executionId,
      "lifecycle execution mismatch",
    );
    assert.equal(
      event.ownerEpoch,
      contract.identity.ownerEpoch,
      "lifecycle epoch mismatch",
    );
    assert.equal(
      event.workerSessionId,
      workerSessionId,
      "lifecycle Worker mismatch",
    );
    assert.ok(
      !eventIds.has(event.eventId) && !sequences.has(event.sequence),
      "duplicate lifecycle event",
    );
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
    assert.equal(
      mailbox.digestRelative(event.payloadRef),
      event.payloadDigest,
      "lifecycle payload changed",
    );
    if (event.type !== "progress") continue;
    const row = mailbox.readJson(event.payloadRef, 16 * 1024);
    if (!row.kind?.startsWith("role-")) continue;
    assert.ok(
      [
        "role-wave-launch-intent",
        "role-launch-intent",
        "role-started",
        "role-completion",
        "role-terminal",
        "role-stop-intent",
        "role-launch-unknown",
      ].includes(row.kind),
      "unknown role lifecycle event",
    );
    const launchId =
      row.kind === "role-wave-launch-intent"
        ? path.basename(event.payloadRef).slice(9, -5)
        : (row.rootLaunchId ?? row.launchId);
    assert.ok(plans.has(launchId), "role lifecycle lacks its launch plan");
    rows.push({ ...row, launchId });
  }
  const runIds = new Set();
  return [...plans].map(([launchId, plan]) => {
    assert.match(launchId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(
      Array.isArray(plan.runs) &&
        plan.runs.length > 0 &&
        plan.runs.length <= 64,
      "bounded role lifecycle plan required",
    );
    const selected = rows.filter((row) => row.launchId === launchId);
    const one = (kind) => {
      const matches = selected.filter((row) => row.kind === kind);
      assert.ok(matches.length <= 1, `duplicate ${kind}`);
      return matches[0];
    };
    const started = one("role-started"),
      completed = one("role-completion"),
      terminal = one("role-terminal");
    const members = plan.runs.map(
      ({ key, role, mode, isolation, maxTokens, task }) => ({
        key,
        role,
        mode,
        isolation,
        maxTokens,
        taskDigest: digest(task),
      }),
    );
    const admitted = selected.filter(
      (row) => row.kind === "role-launch-intent",
    );
    if (started) {
      assert.match(started.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
      assert.ok(!runIds.has(started.runId), "reused lifecycle run identity");
      runIds.add(started.runId);
      assert.deepEqual(
        started.members,
        members,
        "lifecycle membership changed",
      );
      assert.deepEqual(
        admitted.map(({ role, mode, maxTokens }) => ({
          role,
          mode,
          maxTokens,
        })),
        members.map(({ role, mode, maxTokens }) => ({ role, mode, maxTokens })),
        "lifecycle admission incomplete",
      );
      assert.ok(
        one("role-wave-launch-intent"),
        "lifecycle wave intent missing",
      );
    }
    for (const row of [completed, terminal, one("role-stop-intent")].filter(
      Boolean,
    ))
      assert.equal(row.runId, started?.runId, "lifecycle run binding changed");
    if (completed)
      assert.ok(
        ["completed", "failed", "stopped"].includes(completed.completion),
        "unknown role completion",
      );
    if (started?.hostedWorkflow) {
      assert.equal(
        contract.schemaVersion,
        "teams-task-runtime/3",
        "hosted lifecycle requires v3",
      );
      assert.deepEqual(
        started.hostedWorkflow,
        plan.hostedWorkflow,
        "hosted launch declaration changed",
      );
      const boot = mailbox.readJson("receipts/boot.json");
      assert.equal(
        started.hostedWorkflow.pid,
        boot.processId,
        "hosted launch is not the Worker",
      );
    }
    if (terminal) {
      assert.equal(
        terminal.completion,
        completed?.completion,
        "lifecycle completion missing or changed",
      );
      if (terminal.hostedTerminal) {
        const proof = terminal.hostedTerminal;
        assert.equal(
          terminal.processTerminal,
          null,
          "hosted receipt must not claim runner exit",
        );
        assert.equal(proof.version, 1);
        assert.equal(proof.state, "settled");
        assert.equal(proof.runId, started.runId);
        assert.equal(proof.pid, started.hostedWorkflow?.pid);
        assert.ok(
          [
            workerSessionId,
            mailbox.readJson("receipts/boot.json").workerSessionFile,
          ].includes(proof.owner),
          "hosted owner changed",
        );
        assert.match(proof.inventoryDigest, /^[a-f0-9]{64}$/);
      } else {
        assert.equal(
          terminal.processTerminal?.version,
          1,
          "native terminal version missing",
        );
        if (terminal.processTerminal?.state === "not-started") {
          const boot = mailbox.readJson("receipts/boot.json");
          const launch = { ...started, members };
          const owners = [workerSessionId, boot.workerSessionFile];
          const verified = readNativeTerminal(
            launch,
            owners,
            () =>
              readNativeTerminalBytes(
                mailbox,
                launch,
                owners,
                `role-${launchId}`,
              ).bytes,
          );

          assert.equal(
            terminal.completion,
            "failed",
            "no-start must remain failed",
          );
          assert.deepEqual(
            verified?.processTerminal,
            terminal.processTerminal,
            "no-start terminal evidence changed",
          );
        } else
          assert.equal(
            terminal.processTerminal?.state,
            "observed",
            "native terminal not observed",
          );
        assert.equal(
          terminal.processTerminal?.runId,
          started.runId,
          "native terminal run mismatch",
        );
        assert.match(
          terminal.processTerminal.runnerProcessInstanceId,
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
        );
      }
    }
    return {
      ...started,
      launchId,
      waveKey: plan.key,
      members,
      maxTokens: members.reduce((sum, member) => sum + member.maxTokens, 0),
      runId: started?.runId ?? null,
      completion: completed?.completion ?? null,
      processTerminal: terminal?.processTerminal ?? null,
      hostedTerminal: terminal?.hostedTerminal ?? null,
      terminal: Boolean(terminal) && !one("role-launch-unknown"),
      stopRequested: Boolean(one("role-stop-intent")),
    };
  });
}

// Process termination, not product success or budget admission. Failed/stopped
// native runs still need a complete, non-nested member inventory.
export function readNativeTerminal(launch, owners, read = readEvidenceBytes) {
  const bytes = read(path.join(launch.asyncDir, "status.json"), 1024 * 1024);
  let status;
  try {
    status = JSON.parse(bytes);
  } catch (cause) {
    throw new Error("invalid native cancellation status", { cause });
  }
  assert.equal(status.runId, launch.runId, "native cancellation run mismatch");
  assert.ok(
    owners.filter(Boolean).includes(status.sessionId),
    "native cancellation owner mismatch",
  );
  if (!["complete", "failed", "stopped"].includes(status.state)) return null;
  const proof = status.processTerminal;
  if (launch.hostedWorkflow && !Object.hasOwn(status, "processTerminal")) {
    return {
      completion: status.state === "complete" ? "completed" : status.state,
      hostedTerminal: hostedWorkflowTerminal(status, launch),
    };
  }
  assert.equal(proof?.version, 1, "native cancellation proof missing");
  const notStarted = proof.state === "not-started";
  if (notStarted) {
    // Legacy pre-proceed records may have spawned a runner. They cannot prove
    // zero execution: only the explicit pre-spawn producer reason qualifies.
    assert.equal(
      proof.reason,
      "spawn-not-attempted",
      "no-start boundary unproven",
    );
    assert.equal(status.state, "failed", "no-start must remain failed");
    assert.equal(status.pid, undefined, "no-start has a runner pid");
    assert.ok(
      typeof launch.sessionDir === "string",
      "no-start session root required",
    );
    assert.equal(
      status.sessionRoot,
      launch.sessionDir,
      "no-start session root changed",
    );
  } else
    assert.equal(
      proof.state,
      "observed",
      "native cancellation process not observed",
    );
  assert.equal(
    proof.runId,
    launch.runId,
    "native cancellation proof run mismatch",
  );
  assert.match(
    proof.runnerProcessInstanceId,
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  );
  assert.equal(
    status.steps?.length,
    launch.members.length,
    "native cancellation inventory incomplete",
  );
  const selected = new Set();
  for (const member of launch.members) {
    const step =
      launch.mode === "wave" || status.workflow
        ? status.steps.find((row) => row.workflowKey === member.key)
        : status.steps[0];
    assert.ok(
      step && !selected.has(step),
      "native cancellation member missing or reused",
    );
    selected.add(step);
    assert.equal(step.agent, member.role, "native cancellation member changed");
    if (notStarted) {
      assert.equal(step.status, "failed", "no-start member must be failed");
      assert.equal(
        step.sessionFile,
        undefined,
        "no-start member has a session",
      );
      assert.equal(step.pid, undefined, "no-start member has a pid");
    }
    assert.ok(
      ["complete", "completed", "failed", "stopped", "rejected"].includes(
        step.status,
      ),
      "native cancellation child still unresolved",
    );
    assert.ok(
      step.children === undefined ||
        (Array.isArray(step.children) && step.children.length === 0),
      "nested cancellation inventory unsupported",
    );
  }
  return {
    completion: status.state === "complete" ? "completed" : status.state,
    processTerminal: proof,
  };
}

// An RPC error is still a failure. Recover only its correlated native identity
// and independently verify the producer's durable pre-spawn terminal record.
export function readNativeStartFailure(error, launch, owners) {
  if (
    error?.code !== "execution_failed" ||
    error.details?.lifecycleStatus?.processTerminal?.state !== "not-started"
  )
    return null;
  assert.match(
    error.requestId,
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "no-start RPC identity missing",
  );
  const { runId, asyncDir, lifecycleStatus } = error.details;
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.ok(
    typeof asyncDir === "string" &&
      path.isAbsolute(asyncDir) &&
      path.resolve(asyncDir) === asyncDir,
    "no-start native directory invalid",
  );
  const verified = readNativeTerminal({ ...launch, runId, asyncDir }, owners);
  assert.equal(verified?.completion, "failed", "no-start failure missing");
  assert.deepEqual(
    verified.processTerminal,
    lifecycleStatus.processTerminal,
    "no-start RPC and durable proof differ",
  );
  return { runId, asyncDir, processTerminal: verified.processTerminal };
}

export function readNativeTerminalBytes(mailbox, launch, owners, key) {
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  const relative = `receipts/cancel-native-${key}.json`;
  const origin = path.join(launch.asyncDir, "status.json");
  const binding = {
    origin,
    runId: launch.runId,
    owners: owners.filter(Boolean),
    membersDigest: digest(launch.members),
  };
  let bytes, saved;
  if (fs.existsSync(path.join(mailbox.root, relative))) {
    saved = mailbox.readJson(relative, 2 * 1024 * 1024);
    assert.deepEqual(
      saved.binding,
      binding,
      "cancel native capture binding changed",
    );
    assert.equal(typeof saved.base64, "string", "cancel native bytes missing");
    bytes = Buffer.from(saved.base64, "base64");
    assert.equal(
      bytes.toString("base64"),
      saved.base64,
      "cancel native encoding changed",
    );
    assert.ok(bytes.length <= 1024 * 1024, "cancel native capture too large");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      saved.sha256,
      "cancel native capture changed",
    );
  } else bytes = readEvidenceBytes(origin, 1024 * 1024);
  return { bytes, binding, saved: Boolean(saved), relative };
}

export function captureNativeTerminal(
  mailbox,
  launch,
  owners,
  key,
  read = readEvidenceBytes,
) {
  // Existing review captures already supply durable, SHA-bound bytes.
  if (read !== readEvidenceBytes)
    return readNativeTerminal(launch, owners, read);
  const { bytes, binding, saved, relative } = readNativeTerminalBytes(
    mailbox,
    launch,
    owners,
    key,
  );
  const proof = readNativeTerminal(launch, owners, () => bytes);
  if (proof && !saved)
    mailbox.writeJson(
      relative,
      {
        binding,
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      2 * 1024 * 1024,
    );
  return proof;
}

export function readReviewLifecycle(
  mailbox,
  contract,
  ownerSessionId,
  readTerminal = readNativeTerminal,
) {
  const root = path.join(mailbox.root, "integration/reviews");
  if (!fs.existsSync(root)) return [];
  assert.equal(
    fs.realpathSync(root),
    root,
    "canonical review inventory required",
  );
  const entries = fs.readdirSync(root).sort();
  assert.ok(
    entries.length <= contract.policy.maxRoleSpawnsPerTask + 1,
    "review cancellation inventory exceeds bounds",
  );
  const runIds = new Set();
  return entries.map((key) => {
    if (key === "operation.lock") return { key, runId: null, terminal: false };
    assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    const dir = `integration/reviews/${key}`;
    const plan = mailbox.readJson(`${dir}/plan.json`);
    const { planDigest, ...body } = plan;
    assert.equal(plan.schemaVersion, "teams-review-wave-plan/1");
    assert.equal(digest(body), planDigest, "review cancellation plan changed");
    assert.equal(plan.key, key, "review cancellation key changed");
    assert.equal(
      plan.ownerSessionId,
      ownerSessionId,
      "review cancellation controller changed",
    );
    assert.equal(
      plan.contractDigest,
      digest(contract),
      "review cancellation contract changed",
    );
    assert.equal(
      plan.sessionDir,
      path.join(root, key, "sessions"),
      "review cancellation session root changed",
    );
    assert.ok(
      Array.isArray(plan.wave?.runs) &&
        plan.wave.runs.length > 0 &&
        plan.wave.runs.length <= 64,
      "review cancellation members missing",
    );
    const exists = (name) => fs.existsSync(path.join(mailbox.root, dir, name));
    const binding = {
      key,
      dir,
      planDigest,
      nativeOwner: plan.nativeOwner,
      runId: null,
      terminal: false,
    };
    if (!exists("launch-intent.json")) {
      assert.ok(
        !exists("started.json") &&
          !exists("unknown.json") &&
          !exists("complete.json"),
        "review cancellation intent missing",
      );
      return { ...binding, terminal: true, disposition: "not-started" };
    }
    const intent = mailbox.readJson(`${dir}/launch-intent.json`);
    assert.equal(intent.schemaVersion, "teams-review-launch-intent/2");
    assert.equal(
      intent.planDigest,
      planDigest,
      "review cancellation intent changed",
    );
    assert.equal(
      intent.paramsDigest,
      digest(intent.params),
      "review cancellation dispatch changed",
    );
    assert.equal(
      intent.params.sessionDir,
      plan.sessionDir,
      "review cancellation dispatch session changed",
    );
    if (!exists("started.json")) return binding; // Ambiguous spawn is not zero runs.
    const started = mailbox.readJson(`${dir}/started.json`);
    assert.equal(started.schemaVersion, "teams-review-started/1");
    assert.equal(
      started.planDigest,
      planDigest,
      "review cancellation started plan changed",
    );
    assert.equal(
      started.nativeOwner,
      plan.nativeOwner,
      "review cancellation native owner changed",
    );
    assert.match(started.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(!runIds.has(started.runId), "review cancellation run reused");
    runIds.add(started.runId);
    assert.ok(
      typeof started.asyncDir === "string" &&
        path.isAbsolute(started.asyncDir) &&
        path.resolve(started.asyncDir) === started.asyncDir,
      "canonical native review directory required",
    );
    const launch = {
      ...binding,
      runId: started.runId,
      asyncDir: started.asyncDir,
      sessionDir: plan.sessionDir,
      mode: "wave",
      ...(plan.hostedWorkflow ? { hostedWorkflow: plan.hostedWorkflow } : {}),
      members: plan.wave.runs.map(({ key, role }) => ({ key, role })),
    };
    let read = readEvidenceBytes;
    if (exists("complete.json")) {
      const complete = mailbox.readJson(`${dir}/complete.json`);
      assert.equal(complete.schemaVersion, "teams-review-wave-completion/1");
      assert.equal(
        complete.planDigest,
        planDigest,
        "review cancellation completion changed",
      );
      assert.equal(
        complete.runId,
        started.runId,
        "review cancellation completion run changed",
      );
      assert.equal(
        complete.requestDigest,
        plan.requestDigest,
        "review cancellation completion request changed",
      );
      read = (origin, limit = 1024 * 1024) => {
        const matches = complete.captures.filter(
          (capture) => capture.origin === origin,
        );
        assert.equal(
          matches.length,
          1,
          "review cancellation capture missing or repeated",
        );
        const capture = matches[0];
        assert.match(capture.saved, /^captures\/\d+\.bin$/);
        const bytes = readEvidenceBytes(
          path.join(mailbox.root, dir, capture.saved),
          limit,
        );
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          capture.sha256,
          "review cancellation capture changed",
        );
        return bytes;
      };
    }
    try {
      const proof = readTerminal(launch, [plan.nativeOwner], read);
      return { ...launch, terminal: Boolean(proof), proof };
    } catch (error) {
      return {
        ...launch,
        error: String(error.message ?? error).slice(0, 1000),
      };
    }
  });
}
