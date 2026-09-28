// Host-owned source/usage lineage for a report-only revision. An old BLOCKED
// review is not a pass: a new report, new source-bound review and receipt are
// still required. Never turn an old writer/status/check into a new native run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { digest, validateTaskResult } from "./contracts.mjs";
import { Mailbox } from "./mailbox.mjs";
import { readIntegrationRehearsal } from "./integration.mjs";
import { integrationReviewBinding } from "./integration-authority.mjs";
import { readCompletedReviewWave } from "./review-runs.mjs";
import { snapshot } from "../host-evidence.mjs";

const hex = /^[a-f0-9]{64}$/;
const completed =
  /^integration\/reviews\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/complete\.json$/;

function assertClosedBlockedReview(mailbox, relative) {
  const match = completed.exec(relative);
  assert.ok(match, "sealed review completion reference required");
  const integration = path.join(mailbox.root, "integration");
  for (const name of [
    "failure.json",
    "review-candidate.json",
    "review-candidate-intent.json",
    "target-apply",
  ])
    assert.ok(
      !fs.existsSync(path.join(integration, name)),
      "old review has failure, seal or target journal; reconcile",
    );
  assert.ok(
    !fs
      .readdirSync(path.join(mailbox.root, "receipts"))
      .some((name) => /^acceptance-[A-Za-z0-9-]+\.json$/.test(name)),
    "old acceptance publication exists; reconcile",
  );
  const reviews = path.join(integration, "reviews");
  assert.deepEqual(
    fs.readdirSync(reviews).sort(),
    [match[1]],
    "old review has another/unknown wave or active lock; reconcile",
  );
  for (const name of [
    "unknown.json",
    "cancel-stop.json",
    "cancel-stop-result.json",
  ])
    assert.ok(
      !fs.existsSync(path.join(reviews, match[1], name)),
      "old review effect is unknown; reconcile",
    );
  return match[1];
}

function oldContext({
  mailbox,
  contract,
  result,
  ownerSessionId,
  assertOwner,
  ledger,
}) {
  return { mailbox, contract, result, ownerSessionId, assertOwner, ledger };
}

// The ledger and present source are checked again on every L0/Worker boundary.
// This returns the ORIGINAL receipt/identity, not a forged current-execution
// native status. The review capture is separately replayed at preparation and
// final acceptance through readCompletedReviewWave.
export function verifyReportOrigin({
  runtimeRoot,
  ledger,
  contract,
  intent,
  assertOwner,
}) {
  assert.equal(intent.schemaVersion, "teams-report-revision-intent/1");
  assert.equal(intent.mode, "report-only");
  assert.equal(intent.repairOrdinal, 1);
  assert.equal(intent.executionId, contract.identity.executionId);
  assert.equal(intent.requestDigest, digest(contract));
  assert.equal(intent.previousOwnerSessionId, intent.ownerSessionId);
  assert.equal(intent.previousExecutionId === intent.executionId, false);
  const previous = ledger.getExecution(intent.previousExecutionId);
  assert.equal(previous.projectId, contract.identity.projectId);
  assert.equal(previous.goalId, contract.identity.goalId);
  assert.equal(previous.taskId, contract.identity.taskId);
  assert.equal(previous.taskRevision + 1, contract.identity.taskRevision);
  assert.ok(
    ["CANCELLED", "FAILED"].includes(previous.state) &&
      !previous.reservationOpen,
    "previous report execution must remain closed",
  );
  assert.equal(previous.ownerSessionId, intent.previousOwnerSessionId);
  assert.equal(
    previous.ownerEpoch,
    contract.identity.ownerEpoch,
    "report revision changed original controller epoch",
  );
  assert.equal(previous.requestDigest, intent.previousRequestDigest);
  assert.equal(
    ledger.getAcceptance(previous.executionId),
    null,
    "previous report cannot be accepted",
  );
  const root = path.join(
    runtimeRoot,
    "projects",
    previous.projectId,
    "executions",
    previous.executionId,
  );
  const mailbox = Mailbox.open(root, previous.executionId);
  assertClosedBlockedReview(mailbox, intent.reviewFailureRelative);
  const original = ledger.getContract(previous.executionId);
  const baseline = mailbox.readJson("receipts/workspace-baseline.json");
  assert.equal(baseline.requestDigest, previous.requestDigest);
  assert.equal(
    digest(baseline.workspaces),
    intent.previousBaselineDigest,
    "original workspace baseline changed",
  );
  assert.equal(digest(original), previous.requestDigest);
  assert.equal(original.identity.ownerEpoch, previous.ownerEpoch);
  assert.equal(original.schemaVersion, "teams-task-runtime/3");
  assert.equal(original.policy.integrationMode, "verify-only");
  assert.equal(original.policy.tokenBudgetMode, "shared");
  for (const key of [
    "objective",
    "nonGoals",
    "workspace",
    "criteria",
    "checks",
    "policy",
    "contextRefs",
  ])
    assert.deepEqual(
      contract[key],
      original[key],
      `report revision ${key} changed`,
    );
  const resultRef = path.relative(root, intent.previousResultRef);
  assert.match(resultRef, /^results\/r[0-9]{4}\.json$/);
  assert.equal(mailbox.digestRelative(resultRef), intent.previousResultSha256);
  const result = mailbox.readJson(resultRef);
  validateTaskResult(result, original, previous.requestDigest);
  assert.equal(digest(result), intent.previousResultDigest);
  assert.equal(result.source.sourceDigest, intent.previousSourceDigest);
  assert.equal(result.outcome, "ready_for_acceptance");
  assert.equal(result.unresolvedRunCount, 0);
  const manifest = mailbox.readJson(result.source.manifestRef);
  assert.equal(manifest.cwd, original.workspace.sourceRoot);
  assert.equal(manifest.digest, result.source.sourceDigest);
  assert.equal(
    digest(manifest.files),
    manifest.digest,
    "original source manifest changed",
  );
  const latest = ledger.getLatestResult(previous.executionId);
  assert.equal(latest.resultDigest, digest(result));
  assert.equal(
    latest.resultRef,
    intent.previousResultRef,
    "previous result reference changed",
  );
  assert.equal(
    snapshot(original.workspace.sourceRoot, original.workspace.sourcePaths)
      .digest,
    result.source.sourceDigest,
    "original target source changed",
  );
  const origin = oldContext({
    mailbox,
    contract: original,
    result,
    ownerSessionId: previous.ownerSessionId,
    assertOwner,
    ledger,
  });
  const staged = readIntegrationRehearsal(origin); // Verifies every original check/log and captured bytes.
  assert.equal(staged.sourceDigest, intent.sourceDigest);
  assert.equal(staged.tree, intent.tree);
  assert.equal(
    mailbox.digestRelative("integration/receipt.json"),
    intent.rehearsalSha256,
  );
  const request = mailbox.readJson("integration/review-request.json");
  assert.equal(request.schemaVersion, "teams-integration-review-request/1");
  assert.equal(request.acceptance, "not-assessed");
  assert.equal(
    digest(request.subject),
    request.digest,
    "original review subject changed",
  );
  assert.equal(request.digest, intent.previousReviewRequestDigest);
  assert.equal(request.subject.rehearsalDigest, digest(staged));
  assert.equal(request.subject.resultDigest, digest(result));
  assert.equal(request.subject.sourceDigest, staged.sourceDigest);
  assert.equal(
    mailbox.digestRelative("integration/review.patch"),
    request.subject.patch.sha256,
  );
  assert.equal(
    mailbox.digestRelative(intent.reviewFailureRelative),
    intent.reviewFailureSha256,
  );
  const complete = mailbox.readJson(intent.reviewFailureRelative);
  assert.equal(complete.schemaVersion, "teams-review-wave-completion/1");
  assert.equal(complete.planDigest, intent.reviewPlanDigest);
  assert.equal(complete.requestDigest, request.digest);
  assert.equal(complete.verdict, "blocked");
  assert.ok(
    complete.reports.some(
      (row) =>
        row.report.verdict === "blocked" &&
        row.report.findings.some((finding) => finding.severity === "blocker"),
    ),
    "original report blocker missing",
  );
  const writer = integrationReviewBinding(origin, staged, {
    requestDigest: request.digest,
    candidateDigest: digest(complete),
  });
  assert.equal(writer.writerEvidenceDigest, intent.writerEvidenceDigest);
  assertOwner();
  return {
    mailbox,
    contract: original,
    result,
    staged,
    request,
    complete,
    origin,
  };
}

export async function reportRevisionIntent({
  orchestrator,
  previous,
  oldContract,
  previousMailbox,
  spec,
  revision,
  baseline,
}) {
  assert.ok(
    revision && typeof revision === "object",
    "explicit report revision required",
  );
  assert.ok(
    ["CANCELLED", "FAILED"].includes(previous.state) &&
      !previous.reservationOpen,
    "previous report execution must be closed",
  );
  assert.equal(
    previous.ownerSessionId,
    orchestrator.ownerSessionId,
    "report owner changed",
  );
  assert.equal(oldContract.schemaVersion, "teams-task-runtime/3");
  assert.equal(oldContract.policy.integrationMode, "verify-only");
  assert.equal(oldContract.policy.tokenBudgetMode, "shared");
  assert.equal(spec.taskRevision, previous.taskRevision + 1);
  assert.equal(spec.goalId, previous.goalId);
  assert.equal(spec.taskId, previous.taskId);
  for (const key of [
    "objective",
    "nonGoals",
    "workspace",
    "criteria",
    "checks",
    "policy",
    "contextRefs",
  ])
    assert.deepEqual(
      spec[key],
      oldContract[key],
      `report revision ${key} changed`,
    );
  assert.equal(revision.previousExecutionId, previous.executionId);
  assert.match(revision.expectedPreviousResultDigest ?? "", hex);
  assert.match(revision.reviewFailureSha256 ?? "", hex);
  assert.ok(
    typeof revision.reportReason === "string" &&
      revision.reportReason.trim() &&
      Buffer.byteLength(revision.reportReason) <= 500,
    "bounded report reason required",
  );
  const relative = path.relative(
    previousMailbox.root,
    revision.reviewFailureRef ?? "",
  );
  assert.ok(
    path.isAbsolute(revision.reviewFailureRef) &&
      path.join(previousMailbox.root, relative) === revision.reviewFailureRef,
    "sealed review completion reference required",
  );
  const key = assertClosedBlockedReview(previousMailbox, relative);
  const oldResultRow = orchestrator.ledger.getLatestResult(
    previous.executionId,
  );
  const resultRelative = path.relative(
    previousMailbox.root,
    oldResultRow.resultRef,
  );
  assert.match(resultRelative, /^results\/r[0-9]{4}\.json$/);
  const result = previousMailbox.readJson(resultRelative);
  validateTaskResult(result, oldContract, previous.requestDigest);
  assert.equal(result.outcome, "ready_for_acceptance");
  assert.equal(result.unresolvedRunCount, 0);
  assert.equal(digest(result), revision.expectedPreviousResultDigest);
  assert.equal(digest(result), oldResultRow.resultDigest);
  assert.equal(
    orchestrator.ledger.getAcceptance(previous.executionId),
    null,
    "accepted execution cannot be report-revised",
  );
  const originalBaseline = previousMailbox.readJson(
    "receipts/workspace-baseline.json",
  );
  assert.equal(originalBaseline.requestDigest, previous.requestDigest);
  assert.deepEqual(
    originalBaseline.workspaces,
    baseline.workspaces,
    "report revision source baseline drifted",
  );
  const origin = oldContext({
    mailbox: previousMailbox,
    contract: oldContract,
    result,
    ownerSessionId: previous.ownerSessionId,
    ledger: orchestrator.ledger,
    assertOwner: () => {
      orchestrator.assertController(previous.projectId);
      const current = orchestrator.ledger.getExecution(previous.executionId);
      assert.equal(
        current.revision,
        previous.revision,
        "original execution changed",
      );
    },
  });
  const staged = readIntegrationRehearsal(origin);
  const request = previousMailbox.readJson("integration/review-request.json");
  assert.equal(request.subject.rehearsalDigest, digest(staged));
  assert.equal(request.subject.resultDigest, digest(result));
  assert.equal(request.subject.sourceDigest, staged.sourceDigest);
  const plan = previousMailbox.readJson(`integration/reviews/${key}/plan.json`);
  const complete = await readCompletedReviewWave(origin, key, plan.planDigest);
  assert.equal(
    complete.verdict,
    "blocked",
    "only a BLOCKED old review is report-revisable",
  );
  assert.ok(
    complete.reports.some(
      (row) =>
        row.report.verdict === "blocked" &&
        row.report.findings.some((finding) => finding.severity === "blocker"),
    ),
    "sealed BLOCKED review must identify the original blocker",
  );
  assert.equal(
    previousMailbox.digestRelative(relative),
    revision.reviewFailureSha256,
  );
  const writer = integrationReviewBinding(origin, staged, {
    requestDigest: request.digest,
    candidateDigest: digest(complete),
  });
  return {
    schemaVersion: "teams-report-revision-intent/1",
    mode: "report-only",
    previousExecutionId: previous.executionId,
    previousOwnerSessionId: previous.ownerSessionId,
    ownerSessionId: orchestrator.ownerSessionId,
    previousRequestDigest: previous.requestDigest,
    previousResultDigest: digest(result),
    previousResultRef: oldResultRow.resultRef,
    previousResultSha256: previousMailbox.digestRelative(resultRelative),
    previousSourceDigest: result.source.sourceDigest,
    sourceDigest: staged.sourceDigest,
    rehearsalSha256: previousMailbox.digestRelative("integration/receipt.json"),
    tree: staged.tree,
    previousReviewRequestDigest: request.digest,
    reviewFailureRelative: relative,
    reviewFailureSha256: revision.reviewFailureSha256,
    reviewPlanDigest: plan.planDigest,
    writerEvidenceDigest: writer.writerEvidenceDigest,
    previousBaselineDigest: digest(originalBaseline.workspaces),
    reportReason: revision.reportReason.trim(),
    repairOrdinal: 1,
  };
}
