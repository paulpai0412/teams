import assert from "node:assert/strict";
import { deriveProjectId } from "./orchestrator.mjs";
import { HostAcceptance } from "./acceptance.mjs";

export function createGoalGuard(orchestrator, sourceRoot) {
  assert.ok(orchestrator?.ledger, "TaskOrchestrator required");
  const projectId = deriveProjectId(sourceRoot);
  return {
    beforeTaskCompletion({ goalId, taskId }) {
      const execution = orchestrator.ledger.findLatestTask(
        projectId,
        goalId,
        taskId,
      );
      if (!execution) return { ok: true };
      orchestrator.assertController(projectId);
      if (execution.state !== "ACCEPTED") {
        return {
          ok: false,
          message: `Task ${taskId} has Task Pi execution ${execution.executionId} in ${execution.state}; an AcceptanceReceipt is required before Goal completion.`,
        };
      }
      const acceptance = orchestrator.ledger.getAcceptance(
        execution.executionId,
      );
      if (!acceptance || acceptance.decision !== "accepted")
        return {
          ok: false,
          message: `Task ${taskId} has no accepted AcceptanceReceipt.`,
        };
      const gate = {
        ok: true,
        evidence: `task-runtime:${acceptance.acceptanceId}`,
      };
      if (
        orchestrator.ledger.getContract(execution.executionId).schemaVersion ===
        "teams-task-runtime/3"
      )
        return new HostAcceptance({ orchestrator })
          .verifyAccepted(execution.executionId)
          .then(() => gate);
      return gate;
    },

    afterTaskCompletion({ goalId, taskId, evidence }) {
      const execution = orchestrator.ledger.findLatestTask(
        projectId,
        goalId,
        taskId,
      );
      assert.ok(execution, `Task Pi execution missing for ${taskId}`);
      orchestrator.assertController(projectId);
      const acceptance = orchestrator.ledger.getAcceptance(
        execution.executionId,
      );
      assert.equal(
        evidence,
        `task-runtime:${acceptance?.acceptanceId}`,
        "Goal evidence does not match acceptance",
      );
      // The matching external Goal reply already happened. Keep that fact even
      // when subsequent freshness/cleanup fails; do not release on failure.
      orchestrator.ledger.markGoalCommitted(
        execution.executionId,
        acceptance.acceptanceId,
      );
      if (
        orchestrator.ledger.getContract(execution.executionId).schemaVersion ===
        "teams-task-runtime/3"
      )
        return new HostAcceptance({ orchestrator })
          .verifyAccepted(execution.executionId)
          .then(({ receipt }) => {
            orchestrator.closeAcceptedPane(receipt);
            orchestrator.ledger.releaseReservation(execution.executionId);
          });
      return orchestrator.ledger.releaseReservation(execution.executionId);
    },

    beforeGoalCompletion({ goalId }) {
      const open = orchestrator.ledger.listGoalOpen(projectId, goalId);
      if (open.length === 0) return { ok: true };
      orchestrator.assertController(projectId);
      return {
        ok: false,
        message: `Goal ${goalId} has ${open.length} unreconciled Task Pi execution${open.length === 1 ? "" : "s"}; complete Goal readback and release reservations first.`,
      };
    },
  };
}
