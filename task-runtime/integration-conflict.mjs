// A terminated Git conflict in a host-owned rehearsal is a known candidate
// failure, not an unknown target write. Preserve it; L0 owns semantic repair.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  bytesDigest,
  digest,
  validateTaskContract,
  validateTaskResult,
} from "./contracts.mjs";
import { readEvidenceBytes, snapshot } from "../host-evidence.mjs";
import { integrationGitInvocation } from "./integration.mjs";
import { inspectNativeHandoffs } from "./native-handoff.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";
import { captureWorkspace } from "./workspace-scope.mjs";
import { Mailbox } from "./mailbox.mjs";
import { validateInput } from "./input-rejection.mjs";
import { RuntimeLedger } from "./ledger.mjs";
import { measureClosedExecutionUsage } from "./task-usage.mjs";
import { processTerminalProof } from "./orchestrator.mjs";

function git(cwd, args, options = {}) {
  const command = integrationGitInvocation(cwd, args, options);
  const result = spawnSync("git", command.args, command.options);
  assert.ok(
    !result.error && result.status === 0 && !result.signal,
    "conflict evidence Git read failed",
  );
  return result.stdout;
}

export function conflictIndex(cwd, index) {
  const bytes = git(cwd, ["ls-files", "--stage", "-z"], {
    index,
    encoding: "buffer",
  });
  const paths = [];
  for (const row of bytes.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/.exec(row);
    assert.ok(match, "invalid conflict index entry");
    if (match[3] !== "0") paths.push(match[4]);
  }
  return {
    indexSha256: bytesDigest(bytes),
    conflictPaths: [...new Set(paths)].sort(),
  };
}

export class CompletedIntegrationConflict extends Error {
  constructor(proof) {
    super(`integration merge conflict: ${proof.conflictPaths.join(", ")}`);
    this.name = "CompletedIntegrationConflict";
    this.proof = proof;
  }
}

// Called only after ALL lane patches have independently passed base/scope checks.
// All process/owner/source checks precede the typed error and its public reply.
export function completedIntegrationConflict(
  context,
  { result, native, lanes, failedLaneIndex },
) {
  const { mailbox, contract, runtimeRoot, assertOwner } = context;
  assert.equal(contract.schemaVersion, "teams-task-runtime/3");
  assert.equal(result.status, 1, "not a completed Git conflict");
  assert.ok(!result.error && !result.signal, "Git termination is unknown");
  const cwd = path.join(mailbox.root, "integration/repo");
  const index = conflictIndex(cwd);
  assert.ok(
    index.conflictPaths.length > 0,
    "nonzero apply without conflict entries is not repairable here",
  );
  assertOwner();
  inspectWorktreeBase(
    contract.workspace.sourceRoot,
    contract.workspace.baseCommit,
  );
  const baseline = mailbox.readJson("receipts/workspace-baseline.json");
  assert.deepEqual(
    captureWorkspace(contract, runtimeRoot).workspaces,
    baseline.workspaces,
    "target changed during conflict",
  );
  return new CompletedIntegrationConflict({
    schemaVersion: "teams-integration-conflict/1",
    effects: "isolated-integration-only",
    processTerminated: true,
    baseCommit: contract.workspace.baseCommit,
    targetBaselineDigest: digest(baseline.workspaces),
    ...index,
    failedLaneIndex,
    lanes,
    nativeDigest: digest(native),
    command: {
      exitCode: result.status,
      signal: null,
      errorCode: null,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    },
  });
}

export function integrationConflictReply(error, toolCallId, input) {
  if (!(error instanceof CompletedIntegrationConflict)) throw error;
  assert.ok(
    error.receiptRef && error.receiptSha256,
    "conflict receipt was not published",
  );
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${error.message}\nThe Git operation terminated in the isolated rehearsal; original target is unchanged. Acceptance remains blocked. L0 should inspect all captured lane contributions, diagnose the conflict, cancel/reconcile this execution, and use an authorized same-Task revision if repairable. Do not replay stage or edit the preserved index/target. A new writer must deliver one complete resolved candidate, followed by new checks and independent review.`,
      },
    ],
    details: {
      integrationConflict: {
        schemaVersion: "teams-completed-integration-conflict/1",
        toolName: "team_task_stage_integration",
        toolCallId,
        inputDigest: digest(input),
        executionId: input.execution_id,
        disposition: "diagnose-only",
        acceptance: "blocked",
        effects: "isolated-integration-only",
        processTerminated: true,
        receiptRef: error.receiptRef,
        receiptSha256: error.receiptSha256,
        conflictPaths: error.proof.conflictPaths,
      },
    },
  };
}

export function isCompletedIntegrationConflict(
  fact,
  call,
  toolName,
  toolCallId,
) {
  return Boolean(
    call &&
      call.tool === toolName &&
      toolName === "team_task_stage_integration" &&
      (!call.input.action || call.input.action === "stage") &&
      fact?.schemaVersion === "teams-completed-integration-conflict/1" &&
      fact.toolName === toolName &&
      fact.toolCallId === toolCallId &&
      fact.executionId === call.input.execution_id &&
      fact.inputDigest === digest(call.input) &&
      fact.disposition === "diagnose-only" &&
      fact.acceptance === "blocked" &&
      fact.effects === "isolated-integration-only" &&
      fact.processTerminated === true &&
      typeof fact.receiptRef === "string" &&
      path.isAbsolute(fact.receiptRef) &&
      /^[a-f0-9]{64}$/.test(fact.receiptSha256 ?? "") &&
      Array.isArray(fact.conflictPaths) &&
      fact.conflictPaths.length > 0 &&
      fact.conflictPaths.length <= 10000 &&
      fact.conflictPaths.every((p) => typeof p === "string" && p.length > 0),
  );
}

// Read frozen captures, never depend on a removed native temporary directory.
function readConflict(mailbox, contract, candidate) {
  const failure = mailbox.readJson("integration/failure.json", 8 * 1024 * 1024);
  const proof = failure.conflict;
  assert.equal(failure.schemaVersion, "teams-integration-failure/1");
  assert.equal(failure.disposition, "preserved-reconcile-required");
  assert.equal(proof?.schemaVersion, "teams-integration-conflict/1");
  assert.equal(proof.effects, "isolated-integration-only");
  assert.equal(proof.processTerminated, true);
  assert.deepEqual(
    [proof.command.exitCode, proof.command.signal, proof.command.errorCode],
    [1, null, null],
  );
  const stage = mailbox.readJson("integration/intent.json");
  assert.equal(failure.inputDigest, digest(stage));
  assert.equal(stage.executionId, contract.identity.executionId);
  assert.equal(stage.contractDigest, digest(contract));
  assert.equal(stage.resultDigest, digest(candidate));
  assert.equal(proof.baseCommit, contract.workspace.baseCommit);
  for (const name of [
    "receipt.json",
    "review-request.json",
    "review-candidate.json",
    "review-candidate-intent.json",
    "reviews",
    "target-apply",
  ])
    assert.equal(
      fs.existsSync(path.join(mailbox.root, "integration", name)),
      false,
      "conflicted integration cannot have review/apply/completion artifacts",
    );
  const native = mailbox.readJson("integration/native.json", 8 * 1024 * 1024);
  assert.equal(
    digest(native),
    proof.nativeDigest,
    "conflict native inventory changed",
  );
  const captured = new Map();
  for (const row of native.captures) {
    assert.match(row.saved, /^captures\/[0-9]+\.bin$/);
    assert.ok(!captured.has(row.origin), "duplicate conflict capture");
    const bytes = mailbox.readRelative(
      `integration/${row.saved}`,
      8 * 1024 * 1024,
    );
    assert.equal(bytesDigest(bytes), row.sha256, "conflict capture changed");
    captured.set(row.origin, bytes);
  }
  const checked = inspectNativeHandoffs(
    mailbox,
    contract,
    candidate.childRunRefs,
    (file, limit) => {
      const bytes = captured.get(file);
      assert.ok(
        bytes && bytes.length <= limit,
        "missing conflict native capture",
      );
      return bytes;
    },
  );
  assert.deepEqual(checked.lanes, native.lanes);
  assert.equal(
    checked.files.length,
    captured.size,
    "unbound conflict native capture",
  );
  assert.ok(
    Array.isArray(proof.lanes) && proof.lanes.length === native.lanes.length,
    "conflict lane inventory changed",
  );
  assert.ok(
    Number.isSafeInteger(proof.failedLaneIndex) &&
      proof.failedLaneIndex >= 0 &&
      proof.failedLaneIndex < proof.lanes.length,
  );
  const cwd = path.join(mailbox.root, "integration/repo");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]).trim(), proof.baseCommit);
  assert.deepEqual(
    conflictIndex(cwd),
    { indexSha256: proof.indexSha256, conflictPaths: proof.conflictPaths },
    "preserved conflict index changed",
  );
  for (const [i, lane] of proof.lanes.entries()) {
    const { tree, changedPaths, indexSha256, ...identity } = lane;
    assert.deepEqual(
      identity,
      native.lanes[i],
      "conflict lane binding changed",
    );
    assert.match(tree, /^[a-f0-9]{40,64}$/);
    assert.ok(Array.isArray(changedPaths));
    assert.equal(
      conflictIndex(cwd, path.join(mailbox.root, `integration/lane-${i}.index`))
        .indexSha256,
      indexSha256,
      "validated lane index changed",
    );
  }
  return { failure, proof, native };
}

export function conflictRepairIntent({
  previous,
  oldContract,
  previousMailbox,
  spec,
  revision,
  ownerSessionId,
  baseline,
}) {
  assert.equal(oldContract.schemaVersion, "teams-task-runtime/3");
  assert.equal(oldContract.policy.tokenBudgetMode, "shared");
  assert.ok(
    oldContract.policy.maxProcessRestarts === 1 &&
      oldContract.policy.maxProductRepairsPerRole > 0,
    "original Task has no candidate repair authority",
  );
  assert.ok(
    ["CANCELLED", "FAILED"].includes(previous.state) &&
      !previous.reservationOpen &&
      previous.unresolvedRunCount === 0,
    "previous conflict execution must be closed without unknown effects",
  );
  assert.equal(previous.ownerSessionId, ownerSessionId, "repair owner changed");
  assert.equal(revision.previousExecutionId, previous.executionId);
  assert.equal(
    revision.failureReceiptRef,
    path.join(previousMailbox.root, "integration/failure.json"),
  );
  assert.equal(
    previousMailbox.digestRelative("integration/failure.json"),
    revision.failureReceiptSha256,
    "conflict receipt changed",
  );
  const candidate = previousMailbox.listResults().at(-1);
  validateTaskResult(candidate, oldContract, previous.requestDigest);
  assert.equal(candidate.outcome, "ready_for_acceptance");
  assert.equal(candidate.unresolvedRunCount, 0);
  assert.equal(
    digest(candidate),
    revision.expectedPreviousResultDigest,
    "previous result changed",
  );
  const oldBaseline = previousMailbox.readJson(
    "receipts/workspace-baseline.json",
  );
  assert.equal(oldBaseline.requestDigest, previous.requestDigest);
  assert.deepEqual(
    oldBaseline.workspaces,
    baseline.workspaces,
    "conflict source baseline drifted",
  );
  inspectWorktreeBase(
    oldContract.workspace.sourceRoot,
    oldContract.workspace.baseCommit,
  );
  assert.equal(
    snapshot(
      oldContract.workspace.sourceRoot,
      oldContract.workspace.sourcePaths,
    ).digest,
    candidate.source.sourceDigest,
    "conflict target source changed",
  );
  const { proof, native } = readConflict(
    previousMailbox,
    oldContract,
    candidate,
  );
  assert.equal(proof.targetBaselineDigest, digest(oldBaseline.workspaces));
  assert.ok(
    !fs
      .readdirSync(path.join(previousMailbox.root, "receipts"))
      .some((name) => /^acceptance-/.test(name)),
    "old acceptance publication exists",
  );
  const deadlineAt =
    Date.parse(previous.createdAt) + oldContract.policy.deadlineMs;
  assert.ok(Date.now() < deadlineAt, "original Task deadline exhausted");
  validateInput("task-spec", () => {
    assert.equal(spec.schemaVersion, oldContract.schemaVersion);
    assert.equal(spec.goalId, previous.goalId);
    assert.equal(spec.taskId, previous.taskId);
    assert.equal(spec.taskRevision, previous.taskRevision + 1);
    for (const key of [
      "objective",
      "nonGoals",
      "workspace",
      "criteria",
      "policy",
      "contextRefs",
    ])
      assert.deepEqual(
        spec[key],
        oldContract[key],
        `conflict revision ${key} changed`,
      );
    assert.ok(Array.isArray(spec.checks));
    assert.deepEqual(
      spec.checks.slice(0, oldContract.checks.length),
      oldContract.checks,
      "original checks changed",
    );
    validateTaskContract({ ...oldContract, checks: spec.checks });
    for (const check of spec.checks.slice(oldContract.checks.length))
      assert.ok(
        oldContract.checks.some(
          (old) => old.executable === check.executable && old.cwd === check.cwd,
        ),
        "new regression lacks a previously trusted runner",
      );
    assert.ok(
      typeof revision.repairReason === "string" &&
        revision.repairReason.trim() &&
        Buffer.byteLength(revision.repairReason) <= 500,
      "bounded repair reason required",
    );
  });
  const resultRelative = `results/r${String(candidate.resultRevision).padStart(4, "0")}.json`;
  return {
    schemaVersion: "teams-candidate-repair-intent/3",
    mode: "integration-conflict",
    repairOrdinal: 1,
    previousExecutionId: previous.executionId,
    previousOwnerSessionId: previous.ownerSessionId,
    previousRequestDigest: previous.requestDigest,
    previousResultDigest: digest(candidate),
    previousResultRef: path.join(previousMailbox.root, resultRelative),
    previousResultSha256: previousMailbox.digestRelative(resultRelative),
    previousSourceDigest: candidate.source.sourceDigest,
    previousBaselineDigest: digest(oldBaseline.workspaces),
    failureReceiptRef: revision.failureReceiptRef,
    failureReceiptSha256: revision.failureReceiptSha256,
    conflictPaths: proof.conflictPaths,
    conflictIndexSha256: proof.indexSha256,
    failedLaneIndex: proof.failedLaneIndex,
    patches: proof.lanes.map((lane) => {
      const capture = native.captures.find(
        (row) => row.origin === lane.patchPath,
      );
      assert.ok(capture && capture.sha256 === lane.patchSha256);
      return {
        key: lane.key,
        runId: lane.runId,
        tree: lane.tree,
        changedPaths: lane.changedPaths,
        path: path.join(previousMailbox.root, "integration", capture.saved),
        sha256: capture.sha256,
      };
    }),
    repairReason: revision.repairReason.trim(),
    deadlineAt,
  };
}

export function verifyConflictRepairBinding({
  runtimeRoot,
  projectId,
  intent,
  contract,
  afterApply = false,
}) {
  assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/3");
  assert.equal(intent.mode, "integration-conflict");
  const root = path.join(
    runtimeRoot,
    "projects",
    projectId,
    "executions",
    intent.previousExecutionId,
  );
  const mailbox = Mailbox.open(root, intent.previousExecutionId);
  const old = mailbox.readJson("task-request.json");
  assert.equal(digest(old), intent.previousRequestDigest);
  assert.equal(
    intent.failureReceiptRef,
    path.join(root, "integration/failure.json"),
  );
  assert.equal(
    mailbox.digestRelative("integration/failure.json"),
    intent.failureReceiptSha256,
    "conflict receipt changed",
  );
  const relative = path.relative(root, intent.previousResultRef);
  assert.match(relative, /^results\/r[0-9]{4}\.json$/);
  assert.equal(
    mailbox.digestRelative(relative),
    intent.previousResultSha256,
    "previous result changed",
  );
  const candidate = mailbox.readJson(relative);
  validateTaskResult(candidate, old, digest(old));
  assert.equal(digest(candidate), intent.previousResultDigest);
  const ledger = new RuntimeLedger(path.join(runtimeRoot, "ledger.sqlite"), {
    readOnly: true,
  });
  try {
    const previous = ledger.getExecution(intent.previousExecutionId);
    const current = ledger.getExecution(contract.identity.executionId);
    assert.ok(
      ["CANCELLED", "FAILED"].includes(previous.state) &&
        !previous.reservationOpen &&
        previous.unresolvedRunCount === 0,
      "conflict origin is not fully closed",
    );
    assert.equal(ledger.getAcceptance(previous.executionId), null);
    assert.equal(
      digest(ledger.getContract(previous.executionId)),
      intent.previousRequestDigest,
    );
    assert.equal(previous.resultDigest, intent.previousResultDigest);
    for (const key of [
      "projectId",
      "goalId",
      "taskId",
      "ownerSessionId",
      "ownerEpoch",
    ])
      assert.equal(previous[key], current[key], "conflict Task/owner changed");
    assert.equal(current.taskRevision, previous.taskRevision + 1);
    assert.equal(
      intent.deadlineAt,
      Date.parse(previous.createdAt) + old.policy.deadlineMs,
    );
    const nextMailbox = Mailbox.open(
      path.join(
        runtimeRoot,
        "projects",
        projectId,
        "executions",
        current.executionId,
      ),
      current.executionId,
    );
    assert.equal(
      mailbox.readJson("bootstrap.json").controller.instanceId,
      nextMailbox.readJson("bootstrap.json").controller.instanceId,
      "original live L0 instance changed",
    );
    const usage = measureClosedExecutionUsage({
      mailbox,
      contract: old,
      execution: previous,
      ownerSessionId: previous.ownerSessionId,
      assertOwner: () =>
        assert.equal(
          ledger.getExecution(previous.executionId).revision,
          previous.revision,
        ),
      assertStopped: (boot) =>
        assert.equal(
          processTerminalProof(boot).terminal,
          true,
          "old Worker termination unknown",
        ),
    });
    assert.equal(
      digest(usage),
      intent.priorUsageDigest,
      "conflict closed usage changed",
    );
  } finally {
    ledger.close();
  }
  const { proof, native } = readConflict(mailbox, old, candidate);
  assert.deepEqual(proof.conflictPaths, intent.conflictPaths);
  assert.equal(proof.indexSha256, intent.conflictIndexSha256);
  assert.equal(proof.failedLaneIndex, intent.failedLaneIndex);
  assert.equal(intent.patches.length, proof.lanes.length);
  for (const [i, lane] of proof.lanes.entries()) {
    const capture = native.captures.find(
      (row) => row.origin === lane.patchPath,
    );
    assert.deepEqual(intent.patches[i], {
      key: lane.key,
      runId: lane.runId,
      tree: lane.tree,
      changedPaths: lane.changedPaths,
      path: path.join(root, "integration", capture.saved),
      sha256: capture.sha256,
    });
  }
  for (const key of [
    "objective",
    "nonGoals",
    "workspace",
    "criteria",
    "policy",
    "contextRefs",
  ])
    assert.deepEqual(
      contract[key],
      old[key],
      `conflict revision ${key} changed`,
    );
  if (!afterApply) {
    inspectWorktreeBase(
      contract.workspace.sourceRoot,
      contract.workspace.baseCommit,
    );
    assert.equal(
      digest(captureWorkspace(contract, runtimeRoot).workspaces),
      intent.previousBaselineDigest,
      "conflict target baseline changed",
    );
  }
  return { mailbox, proof };
}

export function conflictRepairCommand(intent, contract) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const executionRoot = path.join(
    path.dirname(path.dirname(path.dirname(intent.previousResultRef))),
    contract.identity.executionId,
  );
  const args = [
    path.join(executionRoot, "receipts/repair-intent.json"),
    digest(intent),
    contract.workspace.sourceRoot,
    contract.workspace.baseCommit,
  ];
  // Reference the sealed inventory instead of repeating up to 64 paths/hashes
  // in the leaf's bounded task text. Only trusted host code, never candidate code.
  const script = `import { reconstructConflictIndex } from ${JSON.stringify(import.meta.url)}; reconstructConflictIndex(...${JSON.stringify(args)});`;
  return `set -eu\n${quote(process.execPath)} --input-type=module -e ${quote(script)}`;
}

export function reconstructConflictIndex(
  intentRef,
  expectedDigest,
  source,
  base,
) {
  const intent = JSON.parse(readEvidenceBytes(intentRef, 1024 * 1024));
  assert.equal(digest(intent), expectedDigest, "repair inventory changed");
  assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/3");
  const cwd = fs.realpathSync(process.cwd());
  assert.equal(git(cwd, ["rev-parse", "--show-toplevel"]).trim(), cwd);
  assert.notEqual(cwd, source, "reconstruction cannot use the original target");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]).trim(), base);
  assert.equal(
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
    "",
    "repair checkout must be clean",
  );
  assert.ok(
    intent.patches.length > 0 &&
      intent.patches.length <= 64 &&
      Number.isSafeInteger(intent.failedLaneIndex) &&
      intent.failedLaneIndex >= 0 &&
      intent.failedLaneIndex < intent.patches.length,
  );
  let total = 0;
  const patches = intent.patches.map((patch) => {
    const bytes = readEvidenceBytes(patch.path, 8 * 1024 * 1024);
    total += bytes.length;
    assert.ok(total <= 64 * 1024 * 1024, "repair patches exceed bound");
    assert.equal(bytesDigest(bytes), patch.sha256, "repair patch changed");
    return bytes;
  });
  for (let i = 0; i <= intent.failedLaneIndex; i++) {
    if (!patches[i].length) continue;
    const command = integrationGitInvocation(
      cwd,
      ["apply", "--cached", "--3way", "--binary", "--whitespace=nowarn", "-"],
      { input: patches[i] },
    );
    const result = spawnSync("git", command.args, command.options);
    assert.ok(
      !result.error && !result.signal,
      "repair reconstruction termination unknown",
    );
    assert.equal(
      result.status,
      i === intent.failedLaneIndex ? 1 : 0,
      "repair reconstruction changed",
    );
  }
  assert.deepEqual(
    conflictIndex(cwd),
    {
      indexSha256: intent.conflictIndexSha256,
      conflictPaths: intent.conflictPaths,
    },
    "repair did not reproduce the preserved conflict",
  );
  console.log(`TASK_PI_CONFLICT_BASE_READY:${intent.conflictIndexSha256}`);
}
