// Explicit, bounded candidate repair from a closed, source-bound failed check.
// This does not reopen the old execution or repair a sealed report in place.
import assert from "node:assert/strict";
import path from "node:path";
import { bytesDigest, digest, validateTaskResult } from "./contracts.mjs";
import { snapshot } from "../host-evidence.mjs";
import { Mailbox } from "./mailbox.mjs";
import {
  conflictRepairIntent,
  verifyConflictRepairBinding,
} from "./integration-conflict.mjs";

// Recheck immutable old artifacts at the new Worker admission boundary, not
// merely when the L0 first authors the repair intent.
export function verifyCandidateRepairBinding({
  runtimeRoot,
  projectId,
  intent,
  sourcePaths,
  contract,
}) {
  if (intent.schemaVersion === "teams-candidate-repair-intent/3")
    return verifyConflictRepairBinding({
      runtimeRoot,
      projectId,
      intent,
      contract,
    });
  assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/1");
  const root = path.join(
    runtimeRoot,
    "projects",
    projectId,
    "executions",
    intent.previousExecutionId,
  );
  const mailbox = Mailbox.open(root, intent.previousExecutionId);
  assert.equal(
    intent.previousStagedSourceRef,
    path.join(root, "integration/repo"),
  );
  const resultRelative = path.relative(root, intent.previousResultRef);
  assert.match(resultRelative, /^results\/r[0-9]{4}\.json$/);
  assert.equal(
    mailbox.digestRelative(resultRelative),
    intent.previousResultSha256,
    "previous result bytes changed",
  );
  const receiptRelative = path.relative(root, intent.failureReceiptRef);
  assert.match(receiptRelative, /^integration\/check-[A-Za-z0-9._-]+\.json$/);
  assert.equal(
    mailbox.digestRelative(receiptRelative),
    intent.failureReceiptSha256,
    "failed check bytes changed",
  );
  assert.equal(intent.failureLogRef, `${intent.failureReceiptRef}.log`);
  const receipt = mailbox.readJson(receiptRelative);
  assert.equal(
    bytesDigest(
      mailbox.readRelative(`${receiptRelative}.log`, 8 * 1024 * 1024),
    ),
    receipt.logSha256,
    "failed check log changed",
  );
  assert.equal(
    snapshot(intent.previousStagedSourceRef, sourcePaths).digest,
    receipt.before.digest,
    "previous staged candidate changed after revision",
  );
}

export function candidateRepairIntent({
  previous,
  oldContract,
  previousMailbox,
  spec,
  revision,
  ownerSessionId,
  baseline,
}) {
  assert.ok(
    revision && typeof revision === "object",
    "explicit revision intent required",
  );
  if (revision.origin === "integration-conflict")
    return conflictRepairIntent({
      previous,
      oldContract,
      previousMailbox,
      spec,
      revision,
      ownerSessionId,
      baseline,
    });
  assert.ok(
    ["CANCELLED", "FAILED"].includes(previous.state) &&
      !previous.reservationOpen,
    "previous execution must be closed after failure; unknown/accepted cannot be revised",
  );
  assert.equal(previous.ownerSessionId, ownerSessionId, "repair owner changed");
  assert.equal(
    oldContract.schemaVersion,
    "teams-task-runtime/3",
    "v3 source-bound candidate required",
  );
  assert.equal(
    oldContract.policy.tokenBudgetMode,
    "shared",
    "shared Task usage required for candidate revision",
  );
  assert.equal(
    spec.schemaVersion,
    oldContract.schemaVersion,
    "revision contract schema changed",
  );
  assert.equal(
    spec.taskRevision,
    previous.taskRevision + 1,
    "taskRevision must advance by one",
  );
  assert.equal(spec.goalId, previous.goalId, "repair Goal changed");
  assert.equal(spec.taskId, previous.taskId, "repair Task changed");
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
      `repair ${key} changed; new authority required`,
    );
  assert.deepEqual(
    spec.checks.map(({ commandId, criterionIds }) => ({
      commandId,
      criterionIds,
    })),
    oldContract.checks.map(({ commandId, criterionIds }) => ({
      commandId,
      criterionIds,
    })),
    "repair checks may correct commands, not drop check or criterion ownership",
  );
  assert.ok(
    typeof revision.repairReason === "string" &&
      revision.repairReason.trim() &&
      Buffer.byteLength(revision.repairReason) <= 500,
    "bounded nonempty repair reason required",
  );
  assert.match(
    revision.expectedPreviousResultDigest ?? "",
    /^[a-f0-9]{64}$/,
    "previous result digest required",
  );
  assert.match(
    revision.failureReceiptSha256 ?? "",
    /^[a-f0-9]{64}$/,
    "failure receipt SHA-256 required",
  );
  assert.equal(
    revision.previousExecutionId,
    previous.executionId,
    "previous execution identity changed",
  );

  const results = previousMailbox.listResults();
  assert.ok(results.length, "previous candidate result missing");
  const candidate = results.at(-1);
  validateTaskResult(candidate, oldContract, previous.requestDigest);
  assert.equal(
    candidate.outcome,
    "ready_for_acceptance",
    "only a sealed candidate with failed host check can be repaired here",
  );
  assert.equal(
    candidate.unresolvedRunCount,
    0,
    "previous candidate has unresolved runs",
  );
  assert.equal(
    digest(candidate),
    revision.expectedPreviousResultDigest,
    "previous result changed",
  );
  const manifest = previousMailbox.readJson(candidate.source.manifestRef);
  assert.equal(
    manifest.digest,
    candidate.source.sourceDigest,
    "previous candidate manifest changed",
  );
  assert.equal(
    snapshot(
      oldContract.workspace.sourceRoot,
      oldContract.workspace.sourcePaths,
    ).digest,
    candidate.source.sourceDigest,
    "previous candidate source changed; reconcile instead of repair",
  );
  const previousBaseline = previousMailbox.readJson(
    "receipts/workspace-baseline.json",
  );
  assert.equal(
    previousBaseline.requestDigest,
    previous.requestDigest,
    "previous baseline contract changed",
  );
  assert.deepEqual(
    previousBaseline.workspaces,
    baseline.workspaces,
    "repair source baseline drifted",
  );

  const failureRef = revision.failureReceiptRef;
  assert.ok(
    typeof failureRef === "string" && path.isAbsolute(failureRef),
    "absolute failed check receipt required",
  );
  const relative = path.relative(previousMailbox.root, failureRef);
  assert.match(
    relative,
    /^integration\/check-[A-Za-z0-9._-]+\.json$/,
    "only an integration failed-check receipt is reparable",
  );
  const checkId = relative.slice("integration/check-".length, -".json".length);
  const check = oldContract.checks.find((row) => row.commandId === checkId);
  assert.ok(check, "failed check not in previous contract");
  const receiptBytes = previousMailbox.readRelative(relative, 1024 * 1024);
  assert.equal(
    bytesDigest(receiptBytes),
    revision.failureReceiptSha256,
    "failure receipt changed",
  );
  const receipt = previousMailbox.readJson(relative, 1024 * 1024);
  assert.equal(receipt.version, "host-check/1");
  assert.equal(receipt.status, "failed");
  assert.ok(
    Number.isSafeInteger(receipt.exitCode) && receipt.exitCode > 0,
    "not a completed nonzero check",
  );
  assert.equal(
    receipt.signal,
    null,
    "signaled check cannot be revised as product defect",
  );
  assert.equal(
    receipt.errorCode,
    null,
    "spawn failure cannot be revised as product defect",
  );
  assert.equal(
    receipt.before.digest,
    receipt.after.digest,
    "check mutated staged source",
  );
  assert.equal(
    snapshot(
      path.join(previousMailbox.root, "integration/repo"),
      oldContract.workspace.sourcePaths,
    ).digest,
    receipt.before.digest,
    "failed candidate source changed after host check",
  );
  const expectedInput = {
    cwd: path.join(previousMailbox.root, "integration/repo"),
    sourcePaths: oldContract.workspace.sourcePaths,
    argv: [check.executable, ...check.argv],
    timeoutMs: check.timeoutMs,
  };
  assert.deepEqual(
    receipt.input,
    expectedInput,
    "failed check input differs from sealed contract",
  );
  const checkIntent = previousMailbox.readJson(`${relative}.intent`);
  assert.equal(checkIntent.version, "host-check-intent/1");
  assert.deepEqual(checkIntent.input, expectedInput);
  assert.deepEqual(checkIntent.before, receipt.before);
  assert.equal(
    bytesDigest(
      previousMailbox.readRelative(`${relative}.log`, 8 * 1024 * 1024),
    ),
    receipt.logSha256,
    "failed check log changed",
  );
  const stageIntent = previousMailbox.readJson("integration/intent.json");
  assert.equal(stageIntent.executionId, previous.executionId);
  assert.equal(stageIntent.contractDigest, previous.requestDigest);
  assert.equal(stageIntent.resultDigest, digest(candidate));
  const stageFailure = previousMailbox.readJson("integration/failure.json");
  assert.equal(stageFailure.schemaVersion, "teams-integration-failure/1");
  assert.equal(
    stageFailure.inputDigest,
    digest(stageIntent),
    "integration failure is unrelated to the candidate",
  );

  return {
    schemaVersion: "teams-candidate-repair-intent/1",
    mode: "failed-host-check",
    previousExecutionId: previous.executionId,
    previousOwnerSessionId: previous.ownerSessionId,
    previousRequestDigest: previous.requestDigest,
    previousResultDigest: digest(candidate),
    previousResultRef: path.join(
      previousMailbox.root,
      `results/r${String(candidate.resultRevision).padStart(4, "0")}.json`,
    ),
    previousResultSha256: previousMailbox.digestRelative(
      `results/r${String(candidate.resultRevision).padStart(4, "0")}.json`,
    ),
    previousStagedSourceRef: path.join(
      previousMailbox.root,
      "integration/repo",
    ),
    previousSourceDigest: candidate.source.sourceDigest,
    previousBaselineDigest: digest(previousBaseline.workspaces),
    failureReceiptRef: failureRef,
    failureReceiptSha256: revision.failureReceiptSha256,
    failureLogRef: `${failureRef}.log`,
    repairReason: revision.repairReason.trim(),
    specDigest: digest(spec),
    repairOrdinal: 1, // v3 maxProcessRestarts <= 1; never reset this count.
  };
}
