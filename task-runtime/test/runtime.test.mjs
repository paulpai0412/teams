import assert from "node:assert/strict";
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
} from "../contracts.mjs";
import { RuntimeLedger } from "../ledger.mjs";
import { Mailbox } from "../mailbox.mjs";
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
