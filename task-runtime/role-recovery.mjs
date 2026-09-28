// Task-local attempt lineage. Native failures remain failures; only an explicit,
// bounded successor replaces a contribution. This is not a new run controller.
import assert from "node:assert/strict";
import path from "node:path";
import { readEvidenceBytes } from "../host-evidence.mjs";
import { bytesDigest, digest } from "./contracts.mjs";
import { readNativeTerminal, nativeWorkflowResult } from "./role-lifecycle.mjs";

export const branchId = (runId, key) => `${runId}/${key}`;

function parse(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error("Invalid branch evidence JSON", { cause });
  }
}

function progress(mailbox, read) {
  const events = mailbox
    .listEvents()
    .filter((event) => event.type === "progress");
  const relevant = events.filter((event) =>
    ["role-started", "branch-repair-intent"].includes(
      mailbox.readJson(event.payloadRef).kind,
    ),
  );
  if (
    !relevant.some(
      (event) =>
        mailbox.readJson(event.payloadRef).kind === "branch-repair-intent",
    )
  )
    return [];
  return relevant.map((event) => {
    const bytes = read(path.join(mailbox.root, event.payloadRef), 16 * 1024);
    const value = parse(bytes);
    assert.equal(
      bytesDigest(bytes),
      event.payloadDigest,
      "branch progress changed",
    );
    return { ...value, sequence: event.sequence };
  });
}

export function roleStatus(
  mailbox,
  contract,
  launch,
  read = readEvidenceBytes,
) {
  assert.ok(
    launch?.asyncDir && path.isAbsolute(launch.asyncDir),
    "branch native directory missing",
  );
  const ref = path.join(launch.asyncDir, "status.json");
  const bytes = read(ref, 1024 * 1024);
  const status = parse(bytes);
  const boot = mailbox.readJson("receipts/boot.json");
  assert.equal(status.runId, launch.runId, "branch root identity changed");
  assert.equal(
    status.cwd,
    contract.workspace.sourceRoot,
    "branch source changed",
  );
  assert.ok(
    [boot.workerSessionId, boot.workerSessionFile]
      .filter(Boolean)
      .includes(status.sessionId),
    "branch owner changed",
  );
  return { ref, bytes, status };
}

export function settledBranch(
  mailbox,
  contract,
  launch,
  key,
  read = readEvidenceBytes,
) {
  const member = launch.members.find((row) => row.key === key);
  assert.ok(member, "branch not owned by this Task");
  const captured = roleStatus(mailbox, contract, launch, read);
  const boot = mailbox.readJson("receipts/boot.json");
  assert.ok(
    readNativeTerminal(
      launch,
      [boot.workerSessionId, boot.workerSessionFile],
      () => captured.bytes,
    ),
    "branch wave termination is not proven",
  );
  const steps =
    launch.mode === "wave"
      ? captured.status.steps.filter((row) => row.workflowKey === key)
      : captured.status.steps;
  assert.equal(steps.length, 1, "branch native member missing or duplicated");
  const step =
    launch.hostedWorkflow && !captured.status.processTerminal
      ? nativeWorkflowResult(captured.status, steps[0])
      : steps[0];
  assert.equal(step.agent, member.role, "branch role changed");
  assert.equal(
    step.acceptance?.childReportParseError,
    undefined,
    "report-only parse failure does not authorize branch replay",
  );
  assert.ok(
    !step.processSignal &&
      !step.timedOut &&
      !step.detached &&
      !step.interrupted &&
      !step.stopped &&
      !step.turnBudgetExceeded &&
      !step.toolBudgetBlocked &&
      step.status !== "stopped" &&
      Number.isSafeInteger(step.exitCode) &&
      step.exitCode >= 0,
    "branch effects need reconciliation before replacement",
  );
  assert.ok(
    ["complete", "completed", "failed", "rejected"].includes(step.status),
    "branch is not settled",
  );
  return { ...captured, member, step };
}

// Used at repair admission AND when reading the final captured handoff. All
// attempts stay in childRunRefs/usage; only delivery selection changes.
export function roleRecovery(mailbox, contract, read = readEvidenceBytes) {
  const events = progress(mailbox, read);
  const roles = events.filter((row) => row.kind === "role-started");
  const intents = events.filter((row) => row.kind === "branch-repair-intent");
  const replaced = new Set(),
    lineage = new Map(),
    repairs = [];
  for (const intent of intents) {
    assert.equal(
      contract.schemaVersion,
      "teams-task-runtime/3",
      "branch repair requires v3",
    );
    assert.equal(intent.schemaVersion, "teams-role-repair/1");
    assert.equal(
      intent.requestDigest,
      digest(contract),
      "branch repair contract changed",
    );
    assert.ok(
      typeof intent.reason === "string" && intent.reason.trim(),
      "branch diagnosis missing",
    );
    const old = roles.find((row) => row.runId === intent.previous.runId);
    assert.ok(
      old && old.sequence < intent.sequence,
      "branch predecessor missing",
    );
    const before = branchId(old.runId, intent.previous.key);
    assert.ok(!replaced.has(before), "branch already replaced");
    const prior = settledBranch(
      mailbox,
      contract,
      old,
      intent.previous.key,
      read,
    );
    assert.equal(
      bytesDigest(prior.bytes),
      intent.previous.statusSha256,
      "branch predecessor evidence changed",
    );
    assert.equal(
      prior.member.taskDigest,
      intent.previous.taskDigest,
      "branch assignment changed",
    );
    assert.equal(
      intent.previous.assignmentRef,
      `receipts/wave-plan-${old.launchId}.json`,
      "branch assignment reference changed",
    );
    const assignment = read(
      path.join(mailbox.root, intent.previous.assignmentRef),
      8 * 1024 * 1024,
    );
    assert.equal(
      bytesDigest(assignment),
      intent.previous.assignmentSha256,
      "branch original assignment changed",
    );
    assert.equal(
      digest(
        parse(assignment).runs.find((row) => row.key === prior.member.key)
          ?.task,
      ),
      prior.member.taskDigest,
      "branch original requirements changed",
    );
    assert.ok(
      prior.member.isolation === "worktree" ||
        ["read-only", "review"].includes(prior.member.mode),
      "replacement requires an isolated writer or read-only predecessor",
    );
    const origin = lineage.get(before) ?? { id: before, ordinal: 0 };
    assert.equal(
      intent.ordinal,
      origin.ordinal + 1,
      "branch repair ordinal changed",
    );
    assert.ok(
      intent.ordinal <= contract.policy.maxProductRepairsPerRole,
      "branch repair allowance exhausted",
    );
    const next = roles.find((row) => row.launchId === intent.next.launchId);
    assert.ok(
      next && next.sequence > intent.sequence,
      "branch successor has no native identity; reconcile",
    );
    const member = next.members.find((row) => row.key === intent.next.key);
    assert.ok(member, "branch successor missing");
    for (const field of ["role", "mode", "isolation"])
      assert.equal(
        member[field],
        prior.member[field],
        `branch repair ${field} changed`,
      );
    assert.equal(
      member.taskDigest,
      intent.next.taskDigest,
      "branch successor assignment changed",
    );
    const after = branchId(next.runId, member.key);
    assert.ok(!lineage.has(after), "branch successor reused");
    replaced.add(before);
    lineage.set(after, { id: origin.id, ordinal: intent.ordinal });
    repairs.push({ ...intent, next: { ...intent.next, runId: next.runId } });
  }
  return { replaced, lineage, repairs };
}
