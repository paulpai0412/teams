import assert from "node:assert/strict";
import { digest } from "./contracts.mjs";

// Only explicit input-validation boundaries may create this error. Ordinary
// assertions (ownership, source, usage, lifecycle, IO) remain execution failures.
export class TaskInputRejection extends Error {
  constructor(phase, cause, diagnostics = {}) {
    super(cause.message, { cause });
    this.name = "TaskInputRejection";
    this.phase = phase;
    this.diagnostics = diagnostics;
  }
}

export function validateInput(phase, validate) {
  try {
    return validate();
  } catch (error) {
    if (
      !(error instanceof assert.AssertionError || error instanceof SyntaxError)
    )
      throw error;
    throw new TaskInputRejection(phase, error);
  }
}

const executionTools = new Set([
  "team_task_collect",
  "team_task_stage_integration",
  "team_task_target_integration",
  "team_task_run_checks",
  "team_task_accept",
  "team_task_prepare_takeover",
  "team_task_reconcile",
  "team_task_cancel",
  "team_task_status",
  "team_task_revise",
  "team_task_revise_report",
]);

export function taskExecutionSelector(toolName, input) {
  if (!executionTools.has(toolName)) return null;
  const value =
    input?.[
      toolName === "team_task_revise" || toolName === "team_task_revise_report"
        ? "previous_execution_id"
        : "execution_id"
    ];
  return typeof value === "string" ? value : null;
}

// Called by an explicit read-only public selector lookup, pre-reservation input validation, pre-registration review planning,
// or a fully captured BLOCKED review's rejected seal (before candidate publication).
// Correction never permits replaying a launched execution or native review.
export function inputRejectionReply(error, toolName, toolCallId, input) {
  if (!(error instanceof TaskInputRejection)) throw error;
  const dispatch =
    ["team_task_dispatch", "team_task_revise"].includes(toolName) &&
    ["task-spec-file", "task-spec", "task-prompt", "task-context-ref"].includes(
      error.phase,
    );
  const review =
    toolName === "team_task_stage_integration" &&
    input.action === "plan-review" &&
    ["review-wave", "review-tools"].includes(error.phase);
  const blockedSeal =
    toolName === "team_task_stage_integration" &&
    input.action === "seal-review" &&
    error.phase === "review-seal";
  const selected = taskExecutionSelector(toolName, input);
  const selector = error.phase === "execution-selector" && selected !== null;
  if (!dispatch && !review && !blockedSeal && !selector) throw error;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: selector
          ? `${error.message}\nNo operation was attempted for this selector. Re-read the exact execution ID returned by the public tools and correct it within the existing authority; do not create or replay an execution.`
          : blockedSeal
            ? `${error.message}\nThe captured BLOCKED review is preserved. Do not repeat the seal, reviewer or old execution; proceed only through an authorized, owner-bound revision after cancellation and closed-usage reconciliation.`
            : `${error.message}\nRequest rejected before launch. Correct only within the existing authority; do not alter a sealed policy or replay an execution.`,
      },
    ],
    details: {
      rejection: {
        schemaVersion: "teams-input-rejection/1",
        toolName,
        toolCallId,
        inputDigest: digest(input),
        phase: error.phase,
        launchAttempted: false,
        executionId: selector ? selected : dispatch ? null : input.execution_id,
        // Selector lookup is read-only. Other preparation may persist metadata.
        preparationEffects: selector
          ? "none"
          : dispatch
            ? "controller-claim-possible"
            : blockedSeal
              ? "review-completion-preserved"
              : "review-request-possible",
        diagnostics: error.diagnostics,
      },
    },
  };
}

export function isInputRejection(rejection, call, toolName, toolCallId) {
  if (
    !call ||
    call.tool !== toolName ||
    !rejection ||
    !call.input ||
    typeof call.input !== "object"
  )
    return false;
  const dispatch =
    ["team_task_dispatch", "team_task_revise"].includes(toolName) &&
    ["task-spec-file", "task-spec", "task-prompt", "task-context-ref"].includes(
      rejection.phase,
    ) &&
    rejection.executionId === null &&
    rejection.preparationEffects === "controller-claim-possible";
  const review =
    toolName === "team_task_stage_integration" &&
    call.input.action === "plan-review" &&
    ["review-wave", "review-tools"].includes(rejection.phase) &&
    rejection.executionId === call.input.execution_id &&
    rejection.preparationEffects === "review-request-possible";
  const blockedSeal =
    toolName === "team_task_stage_integration" &&
    call.input.action === "seal-review" &&
    rejection.phase === "review-seal" &&
    rejection.executionId === call.input.execution_id &&
    rejection.preparationEffects === "review-completion-preserved";
  const selected = taskExecutionSelector(toolName, call.input);
  const selector =
    rejection.phase === "execution-selector" &&
    selected !== null &&
    rejection.executionId === selected &&
    rejection.preparationEffects === "none";
  return Boolean(
    (dispatch || review || blockedSeal || selector) &&
      rejection.schemaVersion === "teams-input-rejection/1" &&
      rejection.toolName === toolName &&
      rejection.toolCallId === toolCallId &&
      rejection.inputDigest === digest(call.input) &&
      rejection.launchAttempted === false,
  );
}
