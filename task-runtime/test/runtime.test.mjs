import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalBytes,
  digest,
  validateTaskContract,
  validateTaskResult,
  taskPreparationDiagnostics,
  isRelocatableCheck,
} from "../contracts.mjs";
import { RuntimeLedger } from "../ledger.mjs";
import { Mailbox } from "../mailbox.mjs";
import { TaskOrchestrator, deriveProjectId } from "../orchestrator.mjs";
import { WorkerRuntime, buildTaskPrompt } from "../worker-runtime.mjs";
import {
  captureWorkspace,
  verifyWorkspaceScope,
  verifyWorkspaceResult,
} from "../workspace-scope.mjs";

const sha = "a".repeat(64);

function fixture(root, overrides = {}) {
  return {
    schemaVersion: "teams-task-runtime/1",
    identity: {
      projectId: "project-1",
      goalId: "goal-1",
      taskId: "task-1",
      taskRevision: 1,
      executionId: "11111111-1111-4111-8111-111111111111",
      ownerEpoch: 1,
    },
    objective: "Produce the bounded outcome.",
    nonGoals: ["Do not deploy."],
    workspace: {
      sourceRoot: root,
      worktreePath: null,
      baseCommit: "b".repeat(40),
      sourcePaths: ["src"],
      allowedWritePaths: ["src"],
    },
    criteria: [
      {
        id: "criterion-1",
        text: "The outcome is observable.",
        requiredEvidenceKinds: ["host-check"],
      },
    ],
    checks: [
      {
        commandId: "check-1",
        executable: process.execPath,
        argv: ["--version"],
        cwd: root,
        timeoutMs: 30_000,
        expectedExitCode: 0,
        criterionIds: ["criterion-1"],
      },
    ],
    policy: {
      risk: "medium",
      allowedRoles: ["team.implementer"],
      maxActiveRoleRuns: 1,
      maxRoleSpawnsPerTask: 8,
      maxProductRepairsPerRole: 3,
      maxReportRepairs: 1,
      maxProcessRestarts: 1,
      maxTaskTokens: 100_000,
      deadlineMs: 3_600_000,
      integrationMode: "verify-only",
    },
    contextRefs: [],
    ...overrides,
  };
}

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-runtime-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export default 1;\n");
  return root;
}

test("v3 known product defects remain honest review-only candidates, never acceptance-ready", (t) => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root, { schemaVersion: "teams-task-runtime/3" });
  contract.policy.allowedRoles.push("team.reviewer");
  contract.policy.review = {
    authority: "l0-source-bound",
    allowedRoles: ["team.reviewer"],
    allowedTools: ["read"],
  };
  const result = {
    schemaVersion: "teams-task-result/1",
    identity: contract.identity,
    requestDigest: digest(contract),
    resultRevision: 1,
    outcome: "ready_for_review",
    summary:
      "Complete controlled candidate with a known escaping defect; request independent L0 review.",
    source: {
      baseCommit: contract.workspace.baseCommit,
      sourceDigest: sha,
      manifestRef: "receipts/source.json",
    },
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "not_met",
        observation: "Backslashes are not encoded by the complete candidate.",
        evidenceIds: [],
      },
    ],
    evidence: [],
    childRunRefs: ["completed-writer"],
    unresolvedRunCount: 0,
    risks: ["Product defect remains; no acceptance or target application."],
    usage: { inputTokens: null, outputTokens: null },
  };
  assert.equal(validateTaskResult(result, contract, digest(contract)), result);
  assert.equal(result.criterionResults[0].status, "not_met");
  assert.match(buildTaskPrompt(contract), /ready_for_review/);
  for (const mutate of [
    (r) => {
      r.outcome = "ready_for_acceptance";
    },
    (r) => {
      r.criterionResults[0].status = "needs_user";
    },
    (r) => {
      r.criterionResults[0].status = "indeterminate";
    },
    (r) => {
      r.unresolvedRunCount = 1;
    },
    (r) => {
      r.childRunRefs = [];
    },
  ]) {
    const invalid = structuredClone(result);
    mutate(invalid);
    assert.throws(() =>
      validateTaskResult(invalid, contract, digest(contract)),
    );
  }
  for (const version of ["teams-task-runtime/1", "teams-task-runtime/2"]) {
    const invalid = structuredClone(contract);
    invalid.schemaVersion = version;
    delete invalid.policy.review;
    const row = { ...result, requestDigest: digest(invalid) };
    assert.throws(
      () => validateTaskResult(row, invalid, digest(invalid)),
      /review-only requires v3 L0 review/,
    );
  }
  const missingReview = structuredClone(contract);
  delete missingReview.policy.review;
  assert.throws(
    () =>
      validateTaskResult(
        { ...result, requestDigest: digest(missingReview) },
        missingReview,
        digest(missingReview),
      ),
    /policy fields changed/,
  );
});

test("v3 Worker role subset restricts dispatch without changing total Task or L0 review authority", (t) => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = fixture(root, { schemaVersion: "teams-task-runtime/3" });
  legacy.policy.allowedRoles.push("team.reviewer");
  legacy.policy.review = {
    authority: "l0-source-bound",
    allowedRoles: ["team.reviewer"],
    allowedTools: ["read"],
  };
  assert.deepEqual(validateTaskContract(legacy), legacy);
  assert.equal(
    Object.hasOwn(validateTaskContract(legacy).policy, "workerAllowedRoles"),
    false,
  );
  const restricted = structuredClone(legacy);
  restricted.policy.workerAllowedRoles = ["team.implementer"];
  assert.deepEqual(validateTaskContract(restricted), restricted);
  assert.deepEqual(restricted.policy.review.allowedRoles, ["team.reviewer"]);
  assert.deepEqual(restricted.policy.allowedRoles, [
    "team.implementer",
    "team.reviewer",
  ]);
  assert.match(
    buildTaskPrompt(restricted),
    /Allowed Worker roles: team\.implementer\n/,
  );
  for (const roles of [
    [],
    null,
    "team.implementer",
    ["team.implementer", "team.implementer"],
    ["team.advisor"],
  ]) {
    const invalid = structuredClone(restricted);
    invalid.policy.workerAllowedRoles = roles;
    assert.throws(() => validateTaskContract(invalid), /worker|Worker/);
  }
  const old = fixture(root);
  old.policy.workerAllowedRoles = ["team.implementer"];
  assert.throws(() => validateTaskContract(old), /policy fields/);
});

test("preparation diagnostics expose capability gaps without rewriting requirements or commands", (t) => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root, { schemaVersion: "teams-task-runtime/3" });
  contract.criteria.push({
    id: "design",
    text: "Explain tradeoffs",
    requiredEvidenceKinds: ["source-review"],
  });
  contract.checks[0].argv = [path.join(root, "src/index.js")];
  const before = structuredClone(contract);
  assert.deepEqual(taskPreparationDiagnostics(contract), [
    {
      code: "unsupported-final-evidence",
      criterionId: "design",
      kinds: ["source-review"],
    },
    { code: "missing-final-host-check", criterionId: "design" },
    { code: "non-relocatable-check", commandId: "check-1" },
  ]);
  assert.deepEqual(contract, before);
  const prompt = buildTaskPrompt(contract);
  assert.match(prompt, /design \[source-review\]: Explain tradeoffs/);
  assert.equal(isRelocatableCheck({ executable: root, argv: [] }, root), false);
  assert.equal(
    isRelocatableCheck(
      { executable: process.execPath, argv: ["src/index.js"] },
      root,
    ),
    true,
  );
});

for (const version of ["teams-task-runtime/1", "teams-task-runtime/3"]) {
  test(`large sealed requirements stay bounded through E0 and E1: ${version}`, (t) => {
    const root = temp();
    const runtimeRoot = path.join(root, "runtime");
    const orchestrator = new TaskOrchestrator({
      runtimeRoot,
      ownerSessionId: "owner-1",
    });
    t.after(() => {
      orchestrator.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const contract = fixture(root, { schemaVersion: version });
    if (version.endsWith("/3")) {
      contract.policy.allowedRoles.push("team.reviewer");
      contract.policy.tokenBudgetMode = "shared";
      contract.policy.review = {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      };
    }
    const { identity, ...fields } = contract;
    const spec = {
      ...fields,
      goalId: identity.goalId,
      taskId: identity.taskId,
      taskRevision: 1,
    };
    const projectId = deriveProjectId(root);
    // Large product requirements stay in the sealed file, not repeated in the procedure.
    for (const oversized of [
      { ...spec, objective: "x".repeat(3500) },
      { ...spec, criteria: [{ ...spec.criteria[0], text: "需".repeat(1300) }] },
    ]) {
      const { goalId, taskId, taskRevision, ...contractFields } = oversized;
      validateTaskContract({
        ...contractFields,
        identity: { ...identity, goalId, taskId, taskRevision },
      });
      const referenced = {
        ...contractFields,
        identity: { ...identity, goalId, taskId, taskRevision },
      };
      const contractRef = path.join(
        runtimeRoot,
        "projects",
        projectId,
        "executions",
        identity.executionId,
        "task-request.json",
      );
      const e0 = buildTaskPrompt(referenced, contractRef);
      const e1 = buildTaskPrompt(
        referenced,
        contractRef,
        path.join(path.dirname(contractRef), "receipts/repair-intent.json"),
        true,
      );
      assert.ok(Buffer.byteLength(e0) <= 6144);
      assert.ok(
        Buffer.byteLength(e1) <= 6144,
        "unchanged contract must remain usable in E1",
      );
      assert.match(e1, /Read the complete sealed contract before assigning/);
      assert.ok(
        !e1.includes(oversized.objective),
        "do not duplicate product requirements in procedure prompt",
      );
      assert.deepEqual(
        orchestrator.ledger.listTaskExecutions(
          projectId,
          spec.goalId,
          spec.taskId,
        ),
        [],
      );
      assert.deepEqual(orchestrator.ledger.listOpen(projectId), []);
      assert.equal(
        fs.existsSync(
          path.join(runtimeRoot, "projects", projectId, "executions"),
        ),
        false,
      );
    }
    spec.objective = "x".repeat(3500);
    spec.criteria = [{ ...spec.criteria[0], text: "需".repeat(1300) }];
    if (version.endsWith("/3")) {
      spec.policy.reviewProductRevision = "within-scope-once";
      spec.contextRefs = [{ uri: "src/index.js", sha256: sha }];
      assert.throws(
        () => orchestrator.prepare(spec),
        (error) =>
          error.phase === "task-context-ref" &&
          /contextRef SHA-256 mismatch: src\/index.js/.test(error.message),
      );
      assert.deepEqual(
        orchestrator.ledger.listTaskExecutions(
          projectId,
          spec.goalId,
          spec.taskId,
        ),
        [],
      );
      assert.deepEqual(orchestrator.ledger.listOpen(projectId), []);
      spec.contextRefs[0].sha256 = createHash("sha256")
        .update(fs.readFileSync(path.join(root, "src/index.js")))
        .digest("hex");
    }
    // Same Task can be corrected before reservation; no failed execution used a restart.
    const prepared = orchestrator.prepare(spec);
    const worker = new WorkerRuntime({ executionRoot: prepared.executionRoot });
    const sessionFile = path.join(
      prepared.executionRoot,
      "worker-sessions/worker.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session", id: "worker-1", cwd: root }) + "\n",
    );
    worker.boot({
      sessionId: "worker-1",
      sessionFile,
      cwd: root,
      activeTools: ["read", "team_role_spawn", "team_task_result"],
      extensions: ["teams-worker", "pi-subagents"],
      subagents: { compatible: true, checks: {}, ping: { version: 1 } },
    });
    const mailbox = Mailbox.open(prepared.executionRoot, prepared.executionId);
    mailbox.writeCommand({
      schemaVersion: "teams-task-control/1",
      commandId: `grant-${prepared.executionId}`,
      executionId: prepared.executionId,
      ownerEpoch: prepared.ownerEpoch,
      requestDigest: prepared.requestDigest,
      type: "grant",
      payload: {},
    });
    const started = worker.processControls();
    assert.equal(started.started, true);
    assert.equal(
      started.prompt,
      buildTaskPrompt(
        worker.contract,
        path.join(prepared.executionRoot, "task-request.json"),
      ),
    );
    assert.ok(
      started.prompt.includes(
        path.join(prepared.executionRoot, "task-request.json"),
      ),
    );
    assert.deepEqual(worker.contract.criteria, spec.criteria);
    assert.equal(worker.contract.objective, spec.objective);
    assert.ok(Buffer.byteLength(started.prompt) <= 6144);
  });
}

test("prompt limit counts UTF-8 bytes, accepts exactly 6144 and retains Worker guard", (t) => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root, { objective: "任務" });
  const mailbox = { root };
  const room = 6144 - Buffer.byteLength(buildTaskPrompt(contract));
  contract.objective += "x".repeat(room);
  assert.equal(Buffer.byteLength(buildTaskPrompt(contract)), 6144);
  contract.objective += "x";
  assert.throws(() => buildTaskPrompt(contract), /6145 bytes > 6144 bytes/);
  contract.objective = "任務";
  const workerRoom =
    6144 -
    Buffer.byteLength(
      WorkerRuntime.prototype.taskPrompt.call({ contract, mailbox }),
    );
  mailbox.root += "x".repeat(workerRoom);
  assert.equal(
    Buffer.byteLength(
      WorkerRuntime.prototype.taskPrompt.call({ contract, mailbox }),
    ),
    6144,
  );
  mailbox.root += "x";
  assert.throws(
    () => WorkerRuntime.prototype.taskPrompt.call({ contract, mailbox }),
    /6145 bytes > 6144 bytes/,
  );
});

test("opted-in E0 admission reserves prompt space for immutable E1 before allocating", (t) => {
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(root, { schemaVersion: "teams-task-runtime/3" });
  Object.assign(contract.policy, {
    tokenBudgetMode: "shared",
    reviewProductRevision: "within-scope-once",
    review: {
      authority: "l0-source-bound",
      allowedRoles: ["team.reviewer"],
      allowedTools: ["read"],
    },
    allowedRoles: [
      "team.reviewer",
      ...Array.from({ length: 15 }, (_, i) => `team.${i}.`.padEnd(128, "r")),
    ],
  });
  validateTaskContract(contract);
  const projectId = deriveProjectId(root);
  let runtimeRoot = path.join(root, "runtime");
  const ref = () =>
    path.join(
      runtimeRoot,
      "projects",
      projectId,
      "executions",
      contract.identity.executionId,
      "task-request.json",
    );
  while (Buffer.byteLength(buildTaskPrompt(contract, ref())) < 6000) {
    const room = 6000 - Buffer.byteLength(buildTaskPrompt(contract, ref()));
    runtimeRoot = path.join(
      runtimeRoot,
      "p".repeat(Math.min(200, Math.max(1, room - 1))),
    );
  }
  assert.ok(Buffer.byteLength(buildTaskPrompt(contract, ref())) <= 6144);
  assert.throws(
    () =>
      buildTaskPrompt(
        contract,
        ref(),
        path.join(path.dirname(ref()), "receipts/repair-intent.json"),
        true,
      ),
    /exceeds 6 KiB/,
  );
  const orchestrator = new TaskOrchestrator({
    runtimeRoot,
    ownerSessionId: "owner-1",
  });
  t.after(() => orchestrator.close());
  const { identity, ...fields } = contract;
  assert.throws(
    () =>
      orchestrator.prepare({
        ...fields,
        goalId: identity.goalId,
        taskId: identity.taskId,
        taskRevision: 1,
      }),
    (error) => error.phase === "task-prompt",
  );
  assert.deepEqual(
    orchestrator.ledger.listTaskExecutions(
      projectId,
      identity.goalId,
      identity.taskId,
    ),
    [],
  );
  assert.equal(
    fs.existsSync(path.join(runtimeRoot, "projects", projectId, "executions")),
    false,
  );
});

test("D6 permits official Goal metadata only in the source project without granting Worker writes", (t) => {
  const root = temp(),
    worktree = temp();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });
  for (const cwd of [root, worktree]) {
    fs.mkdirSync(path.join(cwd, ".pi/goals"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi/goals/active_goal_probe.md"),
      "synthetic metadata: pending\n",
    );
  }
  const base = fixture(root);
  const contract = validateTaskContract({
    ...base,
    schemaVersion: "teams-task-runtime/3",
    workspace: { ...base.workspace, worktreePath: worktree },
    policy: {
      ...base.policy,
      allowedRoles: ["team.implementer", "team.reviewer"],
      review: {
        authority: "l0-source-bound",
        allowedRoles: ["team.reviewer"],
        allowedTools: ["read"],
      },
    },
  });
  const runtime = path.join(root, "runtime");
  const mailbox = Mailbox.create(
    runtime,
    contract.identity.projectId,
    contract.identity.executionId,
  );
  const baseline = captureWorkspace(contract, runtime);
  mailbox.writeBootstrap({ workspaceBaselineDigest: digest(baseline) });
  mailbox.writeReceipt("workspace-baseline", baseline);
  const result = { outcome: "ready_for_acceptance", resultRevision: 1 };
  mailbox.writeReceipt("workspace-r1", {
    resultDigest: digest(result),
    state: baseline,
  });
  verifyWorkspaceResult(contract, mailbox, result);
  const goalFile = path.join(root, ".pi/goals/active_goal_probe.md");
  fs.writeFileSync(goalFile, "synthetic metadata: complete\n");
  assert.deepEqual(verifyWorkspaceResult(contract, mailbox, result), baseline);
  fs.mkdirSync(path.join(root, ".pi/goals/archived"));
  fs.renameSync(goalFile, path.join(root, ".pi/goals/archived/probe.md"));
  assert.deepEqual(verifyWorkspaceResult(contract, mailbox, result), baseline);
  const poolFile = path.join(root, ".pi/.goals-pool-snapshot.json");
  fs.writeFileSync(poolFile, "{}");
  assert.deepEqual(verifyWorkspaceResult(contract, mailbox, result), baseline);
  fs.writeFileSync(poolFile, '{"updated":true}');
  assert.deepEqual(verifyWorkspaceResult(contract, mailbox, result), baseline);
  fs.unlinkSync(poolFile);
  fs.mkdirSync(poolFile);
  assert.throws(
    () => verifyWorkspaceScope(contract, mailbox),
    /must be a regular file/,
  );
  fs.rmdirSync(poolFile);
  const otherPool = path.join(worktree, ".pi/.goals-pool-snapshot.json");
  fs.writeFileSync(otherPool, "{}");
  assert.throws(
    () => verifyWorkspaceScope(contract, mailbox),
    /outside allowed write scope/,
  );
  fs.unlinkSync(otherPool);
  for (const relative of [
    ".pi/settings.json",
    ".pi/goals-extra.md",
    ".pi/.goals-pool-snapshot.json.bak",
  ]) {
    const file = path.join(root, relative);
    fs.writeFileSync(file, "unexpected");
    assert.throws(
      () => verifyWorkspaceScope(contract, mailbox),
      /outside allowed write scope/,
    );
    fs.unlinkSync(file);
  }
  const piDirectory = path.join(root, ".pi");
  const mode = fs.statSync(piDirectory).mode & 0o777;
  fs.chmodSync(piDirectory, mode ^ 0o100);
  assert.throws(
    () => verifyWorkspaceScope(contract, mailbox),
    (error) =>
      error.code === "EACCES" ||
      /outside allowed write scope/.test(error.message),
  );
  fs.chmodSync(piDirectory, mode);
  const otherGoal = path.join(worktree, ".pi/goals/active_goal_probe.md");
  fs.appendFileSync(otherGoal, "unexpected");
  assert.throws(
    () => verifyWorkspaceScope(contract, mailbox),
    /outside allowed write scope/,
  );
  fs.writeFileSync(otherGoal, "synthetic metadata: pending\n");
  for (const allowed of [
    ".pi",
    ".pi/goals",
    ".pi/goals/probe.md",
    ".pi/.goals-pool-snapshot.json",
  ])
    assert.throws(
      () =>
        captureWorkspace(
          {
            ...contract,
            workspace: { ...contract.workspace, allowedWritePaths: [allowed] },
          },
          runtime,
        ),
      /write scope overlaps harness-owned paths/,
    );
  assert.equal(
    captureWorkspace(base, runtime).workspaces[0].excludedPaths.includes(
      ".pi/goals",
    ),
    false,
  );
  const old = structuredClone(baseline);
  old.workspaces[0].excludedPaths = old.workspaces[0].excludedPaths.filter(
    (name) => name !== ".pi/goals",
  );
  fs.writeFileSync(
    path.join(mailbox.root, "receipts/workspace-baseline.json"),
    JSON.stringify(old),
  );
  fs.writeFileSync(
    path.join(mailbox.root, "bootstrap.json"),
    JSON.stringify({ workspaceBaselineDigest: digest(old) }),
  );
  assert.throws(
    () => verifyWorkspaceScope(contract, mailbox),
    /workspace inventory changed/,
  );
});

test("T01 contract canonicalization is stable and strict", () => {
  const root = temp();
  const contract = validateTaskContract(fixture(root));
  const reordered = Object.fromEntries(Object.entries(contract).reverse());
  assert.deepEqual(canonicalBytes(contract), canonicalBytes(reordered));
  assert.match(digest(contract), /^[a-f0-9]{64}$/);
  const dynamic = fixture(root, {
    schemaVersion: "teams-task-runtime/2",
    policy: { ...contract.policy, maxActiveRoleRuns: 5 },
  });
  assert.equal(validateTaskContract(dynamic).policy.maxActiveRoleRuns, 5);
  assert.throws(
    () =>
      validateTaskContract({
        ...dynamic,
        schemaVersion: "teams-task-runtime/1",
      }),
    /maxActiveRoleRuns/,
  );
  assert.throws(
    () =>
      validateTaskContract({
        ...dynamic,
        schemaVersion: "teams-task-runtime/99",
      }),
    /unsupported contract/,
  );
  assert.throws(() => canonicalBytes({ bad: -0 }), /safe JSON/);
  assert.throws(
    () =>
      validateTaskContract(
        fixture(root, {
          workspace: { ...fixture(root).workspace, sourcePaths: ["../escape"] },
        }),
      ),
    /relative path/,
  );
});

test("T02/T04 one controller and one open task reservation", () => {
  const root = temp();
  const ledger = new RuntimeLedger(path.join(root, "ledger.sqlite"));
  assert.deepEqual(ledger.claimController("project-1", "session-a"), {
    ownerEpoch: 1,
    disposition: "claimed",
  });
  assert.deepEqual(ledger.claimController("project-1", "session-a"), {
    ownerEpoch: 1,
    disposition: "already-owned",
  });
  assert.throws(
    () => ledger.claimController("project-1", "session-b"),
    /owned by another session/,
  );
  const contract = validateTaskContract(fixture(root));
  const requestDigest = digest(contract);
  ledger.reserve(contract, requestDigest, "session-a");
  const second = {
    ...contract,
    identity: {
      ...contract.identity,
      executionId: "22222222-2222-4222-8222-222222222222",
    },
  };
  assert.throws(
    () => ledger.reserve(second, digest(second), "session-a"),
    /open reservation/,
  );
  ledger.close();
});

test("execution transitions use state and revision compare-and-swap", () => {
  const root = temp();
  const ledger = new RuntimeLedger(path.join(root, "ledger.sqlite"));
  ledger.claimController("project-1", "session-a");
  const contract = validateTaskContract(fixture(root));
  ledger.reserve(contract, digest(contract), "session-a");
  const running = ledger.transition(
    contract.identity.executionId,
    "RESERVED",
    0,
    "SPAWNING",
  );
  assert.equal(running.revision, 1);
  assert.throws(
    () =>
      ledger.transition(
        contract.identity.executionId,
        "RESERVED",
        0,
        "SPAWNING",
      ),
    /state changed/,
  );
  assert.throws(
    () =>
      ledger.transition(
        contract.identity.executionId,
        "SPAWNING",
        1,
        "ACCEPTED",
      ),
    /illegal transition/,
  );
  ledger.close();
});

test("T03/T20/T21 mailbox writes are scoped and idempotent", () => {
  const root = temp();
  const box = Mailbox.create(
    path.join(root, "runtime"),
    "project-1",
    "11111111-1111-4111-8111-111111111111",
  );
  const command = {
    schemaVersion: "teams-task-control/1",
    commandId: "cmd-1",
    executionId: "11111111-1111-4111-8111-111111111111",
    ownerEpoch: 1,
    requestDigest: sha,
    type: "grant",
    payload: {},
  };
  assert.equal(box.writeCommand(command).disposition, "written");
  assert.equal(box.writeCommand(command).disposition, "duplicate");
  assert.throws(
    () => box.writeCommand({ ...command, type: "cancel" }),
    /conflicting immutable message/,
  );
  assert.throws(() => box.readRelative("../outside"), /relative path/);
  const event = {
    schemaVersion: "teams-task-event/1",
    eventId: "event-1",
    executionId: command.executionId,
    ownerEpoch: 1,
    workerSessionId: "worker-1",
    sequence: 1,
    type: "booted",
    occurredAt: new Date().toISOString(),
    payloadRef: "receipts/boot.json",
    payloadDigest: sha,
  };
  assert.equal(box.writeEvent(event).disposition, "written");
  assert.equal(box.writeEvent(event).disposition, "duplicate");
  assert.throws(
    () => box.writeEvent({ ...event, eventId: "event-2" }),
    /sequence conflict/,
  );
});

test("result validation rejects missing evidence and stale identity", () => {
  const root = temp();
  const contract = validateTaskContract(fixture(root));
  const requestDigest = digest(contract);
  const result = {
    schemaVersion: "teams-task-result/1",
    identity: contract.identity,
    requestDigest,
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary: "Done.",
    source: {
      baseCommit: contract.workspace.baseCommit,
      sourceDigest: sha,
      manifestRef: "evidence/source.json",
    },
    criterionResults: [
      {
        criterionId: "criterion-1",
        status: "met",
        observation: "Observed.",
        evidenceIds: ["evidence-1"],
      },
    ],
    evidence: [
      {
        evidenceId: "evidence-1",
        kind: "host-check",
        uri: "evidence/check.json",
        sha256: sha,
        producedBy: "host",
        sourceDigest: sha,
      },
    ],
    childRunRefs: [],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  };
  assert.equal(
    validateTaskResult(result, contract, requestDigest).outcome,
    "ready_for_acceptance",
  );
  const pending = {
    ...result,
    evidence: [],
    criterionResults: [
      {
        ...result.criterionResults[0],
        status: "indeterminate",
        evidenceIds: [],
      },
    ],
  };
  assert.throws(
    () => validateTaskResult(pending, contract, requestDigest),
    /criterion/,
  );
  const v2 = { ...contract, schemaVersion: "teams-task-runtime/2" };
  pending.requestDigest = digest(v2);
  assert.equal(
    validateTaskResult(pending, v2, digest(v2)).criterionResults[0].status,
    "indeterminate",
  );
  for (const status of ["not_met", "needs_user"])
    assert.throws(
      () =>
        validateTaskResult(
          {
            ...pending,
            criterionResults: [{ ...pending.criterionResults[0], status }],
          },
          v2,
          digest(v2),
        ),
      /criterion/,
    );
  const artifactOnly = {
    ...v2,
    criteria: [{ ...v2.criteria[0], requiredEvidenceKinds: ["artifact"] }],
  };
  assert.throws(
    () =>
      validateTaskResult(
        { ...pending, requestDigest: digest(artifactOnly) },
        artifactOnly,
        digest(artifactOnly),
      ),
    /criterion/,
  );
  assert.throws(
    () =>
      validateTaskResult({ ...result, evidence: [] }, contract, requestDigest),
    /evidence/,
  );
  assert.throws(
    () =>
      validateTaskResult(
        { ...result, identity: { ...result.identity, ownerEpoch: 2 } },
        contract,
        requestDigest,
      ),
    /identity/,
  );
});

test("U3 ledger migrates v0/v1/v2 to v3 and refuses future schemas", () => {
  const root = temp();
  const legacyFile = path.join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec("CREATE TABLE legacy_marker(value TEXT) STRICT");
  legacy.close();
  const migrated = new RuntimeLedger(legacyFile);
  assert.equal(migrated.schemaVersion, 3);
  migrated.close();
  const readback = new DatabaseSync(legacyFile);
  assert.equal(readback.prepare("PRAGMA user_version").get().user_version, 3);
  assert.ok(
    readback
      .prepare("PRAGMA table_info(executions)")
      .all()
      .some((row) => row.name === "budget_pool_json"),
  );
  readback.close();

  const previousFile = path.join(root, "previous.sqlite");
  const previous = new DatabaseSync(previousFile);
  previous.exec("PRAGMA user_version = 1");
  previous.close();
  const upgraded = new RuntimeLedger(previousFile);
  assert.equal(upgraded.schemaVersion, 3);
  upgraded.close();

  const v2File = path.join(root, "v2.sqlite");
  const v2 = new RuntimeLedger(v2File);
  v2.db.exec(
    "ALTER TABLE executions DROP COLUMN budget_pool_json; PRAGMA user_version = 2",
  );
  v2.close();
  const v2Bytes = fs.readFileSync(v2File);
  const reader = new RuntimeLedger(v2File, { readOnly: true });
  assert.equal(reader.schemaVersion, 2);
  reader.close();
  assert.deepEqual(
    fs.readFileSync(v2File),
    v2Bytes,
    "read-only never migrates legacy ledgers",
  );
  const upgradedV2 = new RuntimeLedger(v2File);
  assert.equal(upgradedV2.schemaVersion, 3);
  assert.ok(
    upgradedV2.db
      .prepare("PRAGMA table_info(executions)")
      .all()
      .some((row) => row.name === "budget_pool_json"),
  );
  upgradedV2.close();

  const futureFile = path.join(root, "future.sqlite");
  const future = new DatabaseSync(futureFile);
  future.exec("PRAGMA user_version = 4");
  future.close();
  assert.throws(
    () => new RuntimeLedger(futureFile),
    /unsupported ledger schema version/,
  );
});

test("U3 mailbox reads v0/v1 and refuses unknown schemas", () => {
  const root = temp();
  const current = Mailbox.create(
    path.join(root, "runtime"),
    "project-1",
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(current.readerVersion, 1);
  fs.rmSync(path.join(current.root, "mailbox.json"));
  assert.equal(
    Mailbox.open(current.root, "11111111-1111-4111-8111-111111111111")
      .readerVersion,
    0,
  );
  fs.writeFileSync(
    path.join(current.root, "mailbox.json"),
    '{"schemaVersion":"teams-mailbox/99","executionId":"11111111-1111-4111-8111-111111111111","writerVersion":99}',
  );
  assert.throws(
    () => Mailbox.open(current.root, "11111111-1111-4111-8111-111111111111"),
    /unsupported mailbox schema/,
  );
});
