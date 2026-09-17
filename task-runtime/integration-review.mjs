// L0 frozen review preparation/readback and format checks. Never accepts a task,
// dispatches a model, or upgrades native acceptance. Native run binding is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  readEvidenceBytes,
  saveEvidenceJson,
  snapshot,
} from "../host-evidence.mjs";
import {
  bytesDigest,
  canonicalBytes,
  digest,
  validateScopedPath,
} from "./contracts.mjs";
import {
  integrationGit,
  integrationWorkspaceSnapshot,
  readIntegrationRehearsal,
} from "./integration.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";
import { verifyIntegrationApply } from "./integration-apply.mjs";

const sha = /^[a-f0-9]{64}$/;
function exact(value, keys) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "review object required",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "review fields changed",
  );
}
function text(value) {
  assert.ok(
    typeof value === "string" && value.trim() && value.length <= 4096,
    "bounded review explanation required",
  );
}
// Self-consistency is not authentication: callers obtain this request from the
// owner-checked preparation/readback above, never from arbitrary model output.
function checkRequest(request) {
  assert.ok(
    canonicalBytes(request).length <= 1024 * 1024,
    "review request exceeds 1 MiB",
  );
  assert.equal(
    request.schemaVersion,
    "teams-integration-review-request/1",
    "unsupported review request",
  );
  assert.equal(request.acceptance, "not-assessed", "request is not acceptance");
  assert.equal(
    digest(request.subject),
    request.digest,
    "review subject changed",
  );
}

export function prepareIntegrationReview(context) {
  return integrationReview(context);
}

export function readAppliedIntegrationReview(context, planDigest) {
  assert.match(
    typeof planDigest === "string" ? planDigest : "",
    sha,
    "explicit apply plan digest required",
  );
  assert.ok(
    fs.existsSync(
      path.join(context.mailbox.root, "integration/review-request.json"),
    ),
    "existing frozen review request required",
  );
  return integrationReview(context, planDigest);
}

// Called only alongside readIntegrationRehearsal, which verifies each declared
// check's input, source, intent and log. Freeze references to those exact bytes;
// the report's existing requestDigest binds this evidence as well as the source.
function reviewHostChecks({ contract, mailbox }) {
  return contract.checks.map((check) => {
    const file = path.join(
      mailbox.root,
      "integration",
      `check-${check.commandId}.json`,
    );
    const bytes = readEvidenceBytes(file, 1024 * 1024);
    const receipt = JSON.parse(bytes.toString("utf8"));
    return {
      commandId: check.commandId,
      criterionIds: check.criterionIds,
      status: receipt.status,
      sourceDigest: receipt.after.digest,
      receipt: { path: file, sha256: bytesDigest(bytes) },
      log: { path: `${file}.log`, sha256: receipt.logSha256 },
    };
  });
}

function integrationReview(context, appliedPlanDigest) {
  const { contract, result, mailbox, ownerSessionId, assertOwner } = context;
  assertOwner();
  assert.equal(
    contract.schemaVersion,
    "teams-task-runtime/3",
    "L0 review requires a new v3 contract",
  );
  assert.equal(
    contract.policy.review.authority,
    "l0-source-bound",
    "L0 review authority required",
  );
  const staged = readIntegrationRehearsal(context);
  const current = integrationWorkspaceSnapshot(staged.cwd);
  assert.equal(
    current.digest,
    staged.workspaceDigest,
    "review workspace changed",
  );
  const patch = integrationGit(
    staged.cwd,
    [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      contract.workspace.baseCommit,
      "--",
    ],
    { encoding: "buffer" },
  );
  const subject = {
    identity: contract.identity,
    ownerSessionId,
    contractDigest: digest(contract),
    resultDigest: digest(result),
    rehearsalDigest: digest(staged),
    cwd: staged.cwd,
    baseCommit: contract.workspace.baseCommit,
    tree: staged.tree,
    sourceDigest: staged.sourceDigest,
    workspaceDigest: staged.workspaceDigest,
    patch: {
      path: path.join(mailbox.root, "integration/review.patch"),
      sha256: bytesDigest(patch),
    },
    sourceFiles: current.files
      .filter((file) => file.sha256)
      .map((file) => file.path),
    changedPaths: [
      ...new Set(staged.lanes.flatMap((lane) => lane.changedPaths)),
    ].sort(),
    writerRoles: [
      ...new Set(
        staged.lanes
          .filter((lane) => ["mutation", "check"].includes(lane.mode))
          .map((lane) => lane.role),
      ),
    ].sort(),
    policy: contract.policy.review,
    objective: contract.objective,
    nonGoals: contract.nonGoals,
    criteria: contract.criteria,
    hostChecks: reviewHostChecks(context),
  };
  const request = {
    schemaVersion: "teams-integration-review-request/1",
    subject,
    digest: digest(subject),
    acceptance: "not-assessed",
  };
  checkRequest(request);
  const file = path.join(mailbox.root, "integration/review-request.json");
  function fresh() {
    assertOwner();
    if (appliedPlanDigest !== undefined) {
      verifyIntegrationApply(context, appliedPlanDigest);
    } else {
      inspectWorktreeBase(
        contract.workspace.sourceRoot,
        contract.workspace.baseCommit,
      );
      assert.equal(
        snapshot(contract.workspace.sourceRoot, contract.workspace.sourcePaths)
          .digest,
        result.source.sourceDigest,
        "target source changed before review",
      );
    }
    assert.equal(
      digest(readIntegrationRehearsal(context)),
      subject.rehearsalDigest,
      "review rehearsal changed",
    );
    assert.deepEqual(
      reviewHostChecks(context),
      subject.hostChecks,
      "review host evidence changed",
    );
  }
  fresh();
  if (fs.existsSync(file)) {
    let stored;
    try {
      stored = JSON.parse(
        readEvidenceBytes(file, 1024 * 1024).toString("utf8"),
      );
    } catch (cause) {
      throw new Error("invalid saved review request; reconcile", { cause });
    }
    assert.deepEqual(stored, request, "review request changed");
    assert.equal(
      bytesDigest(readEvidenceBytes(subject.patch.path, 8 * 1024 * 1024)),
      subject.patch.sha256,
      "review patch changed",
    );
  } else {
    assert.equal(
      appliedPlanDigest,
      undefined,
      "after-apply reader cannot prepare review evidence",
    );
    assert.ok(
      !fs.existsSync(subject.patch.path),
      "incomplete review preparation; reconcile before retry",
    );
    const fd = fs.openSync(subject.patch.path, "wx", 0o600);
    try {
      fs.writeFileSync(fd, patch);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fresh();
    saveEvidenceJson(file, request);
  }
  fresh();
  return request;
}

// The host must resolve this public contract from its exact planned launch input.
// An allowlist is a trusted-policy ceiling, NOT a filesystem sandbox or proof that
// an extension has no OS side effects. This is not evidence of an actual launch.
export function validateReviewLaunch(request, resolution) {
  checkRequest(request);
  assert.equal(resolution?.ok, true, "public review preflight unavailable");
  const launch = resolution.contract;
  assert.equal(launch?.version, 2, "unsupported public launch contract schema");
  const role = launch.agent?.name;
  assert.ok(
    request.subject.policy.allowedRoles.includes(role),
    "review role not approved",
  );
  assert.ok(
    !request.subject.writerRoles.includes(role),
    "writer role cannot self-review",
  );
  assert.equal(launch.context, "fresh", "fresh review context required");
  assert.equal(launch.roots?.cwd, request.subject.cwd, "review cwd mismatch");
  assert.match(
    launch.agent.definitionDigest,
    sha,
    "review definition digest missing",
  );
  assert.match(
    launch.launchContractDigest,
    sha,
    "review launch digest missing",
  );
  assert.ok(
    Array.isArray(launch.diagnostics) &&
      launch.diagnostics.every((row) => row.severity === "warning"),
    "unresolved public review preflight",
  );
  const tools = launch.tools;
  assert.equal(
    tools?.explicitAllowlist,
    true,
    "explicit review tool allowlist required",
  );
  assert.equal(
    tools.disableAmbientExtensions,
    true,
    "ambient extensions forbidden for review",
  );
  assert.equal(tools.fanoutAuthorized, false, "reviewer nesting forbidden");
  assert.ok(
    Array.isArray(tools.effectiveAllowlist) &&
      tools.effectiveAllowlist.length > 0 &&
      Array.isArray(tools.effectiveMcpTools),
    "resolved review tools required",
  );
  assert.ok(
    [...tools.effectiveAllowlist, ...tools.effectiveMcpTools].every((name) =>
      request.subject.policy.allowedTools.includes(name),
    ),
    "review tools exceed approved read-only ceiling",
  );
  return {
    role,
    definitionDigest: launch.agent.definitionDigest,
    launchContractDigest: launch.launchContractDigest,
    requestDigest: request.digest,
    acceptance: "not-assessed",
  };
}

export function integrationReviewSchema(request) {
  checkRequest(request);
  const explanation = {
    type: "string",
    minLength: 1,
    maxLength: 4096,
    pattern: "\\S",
  };
  const paths = {
    type: "array",
    minItems: 1,
    maxItems: 128,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      enum: [
        ...new Set([
          ...request.subject.sourceFiles,
          ...request.subject.changedPaths,
        ]),
      ].sort(),
    },
  };
  const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  return object({
    schemaVersion: {
      type: "string",
      const: "teams-integration-review-report/1",
    },
    requestDigest: { type: "string", const: request.digest },
    verdict: { type: "string", enum: ["pass", "blocked", "needs-user"] },
    criteria: object(
      Object.fromEntries(
        request.subject.criteria.map((criterion) => [
          criterion.id,
          object({
            status: { type: "string", enum: ["met", "blocked", "needs-user"] },
            reason: explanation,
            sourcePaths: paths,
          }),
        ]),
      ),
    ),
    findings: {
      type: "array",
      maxItems: 128,
      items: object({
        severity: { type: "string", enum: ["blocker", "non-blocking"] },
        issue: explanation,
        rationale: explanation,
        sourcePaths: paths,
      }),
    },
  });
}

// A well-formed PASS is still only a report. Callers must bind a real independent
// native run, terminal/usage evidence and before/after source before acceptance.
export function validateReviewReport(request, report) {
  checkRequest(request);
  exact(report, [
    "schemaVersion",
    "requestDigest",
    "verdict",
    "criteria",
    "findings",
  ]);
  assert.ok(
    canonicalBytes(report).length <= 1024 * 1024,
    "review report exceeds 1 MiB",
  );
  assert.equal(report.schemaVersion, "teams-integration-review-report/1");
  assert.equal(
    report.requestDigest,
    request.digest,
    "review report subject mismatch",
  );
  assert.ok(
    ["pass", "blocked", "needs-user"].includes(report.verdict),
    "invalid review verdict",
  );
  exact(
    report.criteria,
    request.subject.criteria.map((criterion) => criterion.id),
  );
  const files = new Set([
    ...request.subject.sourceFiles,
    ...request.subject.changedPaths,
  ]);
  function paths(values) {
    assert.ok(
      Array.isArray(values) &&
        values.length > 0 &&
        values.length <= 128 &&
        new Set(values).size === values.length,
      "bounded unique review source paths required",
    );
    for (const value of values) {
      validateScopedPath(value, "review source path");
      assert.ok(files.has(value), "review source path outside frozen subject");
    }
  }
  for (const row of Object.values(report.criteria)) {
    exact(row, ["status", "reason", "sourcePaths"]);
    assert.ok(
      ["met", "blocked", "needs-user"].includes(row.status),
      "invalid review criterion status",
    );
    text(row.reason);
    paths(row.sourcePaths);
  }
  assert.ok(
    Array.isArray(report.findings) && report.findings.length <= 128,
    "bounded review findings required",
  );
  for (const finding of report.findings) {
    exact(finding, ["severity", "issue", "rationale", "sourcePaths"]);
    assert.ok(
      ["blocker", "non-blocking"].includes(finding.severity),
      "invalid finding severity",
    );
    text(finding.issue);
    text(finding.rationale);
    paths(finding.sourcePaths);
  }
  if (report.verdict === "pass") {
    assert.ok(
      Object.values(report.criteria).every((row) => row.status === "met"),
      "PASS contradicts review criteria",
    );
    assert.ok(
      report.findings.every((finding) => finding.severity !== "blocker"),
      "PASS contains a blocker",
    );
  }
  return report;
}
