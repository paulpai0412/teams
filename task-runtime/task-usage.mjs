// Host-owned reported usage, not provider billing, lifecycle approval or acceptance.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { readEvidenceBytes } from "../host-evidence.mjs";
import { bytesDigest, digest } from "./contracts.mjs";
import { sessionUsageBytes } from "./e2e/usage.mjs";
import { usesSharedTaskBudget } from "./budget-pool.mjs";
import { assertTaskBudgetUsage } from "./task-budget.mjs";
import {
  readRoleLifecycle,
  readReviewLifecycle,
  readNativeTerminal,
  readNativeTerminalBytes,
} from "./role-lifecycle.mjs";

const parts = ["input", "output", "cacheRead", "cacheWrite"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const entryTypes = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
function parsed(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error("invalid usage evidence JSON", { cause });
  }
}
function inside(root, file) {
  assert.ok(
    typeof file === "string" &&
      path.isAbsolute(file) &&
      path.resolve(file) === file &&
      file.startsWith(root + path.sep),
    "session outside planned usage root",
  );
}
// Public SessionManager is authoritative before Pi's first assistant flush.
// Never synthesize zero usage from an absent/unreadable transcript.
export function workerSessionBytes(manager, boot) {
  assert.equal(
    manager.getSessionId(),
    boot.workerSessionId,
    "live Worker session changed",
  );
  assert.equal(
    manager.getSessionFile(),
    boot.workerSessionFile,
    "live Worker session path changed",
  );
  const bytes = Buffer.from(
    [manager.getHeader(), ...manager.getEntries()]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  assert.ok(
    bytes.length <= 8 * 1024 * 1024,
    "Worker session snapshot exceeds 8 MiB",
  );
  const measured = measureSessionBytes(bytes, { allowEmpty: true });
  assert.equal(
    measured.sessionId,
    boot.workerSessionId,
    "live Worker header changed",
  );
  assert.equal(measured.cwd, boot.cwd, "live Worker cwd changed");
  if (fs.existsSync(boot.workerSessionFile)) {
    const disk = readEvidenceBytes(boot.workerSessionFile, 8 * 1024 * 1024);
    assert.ok(
      disk.length <= bytes.length &&
        disk.equals(bytes.subarray(0, disk.length)),
      "persisted Worker session differs from public state",
    );
  } else {
    assert.equal(measured.usage.messages, 0, "Worker usage has not persisted");
    assert.equal(
      measured.usage.total,
      0,
      "Worker summary/tool usage has not persisted",
    );
  }
  return bytes;
}

export function readWorkerUsageCheckpoint(mailbox) {
  const root = path.join(mailbox.root, "receipts");
  const names = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((name) => name.startsWith("worker-usage-"))
        .sort()
    : [];
  assert.ok(
    names.length <= 1024,
    "Worker usage checkpoint inventory too large",
  );
  assert.deepEqual(
    names,
    names.map(
      (_, index) => `worker-usage-${String(index + 1).padStart(6, "0")}.json`,
    ),
    "Worker usage checkpoint inventory changed",
  );
  return {
    count: names.length,
    latest: names.length
      ? mailbox.readJson(`receipts/${names.at(-1)}`, 1024 * 1024)
      : null,
  };
}

export function measureSessionBytes(bytes, { allowEmpty = false } = {}) {
  const entries = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => parsed(Buffer.from(line)));
  const header = entries.shift();
  assert.equal(header?.type, "session", "usage session header missing");
  assert.equal(header.version, 3, "unknown usage session version");
  assert.match(header.id, idPattern, "usage session identity missing");
  assert.ok(
    !header.parentSession,
    "inherited session usage is not a fresh task session",
  );
  assert.ok(
    typeof header.cwd === "string" && path.isAbsolute(header.cwd),
    "usage session cwd missing",
  );
  const ids = new Set();
  for (const entry of entries) {
    assert.ok(entryTypes.has(entry.type), "unknown usage session entry type");
    assert.ok(
      typeof entry.id === "string" && entry.id && !ids.has(entry.id),
      "missing or duplicate usage session entry identity",
    );
    ids.add(entry.id);
    if (entry.type === "message") {
      assert.ok(
        [
          "user",
          "assistant",
          "toolResult",
          "bashExecution",
          "custom",
          "branchSummary",
          "compactionSummary",
        ].includes(entry.message?.role),
        "unknown usage message role",
      );
      if (entry.message?.stopReason !== undefined)
        assert.ok(
          ["stop", "length", "toolUse", "error", "aborted"].includes(
            entry.message.stopReason,
          ),
          "unknown or partial usage message",
        );
    }
  }
  const usage = sessionUsageBytes(bytes, { strict: true });
  assert.ok(
    usage.available &&
      (allowEmpty || usage.messages > 0) &&
      !usage.malformedLines &&
      !usage.missingUsage,
    "session usage missing or unknown",
  );
  delete usage.file;
  return { sessionId: header.id, cwd: header.cwd, usage };
}
function reservedUsage(sources) {
  let tokens = 0;
  for (const source of sources.filter((row) => row.kind !== "worker")) {
    assert.ok(
      Number.isSafeInteger(source.maxTokens) &&
        source.maxTokens > 0 &&
        Number.isSafeInteger(tokens + source.maxTokens),
      "usage reservation missing or overflow",
    );
    tokens += source.maxTokens;
  }
  return tokens;
}

function totalUsage(sources) {
  const total = Object.fromEntries([...parts, "total"].map((key) => [key, 0]));
  for (const source of sources) {
    const usage = source.usage;
    assert.ok(
      usage?.available && !usage.missingUsage && !usage.malformedLines,
      "unknown session usage",
    );
    for (const key of [...parts, "total"]) {
      assert.ok(
        Number.isSafeInteger(usage[key]) &&
          usage[key] >= 0 &&
          Number.isSafeInteger(total[key] + usage[key]),
        "usage total invalid or overflow",
      );
      total[key] += usage[key];
    }
    assert.equal(
      usage.total,
      parts.reduce((sum, key) => sum + usage[key], 0),
      "usage component total mismatch",
    );
    assert.match(
      usage.sourceSha256,
      /^[a-f0-9]{64}$/,
      "usage source digest missing",
    );
  }
  return total;
}

// readNative can replay stage-owned immutable captures. No scanning session homes,
// filename guessing, fallback to model totals, or filtering failed/stopped runs.
export function measureExecutionUsage(
  context,
  {
    readNative = readEvidenceBytes,
    reviews = [],
    previous = null,
    expectedRuns = null,
    readWorker = null,
    reserveActive = false,
  } = {},
) {
  const { mailbox, contract, result } = context;
  context.assertOwner();
  const boot = mailbox.readJson("receipts/boot.json");
  assert.equal(
    boot.executionId,
    contract.identity.executionId,
    "usage worker execution mismatch",
  );
  assert.equal(
    boot.ownerEpoch,
    contract.identity.ownerEpoch,
    "usage worker epoch mismatch",
  );
  assert.equal(
    boot.requestDigest,
    digest(contract),
    "usage worker contract mismatch",
  );
  assert.equal(
    boot.launchNonce,
    mailbox.readJson("bootstrap.json").launchNonce,
    "usage worker launch mismatch",
  );
  assert.equal(
    boot.cwd,
    contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
    "usage worker planned cwd mismatch",
  );
  const workerFile = boot.workerSessionFile;
  inside(path.join(mailbox.root, "worker-sessions"), workerFile);
  const workerBytes = readWorker
    ? readWorker(boot)
    : readEvidenceBytes(workerFile, 8 * 1024 * 1024);
  const workerCheckpoint = readWorkerUsageCheckpoint(mailbox).latest;
  const checkpoints = [
    ...reviews.map((row) => row.usageAdmission),
    ...(previous ? [previous] : []),
    ...(workerCheckpoint ? [workerCheckpoint] : []),
  ];
  for (const checkpoint of checkpoints) {
    assert.equal(
      checkpoint.executionId,
      contract.identity.executionId,
      "usage checkpoint execution changed",
    );
    assert.equal(
      checkpoint.contractDigest,
      digest(contract),
      "usage checkpoint contract changed",
    );
    const old = checkpoint.sources.find((row) => row.kind === "worker");
    assert.ok(
      old &&
        old.sessionFile === workerFile &&
        old.sessionId === boot.workerSessionId &&
        Number.isSafeInteger(old.usage.sourceBytes) &&
        old.usage.sourceBytes > 0 &&
        workerBytes.length >= old.usage.sourceBytes,
      "worker usage history missing or truncated",
    );
    assert.equal(
      bytesDigest(workerBytes.subarray(0, old.usage.sourceBytes)),
      old.usage.sourceSha256,
      "worker usage history changed",
    );
  }
  const worker = measureSessionBytes(workerBytes, {
    allowEmpty: readWorker !== null,
  });
  let totalBytes = workerBytes.length;
  const read = (file, limit) => {
    const bytes = readNative(file, limit);
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "usage corpus exceeds 64 MiB");
    return bytes;
  };
  assert.equal(
    worker.sessionId,
    boot.workerSessionId,
    "worker usage session mismatch",
  );
  assert.equal(worker.cwd, boot.cwd, "worker usage cwd mismatch");
  const sources = [{ kind: "worker", sessionFile: workerFile, ...worker }];
  const progress = mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => mailbox.readJson(event.payloadRef, 16 * 1024));
  assert.ok(
    !progress.some((row) => row.kind === "role-launch-unknown"),
    "unknown launch has unknown usage",
  );
  const roles = progress.filter((row) => row.kind === "role-started");
  assert.ok(
    roles.length <= contract.policy.maxRoleSpawnsPerTask &&
      roles.every(
        (row) =>
          Array.isArray(row.members) &&
          row.members.length > 0 &&
          row.members.length <= 64,
      ),
    "bounded usage member inventory required",
  );
  assert.deepEqual(
    roles.map((row) => row.runId).sort(),
    [...result.childRunRefs].sort(),
    "usage native run inventory changed",
  );
  assert.equal(
    progress.filter((row) => row.kind === "role-launch-intent").length,
    roles.reduce((count, row) => count + row.members.length, 0),
    "usage role admission inventory incomplete",
  );
  if (expectedRuns !== null) {
    const fields = [
      "launchId",
      "runId",
      "asyncDir",
      "sessionDir",
      "members",
      "mode",
      "hostedWorkflow",
    ];
    const binding = (row) =>
      Object.fromEntries(fields.map((key) => [key, row[key]]));
    assert.deepEqual(
      roles.map(binding),
      expectedRuns.map(binding),
      "role usage history binding changed",
    );
  }
  const runs = new Set();
  for (const role of roles) {
    assert.match(role.runId, idPattern);
    assert.match(role.launchId, idPattern);
    assert.ok(!runs.has(role.runId), "duplicate usage root run");
    runs.add(role.runId);
    const sessionDir = path.join(mailbox.root, "role-sessions", role.launchId);
    assert.equal(
      role.sessionDir,
      sessionDir,
      "native planned session root missing or changed",
    );
    const statusBytes = read(
      path.join(role.asyncDir, "status.json"),
      1024 * 1024,
    );
    const status = parsed(statusBytes);
    if (status.processTerminal?.state === "not-started") {
      const proof = readNativeTerminal(
        role,
        [boot.workerSessionId, workerFile],
        () => statusBytes,
      );
      if (expectedRuns !== null) {
        const expected = expectedRuns.find((row) => row.runId === role.runId);
        assert.equal(expected?.terminal, true, "no-start role not settled");
        assert.equal(expected.completion, "failed", "no-start role not failed");
        assert.deepEqual(
          expected.processTerminal,
          proof.processTerminal,
          "no-start usage proof changed",
        );
      }
      // A native pre-spawn failure has no child session. It remains in the
      // run/spawn inventory, but contributes no fabricated zero-usage session.
      continue;
    }
    if (
      reserveActive &&
      expectedRuns?.find((row) => row.runId === role.runId)?.terminal === false
    ) {
      // Worker-only coordination: this exact launch is already admitted and
      // its whole allocation is reserved by the caller. It is not a measured
      // terminal source and cannot be used by final acceptance or a new wave.
      assert.equal(
        status.runId,
        role.runId,
        "active usage native run mismatch",
      );
      assert.ok(
        [boot.workerSessionId, workerFile].includes(status.sessionId),
        "active usage native owner mismatch",
      );
      assert.equal(status.cwd, boot.cwd, "active usage native cwd mismatch");
      assert.ok(
        ["queued", "running"].includes(status.state),
        "active usage lifecycle must be reconciled",
      );
      continue;
    }
    const hosted =
      role.hostedWorkflow && !Object.hasOwn(status, "processTerminal");
    const hostedProof = hosted
      ? readNativeTerminal(
          role,
          [boot.workerSessionId, workerFile],
          () => statusBytes,
        )?.hostedTerminal
      : null;
    if (hosted) {
      assert.equal(
        role.hostedWorkflow.pid,
        boot.processId,
        "usage hosted root is not the Worker",
      );
      assert.ok(hostedProof, "usage hosted workflow unresolved");
    }
    assert.equal(status.runId, role.runId, "usage native run mismatch");
    if (expectedRuns !== null) {
      const expected = expectedRuns.find((row) => row.runId === role.runId);
      assert.equal(expected.terminal, true, "role usage terminal not settled");
      assert.equal(
        status.state,
        expected.completion === "completed" ? "complete" : expected.completion,
        "role usage completion changed",
      );
      if (hosted) {
        assert.deepEqual(
          hostedProof,
          expected.hostedTerminal,
          "role usage hosted settlement changed",
        );
      } else {
        const proof = status.processTerminal;
        assert.deepEqual(
          proof && {
            version: proof.version,
            state: proof.state,
            runId: proof.runId,
            runnerProcessInstanceId: proof.runnerProcessInstanceId,
          },
          expected.processTerminal,
          "role usage process proof changed",
        );
      }
    }
    assert.ok(
      [boot.workerSessionId, workerFile].includes(status.sessionId),
      "usage native owner mismatch",
    );
    assert.ok(
      ["complete", "failed", "stopped"].includes(status.state),
      "usage native lifecycle unknown",
    );
    if (!hosted) {
      assert.equal(
        status.processTerminal?.version,
        1,
        "usage native terminal version missing",
      );
      assert.equal(
        status.processTerminal.runId,
        role.runId,
        "usage terminal run mismatch",
      );
      assert.equal(
        status.processTerminal.state,
        "observed",
        "usage native terminal missing",
      );
      assert.match(
        status.processTerminal.runnerProcessInstanceId,
        idPattern,
        "usage native process identity missing",
      );
    }
    assert.equal(
      status.steps?.length,
      role.members.length,
      "usage native member count mismatch",
    );
    // ponytail: linear lookup within at most 64 members; index if that cap grows.
    const selected = new Set();
    for (const member of role.members) {
      const step =
        role.mode === "wave" || status.workflow
          ? status.steps.find((row) => row.workflowKey === member.key)
          : status.steps[0];
      assert.ok(
        step && !selected.has(step),
        "usage member identity missing or reused",
      );
      selected.add(step);
      assert.equal(step.agent, member.role, "usage native member mismatch");
      assert.ok(
        ["complete", "completed", "failed", "stopped", "rejected"].includes(
          step.status,
        ),
        "usage child lifecycle unknown",
      );
      assert.ok(
        step.children === undefined ||
          (Array.isArray(step.children) && step.children.length === 0),
        "nested native usage inventory unsupported",
      );
      inside(sessionDir, step.sessionFile);
      const measured = measureSessionBytes(
        read(step.sessionFile, 8 * 1024 * 1024),
      );
      sources.push({
        kind: "leaf",
        runId: role.runId,
        key: member.key,
        status: step.status,
        maxTokens: member.maxTokens,
        sessionFile: step.sessionFile,
        ...measured,
      });
    }
  }
  for (const review of reviews) {
    assert.ok(!runs.has(review.runId), "review reuses native usage run");
    runs.add(review.runId);
    for (const row of review.reports)
      sources.push({
        kind: "review",
        maxTokens: row.maxTokens,
        runId: row.runId,
        sessionFile: row.sessionFile,
        sessionId: row.sessionId,
        usage: row.usage,
      });
  }
  assert.ok(
    sources.length <= contract.policy.maxRoleSpawnsPerTask + 1,
    "usage source inventory exceeds task scope",
  );
  assert.equal(
    new Set(sources.map((row) => row.sessionId)).size,
    sources.length,
    "usage session identity reused",
  );
  assert.equal(
    new Set(sources.map((row) => row.sessionFile)).size,
    sources.length,
    "usage session file reused",
  );
  // Closed leaf/review bytes already charged at an earlier checkpoint cannot
  // be replaced by a smaller transcript. New sources still require full proof.
  for (const old of [
    ...(previous?.sources ?? []),
    ...(workerCheckpoint?.sources ?? []),
  ]) {
    if (old.kind === "worker") continue; // Worker is append-only, checked above.
    const current = sources.find(
      (row) =>
        row.sessionId === old.sessionId && row.sessionFile === old.sessionFile,
    );
    assert.deepEqual(
      current,
      old,
      "previously measured session changed or disappeared",
    );
  }
  const totals = totalUsage(sources);
  context.assertOwner();
  return {
    schemaVersion: "teams-execution-usage/1",
    executionId: contract.identity.executionId,
    contractDigest: digest(contract),
    sources,
    totals,
    spawnCount: sources.filter((source) => source.kind !== "worker").length,
    reservedTokens: reservedUsage(sources),
    acceptance: "not-assessed",
  };
}

// Read-only reconciliation of a CLOSED previous attempt. Source freshness is
// irrelevant to historical cost, but owner/run/session/terminal identities are not.
export function measureClosedExecutionUsage(context) {
  context.assertOwner();
  const { mailbox, contract } = context;
  if (!fs.existsSync(path.join(mailbox.root, "receipts/boot.json"))) {
    const execution = context.execution;
    const bootstrap = mailbox.readJson("bootstrap.json");
    // reserve starts at revision zero; launch must CAS to SPAWNING before any effect.
    assert.ok(
      execution.state === "CANCELLED" &&
        execution.revision === 1 &&
        !execution.paneId &&
        !execution.workerSessionId &&
        mailbox.listEvents().length === 0 &&
        bootstrap.controller,
      "previous Worker usage missing; only a proven never-launched reservation has zero cost",
    );
    return {
      schemaVersion: "teams-execution-usage/1",
      executionId: contract.identity.executionId,
      contractDigest: digest(contract),
      sources: [],
      totals: totalUsage([]),
      spawnCount: 0,
      reservedTokens: 0,
      acceptance: "not-assessed",
    };
  }
  const boot = mailbox.readJson("receipts/boot.json");
  context.assertStopped(boot);
  const roles = readRoleLifecycle(mailbox, contract, boot.workerSessionId);
  assert.ok(
    roles.every((role) => role.runId && role.asyncDir),
    "previous execution has unknown role usage",
  );
  const owners = [boot.workerSessionId, boot.workerSessionFile];
  let retainedRead = null;
  if (fs.existsSync(path.join(mailbox.root, "integration/receipt.json"))) {
    const receipt = mailbox.readJson("integration/receipt.json", 1024 * 1024);
    const intent = mailbox.readJson("integration/intent.json");
    const native = mailbox.readJson("integration/native.json", 1024 * 1024);
    assert.equal(receipt.schemaVersion, "teams-integration-rehearsal/1");
    assert.equal(
      intent.contractDigest,
      digest(contract),
      "historical capture contract changed",
    );
    assert.equal(
      intent.executionId,
      contract.identity.executionId,
      "historical capture execution changed",
    );
    assert.equal(
      intent.ownerSessionId,
      context.ownerSessionId,
      "historical capture owner changed",
    );
    assert.equal(
      receipt.inputDigest,
      digest(intent),
      "historical capture intent changed",
    );
    assert.equal(
      receipt.nativeDigest,
      digest(native),
      "historical capture inventory changed",
    );
    assert.deepEqual(
      receipt.captures,
      native.captures,
      "historical captures changed",
    );
    retainedRead = (origin, limit) => {
      const matches = native.captures.filter((row) => row.origin === origin);
      assert.equal(
        matches.length,
        1,
        "historical usage capture missing or duplicated",
      );
      const saved = matches[0];
      assert.match(saved.saved, /^captures\/\d+\.bin$/);
      const bytes = readEvidenceBytes(
        path.join(mailbox.root, "integration", saved.saved),
        limit,
      );
      assert.equal(
        bytesDigest(bytes),
        saved.sha256,
        "historical usage bytes changed",
      );
      return bytes;
    };
  }
  const statuses = new Map(
    roles.map((role) => [
      path.join(role.asyncDir, "status.json"),
      retainedRead
        ? retainedRead(path.join(role.asyncDir, "status.json"), 1024 * 1024)
        : readNativeTerminalBytes(
            mailbox,
            role,
            owners,
            `role-${role.launchId}`,
          ).bytes,
    ]),
  );
  const readNative = (origin, limit) =>
    statuses.get(origin) ?? (retainedRead ?? readEvidenceBytes)(origin, limit);
  const reviews = [];
  let reviewBytes = 0;
  const lifecycle = readReviewLifecycle(
    mailbox,
    contract,
    context.ownerSessionId,
    (launch, owners, read) => {
      const statusBytes =
        read === readEvidenceBytes
          ? readNativeTerminalBytes(
              mailbox,
              launch,
              owners,
              `review-${launch.key}`,
            ).bytes
          : read(path.join(launch.asyncDir, "status.json"));
      const proof = readNativeTerminal(launch, owners, () => statusBytes);
      assert.ok(proof, "previous review lifecycle unresolved");
      const status = parsed(statusBytes);
      const plan = mailbox.readJson(`${launch.dir}/plan.json`);
      const request = mailbox.readJson(
        "integration/review-request.json",
        1024 * 1024,
      );
      assert.equal(
        digest(request.subject),
        request.digest,
        "historical review request changed",
      );
      assert.equal(
        request.digest,
        plan.requestDigest,
        "historical review request mismatch",
      );
      assert.deepEqual(
        request.subject.identity,
        contract.identity,
        "historical review identity mismatch",
      );
      assert.equal(
        request.subject.cwd,
        path.join(mailbox.root, "integration/repo"),
        "historical review cwd mismatch",
      );
      assert.equal(
        status.cwd,
        request.subject.cwd,
        "historical review run cwd mismatch",
      );
      const reports =
        proof.processTerminal?.state === "not-started"
          ? []
          : status.steps.map((step) => {
              inside(plan.sessionDir, step.sessionFile);
              const bytes = read(step.sessionFile, 8 * 1024 * 1024);
              reviewBytes += bytes.length;
              assert.ok(
                reviewBytes <= 64 * 1024 * 1024,
                "previous review usage corpus too large",
              );
              const measured = measureSessionBytes(bytes);
              assert.equal(
                measured.cwd,
                request.subject.cwd,
                "historical review session cwd mismatch",
              );
              const member = plan.wave.runs.find(
                (row) => row.key === step.workflowKey,
              );
              return {
                runId: step.runId,
                sessionFile: step.sessionFile,
                maxTokens: member.maxTokens,
                ...measured,
              };
            });
      const intent = mailbox.readJson(`${launch.dir}/launch-intent.json`);
      assert.equal(
        digest(intent.usageAdmission),
        intent.usageAdmissionDigest,
        "previous review usage admission changed",
      );
      reviews.push({
        runId: launch.runId,
        reports,
        usageAdmission: intent.usageAdmission,
      });
      return proof;
    },
  );
  assert.ok(
    lifecycle.every((row) => row.terminal),
    "previous review usage unavailable",
  );
  return measureExecutionUsage(
    { ...context, result: { childRunRefs: roles.map((role) => role.runId) } },
    { readNative, reviews },
  );
}

export function reviewUsageAdmission(
  context,
  plan,
  usage,
  { checkpointOnly = false } = {},
) {
  const bootstrap = context.mailbox.readJson("bootstrap.json");
  assert.ok(
    Object.hasOwn(bootstrap, "priorExecutionId"),
    "cross-execution usage history unavailable; budget must not reset",
  );
  let prior = null;
  if (bootstrap.priorExecutionId !== null) {
    assert.ok(
      bootstrap.priorUsageDigest,
      "cross-execution usage history unavailable; budget must not reset",
    );
    prior = context.mailbox.readJson("receipts/prior-usage.json", 1024 * 1024);
    assert.equal(
      digest(prior),
      bootstrap.priorUsageDigest,
      "prior execution usage changed",
    );
    assert.equal(prior.schemaVersion, "teams-execution-usage/1");
    assert.equal(
      prior.executionId,
      bootstrap.priorExecutionId,
      "prior usage execution mismatch",
    );
    assert.notEqual(
      prior.executionId,
      usage.executionId,
      "usage history cycle",
    );
    assert.deepEqual(
      totalUsage(prior.sources),
      prior.totals,
      "prior usage totals changed",
    );
    assert.equal(
      prior.spawnCount,
      prior.sources.filter((source) => source.kind !== "worker").length,
      "prior spawn inventory changed",
    );
    assert.equal(
      prior.reservedTokens,
      reservedUsage(prior.sources),
      "prior allocations changed",
    );
  }
  assert.equal(usage.schemaVersion, "teams-execution-usage/1");
  assert.equal(usage.executionId, context.contract.identity.executionId);
  assert.equal(usage.contractDigest, digest(context.contract));
  assert.deepEqual(
    totalUsage(usage.sources),
    usage.totals,
    "usage totals changed",
  );
  assert.equal(
    usage.spawnCount,
    usage.sources.filter((source) => source.kind !== "worker").length,
    "usage spawn count changed",
  );
  assert.equal(
    usage.reservedTokens,
    reservedUsage(usage.sources),
    "usage allocations changed",
  );
  const sources = [...(prior?.sources ?? []), ...usage.sources];
  assert.equal(
    new Set(sources.map((row) => row.sessionId)).size,
    sources.length,
    "session reused across executions",
  );
  assert.equal(
    new Set(sources.map((row) => row.sessionFile)).size,
    sources.length,
    "session file reused across executions",
  );
  for (const source of sources.filter((row) => row.kind !== "worker"))
    assert.ok(
      Number.isSafeInteger(source.maxTokens) &&
        source.maxTokens > 0 &&
        (usesSharedTaskBudget(context.contract) ||
          source.usage.total <= source.maxTokens),
      "actual leaf usage exceeds member budget",
    );
  const sharedPool = assertTaskBudgetUsage(context, usage.sources);
  if (sharedPool)
    assert.equal(
      sharedPool.priorTokens,
      prior?.totals.total ?? 0,
      "pool historical usage changed",
    );
  const taskTotals = totalUsage(sources);
  const nextSpawns = plan.members?.length ?? plan.children?.length ?? 0;
  assert.ok(
    (prior?.spawnCount ?? 0) + usage.spawnCount + nextSpawns <=
      context.contract.policy.maxRoleSpawnsPerTask,
    "cumulative task spawn budget exhausted",
  );
  const allocated =
    (prior?.reservedTokens ?? 0) + usage.reservedTokens + plan.reservedTokens;
  assert.ok(
    Number.isSafeInteger(allocated) &&
      (sharedPool || allocated <= context.contract.policy.maxTaskTokens),
    "cumulative task allocations exhausted",
  );
  assert.ok(
    Number.isSafeInteger(plan.reservedTokens) &&
      (checkpointOnly ? plan.reservedTokens === 0 : plan.reservedTokens > 0) &&
      Number.isSafeInteger(taskTotals.total + plan.reservedTokens) &&
      (sharedPool
        ? taskTotals.total <= context.contract.policy.maxTaskTokens
        : taskTotals.total + plan.reservedTokens <=
          context.contract.policy.maxTaskTokens),
    "actual task usage plus new reservation exceeds budget",
  );
  return {
    ...usage,
    taskTotals,
    nextReservation: plan.reservedTokens,
    maxTaskTokens: context.contract.policy.maxTaskTokens,
  };
}
