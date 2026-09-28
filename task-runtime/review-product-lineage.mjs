// A BLOCKED source review can lead to a new product candidate, never to a
// changed old verdict. All old native/review bytes are read-only provenance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  digest,
  isReviewableResult,
  validateTaskContract,
  validateTaskResult,
} from "./contracts.mjs";
import { validateInput } from "./input-rejection.mjs";
import { Mailbox } from "./mailbox.mjs";
import { snapshot } from "../host-evidence.mjs";
import { readIntegrationRehearsal } from "./integration.mjs";
import { integrationReviewBinding } from "./integration-authority.mjs";
import { readCompletedReviewWave } from "./review-runs.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";
import { reconstructionRejections } from "./reconstruction-input.mjs";

const completeRef =
  /^integration\/reviews\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/complete\.json$/;
const sha = /^[a-f0-9]{64}$/;

function reviewFiles(mailbox) {
  const root = path.join(mailbox.root, "integration");
  const files = [];
  let size = 0;
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "old review contains a symlink");
      assert.ok(
        ![
          "operation.lock",
          "unknown.json",
          "cancel-stop.json",
          "cancel-stop-result.json",
        ].includes(entry.name),
        "old review operation is incomplete or unknown",
      );
      const relative = path.posix.join(prefix, entry.name);
      if (prefix === "" && relative === "repo") continue; // Bound by staged tree/workspace instead.
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file, relative);
      } else {
        assert.ok(entry.isFile(), "unknown review artifact kind");
        const stat = fs.lstatSync(file);
        size += stat.size;
        assert.ok(
          size <= 64 * 1024 * 1024 && files.length < 4096,
          "old review inventory exceeds bound",
        );
        files.push({
          relative: `integration/${relative}`,
          sha256: mailbox.digestRelative(`integration/${relative}`),
        });
      }
    }
  }
  visit(root, "");
  return files.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
}

function oldContext(
  mailbox,
  contract,
  result,
  ownerSessionId,
  assertOwner,
  ledger = null,
) {
  return { mailbox, contract, result, ownerSessionId, assertOwner, ledger };
}

// Synchronous admission/readback: native review runs were fully replayed at
// intent creation. Their complete immutable corpus is rehashed here, along
// with the old rehearsal, result, baseline and the present target (pre-apply).
export function verifyReviewProductOrigin({
  runtimeRoot,
  ledger,
  contract,
  intent,
  assertOwner,
  afterApply = false,
}) {
  assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/2");
  assert.equal(intent.mode, "blocked-review-product");
  assert.equal(intent.repairOrdinal, 1);
  assert.equal(intent.executionId, contract.identity.executionId);
  assert.equal(intent.requestDigest, digest(contract));
  const previous = ledger.getExecution(intent.previousExecutionId);
  assert.equal(previous.projectId, contract.identity.projectId);
  assert.equal(previous.goalId, contract.identity.goalId);
  assert.equal(previous.taskId, contract.identity.taskId);
  assert.equal(previous.taskRevision + 1, contract.identity.taskRevision);
  assert.equal(previous.ownerSessionId, intent.previousOwnerSessionId);
  assert.equal(previous.ownerEpoch, contract.identity.ownerEpoch);
  assert.equal(previous.requestDigest, intent.previousRequestDigest);
  assert.ok(
    ["FAILED", "CANCELLED"].includes(previous.state) &&
      !previous.reservationOpen &&
      previous.unresolvedRunCount === 0,
    "old review execution is not fully closed",
  );
  assert.equal(
    ledger.getAcceptance(previous.executionId),
    null,
    "old review was accepted",
  );
  const mailbox = Mailbox.open(
    path.join(
      runtimeRoot,
      "projects",
      previous.projectId,
      "executions",
      previous.executionId,
    ),
    previous.executionId,
  );
  const original = ledger.getContract(previous.executionId);
  assert.equal(digest(original), previous.requestDigest);
  assert.equal(original.policy.reviewProductRevision, "within-scope-once");
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
      original[key],
      `review product revision ${key} changed`,
    );
  assert.deepEqual(
    contract.checks.slice(0, original.checks.length),
    original.checks,
    "original checks changed",
  );
  assert.ok(
    contract.checks.length >= original.checks.length,
    "original checks dropped",
  );
  for (const check of contract.checks.slice(original.checks.length))
    assert.ok(
      original.checks.some(
        (old) => old.executable === check.executable && old.cwd === check.cwd,
      ),
      "new regression lacks a previously trusted runner",
    );
  assert.deepEqual(
    reviewFiles(mailbox),
    intent.oldFiles,
    "old review artifact inventory changed",
  );
  const baseline = mailbox.readJson("receipts/workspace-baseline.json");
  assert.equal(baseline.requestDigest, previous.requestDigest);
  assert.equal(digest(baseline.workspaces), intent.previousBaselineDigest);
  const relative = path.relative(mailbox.root, intent.previousResultRef);
  assert.match(relative, /^results\/r[0-9]{4}\.json$/);
  assert.equal(mailbox.digestRelative(relative), intent.previousResultSha256);
  const result = mailbox.readJson(relative);
  validateTaskResult(result, original, previous.requestDigest);
  assert.equal(digest(result), intent.previousResultDigest);
  assert.ok(
    isReviewableResult(result),
    "product revision requires a reviewable candidate",
  );
  assert.equal(result.unresolvedRunCount, 0);
  const latest = ledger.getLatestResult(previous.executionId);
  assert.equal(latest.resultDigest, intent.previousResultDigest);
  assert.equal(latest.resultRef, intent.previousResultRef);
  const manifest = mailbox.readJson(result.source.manifestRef);
  assert.equal(manifest.digest, result.source.sourceDigest);
  assert.equal(digest(manifest.files), manifest.digest);
  assert.equal(result.source.sourceDigest, intent.previousSourceDigest);
  if (!afterApply) {
    inspectWorktreeBase(
      original.workspace.sourceRoot,
      original.workspace.baseCommit,
    );
    assert.equal(
      snapshot(original.workspace.sourceRoot, original.workspace.sourcePaths)
        .digest,
      result.source.sourceDigest,
      "old target source drifted",
    );
  }
  const origin = oldContext(
    mailbox,
    original,
    result,
    previous.ownerSessionId,
    assertOwner,
  );
  const staged = readIntegrationRehearsal(origin);
  assert.equal(staged.tree, intent.oldTree);
  assert.equal(staged.workspaceDigest, intent.oldWorkspaceDigest);
  assert.equal(
    mailbox.digestRelative("integration/receipt.json"),
    intent.oldRehearsalSha256,
  );
  const request = mailbox.readJson("integration/review-request.json");
  assert.equal(request.digest, digest(request.subject));
  assert.equal(request.digest, intent.oldReviewRequestDigest);
  assert.equal(request.subject.rehearsalDigest, digest(staged));
  assert.equal(request.subject.resultDigest, digest(result));
  assert.equal(
    mailbox.digestRelative("integration/review.patch"),
    request.subject.patch.sha256,
  );
  assert.equal(request.subject.patch.sha256, intent.oldPatchSha256);
  const keys = fs
    .readdirSync(path.join(mailbox.root, "integration/reviews"), {
      withFileTypes: true,
    })
    .map((entry) => {
      assert.ok(
        entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name),
        "unknown old review operation",
      );
      return entry.name;
    })
    .sort();
  assert.deepEqual(
    keys,
    intent.waves.map((wave) => wave.key).sort(),
    "review wave inventory changed",
  );
  const identities = new Set();
  for (const wave of intent.waves) {
    const plan = mailbox.readJson(`integration/reviews/${wave.key}/plan.json`);
    const completion = mailbox.readJson(
      `integration/reviews/${wave.key}/complete.json`,
    );
    assert.equal(plan.planDigest, wave.planDigest);
    assert.equal(digest(completion), wave.completionDigest);
    assert.equal(completion.planDigest, wave.planDigest);
    assert.equal(completion.verdict, wave.verdict);
    assert.ok(
      completion.reports.every((row) =>
        ["pass", "blocked"].includes(row.report.verdict),
      ),
      "needs-user review report blocks product revision",
    );
    assert.equal(completion.requestDigest, request.digest);
    assert.deepEqual(
      wave.reports,
      completion.reports.map(({ key, runId, sessionId, sessionFile }) => ({
        key,
        runId,
        sessionId,
        sessionFile,
      })),
    );
    assert.deepEqual(
      wave.findings,
      completion.reports.flatMap(({ key, report }) =>
        report.findings.map((finding, index) => ({
          id: `${wave.key}/${key}:${index}`,
          ...finding,
        })),
      ),
    );
    assert.equal(wave.rootRunId, completion.runId);
    for (const identity of [
      completion.runId,
      ...wave.reports.flatMap((report) => [
        report.runId,
        report.sessionId,
        report.sessionFile,
      ]),
    ]) {
      assert.ok(
        !identities.has(identity),
        "original review reused an identity",
      );
      identities.add(identity);
    }
  }
  assert.ok(
    intent.waves.some(
      (wave) =>
        wave.verdict === "blocked" &&
        wave.findings.some((finding) => finding.severity === "blocker"),
    ),
    "no original product blocker",
  );
  const relativeFailure = path.relative(mailbox.root, intent.reviewFailureRef);
  assert.ok(
    path.isAbsolute(intent.reviewFailureRef) &&
      path.join(mailbox.root, relativeFailure) === intent.reviewFailureRef &&
      completeRef.test(relativeFailure),
    "original review failure reference changed",
  );
  assert.ok(
    intent.waves.some(
      (wave) =>
        wave.key === completeRef.exec(relativeFailure)[1] &&
        wave.verdict === "blocked",
    ),
    "selected review was not blocked",
  );
  assert.equal(
    mailbox.digestRelative(relativeFailure),
    intent.reviewFailureSha256,
  );
  assert.equal(
    integrationReviewBinding(origin, staged, {
      requestDigest: request.digest,
      candidateDigest: digest(intent.waves),
    }).writerEvidenceDigest,
    intent.writerEvidenceDigest,
    "old native writer evidence changed",
  );
  assert.equal(
    intent.deadlineAt,
    Date.parse(previous.createdAt) + original.policy.deadlineMs,
  );
  assert.ok(Date.now() < intent.deadlineAt, "original Task deadline exhausted");
  assertOwner();
  return { mailbox, original, result, staged, request, previous };
}

export async function reviewProductRevisionIntent({
  orchestrator,
  previous,
  oldContract,
  previousMailbox,
  spec,
  revision,
  baseline,
}) {
  assert.equal(oldContract.schemaVersion, "teams-task-runtime/3");
  assert.equal(oldContract.policy.tokenBudgetMode, "shared");
  assert.equal(
    oldContract.policy.reviewProductRevision,
    "within-scope-once",
    "original Task did not authorize review-origin product repair",
  );
  assert.ok(
    ["CANCELLED", "FAILED"].includes(previous.state) &&
      !previous.reservationOpen &&
      previous.unresolvedRunCount === 0,
    "old execution must be closed without unknown effects",
  );
  assert.equal(
    previous.ownerSessionId,
    orchestrator.ownerSessionId,
    "original live L0 required",
  );
  assert.equal(
    previous.ownerEpoch,
    orchestrator.assertController(previous.projectId).ownerEpoch,
    "controller epoch changed",
  );
  assert.equal(
    orchestrator.ledger.getAcceptance(previous.executionId),
    null,
    "old Task already accepted",
  );
  assert.equal(revision.previousExecutionId, previous.executionId);
  assert.match(revision.expectedPreviousResultDigest ?? "", sha);
  assert.match(revision.reviewFailureSha256 ?? "", sha);
  assert.ok(
    typeof revision.repairReason === "string" &&
      revision.repairReason.trim() &&
      Buffer.byteLength(revision.repairReason) <= 500,
    "bounded product repair reason required",
  );
  const relative = path.relative(
    previousMailbox.root,
    revision.reviewFailureRef ?? "",
  );
  assert.ok(
    path.isAbsolute(revision.reviewFailureRef) &&
      path.join(previousMailbox.root, relative) === revision.reviewFailureRef &&
      completeRef.test(relative),
    "frozen BLOCKED review completion required",
  );
  for (const name of [
    "failure.json",
    "review-candidate.json",
    "review-candidate-intent.json",
    "target-apply",
  ])
    assert.ok(
      !fs.existsSync(path.join(previousMailbox.root, "integration", name)),
      "old candidate has failure, seal or target journal",
    );
  assert.ok(
    !fs
      .readdirSync(path.join(previousMailbox.root, "receipts"))
      .some((name) => /^acceptance-.*\.json$/.test(name)),
    "old acceptance publication exists",
  );
  const latest = orchestrator.ledger.getLatestResult(previous.executionId);
  const resultRelative = path.relative(previousMailbox.root, latest.resultRef);
  assert.match(resultRelative, /^results\/r[0-9]{4}\.json$/);
  const result = previousMailbox.readJson(resultRelative);
  validateTaskResult(result, oldContract, previous.requestDigest);
  assert.equal(digest(result), latest.resultDigest);
  assert.equal(digest(result), revision.expectedPreviousResultDigest);
  assert.ok(
    isReviewableResult(result),
    "product revision requires a reviewable candidate",
  );
  assert.equal(result.unresolvedRunCount, 0);
  const oldBaseline = previousMailbox.readJson(
    "receipts/workspace-baseline.json",
  );
  assert.equal(oldBaseline.requestDigest, previous.requestDigest);
  assert.deepEqual(
    oldBaseline.workspaces,
    baseline.workspaces,
    "original workspace baseline changed",
  );
  const source = snapshot(
    oldContract.workspace.sourceRoot,
    oldContract.workspace.sourcePaths,
  );
  assert.equal(
    source.digest,
    result.source.sourceDigest,
    "original source changed",
  );
  inspectWorktreeBase(
    oldContract.workspace.sourceRoot,
    oldContract.workspace.baseCommit,
  );
  const origin = oldContext(
    previousMailbox,
    oldContract,
    result,
    previous.ownerSessionId,
    () => {
      orchestrator.assertController(previous.projectId);
      assert.equal(
        orchestrator.ledger.getExecution(previous.executionId).revision,
        previous.revision,
        "old execution changed",
      );
    },
    orchestrator.ledger,
  );
  const staged = readIntegrationRehearsal(origin);
  const request = previousMailbox.readJson("integration/review-request.json");
  assert.equal(request.digest, digest(request.subject));
  assert.equal(request.subject.rehearsalDigest, digest(staged));
  assert.equal(request.subject.resultDigest, digest(result));
  assert.equal(
    previousMailbox.digestRelative("integration/review.patch"),
    request.subject.patch.sha256,
    "old reviewed patch changed",
  );
  const root = path.join(previousMailbox.root, "integration/reviews");
  const keys = fs
    .readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      assert.ok(
        entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name),
        "unresolved or unknown review wave",
      );
      return entry.name;
    })
    .sort();
  assert.ok(
    keys.length > 0 && keys.length <= oldContract.policy.maxRoleSpawnsPerTask,
    "bounded complete review inventory required",
  );
  const waves = [];
  for (const key of keys) {
    const plan = previousMailbox.readJson(
      `integration/reviews/${key}/plan.json`,
    );
    const complete = await readCompletedReviewWave(
      origin,
      key,
      plan.planDigest,
    );
    assert.ok(
      ["pass", "blocked"].includes(complete.verdict) &&
        complete.reports.every((row) =>
          ["pass", "blocked"].includes(row.report.verdict),
        ),
      "needs-user or unknown review is not product revision",
    );
    waves.push({
      key,
      planDigest: plan.planDigest,
      completionDigest: digest(complete),
      verdict: complete.verdict,
      findings: complete.reports.flatMap(({ key: reportKey, report }) =>
        report.findings.map((finding, index) => ({
          id: `${key}/${reportKey}:${index}`,
          ...finding,
        })),
      ),
      rootRunId: complete.runId,
      reports: complete.reports.map(
        ({ key: reportKey, runId, sessionId, sessionFile }) => ({
          key: reportKey,
          runId,
          sessionId,
          sessionFile,
        }),
      ),
    });
  }
  assert.ok(
    waves.some(
      (wave) =>
        wave.verdict === "blocked" &&
        wave.findings.some((finding) => finding.severity === "blocker"),
    ),
    "review lacks an explicit product blocker",
  );
  const anchor = completeRef.exec(relative)[1];
  assert.equal(
    waves.find((wave) => wave.key === anchor)?.verdict,
    "blocked",
    "selected review is not BLOCKED",
  );
  assert.equal(
    previousMailbox.digestRelative(relative),
    revision.reviewFailureSha256,
  );
  const writer = integrationReviewBinding(origin, staged, {
    requestDigest: request.digest,
    candidateDigest: digest(waves),
  });
  const deadlineAt =
    Date.parse(previous.createdAt) + oldContract.policy.deadlineMs;
  assert.ok(Date.now() < deadlineAt, "original Task deadline exhausted");
  // Only the proposed draft is correctable. Ownership, old source/evidence,
  // review completion and deadline above are independently verified first.
  // No successor reservation or launch has occurred at this boundary.
  validateInput("task-spec", () => {
    assert.equal(spec.taskRevision, previous.taskRevision + 1);
    assert.equal(spec.goalId, previous.goalId);
    assert.equal(spec.taskId, previous.taskId);
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
        `review product revision ${key} changed`,
      );
    assert.ok(Array.isArray(spec.checks), "checks array required");
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
  });
  return {
    schemaVersion: "teams-candidate-repair-intent/2",
    mode: "blocked-review-product",
    repairOrdinal: 1,
    previousExecutionId: previous.executionId,
    previousOwnerSessionId: previous.ownerSessionId,
    previousRequestDigest: previous.requestDigest,
    previousResultDigest: digest(result),
    previousResultRef: latest.resultRef,
    previousResultSha256: previousMailbox.digestRelative(resultRelative),
    previousSourceDigest: source.digest,
    previousBaselineDigest: digest(oldBaseline.workspaces),
    oldRehearsalSha256: previousMailbox.digestRelative(
      "integration/receipt.json",
    ),
    oldTree: staged.tree,
    oldWorkspaceDigest: staged.workspaceDigest,
    oldPatchSha256: request.subject.patch.sha256,
    oldPatchRef: path.join(previousMailbox.root, "integration/review.patch"),
    oldReviewRequestDigest: request.digest,
    oldFiles: reviewFiles(previousMailbox),
    waves,
    writerEvidenceDigest: writer.writerEvidenceDigest,
    reviewFailureRef: revision.reviewFailureRef,
    reviewFailureSha256: revision.reviewFailureSha256,
    repairReason: revision.repairReason.trim(),
    deadlineAt,
  };
}

function repairCheckoutPrefix(contract) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "set -eu",
    'for name in "${!GIT_@}"; do unset "$name"; done',
    "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1",
    'ROOT="$(pwd -P)"',
    '[ "$ROOT" = "$(git -c core.fsmonitor=false rev-parse --show-toplevel)" ]',
    `[ "$ROOT" != ${quote(contract.workspace.sourceRoot)} ]`,
    `[ "$(git rev-parse HEAD)" = ${quote(contract.workspace.baseCommit)} ]`,
    '[ -z "$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)" ]',
  ];
}

export function reviewRepairCommand(intent, contract) {
  // All interpolated values are host-validated canonical absolute paths or
  // immutable SHA/tree hex. No free-form model text enters this command.
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const patch = quote(intent.oldPatchRef);
  const expected = quote(intent.oldPatchSha256);
  const tree = quote(intent.oldTree);
  return [
    ...repairCheckoutPrefix(contract),
    `[ "$(sha256sum ${patch} | cut -d ' ' -f1)" = ${expected} ]`,
    `git apply --index --check --binary --whitespace=nowarn ${patch}`,
    `git apply --index --binary --whitespace=nowarn ${patch}`,
    `[ "$(git write-tree)" = ${tree} ]`,
    `printf 'TASK_PI_REVIEW_PRODUCT_BASE_READY:%s\\n' ${tree}`,
  ].join("\n");
}

export function verifyReviewWriterReconstruction(intent, contract, native) {
  return {
    ...verifyWriterReconstruction(
      native,
      reviewRepairCommand(intent, contract),
      `TASK_PI_REVIEW_PRODUCT_BASE_READY:${intent.oldTree}\n`,
    ),
    oldTree: intent.oldTree,
  };
}

// Both repair origins require the exact host reconstruction before leaf writes.
export function verifyWriterReconstruction(native, command, marker) {
  const writers = native.lanes.filter((lane) =>
    ["mutation", "check"].includes(lane.mode),
  );
  assert.equal(
    writers.length,
    1,
    "product revision requires one complete mutation lane",
  );
  assert.equal(
    writers[0].mode,
    "mutation",
    "product repair needs a new mutation writer",
  );
  assert.ok(
    native.lanes.every(
      (lane) =>
        lane === writers[0] || ["read-only", "review"].includes(lane.mode),
    ),
    "second writer is forbidden",
  );
  const session = native.files.find(
    (file) => file.path === writers[0].sessionFile,
  );
  assert.ok(session, "native writer session capture required");
  let call = null,
    result = null,
    earlierWrite = false;
  const entries = session.bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new Error("invalid native writer session; reconcile", { cause });
      }
    });
  const rejected = reconstructionRejections(entries, command);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const part of message.content ?? [])
        if (part.type === "toolCall") {
          if (rejected.has(part.id)) continue; // Native pre-tool block, never a shell exit classification.
          if (part.name === "bash" && part.arguments?.command === command) {
            assert.ok(
              !call && !earlierWrite,
              "review writer reconstruction must precede writes",
            );
            call = part.id;
          } else if (
            !call &&
            ["bash", "write", "edit", "ast_grep_replace"].includes(part.name)
          )
            earlierWrite = true;
        }
    } else if (message?.role === "toolResult" && message.toolCallId === call) {
      assert.ok(!result, "duplicate reconstruction result");
      result = message;
    }
  }
  assert.ok(
    call && result && result.toolName === "bash" && result.isError === false,
    "native reconstruction command/result missing",
  );
  assert.ok(
    result.content?.some(
      (row) => row.type === "text" && row.text.includes(marker),
    ),
    "reconstruction tree proof missing",
  );
  return {
    writerRunId: writers[0].runId,
    sessionFile: session.path,
    sessionSha256: session.sha256,
  };
}
