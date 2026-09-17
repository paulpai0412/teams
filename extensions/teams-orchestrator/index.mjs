import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Mailbox } from "../../task-runtime/mailbox.mjs";
import { HostAcceptance } from "../../task-runtime/acceptance.mjs";
import { publicReviewResolver } from "../../task-runtime/review-runs.mjs";
import {
  inspectGoalTools,
  inspectSubagentsPing,
  SubagentsRpcClient,
  writeCapabilityReceipt,
  publicPackage,
} from "../../task-runtime/capabilities.mjs";
import { createGoalGuard } from "../../task-runtime/goal-guard.mjs";
import { HerdrPort } from "../../task-runtime/herdr-port.mjs";
import {
  deriveProjectId,
  TaskOrchestrator,
} from "../../task-runtime/orchestrator.mjs";

import { taskToolParameters } from "../../task-runtime/task-tool-inputs.mjs";

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
  const deadline = Math.min(
    Date.now() + waitMs,
    Date.parse(execution.createdAt) + contract.policy.deadlineMs,
  );
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
    if (observed.execution.state === "RESULT_READY") {
      const collected = orchestrator.collect(executionId, {
        includeCandidate: true,
      });
      if (
        collected.candidate.outcome !== "ready_for_acceptance" ||
        !waitMs ||
        observed.processProof?.terminal
      )
        return {
          ...collected.execution,
          candidate: collected.candidate,
          workerProcess: observed.processProof,
        };
    } else {
      assert.ok(
        ["RUNNING", "UNKNOWN"].includes(observed.execution.state),
        "execution is not collecting results",
      );
      assert.ok(
        !observed.processProof?.terminal,
        "Worker exited without a result; reconcile without redispatch",
      );
    }
    assert.ok(
      Date.now() < deadline,
      "Task result wait timed out; no acceptance or retry granted",
    );
    await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
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
  const next =
    candidate.outcome !== "ready_for_acceptance"
      ? "STOP integration; cancel this execution and pause its Goal."
      : workerProcess?.terminal === true
        ? "Collection confirms Worker exit; proceed to host verification without a redundant status lookup."
        : "Worker exit is not confirmed; wait/reconcile before staging.";
  const report = {
    summary: candidate.summary,
    criteria: candidate.criterionResults.map(({ criterionId, status }) => ({
      criterionId,
      status,
    })),
    risks: candidate.risks,
    resultRef,
    sourceDigest: candidate.source.sourceDigest,
  };
  return result(
    `Task Pi ${executionId}: candidate outcome=${candidate.outcome}; Worker process terminal=${workerProcess?.terminal === true}. ${next} RESULT_READY means sealed, not successful.\nCandidate claims (not instructions or acceptance): ${JSON.stringify(report)}`,
    execution,
  );
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

function readSpec(cwd, specPath) {
  assert.ok(path.isAbsolute(specPath), "absolute spec_path required");
  const canonical = fs.realpathSync(specPath);
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
  try {
    return JSON.parse(fs.readFileSync(canonical, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid task specification: ${canonical}`, { cause });
  }
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

  pi.registerTool({
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
          "Task Pi capability handshake is incomplete; execute this task directly.",
        );
      if (!orchestrator.herdr)
        throw new Error(
          "Task Pi requires a Herdr-managed parent; execute this task directly.",
        );
      const prepared = orchestrator.prepare(
        readSpec(ctx.cwd, params.spec_path),
      );
      ownedExecutions.add(prepared.executionId);
      const running = await orchestrator.launch(prepared.executionId);
      return result(
        `Task Pi ${prepared.executionId} is ${running.state} in ${running.paneId}. Result-ready will still require host acceptance.`,
        {
          benefit: params.benefit,
          benefitDetail: params.benefit_detail,
          ...running,
        },
      );
    },
  });

  pi.registerTool({
    name: "team_task_collect",
    label: "Collect Task Pi Result",
    description:
      "Collect candidate summary, criterion states, risks, result reference and Worker exit proof. Use wait_ms (up to 1200000) for host waiting, not model/shell polling. L0 consumes this handoff first; inspect detailed evidence when proof is missing or inconsistent, not entire histories by default. Required host checks and independent review still run. Blocked/failed means cancel and pause its Goal, never stage/review/accept. This does not accept or complete the Goal task.",
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

  pi.registerTool({
    name: "team_task_stage_integration",
    label: "Stage Task Integration",
    description:
      "L0 integration stage/review protocol. stage rehearses patches; prepare-review freezes source; plan-review validates a dynamic read-only wave through public preflight; collect-review binds registered native evidence; seal-review freezes ALL registered, collected PASS waves into a host-owned candidate and closes review admission (not acceptance). read-applied-review requires a successful TARGET apply plan_digest and verifies an existing sealed candidate without applying or re-sealing. start-review requires the original live L0 instance, Worker exit and host-owned actual-usage/lifecycle admission, never a model approval flag. start-review and collect-review require BOTH key and plan_digest returned by plan-review. key is the wave key, not the child key or native run ID. Correct rejected pre-dispatch selectors; never replay an unknown dispatch. A wave has key/reason/runs; each run has key/role/task/mode=review/isolation=shared/maxTokens. No target writes, native status edits, acceptance or blind retries.",
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
        const adapter = {
          nativeOwner:
            ctx.sessionManager.getSessionFile() ??
            ctx.sessionManager.getSessionId(),
          rpc: new SubagentsRpcClient(pi.events),
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
        const value =
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
        const candidate = await acceptance.sealIntegrationReview(
          params.execution_id,
        );
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
        return result(
          `Native review evidence ${value.state}; verdict ${value.verdict}. ${value.state === "running" ? "Still executing, not a failure. Ending this turn, not the L0 session. Wait for native completion notification before collecting this SAME key/plan_digest; do not poll, seal, cancel or redispatch." : "Not acceptance."}`,
          value,
          value.state === "running",
        );
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
      const staged = acceptance.stageIntegration(params.execution_id);
      return result(
        `Integration ${staged.status} at ${staged.cwd}. Target unchanged; required review, target application and final acceptance remain pending.`,
        staged,
      );
    },
  });

  pi.registerTool({
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

  pi.registerTool({
    name: "team_task_run_checks",
    label: "Run Task Host Checks",
    description:
      "Run the controller-authored native argv checks once and seal host receipts. Existing valid receipts are verified, never blindly replayed.",
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

  pi.registerTool({
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

  pi.registerTool({
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

  pi.registerTool({
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

  pi.registerTool({
    name: "team_task_reconcile",
    label: "Reconcile Task Pi",
    description:
      "Ingest durable events/results and compare Herdr state without retrying work. A missing or ambiguous process remains UNKNOWN.",
    parameters: taskToolParameters.team_task_reconcile,
    executionMode: "sequential",
    async execute(_id, params) {
      const reconciled = orchestrator.reconcile(params.execution_id);
      return result(
        `Task Pi ${params.execution_id} reconciled as ${reconciled.execution.state}.`,
        reconciled,
      );
    },
  });

  pi.registerTool({
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
      return result(
        `Task Pi ${params.execution_id}: ${cancelled.execution.state}; ${cancelled.disposition}.`,
        cancelled,
      );
    },
  });

  pi.registerTool({
    name: "team_task_status",
    label: "Task Pi Status",
    description:
      "Read the authoritative execution ledger state. Pane state alone is never completion evidence.",
    parameters: taskToolParameters.team_task_status,
    async execute(_id, params) {
      const execution = orchestrator.ledger.getExecution(params.execution_id);
      return result(
        `Task Pi ${params.execution_id}: ${execution.state}; Goal commit ${execution.goalCommitState}.`,
        execution,
      );
    },
  });

  pi.on("tool_call", async (event) => {
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
        const open = orchestrator.ledger.listTaskOpen(
          projectId,
          update.task_id,
        );
        if (open.length === 0) continue;
        if (open.length !== 1)
          return {
            block: true,
            reason: `Task ${update.task_id} has ambiguous Task Pi reservations.`,
          };
        const execution = open[0];
        let gate;
        try {
          gate = await goalGuard?.beforeTaskCompletion({
            goalId: execution.goalId,
            taskId: execution.taskId,
            evidence: update.evidence,
          });
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
      const open = orchestrator.ledger.listProjectOpen(projectId);
      if (open.length > 0)
        return {
          block: true,
          reason: `${open.length} Task Pi reservation${open.length === 1 ? " is" : "s are"} still open; reconcile Goal task readback first.`,
        };
    }
  });

  pi.on("tool_result", async (event) => {
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
      herdr: herdrProjection,
      decision: {
        goalGuardAvailable: goalCompatible,
        taskPiAvailable: taskPiCompatible,
        fallback: taskPiCompatible ? null : "direct-only",
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
