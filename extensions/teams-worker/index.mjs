import os from "node:os";
import path from "node:path";
import { publicReviewResolver } from "../../task-runtime/review-runs.mjs";
import {
  inspectSubagentsPing,
  SubagentsRpcClient,
} from "../../task-runtime/capabilities.mjs";
import { RoleController } from "../../task-runtime/role-controller.mjs";
import { WorkerRuntime } from "../../task-runtime/worker-runtime.mjs";
import { workerSessionBytes } from "../../task-runtime/task-usage.mjs";
import {
  installTaskBudgetHooks,
  taskBudgetBinding,
} from "../../task-runtime/task-budget.mjs";

const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "resultRevision",
    "outcome",
    "summary",
    "criterionResults",
    "evidence",
    "risks",
    "usage",
  ],
  properties: {
    resultRevision: { type: "integer", minimum: 1 },
    outcome: {
      type: "string",
      enum: ["ready_for_acceptance", "blocked", "failed", "cancelled"],
      description:
        "ready_for_acceptance means the candidate/handoff is ready for host verification, NOT accepted: role work succeeded and all roles are terminal. With L0-owned checks/review, keep pending host-check criteria indeterminate; those pending gates alone are not blocked. blocked requires a concrete candidate impediment or out-of-scope decision; failed means task work failed; cancelled means cancelled work. Never relabel a real blocker as ready.",
    },
    summary: { type: "string", maxLength: 4096 },
    criterionResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "status", "observation", "evidenceIds"],
        properties: {
          criterionId: { type: "string" },
          status: {
            type: "string",
            enum: ["met", "not_met", "indeterminate", "needs_user"],
            description:
              "Use indeterminate for untested host-check behavior even when static checks pass. Pending host-check criteria can accompany outcome=ready_for_acceptance; met must not stand in for missing runtime verification.",
          },
          observation: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidence: {
      type: "array",
      description:
        "Only exact current-execution files with verified matching hashes. Pending host-only criteria may use evidence:[] and evidenceIds:[]; native child handoffs are already captured by the runtime. Describe external/old artifacts in summary or risks, not as evidence entries.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "kind", "uri", "sha256", "producedBy"],
        properties: {
          evidenceId: { type: "string" },
          kind: { type: "string" },
          uri: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            pattern:
              "^(?!\\.{1,2}([/\\\\]|$))[^/\\\\]+(?:[/\\\\](?!\\.{1,2}([/\\\\]|$))[^/\\\\]+)*$",
            description:
              "Relative to this execution's mailbox root, not the project/worktree or runtime root. No absolute path, empty segment, dot or parent traversal. Example: worker-sessions/subagent-artifacts/worktree-diffs/<run>/task-0-team.implementer.patch. Host still verifies containment and credential-path restrictions.",
          },
          sha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
            description:
              "SHA256 of the exact bytes at uri. A patch hash cannot authenticate a handoff JSON or another file. Never guess a digest; omit optional evidence if its exact file/hash pair is unavailable.",
          },
          producedBy: { type: "string", enum: ["host", "worker", "subagent"] },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["inputTokens", "outputTokens"],
      properties: {
        inputTokens: { type: ["integer", "null"], minimum: 0 },
        outputTokens: { type: ["integer", "null"], minimum: 0 },
      },
    },
  },
};

export default function teamsWorker(pi) {
  let runtime = null;
  let roles = null;
  let timer = null;
  let promptSent = false;
  let unsubscribeComplete = null;
  let unsubscribeTerminal = null;
  let cancelInFlight = false;
  let waitingForRoles = false;
  // Existing lifecycle/admission vetoes must run before reserving compaction
  // headroom: a locally cancelled summary never began a model request.
  for (const event of ["session_before_compact", "session_before_tree"]) {
    pi.on(event, (_event, ctx) => {
      if (!runtime) return;
      try {
        if (!roles.admitTurn().waiting) return;
      } catch (error) {
        ctx.ui.setStatus(
          "teams-worker",
          `admission blocked: ${String(error.message ?? error)}`,
        );
      }
      return { cancel: true };
    });
  }
  installTaskBudgetHooks(
    pi,
    () => (runtime ? taskBudgetBinding(runtime, "worker") : null),
    (error) => runtime?.failAdmission(error),
  );

  function shutdownIfCancelled(ctx) {
    if (
      runtime?.state === "CANCEL_REQUESTED" &&
      roles?.snapshot().unresolvedRunCount === 0
    ) {
      runtime.confirmCancelled(0);
      ctx.shutdown();
    }
  }

  async function drainCancellation(ctx) {
    if (
      !runtime ||
      !roles ||
      cancelInFlight ||
      runtime.state !== "CANCEL_REQUESTED"
    )
      return;
    cancelInFlight = true;
    try {
      ctx.abort();
      await roles.stopAll();
      shutdownIfCancelled(ctx);
    } finally {
      cancelInFlight = false;
    }
  }

  pi.registerTool({
    name: "team_role_spawn",
    label: "Spawn Task Role",
    description:
      "Start one role or an independently justified parallel wave through one native controller run. Roles are chosen from the task allowlist, not a fixed pipeline. Shared writes/checks run alone; parallel writers require managed worktrees. New v3 Tasks use a shared pool: max_tokens is a cumulative role estimate including input/output/cache, not an output limit. Request headroom grows only from unreserved Task funds; actual usage is settled atomically. Unknown usage or insufficient Task funds block requests. Legacy member-hard contracts retain hard role limits. Reported metering is not an instantaneous provider billing cap.",
    parameters: {
      type: "object",
      additionalProperties: false,
      oneOf: [
        {
          required: ["role", "task", "mode", "max_tokens"],
          not: {
            anyOf: ["key", "reason", "runs"].map((key) => ({
              required: [key],
            })),
          },
        },
        {
          required: ["key", "reason", "runs"],
          not: {
            anyOf: ["role", "task", "mode", "max_tokens"].map((key) => ({
              required: [key],
            })),
          },
        },
      ],
      properties: {
        role: { type: "string", pattern: "^team\\.[A-Za-z0-9._-]+$" },
        task: { type: "string", maxLength: 16384 },
        mode: {
          type: "string",
          enum: ["mutation", "review", "read-only", "check"],
        },
        max_tokens: {
          type: "integer",
          minimum: 1,
          description:
            "Cumulative input/output/cache estimate reserved from the shared Task pool; legacy contracts use a hard role cap. Not per-response output tokens.",
        },
        key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
        runs: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "key",
              "role",
              "task",
              "mode",
              "isolation",
              "max_tokens",
            ],
            properties: {
              key: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
              },
              role: { type: "string", pattern: "^team\\.[A-Za-z0-9._-]+$" },
              task: { type: "string", maxLength: 16384 },
              mode: {
                type: "string",
                enum: ["mutation", "review", "read-only", "check"],
              },
              isolation: { type: "string", enum: ["shared", "worktree"] },
              max_tokens: {
                type: "integer",
                minimum: 1,
                description:
                  "Cumulative role estimate including input/output/cache; shared Task pool may grow its request reservation within the unchanged Task ceiling.",
              },
            },
          },
        },
      },
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (!roles) throw new Error("Task role controller is not bound.");
      const wave = Array.isArray(params.runs);
      if (
        wave &&
        ["role", "task", "mode", "max_tokens"].some((key) => key in params)
      )
        throw new Error("Choose a single role or a wave, not both.");
      if (!wave && ["key", "reason", "runs"].some((key) => key in params))
        throw new Error("Wave key/reason require a complete runs array.");
      const launched = wave
        ? await roles.spawnWave({
            key: params.key,
            reason: params.reason,
            runs: params.runs.map(({ max_tokens, ...run }) => ({
              ...run,
              maxTokens: max_tokens,
            })),
          })
        : await roles.spawn({
            role: params.role,
            task: params.task,
            mode: params.mode,
            maxTokens: params.max_tokens,
          });
      return {
        content: [
          {
            type: "text",
            text: `${launched.members.length} role(s) started as native run ${launched.runId}. Consume completion and process-terminal proof before the next wave. Worktree outputs are not merged or accepted.`,
          },
        ],
        details: launched,
        // Yield to native completion notification instead of another polling LLM turn.
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "team_task_result",
    label: "Task Result",
    description:
      "Seal this Task Pi execution result. Result-ready is a candidate for root acceptance, never Goal completion. Evidence URIs are relative to the current execution mailbox and hashes must match those exact files. For pending host-only criteria, use indeterminate and empty evidence/evidenceIds rather than manufacturing provenance. Native role handoffs/source/usage are captured by the runtime; do not duplicate final host checks.",
    parameters: resultSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      if (!runtime)
        throw new Error("Task Worker is not bound to an execution.");
      if (!roles) throw new Error("Task role controller is not bound.");
      const roleState = roles.snapshot();
      if (roleState.unresolvedRunCount !== 0)
        throw new Error(
          "All role runs need completion and process-terminal proof.",
        );
      const source = runtime.captureSource(params.resultRevision);
      const result = {
        schemaVersion: "teams-task-result/1",
        identity: runtime.contract.identity,
        requestDigest: runtime.bootstrap.requestDigest,
        resultRevision: params.resultRevision,
        outcome: params.outcome,
        summary: params.summary,
        source,
        criterionResults: params.criterionResults,
        evidence: params.evidence.map((item) => ({
          ...item,
          sourceDigest: source.sourceDigest,
        })),
        childRunRefs: roleState.childRunRefs,
        unresolvedRunCount: roleState.unresolvedRunCount,
        risks: params.risks,
        usage: params.usage,
      };
      const sealed = runtime.sealResult(result);
      ctx.shutdown();
      return {
        content: [
          {
            type: "text",
            text: `Task result sealed at ${sealed.resultRef}. Await root acceptance; do not modify product source.`,
          },
        ],
        details: sealed,
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const executionRoot = process.env.TEAMS_TASK_EXECUTION_DIR;
    if (!executionRoot) return;
    try {
      runtime = new WorkerRuntime({ executionRoot });
      const extensions = [
        ...new Set(
          pi
            .getAllTools()
            .map((tool) => tool.sourceInfo?.path)
            .filter((value) => typeof value === "string"),
        ),
      ];
      const rpc = new SubagentsRpcClient(pi.events);
      const subagents = inspectSubagentsPing(await rpc.ping());
      runtime.boot({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd,
        activeTools: pi.getActiveTools(),
        extensions,
        subagents,
      });
      roles = new RoleController({
        runtime,
        rpc,
        cwd: ctx.cwd,
        readWorker: (boot) => workerSessionBytes(ctx.sessionManager, boot),
        resolve: async (input) => {
          const resolver = await publicReviewResolver(
            process.env.PI_CODING_AGENT_DIR ??
              path.join(os.homedir(), ".pi", "agent"),
            process.argv[1],
            pi.getAllTools().find((tool) => tool.name === "subagent")
              ?.sourceInfo?.path,
          );
          return resolver({
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
      });
      unsubscribeComplete = pi.events.on(
        subagents.ping?.events?.asyncComplete ?? "subagent:async-complete",
        (payload) => {
          if (!roles || typeof payload?.runId !== "string") return;
          try {
            if (!roles.snapshot().childRunRefs.includes(payload.runId)) return;
            roles.refreshTerminals();
            shutdownIfCancelled(ctx);
          } catch {
            // Ignore unrelated pi-subagents completions in this process.
          }
        },
      );
      unsubscribeTerminal = pi.events.on(
        subagents.ping?.events?.processTerminal ?? "subagent:process-terminal",
        (payload) => {
          if (!roles || typeof payload?.runId !== "string") return;
          try {
            roles.observeProcessTerminal(payload);
            shutdownIfCancelled(ctx);
          } catch {
            // Ignore unrelated pi-subagents process proofs in this process.
          }
        },
      );
      timer = setInterval(() => {
        if (!runtime) return;
        try {
          const control = runtime.processControls();
          if (control.cancelRequested)
            void drainCancellation(ctx).catch((error) =>
              ctx.ui.setStatus(
                "teams-worker",
                `cancel unknown: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          if (
            waitingForRoles &&
            runtime.state === "RUNNING" &&
            ctx.isIdle() &&
            !ctx.hasPendingMessages()
          ) {
            roles.refreshTerminals();
            if (roles.snapshot().unresolvedRunCount === 0) {
              waitingForRoles = false;
              pi.sendUserMessage(
                "The registered native roles have terminated. Continue the same bounded task; admission is rechecked before the model turn.",
              );
            }
          }
          if (
            control.started &&
            runtime.state === "RUNNING" &&
            !promptSent &&
            ctx.isIdle() &&
            !ctx.hasPendingMessages()
          ) {
            pi.sendUserMessage(control.prompt ?? runtime.taskPrompt());
            promptSent = true;
          }
        } catch (error) {
          // Startup and wake failures must reach the owner even before turn_start.
          // The existing failure path stops model wakes but keeps cancellation alive.
          runtime.failAdmission(error);
          ctx.ui.setStatus(
            "teams-worker",
            `blocked: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, 250);
      timer.unref?.();
      ctx.ui.setStatus(
        "teams-worker",
        `waiting ${runtime.executionId.slice(0, 8)}`,
      );
    } catch (error) {
      pi.setActiveTools([]);
      ctx.ui.notify(
        `Teams Worker refused startup: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      ctx.shutdown();
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!runtime) return;
    try {
      const admission = roles.admitTurn();
      waitingForRoles = admission.waiting;
      // Native progress and decision requests legitimately wake this parent.
      // admitTurn meters coordination without releasing in-flight reservations.
    } catch (error) {
      ctx.abort();
      waitingForRoles = false;
      runtime.failAdmission(error);
      ctx.ui.setStatus(
        "teams-worker",
        `admission blocked: ${String(error.message ?? error)}`,
      );
    }
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent_supervisor") return;
    try {
      if (!runtime) throw new Error("Task Worker is not bound.");
      runtime.assertAdmission();
    } catch (error) {
      return { block: true, reason: String(error.message ?? error) };
    }
  });

  for (const event of ["session_before_switch", "session_before_fork"])
    pi.on(event, () => {
      if (runtime) return { cancel: true };
    });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    unsubscribeComplete?.();
    unsubscribeTerminal?.();
    unsubscribeComplete = null;
    unsubscribeTerminal = null;
    cancelInFlight = false;
    waitingForRoles = false;
    timer = null;
    roles = null;
    runtime = null;
  });
}
