import assert from "node:assert/strict";
import { deriveProjectId } from "./orchestrator.mjs";
import { HostAcceptance } from "./acceptance.mjs";

// Goal-X's native session focus entry; never infer identity from another Task's
// reservation or from the project's shared goal directory. No parallel state store.
export function focusedGoalId(sessionManager) {
  const entry = sessionManager
    ?.getBranch?.()
    .findLast(
      (row) => row.type === "custom" && row.customType === "pi-goal-focus",
    );
  assert.equal(
    entry?.data?.version,
    1,
    "native Goal-X session focus unavailable; refresh Goal context before completion",
  );
  const id = entry.data.focusedGoalId;
  assert.ok(
    typeof id === "string" && id.length > 0 && id.length <= 128,
    "no native focused Goal for completion",
  );
  return id;
}

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
      const incomplete = orchestrator.ledger
        .listGoalLatest(projectId, goalId)
        .filter(
          (row) =>
            row.state !== "ACCEPTED" || row.goalCommitState !== "committed",
        );
      if (open.length === 0 && incomplete.length === 0) return { ok: true };
      orchestrator.assertController(projectId);
      return {
        ok: false,
        message: `Goal ${goalId} has ${open.length} open reservations and ${incomplete.length} Tasks without accepted Goal readback; closed failures are not completion. Recover affected Tasks, then complete Goal readback and release reservations.`,
      };
    },
  };
}
