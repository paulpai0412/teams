import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Mailbox } from "../../task-runtime/mailbox.mjs";
import { isReviewableResult } from "../../task-runtime/contracts.mjs";
import { HostAcceptance } from "../../task-runtime/acceptance.mjs";
import { publicReviewResolver } from "../../task-runtime/review-runs.mjs";
import { preflightTaskReviewPolicy } from "../../task-runtime/integration-review.mjs";
import { createReviewLaunchScheduler } from "../../task-runtime/review-capacity.mjs";
import {
  checkFailureReply,
  isCompletedCheckFailure,
} from "../../task-runtime/check-failure.mjs";
import {
  CompletedIntegrationConflict,
  integrationConflictReply,
  isCompletedIntegrationConflict,
} from "../../task-runtime/integration-conflict.mjs";
import {
  inspectGoalTools,
  inspectSubagentsPing,
  SubagentsRpcClient,
  writeCapabilityReceipt,
  publicPackage,
} from "../../task-runtime/capabilities.mjs";
import {
  createGoalGuard,
  focusedGoalId,
} from "../../task-runtime/goal-guard.mjs";
import { HerdrPort } from "../../task-runtime/herdr-port.mjs";
import {
  deriveProjectId,
  TaskOrchestrator,
} from "../../task-runtime/orchestrator.mjs";

import { taskToolParameters } from "../../task-runtime/task-tool-inputs.mjs";
import { taskDeadlineAt } from "../../task-runtime/task-deadline.mjs";
import {
  inputRejectionReply,
  isInputRejection,
  taskExecutionSelector,
  TaskInputRejection,
} from "../../task-runtime/input-rejection.mjs";

// Existing collect entrypoint: bounded host waiting, never a model-authored path scan.
export async function collectTaskResult(
  orchestrator,
  executionId,
  { waitMs = 0, signal } = {},
) {
  assert.ok(
    Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 1_200_000,
    "bounded wait_ms required",
  );
  const execution = orchestrator.ledger.getExecution(executionId);
  orchestrator.assertExecutionOwner(execution);
  const contract = orchestrator.ledger.getContract(executionId);
  const mailbox = Mailbox.open(
    path.join(
      orchestrator.runtimeRoot,
      "projects",
      execution.projectId,
      "executions",
      executionId,
    ),
    executionId,
  );
  const waitDeadline = Date.now() + waitMs;
  const taskDeadline = taskDeadlineAt(orchestrator.ledger, execution, contract);
  for (;;) {
    signal?.throwIfAborted();
    const observed = orchestrator.reconcile(executionId);
    for (const event of mailbox.listEvents()) {
      if (event.type === "failed") {
        assert.equal(
          mailbox.digestRelative(event.payloadRef),
          event.payloadDigest,
          "Worker failure payload changed",
        );
        const failure = mailbox.readJson(event.payloadRef, 16 * 1024);
        throw new Error(
          `Worker admission failed: ${String(failure.error).slice(0, 1000)}; cancel/reconcile without retry`,
        );
      }
      if (event.type === "progress") {
        const payload = mailbox.readJson(event.payloadRef, 16 * 1024);
        assert.notEqual(
          payload.kind,
          "role-launch-unknown",
          "native launch unknown; cancel/reconcile without retry",
        );
      }
    }
    let candidate = null;
    if (observed.execution.state === "RESULT_READY") {
      const collected = orchestrator.collect(executionId, {
        includeCandidate: true,
      });
      candidate = collected.candidate;
      if (
        !isReviewableResult(collected.candidate) ||
        !waitMs ||
        observed.processProof?.terminal
      )
        return {
          ...collected.execution,
          candidate: collected.candidate,
          resultRef: collected.resultRef,
          workerProcess: observed.processProof,
        };
    } else {
      assert.ok(
        observed.execution.state === "RUNNING",
        "execution is not collecting results",
      );
      assert.ok(
        !observed.processProof?.terminal,
        "Worker exited without a result; reconcile without redispatch",
      );
    }
    assert.ok(
      observed.processProof?.reason === "worker-process-alive",
      "Worker process is unknown; reconcile without redispatch",
    );
    const now = Date.now();
    assert.ok(
      now < taskDeadline,
      "Task deadline reached; cancel/reconcile without redispatch",
    );
    if (now >= waitDeadline)
      return {
        ...observed.execution,
        candidate,
        workerProcess: observed.processProof,
        collection: "waiting",
      };
    await delay(
      Math.min(250, waitDeadline - now, taskDeadline - now),
      undefined,
      { signal },
    );
  }
}

export function result(text, details, terminate = false) {
  return {
    content: [{ type: "text", text }],
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

export function collectedTaskReply(executionId, execution) {
  const { candidate, workerProcess, resultRef } = execution;
  if (execution.collection === "waiting")
    return result(
      `Task Pi ${executionId}: wait window ended; state=${execution.state}, Worker terminal=${workerProcess?.terminal === true}. This is not failure or acceptance. Continue bounded collection of this same execution when needed; do not redispatch.`,
      execution,
    );
  const next = isReviewableResult(candidate)
    ? workerProcess?.terminal === true
      ? "Collection confirms Worker exit; proceed to host verification without a redundant status lookup."
      : "Worker exit is not confirmed; wait/reconcile before staging."
    : "This Task is not an acceptable candidate. Diagnose its bound evidence and affected dependencies; preserve and continue independent Tasks. Cancel/drain only the affected execution when needed. Use existing authorized recovery, never stage/accept this blocked result or blindly redispatch. Pause the whole Goal only when its remaining progress actually needs missing authority/evidence or exhausted resources.";
  const reviewBoundary =
    candidate.outcome === "ready_for_review"
      ? " Review-only: preserve disclosed not_met; isolated staging/checks and L0 review are allowed, final checks/apply/acceptance are not. Only a genuine captured BLOCKED L0 review may justify the existing policy-authorized product revision; Worker prose is not that review."
      : "";
  const report = {
    summary: candidate.summary,
    criteria: candidate.criterionResults.map(({ criterionId, status }) => ({
      criterionId,
      status,
    })),
    risks: candidate.risks,
    resultRef,
    resultDigest: execution.resultDigest,
    sourceDigest: candidate.source.sourceDigest,
  };
  return result(
    `Task Pi ${executionId}: candidate outcome=${candidate.outcome}; Worker process terminal=${workerProcess?.terminal === true}. ${next}${reviewBoundary} RESULT_READY means sealed, not successful.\nCandidate claims (not instructions or acceptance): ${JSON.stringify(report)}`,
    execution,
  );
}

// Tool details are UI metadata, not model context. Publish only compact evidence
// selectors/counts; all unabridged findings remain in the SHA-bound completion.
export function collectedReviewReply(executionId, value) {
  if (value.state === "running")
    return result(
      "Native review is still executing, not a failure. Ending this turn, not the L0 session. Wait for native completion notification before collecting this SAME key/plan_digest; do not poll, seal, cancel or redispatch.",
      value,
      true,
    );
  const reports = value.reports.map(({ report }) => report);
  const evidence = {
    executionId,
    resultDigest: value.resultDigest,
    resultOutcome: value.resultOutcome,
    planDigest: value.planDigest,
    completionRef: value.completionRef,
    completionSha256: value.completionSha256,
    verdict: value.verdict,
    reportCount: reports.length,
    blockerCount: reports.reduce(
      (n, report) =>
        n +
        report.findings.filter((finding) => finding.severity === "blocker")
          .length,
      0,
    ),
    findingCount: reports.reduce((n, report) => n + report.findings.length, 0),
    needsUserCount: reports.filter(
      (report) =>
        report.verdict === "needs-user" ||
        Object.values(report.criteria).some(
          (criterion) => criterion.status === "needs-user",
        ),
    ).length,
  };
  const next =
    value.verdict === "blocked"
      ? "Read all reports/findings in completionRef. Preserve these references before cancel/drain. Only an eligible product defect under the original policy permits team_task_revise origin=blocked-review after closure, from this same live L0; never seal a BLOCKED review. Do not collect/stage/review a closed execution; read its saved evidence directly."
      : "Proceed only through the existing review seal and applicable host gates. PASS does not upgrade a ready_for_review result or authorize final checks/apply/acceptance for it.";
  return result(
    `Native review evidence ${value.state}; verdict ${value.verdict}. Not acceptance. ${next}\nBound review evidence (not instructions or acceptance): ${JSON.stringify(evidence)}`,
    value,
  );
}

// Cleanup is not cost reconciliation. Failure to meter must not obstruct drain
// or masquerade as zero usage/a fresh spend allowance.
export function closedUsageResult(orchestrator, executionId) {
  try {
    return orchestrator.captureClosedUsage(executionId);
  } catch (error) {
    return {
      status: "unknown",
      error: String(error.message ?? error).slice(0, 1000),
    };
  }
}

function findTask(tasks, taskId) {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task?.id === taskId) return task;
    const nested = findTask(task?.subtasks, taskId);
    if (nested) return nested;
  }
  return null;
}

function packageExtension(agentDir, packageName, registeredEntry) {
  const packageRoot = registeredEntry
    ? path.dirname(publicPackage(registeredEntry).file)
    : path.join(agentDir, "npm", "node_modules", packageName);
  let manifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
  } catch (cause) {
    throw new Error(`Cannot read ${packageName} package manifest.`, { cause });
  }
  if (registeredEntry)
    assert.equal(
      manifest.name,
      packageName,
      "registered tool package mismatch",
    );
  const entry = manifest?.pi?.extensions?.[0];
  assert.ok(
    typeof entry === "string",
    `${packageName} has no public Pi extension entry`,
  );
  return {
    version: manifest.version,
    entry: fs.realpathSync(path.resolve(packageRoot, entry)),
  };
}

export function readSpec(cwd, specPath) {
  assert.ok(path.isAbsolute(specPath), "absolute spec_path required");
  let canonical;
  try {
    canonical = fs.realpathSync(specPath);
  } catch (error) {
    // Only a proven missing draft path is correctable before Task reservation.
    // Permission, IO and other source failures retain their unknown effect.
    if (["ENOENT", "ENOTDIR"].includes(error?.code))
      throw new TaskInputRejection("task-spec-file", error);
    throw error;
  }
  const relative = path.relative(fs.realpathSync(cwd), canonical);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "spec_path must be inside cwd",
  );
  const stat = fs.lstatSync(canonical);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024,
    "bounded regular task spec required",
  );
  const text = fs.readFileSync(canonical, "utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new TaskInputRejection("task-spec-file", cause);
  }
}

// Model-facing Task-mode tool selection, not a sandbox or a change to the
// registered pi-subagents event/RPC transport used by Worker and final review.
export function selectTaskL0Tools(
  pi,
  { mode, compatible, sessionId, ownerSessionId },
) {
  if (mode !== "task-pi")
    return { mode: mode ?? "unspecified", disposition: "unchanged" };
  const current = pi.getActiveTools();
  const selected = current.filter((name) => name !== "subagent");
  // Restrict first, then report capability/identity blockers. A rejected
  // preflight must never leave a raw model-facing writer as a fallback.
  if (selected.length !== current.length) pi.setActiveTools(selected);
  assert.deepEqual(
    pi.getActiveTools(),
    selected,
    "Task mode active tool selection changed",
  );
  assert.equal(sessionId, ownerSessionId, "Task mode L0 owner changed");
  assert.equal(
    compatible,
    true,
    "Task mode native capability unavailable; do not switch modes",
  );
  assert.ok(
    pi.getAllTools().some((tool) => tool.name === "subagent"),
    "internal native subagent transport not registered",
  );
  assert.ok(
    selected.includes("team_task_dispatch"),
    "Task dispatch not active for L0",
  );
  return {
    mode,
    disposition: "task-tools-only",
    hiddenFromModel: current.includes("subagent") ? ["subagent"] : [],
    internalNativeTransportRegistered: true,
  };
}

export default function teamsOrchestrator(pi) {
  let orchestrator = null;
  let acceptance = null;
  let goalGuard = null;
  let projectId = null;
  let goalCompatible = false;
  let taskPiCompatible = false;
  let capabilityState = null;
  let capabilityReceiptFile = null;
  let subagentsEntry = null;
  let scheduleReviewLaunch;
  const pendingGoalCommits = new Map();
  const ownedExecutions = new Set();
  let draining = false;

  // The existing E2E RPC observer must drain through the LIVE owner, without
  // asking a model to cancel or constructing a second controller after its exit.
  if (process.env.TEAMS_E2E_CANARY === "1") {
    pi.registerCommand("teams-e2e-drain", {
      description:
        "E2E-only: cancel this session's Task Pi executions before host shutdown.",
      async handler(args, ctx) {
        assert.ok(
          Buffer.byteLength(args) <= 1024,
          "bounded drain request required",
        );
        let input;
        try {
          input = JSON.parse(args);
        } catch (cause) {
          throw new Error("Invalid E2E drain request", { cause });
        }
        assert.match(input.requestId, /^[A-Za-z0-9._-]{1,80}$/);
        assert.ok(
          typeof input.reason === "string" && input.reason.length <= 128,
        );
        assert.equal(draining, false, "drain already requested; do not replay");
        draining = true;
        const rows = [];
        // Include a reservation created before a dispatch error returned its id.
        for (const execution of orchestrator?.ledger.listProjectOpen(
          projectId,
        ) ?? []) {
          if (execution.ownerSessionId === ctx.sessionManager.getSessionId())
            ownedExecutions.add(execution.executionId);
        }
        assert.ok(
          ownedExecutions.size <= 64,
          "bounded E2E execution inventory required",
        );
        const deadline = Date.now() + 30_000;
        const rpc = new SubagentsRpcClient(pi.events);
        try {
          for (const id of ownedExecutions) {
            try {
              const outcome = await orchestrator.cancel(
                id,
                `E2E observer: ${input.reason}`,
                {
                  timeoutMs: Math.max(0, deadline - Date.now()),
                  reviewAdapter: {
                    nativeOwner:
                      ctx.sessionManager.getSessionFile() ??
                      ctx.sessionManager.getSessionId(),
                    rpc,
                  },
                },
              );
              rows.push({
                executionId: id,
                state: outcome.execution.state,
                disposition: outcome.disposition,
                reservationOpen: outcome.execution.reservationOpen,
                closedUsage: closedUsageResult(orchestrator, id),
              });
            } catch (error) {
              rows.push({
                executionId: id,
                disposition: "unknown",
                error: String(error.message ?? error).slice(0, 500),
              });
            }
          }
        } finally {
          ctx.ui.setWidget("teams-e2e-drain", [
            `TEAMS_E2E_DRAIN:${JSON.stringify({
              version: 1,
              requestId: input.requestId,
              ownerSessionId: ctx.sessionManager.getSessionId(),
              rows,
              settled: rows.every((row) => row.reservationOpen === false),
            })}`,
          ]);
        }
      },
    });
    pi.on("turn_start", (_event, ctx) => {
      if (draining) ctx.abort();
    });
  }

  // Validate only an unrecognized caller selector before entering an operation.
  // A previously dispatched ID is not a spelling error if its row disappears.
  // Do not catch execution, ownership, lifecycle or I/O failures here.
  const registerTaskTool = (definition) =>
    pi.registerTool({
      ...definition,
      async execute(...args) {
        const [callId, input] = args;
        const selected = taskExecutionSelector(definition.name, input);
        if (
          orchestrator &&
          selected !== null &&
          !ownedExecutions.has(selected) &&
          !orchestrator.ledger.hasExecution(selected)
        ) {
          return inputRejectionReply(
            new TaskInputRejection(
              "execution-selector",
              new Error(`Unknown execution selector: ${selected}`),
            ),
            definition.name,
            callId,
            input,
          );
        }
        return definition.execute(...args);
      },
    });

  registerTaskTool({
    name: "team_task_dispatch",
    label: "Dispatch Task Pi",
    promptSnippet:
      "Dispatch an L0-authored outcome Task spec; candidate results still need host acceptance.",
    promptGuidelines: [
      `Before team_task_dispatch, follow ${fileURLToPath(new URL("./SPEC.md", import.meta.url))}: L0 derives outcomes, dependencies, criteria, checks and Task specs from the user's request and current source; no prepared solution or fixed task/role count is required.`,
      "team_task_dispatch accepts a spec file written by L0 with native file tools. Read real Goal/task IDs; cover original requirements without duplicating one deliverable by criterion. Reserve the sum of Task ceilings within the existing cumulative budget, including history and coordination; missing accounting is not zero. Preserve required acceptance and user authority.",
    ],
    description: `Direct execution is the default for small tasks. Delegate only when context, recovery, worktree, duration or diagnosis benefit exceeds overhead. L0 owns the Goal, cross-task decisions and final acceptance; Worker owns task-internal coordination and handoff completeness. Do not micromanage roles or repeat their implementation/review. Scope, authority, deployment or budget changes still require owner approval. L0 authors the Task spec from the user's requirements; the file format and request-to-outcome protocol are in ${fileURLToPath(new URL("./SPEC.md", import.meta.url))}. No prepared solution patch is required.`,
    parameters: taskToolParameters.team_task_dispatch,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (draining)
        throw new Error("E2E owner is draining; new dispatch is forbidden.");
      if (!orchestrator)
        throw new Error("Teams Orchestrator has not initialized.");
      if (!taskPiCompatible)
        throw new Error(
          "Task Pi capability handshake is incomplete; report the blocker without changing execution mode.",
        );
      if (!orchestrator.herdr)
        throw new Error(
          "Task Pi requires a Herdr-managed parent; report the blocker without changing execution mode.",
        );
      let prepared;
      try {
        const spec = readSpec(ctx.cwd, params.spec_path);
        if (spec?.schemaVersion === "teams-task-runtime/3") {
          const agentDir =
            process.env.PI_CODING_AGENT_DIR ??
            path.join(os.homedir(), ".pi", "agent");
          const resolve = await publicReviewResolver(
            agentDir,
            process.argv[1],
            subagentsEntry,
          );
          await preflightTaskReviewPolicy(
            spec,
            ctx.cwd,
            (input) =>
              resolve({
                ...input,
                availableModels: ctx.modelRegistry.getAvailable(),
                ...(ctx.model
                  ? {
                      parentModel: {
                        provider: ctx.model.provider,
                        id: ctx.model.id,
                      },
                    }
                  : {}),
              }),
            path.join(
              os.tmpdir(),
              "teams-review-preflight",
              ctx.sessionManager.getSessionId(),
            ),
          );
        }
        // No ledger reservation/Worker starts until the public review-tool
        // inventory fits the proposed sealed Task ceiling.
        prepared = orchestrator.prepare(spec);
      } catch (error) {
        return inputRejectionReply(error, "team_task_dispatch", _id, params);
      }
      ownedExecutions.add(prepared.executionId);
      const running = await orchestrator.launch(prepared.executionId);
      return result(
        `Task Pi ${prepared.executionId} is ${running.state} in ${running.paneId}. Result-ready will still require host acceptance. Preparation diagnostics (not approval): ${JSON.stringify(prepared.diagnostics)}.`,
        {
          benefit: params.benefit,
          benefitDetail: params.benefit_detail,
          diagnostics: prepared.diagnostics,
          ...running,
        },
      );
    },
  });

  registerTaskTool({
    name: "team_task_revise",
    label: "Revise Task Candidate",
    description:
      "One bounded, same-Task new execution for a closed source-bound candidate. Default: proven nonzero staged check with failure receipt and spec_path. With origin=blocked-review: cite the complete BLOCKED review ref/SHA. With origin=integration-conflict: cite the completed isolated conflict failure receipt ref/SHA; the original shared Task must allow one candidate repair. For either product origin cite the old result digest, omit spec_path and supply additional_checks (or []) so the host inherits the sealed contract and increments taskRevision. Do not regenerate immutable fields. Requires original opt-in, owner, closed usage and complete review evidence. Legacy spec_path is accepted only with exactly unchanged contract fields and original checks. New writer delivers the complete corrected candidate, then new checks/review/acceptance. No old evidence rewriting, unknown effects, scope expansion or target apply permission. Never blindly retry an unknown call.",
    parameters: taskToolParameters.team_task_revise,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (draining)
        throw new Error("E2E owner is draining; revision is forbidden.");
      if (!orchestrator || !taskPiCompatible || !orchestrator.herdr)
        throw new Error(
          "Task Pi native capability unavailable; do not switch modes.",
        );
      if (!ownedExecutions.has(params.previous_execution_id))
        throw new Error(
          "candidate revision requires this original live L0 execution; reconcile or report blocker",
        );
      let prepared;
      try {
        assert.ok(
          params.origin === "blocked-review"
            ? params.failure_receipt_ref === undefined &&
                params.failure_receipt_sha256 === undefined
            : [undefined, "integration-conflict"].includes(params.origin) &&
                params.review_failure_ref === undefined &&
                params.review_failure_sha256 === undefined,
          "revision origin and failure receipt selectors cannot be mixed",
        );
        const spec =
          params.spec_path === undefined
            ? null
            : readSpec(ctx.cwd, params.spec_path);
        prepared = params.origin
          ? await orchestrator.prepareProductRevision(spec, {
              origin: params.origin,
              failureReceiptRef: params.failure_receipt_ref,
              failureReceiptSha256: params.failure_receipt_sha256,
              previousExecutionId: params.previous_execution_id,
              expectedPreviousResultDigest:
                params.expected_previous_result_digest,
              reviewFailureRef: params.review_failure_ref,
              reviewFailureSha256: params.review_failure_sha256,
              repairReason: params.repair_reason,
              additionalChecks: params.additional_checks,
            })
          : orchestrator.prepare(spec, {
              repairOf: {
                previousExecutionId: params.previous_execution_id,
                expectedPreviousResultDigest:
                  params.expected_previous_result_digest,
                failureReceiptRef: params.failure_receipt_ref,
                failureReceiptSha256: params.failure_receipt_sha256,
                repairReason: params.repair_reason,
              },
            });
      } catch (error) {
        return inputRejectionReply(error, "team_task_revise", _id, params);
      }
      ownedExecutions.add(prepared.executionId);
      const running = await orchestrator.launch(prepared.executionId);
      const product = params.origin
        ? Mailbox.open(prepared.executionRoot, prepared.executionId).readJson(
            "receipts/repair-intent.json",
          )
        : null;
      return result(
        `Task candidate revision ${prepared.executionId} is ${running.state}; old evidence remains sealed. Fresh staging/check/review/acceptance are required.`,
        {
          repairIntentDigest: prepared.repairIntentDigest,
          ...running,
          ...(product
            ? {
                origin: params.origin,
                previousExecutionId: product.previousExecutionId,
                previousResultRef: product.previousResultRef,
                previousResultDigest: product.previousResultDigest,
                ...(params.origin === "blocked-review"
                  ? {
                      oldCandidate: {
                        tree: product.oldTree,
                        patchRef: product.oldPatchRef,
                        patchSha256: product.oldPatchSha256,
                      },
                      priorFindings: product.waves.flatMap((wave) =>
                        wave.findings.map((finding) => ({
                          id: finding.id,
                          severity: finding.severity,
                          sourcePaths: finding.sourcePaths,
                        })),
                      ),
                    }
                  : {
                      conflictPaths: product.conflictPaths,
                      inputPatches: product.patches,
                      failureReceiptRef: product.failureReceiptRef,
                      failureReceiptSha256: product.failureReceiptSha256,
                    }),
                priorTokens: orchestrator.ledger.readTaskPool(
                  prepared.executionId,
                ).priorTokens,
                deadlineAt: product.deadlineAt,
              }
            : {}),
        },
      );
    },
  });

  registerTaskTool({
    name: "team_task_revise_report",
    label: "Revise Sealed Task Report",
    description:
      "One report-only revision of an original live L0's closed v3 verify-only Task after a fully captured native BLOCKED independent review. Supply the exact prior result digest and sealed review completion SHA. Host preserves original writer/check/source and cumulative usage, launches a new report-only Worker with no role dispatch, and requires a fresh independent review and acceptance. Never use for unknown effects, source defects, missing writer evidence or replays.",
    parameters: taskToolParameters.team_task_revise_report,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (draining)
        throw new Error("E2E owner is draining; report revision is forbidden.");
      if (!orchestrator || !taskPiCompatible || !orchestrator.herdr)
        throw new Error(
          "Task Pi native capability unavailable; do not switch modes.",
        );
      if (!ownedExecutions.has(params.previous_execution_id))
        throw new Error(
          "report revision requires this original live L0 execution",
        );
      let prepared;
      try {
        prepared = await orchestrator.prepareReportRevision(
          readSpec(ctx.cwd, params.spec_path),
          {
            previousExecutionId: params.previous_execution_id,
            expectedPreviousResultDigest:
              params.expected_previous_result_digest,
            reviewFailureRef: params.review_failure_ref,
            reviewFailureSha256: params.review_failure_sha256,
            reportReason: params.report_reason,
          },
        );
      } catch (error) {
        return inputRejectionReply(
          error,
          "team_task_revise_report",
          _id,
          params,
        );
      }
      ownedExecutions.add(prepared.executionId);
      const running = await orchestrator.launch(prepared.executionId);
      return result(
        `Report revision ${prepared.executionId} is ${running.state}; old BLOCKED review is unchanged. New report, source-bound independent review and acceptance remain required.`,
        {
          reportRevisionIntentDigest: prepared.reportRevisionIntentDigest,
          ...running,
        },
      );
    },
  });

  registerTaskTool({
    name: "team_task_collect",
    label: "Collect Task Pi Result",
    description:
      "Collect candidate summary, criterion states, risks, result reference and Worker exit proof. Use wait_ms (up to 1200000) for host waiting, not model/shell polling. L0 consumes this handoff first; inspect detailed evidence when proof is missing or inconsistent, not entire histories by default. Required host checks and independent review still run. A wait window ending with collection=waiting is normal: continue the same execution, never redispatch. Task deadline or unknown process remains a failure. Blocked/failed blocks this candidate, not all Goal coordination: diagnose the affected Task and dependencies, preserve independent Tasks, and cancel/drain only the affected execution when needed. Use authorized recovery before declaring the Goal blocked; never stage/review/accept the blocked result or blindly redispatch. This does not accept or complete the Goal task.",
    parameters: taskToolParameters.team_task_collect,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const execution = await collectTaskResult(
        orchestrator,
        params.execution_id,
        { waitMs: params.wait_ms, signal },
      );
      return collectedTaskReply(params.execution_id, execution);
    },
  });

  registerTaskTool({
    name: "team_task_stage_integration",
    label: "Stage Task Integration",
    description:
      "L0 integration stage/review protocol. stage rehearses patches; prepare-review freezes source; plan-review validates a dynamic read-only wave through public preflight; collect-review binds registered native evidence; seal-review freezes ALL registered, collected PASS waves into a host-owned candidate and closes review admission (not acceptance). read-applied-review requires a successful TARGET apply plan_digest and verifies an existing sealed candidate without applying or re-sealing. start-review requires the original live L0 instance, Worker exit and host-owned actual-usage/lifecycle admission, never a model approval flag. It waits for native per-session async capacity before launch intent, allowing only the configured number of concurrent reviews; do not duplicate a waiting call. start-review and collect-review require BOTH key and plan_digest returned by plan-review. key is the wave key, not the child key or native run ID. Correct rejected pre-dispatch selectors; never replay an unknown dispatch. A wave has key/reason/runs; each run has key/role/task/mode=review/isolation=shared/maxTokens. No target writes, native status edits, acceptance or blind retries.",
    parameters: taskToolParameters.team_task_stage_integration,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      assert.ok(
        acceptance && !signal?.aborted,
        "Integration unavailable or cancelled.",
      );
      if (["plan-review", "start-review"].includes(params.action)) {
        const agentDir =
          process.env.PI_CODING_AGENT_DIR ??
          path.join(os.homedir(), ".pi", "agent");
        const nativeOwner =
          ctx.sessionManager.getSessionFile() ??
          ctx.sessionManager.getSessionId();
        const rpc = new SubagentsRpcClient(pi.events);
        const adapter = {
          nativeOwner,
          rpc,
          scheduleReviewLaunch: (launch, timeoutMs) =>
            (scheduleReviewLaunch ??= createReviewLaunchScheduler(pi.events))(
              { owner: nativeOwner, rpc, signal, timeoutMs },
              launch,
            ),
          resolve: async (input) => {
            assert.ok(!signal?.aborted, "Review preflight cancelled.");
            const resolve = await publicReviewResolver(
              agentDir,
              process.argv[1],
              subagentsEntry,
            );
            return resolve({
              ...input,
              availableModels: ctx.modelRegistry.getAvailable(),
              ...(ctx.model
                ? {
                    parentModel: {
                      provider: ctx.model.provider,
                      id: ctx.model.id,
                    },
                  }
                : {}),
            });
          },
          assertAdmission: () => {
            assert.ok(!signal?.aborted, "Review admission cancelled.");
            orchestrator.assertReviewAdmission(params.execution_id);
          },
        };
        let value;
        try {
          value =
            params.action === "plan-review"
              ? await acceptance.planIntegrationReview(
                  params.execution_id,
                  params.wave,
                  adapter,
                )
              : await acceptance.startIntegrationReview(
                  params.execution_id,
                  params.key,
                  params.plan_digest,
                  adapter,
                );
        } catch (error) {
          return inputRejectionReply(
            error,
            "team_task_stage_integration",
            _id,
            params,
          );
        }
        return result(
          `Review key=${value.key ?? params.key}, plan_digest=${value.planDigest}${value.runId ? `, native run ${value.runId}` : " (plan only; start-review requires BOTH key and plan_digest above)"}. Final acceptance remains blocked.${params.action === "start-review" ? " Ending this turn; the L0 session stays alive. Wait for native completion, then collect this same key/plan_digest. Do not poll." : ""}`,
          value,
          params.action === "start-review",
        );
      }
      if (params.action === "seal-review") {
        assert.ok(
          params.wave === undefined &&
            params.key === undefined &&
            params.plan_digest === undefined,
          "seal-review accepts no wave selectors",
        );
        let candidate;
        try {
          candidate = await acceptance.sealIntegrationReview(
            params.execution_id,
          );
        } catch (error) {
          return inputRejectionReply(
            error,
            "team_task_stage_integration",
            _id,
            params,
          );
        }
        return result(
          `Review candidate ${candidate.candidateDigest} sealed; review admission closed. Target unchanged; final acceptance remains blocked. Apply requires fresh writer/review proof and separate confirmation.`,
          candidate,
        );
      }
      if (params.action === "read-applied-review") {
        assert.ok(
          params.wave === undefined && params.key === undefined,
          "read-applied-review accepts no wave selectors",
        );
        const candidate = await acceptance.readAppliedIntegrationReview(
          params.execution_id,
          params.plan_digest,
        );
        return result(
          `Existing review candidate ${candidate.candidateDigest} verified against applied target plan ${params.plan_digest}. No writes or acceptance.`,
          { candidate, applyPlanDigest: params.plan_digest },
        );
      }
      if (params.action === "collect-review") {
        const value = await acceptance.collectIntegrationReview(
          params.execution_id,
          params.key,
          params.plan_digest,
        );
        return collectedReviewReply(params.execution_id, value);
      }
      if (params.action === "prepare-review") {
        const request = acceptance.prepareIntegrationReview(
          params.execution_id,
        );
        return result(
          `Frozen review request ${request.digest}. No reviewer launched; native run binding and final acceptance remain pending.`,
          request,
        );
      }
      let staged;
      try {
        staged = acceptance.stageIntegration(params.execution_id);
      } catch (error) {
        return error instanceof CompletedIntegrationConflict
          ? integrationConflictReply(error, _id, params)
          : checkFailureReply(error, _id, params);
      }
      const integrationMode = orchestrator.ledger.getContract(
        params.execution_id,
      ).policy.integrationMode;
      return result(
        `Integration ${staged.status} at ${staged.cwd}. Designated staged checks/receipts are in this result; do not rerun them manually. Target unchanged; source-bound review and final acceptance remain pending. ${integrationMode === "approved-integration" ? "Do not call team_task_run_checks before the separately confirmed target apply; it performs final checks on the applied target. Continue with independent review, then target prepare/inspect/apply." : "For verify-only, team_task_run_checks verifies the already-staged receipts without replaying checks; no target apply."}`,
        staged,
      );
    },
  });

  registerTaskTool({
    name: "team_task_target_integration",
    label: "Task Integration Target Operation",
    description:
      "L0-only: prepare an immutable staged-diff plan, inspect its target read-only, or explicitly confirm apply/rollback. Requires approved-integration policy; never commits, moves refs, waives required review, or retries an incomplete intent. Not acceptance.",
    parameters: taskToolParameters.team_task_target_integration,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      assert.ok(acceptance, "Teams Orchestrator has not initialized.");
      if (params.action === "prepare") {
        const plan = acceptance.prepareIntegrationApply(params.execution_id);
        return result(
          `Staged-diff plan ${plan.planDigest}; this call makes no target changes. Use inspect for current state; apply requires separate interactive confirmation.`,
          plan,
        );
      }
      assert.match(
        params.plan_digest ?? "",
        /^[a-f0-9]{64}$/,
        "explicit plan_digest required",
      );
      if (params.action === "inspect") {
        const observed = acceptance.inspectIntegrationApply(
          params.execution_id,
          params.plan_digest,
        );
        return result(
          `Target ${observed.disposition}; read-only observation, not acceptance or permission to retry.`,
          observed,
        );
      }
      assert.ok(
        ["apply", "rollback"].includes(params.action),
        "unsupported target operation",
      );
      assert.ok(
        ctx.hasUI,
        "Target apply/rollback requires interactive user confirmation.",
      );
      const confirm = async ({ action, plan }) =>
        !_signal?.aborted &&
        (await ctx.ui.confirm(
          `${action === "apply" ? "Apply" : "Roll back"} staged integration?`,
          `${action} only the sealed patch at ${plan.targetRoot}\nBranch: ${plan.before.ref}\nHEAD remains: ${plan.baseCommit}\nIntegration tree: ${plan.mergedTree}\nPlan: ${plan.planDigest}\nNo commit, ref movement or acceptance. Later edits cause refusal.`,
        )) &&
        !_signal?.aborted;
      const receipt =
        params.action === "apply"
          ? await acceptance.applyIntegration(
              params.execution_id,
              params.plan_digest,
              confirm,
            )
          : await acceptance.rollbackIntegration(
              params.execution_id,
              params.plan_digest,
              confirm,
            );
      return result(
        `Target operation ${receipt.status}; required final gates and Goal readback remain pending.`,
        receipt,
      );
    },
  });

  registerTaskTool({
    name: "team_task_run_checks",
    label: "Run Task Host Checks",
    description:
      "Verify staged receipts for verify-only; for approved-integration run final host checks only AFTER a confirmed target apply. Never check the unmodified target before apply or blindly replay a receipt.",
    parameters: taskToolParameters.team_task_run_checks,
    executionMode: "sequential",
    async execute(_id, params) {
      const checks = acceptance.runChecks(params.execution_id);
      return result(
        `${checks.length} host check${checks.length === 1 ? "" : "s"} verified.`,
        checks,
      );
    },
  });

  registerTaskTool({
    name: "team_task_accept",
    label: "Accept Task Pi Outcome",
    description:
      "Validate source freshness, evidence, criteria, host checks, and unresolved runs; seal an AcceptanceReceipt. Verify-only delivers a reviewed patch, not target changes. Goal-X readback remains required.",
    parameters: taskToolParameters.team_task_accept,
    executionMode: "sequential",
    async execute(_id, params) {
      const accepted = await acceptance.accept(params.execution_id);
      const delivery = accepted.receipt.finalEvidence?.delivery;
      return result(
        `${delivery?.kind === "verified-patch" ? `Verified patch: ${delivery.patchRef}; target unchanged. ` : ""}AcceptanceReceipt ${accepted.receipt.acceptanceId} sealed. Complete the matching Goal task; Goal-X will inject the authoritative receipt reference and confirm readback.`,
        accepted,
      );
    },
  });

  registerTaskTool({
    name: "team_task_prepare_takeover",
    label: "Prepare Task Controller Takeover",
    description:
      "Capture a bounded read-only reconciliation proof for a stale controller. This does not change ownership.",
    parameters: taskToolParameters.team_task_prepare_takeover,
    executionMode: "sequential",
    async execute(_id, params) {
      const prepared = orchestrator.prepareTakeover(params.execution_id);
      return result(
        `Takeover proof prepared at ${prepared.proofRef}; ownership is unchanged.`,
        prepared,
      );
    },
  });

  registerTaskTool({
    name: "team_task_takeover",
    label: "Take Over Task Controller",
    description:
      "After explicit interactive confirmation, CAS-fence the previous root controller using a prepared reconciliation proof.",
    parameters: taskToolParameters.team_task_takeover,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI)
        throw new Error(
          "Controller takeover requires interactive user confirmation.",
        );
      const confirmed = await ctx.ui.confirm(
        "Take over Task Pi controller?",
        `Fence the previous root using ${params.proof_ref}?`,
      );
      if (!confirmed)
        return result("Controller takeover declined; ownership is unchanged.", {
          disposition: "declined",
        });
      const takeover = orchestrator.commitTakeover(params.proof_ref);
      return result(
        `Controller ownership moved to epoch ${takeover.ownerEpoch}. Reconcile before any further action.`,
        takeover,
      );
    },
  });

  registerTaskTool({
    name: "team_task_reconcile",
    label: "Reconcile Task Pi",
    description:
      "Ingest durable events/results and compare Herdr state without retrying work. A missing or ambiguous process remains UNKNOWN.",
    parameters: taskToolParameters.team_task_reconcile,
    executionMode: "sequential",
    async execute(_id, params) {
      const reconciled = orchestrator.reconcile(params.execution_id);
      if (!reconciled.execution.reservationOpen)
        reconciled.closedUsage = closedUsageResult(
          orchestrator,
          params.execution_id,
        );
      return result(
        `Task Pi ${params.execution_id} reconciled as ${reconciled.execution.state}.`,
        reconciled,
      );
    },
  });

  registerTaskTool({
    name: "team_task_cancel",
    label: "Cancel Task Pi",
    description:
      "Persist cancellation and wait up to 30 seconds for native drain, Worker exit and pane closure. Unknown outcomes keep the reservation and are never replayed.",
    parameters: taskToolParameters.team_task_cancel,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const cancelled = await orchestrator.cancel(
        params.execution_id,
        params.reason,
        {
          signal,
          reviewAdapter: {
            nativeOwner:
              ctx.sessionManager.getSessionFile() ??
              ctx.sessionManager.getSessionId(),
            rpc: new SubagentsRpcClient(pi.events),
          },
        },
      );
      cancelled.closedUsage = closedUsageResult(
        orchestrator,
        params.execution_id,
      );
      return result(
        `Task Pi ${params.execution_id}: ${cancelled.execution.state}; ${cancelled.disposition}. Closed usage: ${cancelled.closedUsage.status}; cleanup alone is not accounting. Do not collect/stage/review a closed execution; use saved evidence for any policy-authorized recovery.`,
        cancelled,
      );
    },
  });

  registerTaskTool({
    name: "team_task_status",
    label: "Task Pi Status",
    description:
      "Read the authoritative execution ledger state. Pane state alone is never completion evidence.",
    parameters: taskToolParameters.team_task_status,
    async execute(_id, params) {
      const execution = orchestrator.ledger.getExecution(params.execution_id);
      return result(
        `Task Pi ${params.execution_id}: ${execution.state}; Goal commit ${execution.goalCommitState}; resultDigest=${execution.resultDigest ?? "none"}. Status is not acceptance or permission to collect/stage/review a closed execution.`,
        execution,
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (draining)
      return {
        block: true,
        reason: "E2E owner is draining; no further model-driven effects.",
      };
    if (!orchestrator || !projectId || !goalCompatible) return;
    if (event.toolName === "update_goal_task") {
      const input = event.input;
      if (!input || typeof input !== "object")
        return {
          block: true,
          reason:
            "Goal-X task input schema is incompatible; Task Pi remains uncommitted.",
        };
      const updates = Array.isArray(input.updates) ? input.updates : [input];
      const completions = [];
      for (const update of updates) {
        if (!update || update.status !== "complete") continue;
        if (typeof update.task_id !== "string")
          return {
            block: true,
            reason:
              "Goal-X complete input lacks task_id; Task Pi remains uncommitted.",
          };
        let execution, gate;
        try {
          const goalId = focusedGoalId(ctx.sessionManager);
          execution = orchestrator.ledger.findLatestTask(
            projectId,
            goalId,
            update.task_id,
          );
          if (!execution) continue;
          gate = await goalGuard?.beforeTaskCompletion({
            goalId: execution.goalId,
            taskId: execution.taskId,
            evidence: update.evidence,
          });
          assert.equal(
            focusedGoalId(ctx.sessionManager),
            execution.goalId,
            "Goal focus changed during acceptance readback",
          );
        } catch (error) {
          return {
            block: true,
            reason: `Task acceptance revalidation failed: ${String(error.message ?? error).slice(0, 500)}`,
          };
        }
        if (!gate?.ok || typeof gate.evidence !== "string")
          return {
            block: true,
            reason:
              gate?.message ??
              `Task ${update.task_id} lacks an AcceptanceReceipt.`,
          };
        update.evidence = gate.evidence;
        completions.push({
          executionId: execution.executionId,
          goalId: execution.goalId,
          taskId: execution.taskId,
          evidence: gate.evidence,
        });
      }
      if (completions.length > 0)
        pendingGoalCommits.set(event.toolCallId, completions);
    }
    if (
      event.toolName === "update_goal" &&
      event.input?.status === "complete"
    ) {
      try {
        const gate = goalGuard.beforeGoalCompletion({
          goalId: focusedGoalId(ctx.sessionManager),
        });
        if (!gate.ok) return { block: true, reason: gate.message };
      } catch (error) {
        return {
          block: true,
          reason: `Goal completion context unavailable: ${String(error.message ?? error).slice(0, 500)}`,
        };
      }
    }
  });

  pi.on("tool_result", async (event) => {
    // Pi marks a returned execute() value successful regardless of an isError
    // property on that value. Use its public result hook to preserve a rejected
    // request as an error while retaining the structured effect facts.
    if (
      isInputRejection(
        event.details?.rejection,
        { tool: event.toolName, input: event.input },
        event.toolName,
        event.toolCallId,
      ) ||
      isCompletedCheckFailure(
        event.details?.checkFailure,
        { tool: event.toolName, input: event.input },
        event.toolName,
        event.toolCallId,
      ) ||
      isCompletedIntegrationConflict(
        event.details?.integrationConflict,
        { tool: event.toolName, input: event.input },
        event.toolName,
        event.toolCallId,
      )
    )
      return { isError: true };
    const pending = pendingGoalCommits.get(event.toolCallId);
    if (!pending) return;
    pendingGoalCommits.delete(event.toolCallId);
    if (event.isError) return;
    const goal = event.details?.goal;
    if (capabilityState && capabilityReceiptFile && goal?.id) {
      capabilityState.goalX.resultReadback = {
        compatible: true,
        observedAt: new Date().toISOString(),
        detailsVersion: event.details?.version ?? null,
      };
      writeCapabilityReceipt(capabilityReceiptFile, capabilityState);
    }
    const warnings = [];
    for (const commit of pending) {
      const task =
        goal?.id === commit.goalId
          ? findTask(goal.taskList?.tasks, commit.taskId)
          : null;
      if (task?.status !== "complete" || task.evidence !== commit.evidence) {
        warnings.push(
          `Task ${commit.taskId} result schema/readback was not confirmed; reservation remains open.`,
        );
        continue;
      }
      try {
        await goalGuard?.afterTaskCompletion({
          goalId: commit.goalId,
          taskId: commit.taskId,
          evidence: commit.evidence,
        });
      } catch (error) {
        warnings.push(
          `Task ${commit.taskId} committed in Goal-X, but ledger reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (warnings.length > 0)
      return {
        content: [...event.content, { type: "text", text: warnings.join(" ") }],
      };
  });

  for (const event of ["session_before_switch", "session_before_fork"])
    pi.on(event, (_event, ctx) => {
      if (
        orchestrator &&
        [...orchestrator.admittedExecutions].some(
          (id) => orchestrator.ledger.getExecution(id).reservationOpen,
        )
      ) {
        ctx.ui.notify(
          "Task Pi reservations are still open; cancel/reconcile them before switching the L0 session.",
          "warning",
        );
        return { cancel: true };
      }
    });

  const initialize = async (_event, ctx) => {
    orchestrator?.close();
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ??
      path.join(os.homedir(), ".pi", "agent");
    const workerExtension = fileURLToPath(
      new URL("../teams-worker/index.mjs", import.meta.url),
    );
    // Follow public registration provenance, including explicit temporary -e
    // packages. Do not silently run Worker/review from a different global copy.
    const subagents = packageExtension(
      agentDir,
      "pi-subagents",
      pi.getAllTools().find((tool) => tool.name === "subagent")?.sourceInfo
        ?.path,
    );
    subagentsEntry = subagents.entry;
    const goalPackage = packageExtension(agentDir, "pi-goal-x");
    let herdr = null;
    if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
      herdr = new HerdrPort({
        piExecutable: path.join(path.dirname(process.execPath), "pi"),
        workerExtension,
        subagentsExtension: subagents.entry,
        goalExtension: goalPackage.entry,
        readinessReceipt: path.join(
          agentDir,
          "teams-task-runtime-v1",
          "capabilities",
          `${deriveProjectId(ctx.cwd)}.readiness.json`,
        ),
        allowUnverifiedCanary: process.env.TEAMS_E2E_CANARY === "1",
        environment: process.env,
      });
    }
    orchestrator = new TaskOrchestrator({
      runtimeRoot: path.join(agentDir, "teams-task-runtime-v1"),
      ownerSessionId: ctx.sessionManager.getSessionId(),
      herdr,
    });
    acceptance = new HostAcceptance({ orchestrator });
    projectId = deriveProjectId(ctx.cwd);
    goalGuard = createGoalGuard(orchestrator, ctx.cwd);
    const goalProjection = inspectGoalTools(pi);
    goalCompatible = goalProjection.compatible;
    let subagentsProjection;
    try {
      subagentsProjection = inspectSubagentsPing(
        await new SubagentsRpcClient(pi.events).ping(),
      );
    } catch (error) {
      subagentsProjection = {
        compatible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const herdrProjection = herdr
      ? herdr.capabilities()
      : { compatible: false, reason: "not-herdr-managed" };
    taskPiCompatible =
      goalCompatible &&
      subagentsProjection.compatible === true &&
      (herdrProjection.compatible === true ||
        herdrProjection.canaryAllowed === true);
    const selectedMode = process.env.TEAMS_E2E_L0_MODE;
    if (selectedMode !== undefined)
      assert.equal(
        process.env.TEAMS_E2E_CANARY,
        "1",
        "mode-specific tool selection requires an authorized canary launch",
      );
    const modelTools = selectTaskL0Tools(pi, {
      mode: selectedMode,
      compatible: taskPiCompatible,
      sessionId: ctx.sessionManager.getSessionId(),
      ownerSessionId: orchestrator.ownerSessionId,
    });
    capabilityState = {
      schemaVersion: "teams-runtime-capabilities/1",
      capturedAt: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
      projectId,
      pi: {
        publicEvents: ["tool_call", "tool_result"],
        handlersRegistered: true,
      },
      goalX: {
        packageVersion: goalPackage.version,
        ...goalProjection,
        resultReadback: {
          compatible: false,
          reason: "not-observed-this-session",
        },
      },
      subagents: {
        packageVersion: subagents.version,
        publicEntry: subagents.entry,
        ...subagentsProjection,
      },
      modelTools,
      herdr: herdrProjection,
      decision: {
        goalGuardAvailable: goalCompatible,
        taskPiAvailable: taskPiCompatible,
        fallback:
          selectedMode === "task-pi" || taskPiCompatible ? null : "direct-only",
      },
    };
    capabilityReceiptFile = path.join(
      orchestrator.runtimeRoot,
      "capabilities",
      `${projectId}.json`,
    );
    writeCapabilityReceipt(capabilityReceiptFile, capabilityState);
    ctx.ui.setStatus(
      "teams-orchestrator",
      taskPiCompatible
        ? herdrProjection.compatible
          ? "direct-first · Task Pi available"
          : "authorized canary · live readiness unverified"
        : "direct-only · compatibility gate",
    );
  };

  for (const event of ["session_start", "session_switch", "session_fork"])
    pi.on(event, initialize);

  pi.on("session_shutdown", () => {
    goalGuard = null;
    orchestrator?.close();
    orchestrator = null;
    acceptance = null;
    projectId = null;
    goalCompatible = false;
    taskPiCompatible = false;
    capabilityState = null;
    capabilityReceiptFile = null;
    pendingGoalCommits.clear();
  });
}
