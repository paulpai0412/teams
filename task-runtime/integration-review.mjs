// L0 frozen review preparation/readback and format checks. Never accepts a task,
// dispatches a model, or upgrades native acceptance. Native run binding is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
import { TaskInputRejection } from "./input-rejection.mjs";
import { verifyIntegrationApply } from "./integration-apply.mjs";
import { verifyReportOrigin } from "./report-lineage.mjs";
import { verifyReviewProductOrigin } from "./review-product-lineage.mjs";
import { verifyConflictRepairBinding } from "./integration-conflict.mjs";

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
function reviewHostChecks(context) {
  const { contract, mailbox } = context;
  const staged = readIntegrationRehearsal(context);
  const origin = staged.inheritedFrom
    ? verifyReportOrigin({
        runtimeRoot: context.runtimeRoot,
        ledger: context.ledger,
        contract,
        intent: mailbox.readJson("receipts/report-revision-intent.json"),
        assertOwner: context.assertOwner,
      })
    : null;
  return contract.checks.map((check) => {
    const file = path.join(
      origin?.mailbox.root ?? mailbox.root,
      "integration",
      `check-${check.commandId}.json`,
    );
    const bytes = readEvidenceBytes(file, 1024 * 1024);
    let receipt;
    try {
      receipt = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new Error(`Invalid source-bound host-check receipt: ${file}`, {
        cause,
      });
    }
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
    ...(mailbox.readJson("integration/native.json").repairs?.length
      ? {
          branchRecovery: {
            ref: path.join(mailbox.root, "integration/native.json"),
            sha256: mailbox.digestRelative("integration/native.json"),
          },
        }
      : {}),
    ...(mailbox.readJson("bootstrap.json").repairIntentDigest &&
    mailbox.readJson("receipts/repair-intent.json").schemaVersion ===
      "teams-candidate-repair-intent/2"
      ? (() => {
          const intent = mailbox.readJson("receipts/repair-intent.json");
          assert.equal(
            digest(intent),
            mailbox.readJson("bootstrap.json").repairIntentDigest,
          );
          const origin = verifyReviewProductOrigin({
            runtimeRoot: context.runtimeRoot,
            ledger: context.ledger,
            contract,
            intent,
            assertOwner,
            afterApply: appliedPlanDigest !== undefined,
          });
          assert.notEqual(
            staged.tree,
            origin.staged.tree,
            "revised product is unchanged",
          );
          return {
            productRevision: {
              intentDigest: digest(intent),
              previousExecutionId: intent.previousExecutionId,
              oldTree: origin.staged.tree,
              newTree: staged.tree,
              oldPatchSha256: intent.oldPatchSha256,
              oldPatchRef: intent.oldPatchRef,
              oldCandidateRoot: origin.staged.cwd,
            },
            priorBlockedReview: {
              kind: "product",
              previousExecutionId: intent.previousExecutionId,
              requestDigest: origin.request.digest,
              rootRunIds: intent.waves.map((wave) => wave.rootRunId),
              reports: intent.waves.flatMap((wave) =>
                wave.reports.map((report) => {
                  const complete = origin.mailbox.readJson(
                    `integration/reviews/${wave.key}/complete.json`,
                  );
                  const row = complete.reports.find(
                    (item) => item.key === report.key,
                  );
                  assert.ok(
                    row && row.runId === report.runId,
                    "old review report changed",
                  );
                  return {
                    key: `${wave.key}/${report.key}`,
                    runId: report.runId,
                    sessionId: report.sessionId,
                    sessionFile: report.sessionFile,
                    verdict: row.report.verdict,
                    findings: row.report.findings,
                    completionDigest: wave.completionDigest,
                  };
                }),
              ),
            },
          };
        })()
      : {}),
    ...(mailbox.readJson("bootstrap.json").repairIntentDigest &&
    mailbox.readJson("receipts/repair-intent.json").schemaVersion ===
      "teams-candidate-repair-intent/3"
      ? (() => {
          const intent = mailbox.readJson("receipts/repair-intent.json");
          assert.equal(
            digest(intent),
            mailbox.readJson("bootstrap.json").repairIntentDigest,
          );
          verifyConflictRepairBinding({
            runtimeRoot: context.runtimeRoot,
            projectId: contract.identity.projectId,
            contract,
            intent,
            afterApply: appliedPlanDigest !== undefined,
          });
          return {
            conflictRevision: {
              intentDigest: digest(intent),
              previousExecutionId: intent.previousExecutionId,
              failureReceiptRef: intent.failureReceiptRef,
              failureReceiptSha256: intent.failureReceiptSha256,
              conflictPaths: intent.conflictPaths,
              failedLaneIndex: intent.failedLaneIndex,
              inputPatches: intent.patches,
              newTree: staged.tree,
            },
          };
        })()
      : {}),
    ...(staged.inheritedFrom
      ? (() => {
          const intent = mailbox.readJson(
            "receipts/report-revision-intent.json",
          );
          const origin = verifyReportOrigin({
            runtimeRoot: context.runtimeRoot,
            ledger: context.ledger,
            contract,
            intent,
            assertOwner,
          });
          return {
            reportRevision: {
              resultRef: path.join(
                mailbox.root,
                "results",
                `r${String(result.resultRevision).padStart(4, "0")}.json`,
              ),
              resultDigest: digest(result),
              previousResultDigest: intent.previousResultDigest,
            },
            priorBlockedReview: {
              previousExecutionId: intent.previousExecutionId,
              completionRef: path.join(
                origin.mailbox.root,
                intent.reviewFailureRelative,
              ),
              completionSha256: intent.reviewFailureSha256,
              requestDigest: origin.request.digest,
              rootRunId: origin.complete.runId,
              reports: origin.complete.reports.map(
                ({ key, runId, sessionId, sessionFile, report }) => ({
                  key,
                  runId,
                  sessionId,
                  sessionFile,
                  verdict: report.verdict,
                  findings: report.findings,
                }),
              ),
            },
          };
        })()
      : {}),
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
    if (appliedPlanDigest === undefined) {
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
    } else {
      verifyIntegrationApply(context, appliedPlanDigest);
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

// The same effective public inventory is compared before Task sealing and again
// against the exact review launch. The early read-only projection is advisory about
// the future profile; the later source-bound check remains authoritative.
function reviewToolDiagnostics(approved, tools, role) {
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
    tools.internalTools === undefined || Array.isArray(tools.internalTools),
    "resolved internal tools must be an array",
  );
  const internalTools = tools.internalTools ?? [];
  const effective = [
    ...new Set([
      ...tools.effectiveAllowlist,
      ...tools.effectiveMcpTools,
      ...internalTools,
    ]),
  ];
  const excess = effective.filter((name) => !approved.includes(name));
  if (excess.length)
    throw new TaskInputRejection(
      "review-tools",
      new Error("review tools exceed approved read-only ceiling"),
      { role, approved, effective, internalTools, excess },
    );
  return { approved, effective, internalTools, excess };
}

// Resolve the selected USER review role(s) with outputSchema, so native internal
// structured-output tools are visible before any Task reservation/Worker launch.
// A stale/different profile will still be refused by validateReviewLaunch later.
export async function preflightTaskReviewPolicy(
  spec,
  cwd,
  resolve,
  sessionDir = path.join(os.tmpdir(), `teams-review-preflight-${process.pid}`),
) {
  if (spec?.schemaVersion !== "teams-task-runtime/3") return [];
  const review = spec.policy?.review;
  if (
    !Array.isArray(review?.allowedRoles) ||
    !review.allowedRoles.length ||
    review.allowedRoles.length > 16 ||
    !Array.isArray(review.allowedTools) ||
    !review.allowedTools.length ||
    review.allowedTools.length > 128
  )
    return []; // Contract validation reports malformed draft fields.
  assert.equal(typeof resolve, "function", "public review resolver required");
  const rows = [];
  for (const role of review.allowedRoles) {
    assert.ok(
      typeof role === "string" && role.length <= 128,
      "bounded review role required",
    );
    const resolution = await resolve({
      agent: role,
      agentScope: "user",
      cwd,
      task: "Read-only Task reviewer capability preflight; do not launch.",
      context: "fresh",
      output: false,
      outputMode: "inline",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
        additionalProperties: false,
      },
      sessionDir: path.join(sessionDir, role),
    });
    assert.equal(resolution?.ok, true, "public review preflight unavailable");
    const launch = resolution.contract;
    assert.equal(
      launch?.version,
      2,
      "unsupported public launch contract schema",
    );
    assert.equal(
      launch.agent?.name,
      role,
      "resolved reviewer differs from approved role",
    );
    assert.ok(
      ["user", "package", "builtin"].includes(launch.agent.source),
      "source-controlled or unknown review agent is forbidden",
    );
    assert.equal(launch.context, "fresh", "fresh review context required");
    assert.equal(launch.roots?.cwd, path.resolve(cwd), "review cwd mismatch");
    assert.ok(
      Array.isArray(launch.diagnostics) &&
        launch.diagnostics.every((row) => row.severity === "warning"),
      "unresolved public review preflight",
    );
    try {
      rows.push({
        role,
        toolDiagnostics: reviewToolDiagnostics(
          review.allowedTools,
          launch.tools,
          role,
        ),
      });
    } catch (error) {
      if (
        !(error instanceof TaskInputRejection) ||
        error.phase !== "review-tools"
      )
        throw error;
      // Only a proven, pre-reservation policy mismatch is a correctable draft.
      throw new TaskInputRejection("task-spec", error, error.diagnostics);
    }
  }
  return rows;
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
  const toolDiagnostics = reviewToolDiagnostics(
    request.subject.policy.allowedTools,
    launch.tools,
    role,
  );
  return {
    role,
    definitionDigest: launch.agent.definitionDigest,
    launchContractDigest: launch.launchContractDigest,
    requestDigest: request.digest,
    toolDiagnostics,
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
  const prior = request.subject.priorBlockedReview;
  const priorIds =
    prior?.reports.flatMap(({ key, findings }) =>
      findings.map((_, index) => `${key}:${index}`),
    ) ?? [];
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
    ...(prior
      ? {
          priorResolutions: object(
            Object.fromEntries(
              priorIds.map((id) => [
                id,
                prior.kind === "product"
                  ? object({
                      reason: explanation,
                      sourcePaths: paths,
                      checkIds: {
                        type: "array",
                        minItems: 1,
                        maxItems: 30,
                        uniqueItems: true,
                        items: {
                          type: "string",
                          enum: request.subject.hostChecks.map(
                            (check) => check.commandId,
                          ),
                        },
                      },
                    })
                  : explanation,
              ]),
            ),
          ),
        }
      : {}),
  });
}

// A well-formed PASS is still only a report. Callers must bind a real independent
// native run, terminal/usage evidence and before/after source before acceptance.
export function validateReviewReport(request, report) {
  checkRequest(request);
  const prior = request.subject.priorBlockedReview;
  const priorIds =
    prior?.reports.flatMap(({ key, findings }) =>
      findings.map((_, index) => `${key}:${index}`),
    ) ?? [];
  exact(report, [
    "schemaVersion",
    "requestDigest",
    "verdict",
    "criteria",
    "findings",
    ...(prior ? ["priorResolutions"] : []),
  ]);
  if (prior) {
    exact(report.priorResolutions, priorIds);
    for (const resolution of Object.values(report.priorResolutions)) {
      if (prior.kind === "product") {
        exact(resolution, ["reason", "sourcePaths", "checkIds"]);
        text(resolution.reason);
        assert.ok(
          Array.isArray(resolution.checkIds) &&
            resolution.checkIds.length > 0 &&
            resolution.checkIds.length <= 30 &&
            new Set(resolution.checkIds).size === resolution.checkIds.length,
          "product resolution needs new checks",
        );
        for (const id of resolution.checkIds)
          assert.ok(
            request.subject.hostChecks.some(
              (check) => check.commandId === id && check.status === "verified",
            ),
            "product resolution cites a missing or failed new check",
          );
      } else text(resolution);
    }
  }
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
  if (prior?.kind === "product")
    for (const resolution of Object.values(report.priorResolutions))
      paths(resolution.sourcePaths);
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
