// L0 v3 policy over public native artifacts. Never upgrades native ledger status.
import assert from "node:assert/strict";
import path from "node:path";
import { readEvidenceBytes } from "../host-evidence.mjs";
import { bytesDigest, digest, validateScopedPath } from "./contracts.mjs";
import { inspectNativeHandoffs } from "./native-handoff.mjs";
import { nativeWorkflowResult } from "./role-lifecycle.mjs";
import { measureSessionBytes } from "./task-usage.mjs";
import { usesSharedTaskBudget } from "./budget-pool.mjs";
import { assertTaskBudgetUsage } from "./task-budget.mjs";

function writerEvidence(step) {
  assert.equal(step.exitCode, 0, "native writer exit proof missing");
  const a = step.acceptance;
  assert.ok(
    ["checked", "verified"].includes(a?.evidenceStatus),
    "native writer evidence not checked",
  );
  const policy = a.effectiveAcceptance;
  assert.ok(
    ["checked", "verified"].includes(policy?.level),
    "native writer evidence policy missing",
  );
  if (policy.level === "verified")
    assert.equal(
      a.evidenceStatus,
      "verified",
      "native verified evidence required",
    );
  // The public effective policy omits review entirely when it is not required.
  // An explicit review object must still declare a valid boolean.
  const required = policy.review === undefined ? false : policy.review.required;
  assert.equal(
    typeof required,
    "boolean",
    "native writer review policy missing",
  );
  assert.ok(
    (required
      ? ["review-required", "reviewed"]
      : ["checked", "verified"]
    ).includes(a.status),
    "native writer rejected or inconsistent review status",
  );
  assert.equal(
    a.childReportParseError,
    undefined,
    "native writer report parse error",
  );
  assert.ok(
    a.childReport &&
      typeof a.childReport === "object" &&
      !Array.isArray(a.childReport),
    "native writer report missing",
  );
  assert.deepEqual(
    a.criteria,
    policy.criteria,
    "native writer criteria changed",
  );
  assert.ok(Array.isArray(a.criteria), "native writer criteria missing");
  for (const criterion of a.criteria) {
    assert.ok(
      ["required", "recommended"].includes(criterion.severity),
      "unknown native criterion severity",
    );
    if (criterion.severity === "required") {
      const rows = a.childReport.criteriaSatisfied?.filter(
        (row) => row.id === criterion.id,
      );
      assert.equal(rows?.length, 1, "native required criterion report missing");
      assert.equal(
        rows[0].status,
        "satisfied",
        "native required criterion unsatisfied",
      );
    }
  }
  assert.ok(
    Array.isArray(a.runtimeChecks) &&
      a.runtimeChecks.every((check) =>
        ["passed", "not-applicable"].includes(check.status),
      ),
    "native runtime check failed or unknown",
  );
  assert.ok(
    Array.isArray(policy.verify) && Array.isArray(a.verifyRuns),
    "native verify inventory missing",
  );
  assert.deepEqual(
    a.verifyRuns.map((run) => run.id).sort(),
    policy.verify.map((run) => run.id).sort(),
    "native verify inventory changed",
  );
  assert.equal(
    new Set(a.verifyRuns.map((run) => run.id)).size,
    a.verifyRuns.length,
    "duplicate native verify run",
  );
  for (const run of a.verifyRuns) {
    const declared = policy.verify.find((item) => item.id === run.id);
    assert.equal(
      run.command,
      declared.command,
      "native verify command changed",
    );
    if (declared.cwd !== undefined)
      assert.equal(run.cwd, declared.cwd, "native verify cwd changed");
    assert.equal(run.status, "passed", "native verify did not pass");
    assert.equal(run.exitCode, 0, "native verify exit failed");
    assert.equal(run.artifactError, undefined, "native verify artifact error");
  }
  if (a.parentDecision !== undefined)
    assert.equal(
      a.parentDecision.status,
      "accepted",
      "native parent rejected or unknown",
    );
  if (a.reviewResult !== undefined) {
    assert.ok(
      ["review-required", "reviewed"].includes(a.reviewResult.status),
      "native review blockers or unknown",
    );
    assert.ok(
      Array.isArray(a.reviewResult.findings) &&
        a.reviewResult.findings.every((row) => row.severity === "non-blocking"),
      "native review has blocker or unknown finding",
    );
  }
  if (a.status === "reviewed")
    assert.equal(
      a.reviewResult?.status,
      "reviewed",
      "native reviewed proof missing",
    );
}

export function integrationReviewBinding(context, staged, candidate) {
  const { contract, result, mailbox } = context;
  context.assertOwner();
  assert.equal(
    contract.schemaVersion,
    "teams-task-runtime/3",
    "L0 authority requires new v3 contract",
  );
  assert.equal(
    contract.policy.review.authority,
    "l0-source-bound",
    "L0 review authority required",
  );
  assert.ok(
    contract.criteria.every((criterion) =>
      criterion.requiredEvidenceKinds.every((kind) => kind === "host-check"),
    ),
    "final integrated-source evidence binding required before apply",
  );
  const read = (origin, limit) => {
    const rows = staged.captures.filter((row) => row.origin === origin);
    assert.equal(rows.length, 1, "unique captured native artifact required");
    const row = rows[0];
    validateScopedPath(row.saved, "captured native artifact");
    assert.ok(
      row.saved.startsWith("captures/"),
      "captured native artifact escapes integration",
    );
    const bytes = readEvidenceBytes(
      path.join(mailbox.root, "integration", row.saved),
      limit,
    );
    assert.equal(
      bytesDigest(bytes),
      row.sha256,
      "captured native artifact changed",
    );
    return bytes;
  };
  // Replay the SAME public identity/terminal/handoff parser against durable copies,
  // including workflowKey lookup. Native temporary paths may already be removed.
  const native = inspectNativeHandoffs(
    mailbox,
    contract,
    result.childRunRefs,
    read,
  );
  assert.deepEqual(
    native.lanes,
    staged.lanes.map(({ tree: _tree, changedPaths: _paths, ...lane }) => lane),
    "integration lane inventory changed",
  );
  const roles = mailbox
    .listEvents()
    .filter((row) => row.type === "progress")
    .map((row) => mailbox.readJson(row.payloadRef, 16 * 1024))
    .filter((row) => row.kind === "role-started");
  assert.equal(
    new Set(roles.map((role) => role.runId)).size,
    roles.length,
    "duplicate native root run",
  );
  const receipts = roles.map((role) => {
    let status;
    const statusBytes = read(
      path.join(role.asyncDir, "status.json"),
      1024 * 1024,
    );
    try {
      status = JSON.parse(statusBytes.toString("utf8"));
    } catch (cause) {
      throw new Error(`Invalid captured native writer status: ${role.runId}`, {
        cause,
      });
    }
    const hosted =
      role.hostedWorkflow && !Object.hasOwn(status, "processTerminal");
    const budget = status.usageBudget;
    if (!hosted || budget !== undefined) {
      assert.equal(budget?.version, 1, "native budget version missing");
      assert.equal(budget.source, "reported", "native reported budget missing");
      assert.equal(budget.exhausted, false, "native budget failed or unknown");
      assert.ok(
        Number.isSafeInteger(budget.tokens?.used) && budget.tokens.used >= 0,
        "native reported usage missing",
      );
    }
    const allocated = role.members.reduce(
      (sum, member) => sum + member.maxTokens,
      0,
    );
    assert.ok(
      Number.isSafeInteger(allocated) &&
        allocated > 0 &&
        allocated <= contract.policy.maxTaskTokens,
      "native allocation invalid",
    );
    if (!hosted || budget !== undefined) {
      assert.equal(
        budget.tokens.hard,
        usesSharedTaskBudget(contract)
          ? contract.policy.maxTaskTokens
          : allocated,
        "native budget allocation changed",
      );
      assert.ok(
        budget.tokens.used <=
          (usesSharedTaskBudget(contract)
            ? contract.policy.maxTaskTokens
            : allocated) &&
          ["within-budget", "soft-exceeded"].includes(budget.tokens.outcome),
        "native reported budget exceeded or unknown",
      );
    }
    let measuredTokens = 0;
    for (const [index, member] of role.members.entries()) {
      assert.ok(
        contract.policy.allowedRoles.includes(member.role),
        "native role outside approved policy",
      );
      assert.ok(
        ["mutation", "check", "read-only", "review"].includes(member.mode),
        "unknown native member mode",
      );
      const display = status.workflow
        ? status.steps.find((row) => row.workflowKey === member.key)
        : status.steps[index];
      const step = hosted ? nativeWorkflowResult(status, display) : display;
      if (hosted || usesSharedTaskBudget(contract)) {
        const measured = measureSessionBytes(
          read(step.sessionFile, 8 * 1024 * 1024),
        );
        const { usage } = measured;
        assertTaskBudgetUsage({ contract, mailbox }, [
          { ...measured, kind: "leaf", sessionFile: step.sessionFile },
        ]);
        assert.ok(
          usesSharedTaskBudget(contract) || usage.total <= member.maxTokens,
          "native member budget exceeded",
        );
        measuredTokens += usage.total;
        assert.ok(
          Number.isSafeInteger(measuredTokens) &&
            (usesSharedTaskBudget(contract) || measuredTokens <= allocated),
          "native wave budget exceeded",
        );
      }
      if (["mutation", "check"].includes(member.mode)) writerEvidence(step);
      else {
        assert.ok(
          step.acceptance &&
            ["not-required", "checked", "verified", "reviewed"].includes(
              step.acceptance.status,
            ),
          "native reader evidence failed or unknown",
        );
        assert.ok(
          !step.acceptance.effectiveAcceptance?.review?.required,
          "reader needs separate native review proof",
        );
        assert.ok(
          step.acceptance.parentDecision === undefined ||
            step.acceptance.parentDecision.status === "accepted",
          "native reader parent rejected or unknown",
        );
        assert.ok(
          step.acceptance.reviewResult === undefined ||
            (step.acceptance.reviewResult.status === "reviewed" &&
              Array.isArray(step.acceptance.reviewResult.findings) &&
              step.acceptance.reviewResult.findings.every(
                (row) => row.severity === "non-blocking",
              )),
          "native reader review failed or unknown",
        );
      }
    }
    // Native telemetry may contain fractional numbers. Bind the verified raw
    // capture, not the integer-only canonical form used for our task contracts.
    return { runId: role.runId, statusDigest: bytesDigest(statusBytes) };
  });
  context.assertOwner();
  return {
    schemaVersion: "teams-integration-review-binding/1",
    requestDigest: candidate.requestDigest,
    candidateDigest: candidate.candidateDigest,
    writerEvidenceDigest: digest(receipts),
  };
}
