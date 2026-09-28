// Product-review and conflict successors keep the original wall-clock window. In particular,
// execution n+1 does not acquire a fresh deadline just by receiving a new id.
import assert from "node:assert/strict";
import path from "node:path";
import { digest } from "./contracts.mjs";
import { Mailbox } from "./mailbox.mjs";

export function hasOriginalTaskDeadline(contract, mailbox) {
  if (contract.policy.reviewProductRevision === "within-scope-once")
    return true;
  if (contract.schemaVersion !== "teams-task-runtime/3" || !mailbox)
    return false;
  const boot = mailbox.readJson("bootstrap.json");
  if (!boot.repairIntentDigest) return false;
  const intent = mailbox.readJson("receipts/repair-intent.json");
  assert.equal(
    digest(intent),
    boot.repairIntentDigest,
    "deadline repair intent changed",
  );
  return intent.schemaVersion === "teams-candidate-repair-intent/3";
}

export function taskDeadlineAt(ledger, execution, contract) {
  const mailbox =
    contract.schemaVersion === "teams-task-runtime/3" &&
    execution.taskRevision > 1 &&
    contract.policy.reviewProductRevision !== "within-scope-once"
      ? Mailbox.open(
          path.join(
            path.dirname(ledger.file),
            "projects",
            execution.projectId,
            "executions",
            execution.executionId,
          ),
          execution.executionId,
        )
      : null;
  if (!hasOriginalTaskDeadline(contract, mailbox))
    return Date.parse(execution.createdAt) + contract.policy.deadlineMs;
  const history = ledger.listTaskExecutions(
    execution.projectId,
    execution.goalId,
    execution.taskId,
  );
  assert.ok(
    history.length >= 1 && history.length <= 2,
    "review revision history changed",
  );
  const first = history[0];
  // Historical E0 review/readback remains valid after E1 exists. Liveness and
  // latest-execution admission are separate gates, not a deadline calculation.
  assert.deepEqual(
    history.map((row) => row.taskRevision),
    history.map((_, index) => first.taskRevision + index),
    "revision history is not contiguous",
  );
  assert.ok(
    history.some(
      (row) =>
        row.executionId === execution.executionId &&
        row.taskRevision === execution.taskRevision,
    ),
    "execution outside revision history",
  );
  const original = ledger.getContract(first.executionId);
  assert.equal(
    original.policy.reviewProductRevision,
    contract.policy.reviewProductRevision,
  );
  assert.equal(original.policy.deadlineMs, contract.policy.deadlineMs);
  assert.equal(original.identity.ownerEpoch, execution.ownerEpoch);
  return Date.parse(first.createdAt) + original.policy.deadlineMs;
}

export function taskRemainingMs(ledger, execution, contract) {
  const remaining = taskDeadlineAt(ledger, execution, contract) - Date.now();
  assert.ok(remaining > 0, "original Task deadline exhausted");
  return Math.min(contract.policy.deadlineMs, remaining);
}

export function taskMemberTimeoutMs(ledger, execution, contract) {
  // Deterministic across review plan/launch/readback. Admission still checks
  // the current absolute deadline at each operation, not only this ceiling.
  const remainingAtReservation =
    taskDeadlineAt(ledger, execution, contract) -
    Date.parse(execution.createdAt);
  assert.ok(remainingAtReservation > 0, "original Task deadline exhausted");
  return Math.min(contract.policy.deadlineMs, remainingAtReservation);
}
