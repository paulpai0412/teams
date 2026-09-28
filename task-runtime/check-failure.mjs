import path from "node:path";
import { digest } from "./contracts.mjs";

// A completed nonzero command is not a product diagnosis or retry permission.
// Construct only after source, staged tree, owner and terminal checks in stage.
export class CompletedCheckFailure extends Error {
  constructor(checkId, receiptRef, receiptDigest, logDigest, exitCode) {
    super(`integration host check failed: ${checkId} (exit ${exitCode})`);
    this.name = "CompletedCheckFailure";
    this.check = {
      checkId,
      receiptRef,
      receiptDigest,
      logRef: `${receiptRef}.log`,
      logDigest,
      exitCode,
    };
  }
}

export function checkFailureReply(error, toolCallId, input) {
  if (!(error instanceof CompletedCheckFailure)) throw error;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${error.message}\nCheck completed but did not pass; acceptance is blocked. Keep this L0 available to inspect the receipt/log and diagnose. If the original Task admits a bounded candidate revision, cancel/drain this execution and use team_task_revise; otherwise pause the Goal and request the missing decision or authority. No check replay, sealed-source edits, new Task or automatic retry is authorized.`,
      },
    ],
    details: {
      checkFailure: {
        schemaVersion: "teams-completed-check-failure/1",
        toolName: "team_task_stage_integration",
        toolCallId,
        inputDigest: digest(input),
        executionId: input.execution_id,
        disposition: "diagnose-only",
        acceptance: "blocked",
        ...error.check,
      },
    },
  };
}

export function isCompletedCheckFailure(fact, call, toolName, toolCallId) {
  const sha = /^[a-f0-9]{64}$/;
  return Boolean(
    call &&
      call.tool === toolName &&
      toolName === "team_task_stage_integration" &&
      (!call.input.action || call.input.action === "stage") &&
      fact?.schemaVersion === "teams-completed-check-failure/1" &&
      fact.toolName === toolName &&
      fact.toolCallId === toolCallId &&
      fact.executionId === call.input.execution_id &&
      fact.inputDigest === digest(call.input) &&
      fact.disposition === "diagnose-only" &&
      fact.acceptance === "blocked" &&
      typeof fact.checkId === "string" &&
      fact.checkId.length > 0 &&
      typeof fact.receiptRef === "string" &&
      path.isAbsolute(fact.receiptRef) &&
      fact.logRef === `${fact.receiptRef}.log` &&
      sha.test(fact.receiptDigest ?? "") &&
      sha.test(fact.logDigest ?? "") &&
      Number.isSafeInteger(fact.exitCode) &&
      fact.exitCode > 0,
  );
}
