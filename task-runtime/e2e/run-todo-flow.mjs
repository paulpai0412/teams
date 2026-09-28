// One prepared Todo E2E through the public Pi RPC entrypoint. No Goal projection,
// direct TaskOrchestrator construction, Task redispatch, dependency patch or acceptance claim.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { inspectWorktreeBase } from "../role-wave.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { bytesDigest, digest } from "../contracts.mjs";
import { readClosedExecutionUsage } from "../orchestrator.mjs";
import { measureSessionBytes } from "../task-usage.mjs";
import { publicPackage, modelId, readTaskModels } from "../capabilities.mjs";
import { taskToolParameters } from "../task-tool-inputs.mjs";
import { isInputRejection } from "../input-rejection.mjs";
import { isCompletedCheckFailure } from "../check-failure.mjs";
import { isCompletedIntegrationConflict } from "../integration-conflict.mjs";
import { RuntimeLedger } from "../ledger.mjs";
import { createTargetConfirmationBridge } from "./target-confirmation-bridge.mjs";

// The observer may retain diagnosis, not waive acceptance. A later Goal/prose
// claim clears no failure; only a real accepted same-Task successor can do so.
function acceptedRepairProof(receipt, call, failures) {
  assert.equal(receipt.executionId, call.input.execution_id);
  assert.ok(
    ["teams-task-acceptance/2", "teams-task-acceptance/3"].includes(
      receipt.schemaVersion,
    ),
  );
  const root = path.dirname(path.dirname(receipt.receiptRef));
  const runtimeRoot = path.resolve(root, "../../../..");
  const sealed = parsed(
    bounded(receipt.receiptRef, 1024 * 1024),
    "acceptance receipt",
  );
  assert.deepEqual(
    sealed,
    receipt,
    "accepted repair reply differs from sealed receipt",
  );
  const ledger = new RuntimeLedger(path.join(runtimeRoot, "ledger.sqlite"), {
    readOnly: true,
  });
  try {
    const current = ledger.getExecution(receipt.executionId);
    const recorded = ledger.getAcceptance(receipt.executionId);
    assert.equal(current.state, "ACCEPTED");
    // Acceptance precedes Goal-X readback; its reservation may still be open.
    // This proves a repaired candidate, not Goal completion or another dispatch.
    assert.equal(current.unresolvedRunCount, 0);
    assert.equal(
      root,
      path.join(
        runtimeRoot,
        "projects",
        current.projectId,
        "executions",
        current.executionId,
      ),
    );
    for (const key of [
      "acceptanceId",
      "executionId",
      "requestDigest",
      "resultDigest",
      "sourceDigest",
      "decision",
      "receiptRef",
    ])
      assert.equal(
        recorded[key],
        receipt[key],
        "acceptance ledger binding changed",
      );
    assert.equal(receipt.decision, "accepted");
    const bootBytes = bounded(path.join(root, "bootstrap.json"), 65536);
    assert.equal(bytesDigest(bootBytes), receipt.finalEvidence.bootstrapDigest);
    const boot = parsed(bootBytes, "Worker bootstrap");
    if (!boot.repairIntentDigest) return null;
    const intent = parsed(
      bounded(path.join(root, "receipts/repair-intent.json"), 1024 * 1024),
      "repair intent",
    );
    assert.equal(digest(intent), boot.repairIntentDigest);
    const previous = ledger.getExecution(intent.previousExecutionId);
    for (const key of [
      "projectId",
      "goalId",
      "taskId",
      "ownerSessionId",
      "ownerEpoch",
    ])
      assert.equal(
        previous[key],
        current[key],
        "accepted revision crossed original Task/owner",
      );
    assert.equal(current.taskRevision, previous.taskRevision + 1);
    assert.ok(
      ["CANCELLED", "FAILED"].includes(previous.state) &&
        !previous.reservationOpen &&
        previous.unresolvedRunCount === 0,
    );
    assert.equal(intent.previousResultDigest, previous.resultDigest);
    assert.equal(intent.previousRequestDigest, previous.requestDigest);
    const failure = failures.find(
      (item) =>
        item.executionId === previous.executionId &&
        item.receiptRef === intent.failureReceiptRef &&
        (item.receiptSha256 ?? item.receiptDigest) ===
          intent.failureReceiptSha256,
    );
    if (!failure) return null;
    assert.equal(
      bytesDigest(bounded(failure.receiptRef, 8 * 1024 * 1024)),
      intent.failureReceiptSha256,
    );
    return {
      executionId: current.executionId,
      previousExecutionId: previous.executionId,
      failureReceiptRef: failure.receiptRef,
      failureReceiptSha256: intent.failureReceiptSha256,
      acceptanceReceiptRef: receipt.receiptRef,
      acceptanceReceiptSha256: bytesDigest(
        bounded(receipt.receiptRef, 1024 * 1024),
      ),
    };
  } finally {
    ledger.close();
  }
}

function unresolvedCandidateFailure(report) {
  const unresolved = (item) =>
    !(report.acceptedRepairs ?? []).some(
      (proof) =>
        proof.previousExecutionId === item.executionId &&
        proof.failureReceiptRef === item.receiptRef &&
        proof.failureReceiptSha256 ===
          (item.receiptSha256 ?? item.receiptDigest),
    );
  if (report.checkFailures?.some(unresolved)) return "check-failed";
  if (report.integrationConflicts?.some(unresolved))
    return "integration-conflict";
  return null;
}

const MAX_BYTES = 64 * 1024 * 1024;
const parts = ["input", "output", "cacheRead", "cacheWrite"];
function parsed(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (cause) {
    throw new Error(`Invalid ${label} JSON`, { cause });
  }
}
function bounded(file, maximum = MAX_BYTES) {
  assert.equal(fs.realpathSync(file), file, "canonical input file required");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= maximum,
      "bounded regular input required",
    );
    const bytes = Buffer.alloc(stat.size);
    assert.equal(
      fs.readSync(fd, bytes, 0, bytes.length, 0),
      bytes.length,
      "incomplete input snapshot",
    );
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

// Only the disposable source repository is configured, before its real Goal exists.
// Native worktrees still require clean Git status; no product change is ignored.
export function prepareTodoWorkspace(cwd) {
  assert.equal(fs.realpathSync(cwd), cwd, "canonical Todo source required");
  const gitDir = path.join(cwd, ".git");
  assert.ok(
    fs.lstatSync(gitDir).isDirectory() && fs.realpathSync(gitDir) === gitDir,
    "fresh source repository required, not a worktree",
  );
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(head.status, 0, "Todo base unavailable");
  inspectWorktreeBase(cwd, head.stdout.trim());
  const paths = [".pi/goals", ".pi/.goals-pool-snapshot.json"];
  for (const name of paths)
    assert.ok(
      !fs.lstatSync(path.join(cwd, name), { throwIfNoEntry: false }),
      "prepare Goal exclusions before creating a Goal; do not retrofit old runs",
    );
  const tracked = spawnSync(
    "git",
    ["-C", cwd, "ls-files", "-z", "--", ...paths],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.ok(
    tracked.status === 0 && tracked.stdout === "",
    "Goal control files must not be tracked product files",
  );
  const info = path.join(gitDir, "info");
  assert.equal(
    fs.realpathSync(info),
    info,
    "canonical Git info directory required",
  );
  const file = path.join(info, "exclude");
  const before = fs.lstatSync(file, { throwIfNoEntry: false })
    ? bounded(file, 65536).toString("utf8")
    : "";
  const rules = ["/.pi/goals/", "/.pi/.goals-pool-snapshot.json"];
  const missing = rules.filter((rule) => !before.split(/\r?\n/).includes(rule));
  if (missing.length)
    fs.appendFileSync(file, `\n${missing.join("\n")}\n`, { mode: 0o600 });
  return {
    cwd,
    baseCommit: head.stdout.trim(),
    rules,
    scope: "source-repository-only",
  };
}

// The anchor is an owner-selected approval entry, not the launch time. Charge all
// subsequent preparation/audit usage, including cache, nested tools and summaries.
export function parentUsage(file, authorizationEntryId, previous) {
  assert.equal(fs.realpathSync(file), file, "canonical input file required");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  const fullHash = createHash("sha256");
  const prefixHash = previous ? createHash("sha256") : null;
  const lines = [];
  let projectedBytes = 0,
    lineCount = 0,
    matches = 0,
    anchor,
    anchorIndex;
  let snapshotBytes = 0;
  // Retain only the original header and the COMPLETE authorized window. The
  // lifetime prefix is parsed/hashed, not charged again or retained in memory.
  // Existing 64 MiB bounds still apply to each record and the charged window.
  function consume(line) {
    if (!line.trim()) return;
    assert.ok(
      Buffer.byteLength(line) <= MAX_BYTES,
      "bounded parent record required",
    );
    const entry = parsed(line, "parent session");
    if (entry.id === authorizationEntryId) {
      matches++;
      if (matches === 1) {
        anchor = entry;
        anchorIndex = lineCount;
      }
    }
    if (lineCount === 0 || matches > 0) {
      projectedBytes += Buffer.byteLength(line) + (lines.length ? 1 : 0);
      assert.ok(
        projectedBytes <= MAX_BYTES,
        "bounded parent accounting window required",
      );
      lines.push(line);
    }
    lineCount++;
  }
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() && Number.isSafeInteger(stat.size),
      "regular parent input required",
    );
    if (previous)
      assert.ok(stat.size >= previous.bytes, "parent transcript shrank");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0,
      pending = Buffer.alloc(0);
    while (offset < stat.size) {
      const length = Math.min(chunk.length, stat.size - offset);
      assert.equal(
        fs.readSync(fd, chunk, 0, length, offset),
        length,
        "incomplete input snapshot",
      );
      const bytes = chunk.subarray(0, length);
      if (previous && offset < previous.bytes)
        prefixHash.update(
          bytes.subarray(0, Math.min(length, previous.bytes - offset)),
        );
      offset += length;
      pending = Buffer.concat([pending, bytes]);
      const end = pending.lastIndexOf(10) + 1;
      if (end) {
        const complete = pending.subarray(0, end);
        fullHash.update(complete);
        snapshotBytes += complete.length;
        for (const line of complete.toString("utf8").split("\n")) consume(line);
        pending = pending.subarray(end);
      }
      assert.ok(pending.length <= MAX_BYTES, "bounded parent record required");
    }
    // A growing parent's unfinished suffix is not a zero-cost completed record.
    // Defer it only after a verified prefix; completed malformed lines still fail.
    if (pending.length && previous && stat.size > previous.bytes) {
      assert.ok(
        snapshotBytes >= previous.bytes,
        "parent transcript append crossed confirmed line",
      );
    } else if (pending.length) {
      consume(pending.toString("utf8"));
      fullHash.update(pending);
      snapshotBytes += pending.length;
    }
    if (previous)
      assert.equal(
        prefixHash.digest("hex"),
        previous.digest,
        "parent transcript prefix changed",
      );
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(matches, 1, "unique parent authorization entry required");
  assert.ok(
    anchorIndex > 0 &&
      anchor.type === "message" &&
      (anchor.message?.role === "user" ||
        (anchor.message?.role === "toolResult" &&
          anchor.message.toolName === "ask_user" &&
          anchor.message.isError !== true)),
    "authorization must reference a user/ask_user entry",
  );
  const measured = measureSessionBytes(Buffer.from(lines.join("\n")), {
    allowEmpty: true,
  });
  return {
    file,
    authorizationEntryId,
    sessionId: measured.sessionId,
    usage: measured.usage,
    bytes: snapshotBytes,
    digest: fullHash.digest("hex"),
  };
}

function total(value) {
  assert.ok(
    parts.every((key) => Number.isSafeInteger(value?.[key]) && value[key] >= 0),
    "unknown native usage",
  );
  const sum = parts.reduce((n, key) => n + value[key], 0);
  assert.ok(
    Number.isSafeInteger(sum) && sum === value.total,
    "inconsistent native usage",
  );
  return sum;
}

export function assertBudget(
  parent,
  rootTokens,
  taskTokenReservation,
  maxTokens,
  historicalTokens = 0,
) {
  for (const value of [
    rootTokens,
    taskTokenReservation,
    maxTokens,
    historicalTokens,
  ])
    assert.ok(
      Number.isSafeInteger(value) && value >= 0,
      "explicit safe token limits required",
    );
  const committed =
    historicalTokens + parent.usage.total + rootTokens + taskTokenReservation;
  assert.ok(
    Number.isSafeInteger(committed) && maxTokens > 0 && committed < maxTokens,
    "aggregate budget exhausted (history + parent + L0 + reserved Task Pi allocations)",
  );
  return committed;
}

// One explicit input for the CLI, shared by single- and multi-Task attempts.
// The campaign anchor/ceiling belong to the budget, not to a new group's prompt.
export function loadAttemptInputs(file, cwd, parentSessionFile) {
  const bytes = bounded(file, 1024 * 1024);
  const input = parsed(bytes, "E2E attempt input");
  const budget = input.budget;
  assert.ok(
    budget && Number.isSafeInteger(budget.maxTokens) && budget.maxTokens > 0,
    "explicit cumulative budget required",
  );
  assert.equal(
    budget.parent?.file,
    parentSessionFile,
    "budget parent must match the current parent session",
  );
  assert.ok(
    typeof budget.parent.authorizationEntryId === "string" &&
      budget.parent.authorizationEntryId,
    "original campaign authorization anchor required",
  );
  assert.ok(
    Array.isArray(budget.history),
    "explicit historical session inventory required, even when empty",
  );
  if (input.mode === "request-driven") {
    const reservation = input.planningTaskCeiling;
    assert.ok(
      Number.isSafeInteger(reservation) && reservation > 0,
      "explicit aggregate Task planning allocation required",
    );
    const requestBytes = bounded(input.requestFile, 65536);
    assert.ok(
      requestBytes.toString("utf8").trim(),
      "nonempty original request required",
    );
    const authorization = input.authorization;
    assert.equal(
      authorization?.mode,
      "task-pi",
      "request-driven Task mode requires owner authorization",
    );
    assert.equal(
      authorization.goalAction,
      "create",
      "fresh Goal creation must be approved explicitly",
    );
    assert.equal(
      authorization.parentAuthorizationEntryId,
      budget.parent.authorizationEntryId,
    );
    assert.equal(authorization.parentSessionFile, parentSessionFile);
    assert.equal(authorization.unknownUsage, 0, "unreconciled campaign usage");
    assert.equal(
      authorization.openReservations,
      0,
      "open campaign reservations",
    );
    assert.ok(
      authorization.historyProvenance?.file,
      "campaign inventory source required",
    );
    assert.equal(
      bytesDigest(bounded(authorization.historyProvenance.file, 1024 * 1024)),
      authorization.historyProvenance.sha256,
      "campaign inventory evidence changed",
    );
    assert.ok(
      !input.specPaths && !input.solutionPatch,
      "request-driven input cannot supply an answer",
    );
    return {
      parentSessionFile,
      authorizationEntryId: budget.parent.authorizationEntryId,
      maxTokens: budget.maxTokens,
      taskTokenReservation: reservation,
      historicalSessions: budget.history,
      historicalExecutions: budget.executions ?? [],
      authorization,
      preparation: {
        mode: "request-driven",
        requestFile: input.requestFile,
        requestSha256: bytesDigest(requestBytes),
        inputFile: file,
        inputSha256: bytesDigest(bytes),
        noTaskSpecsProvided: true,
        noSolutionPatchProvided: true,
      },
    };
  }
  assert.ok(
    input.mode === undefined || input.mode === "prepared-spec",
    "unknown attempt mode",
  );
  assert.ok(
    Array.isArray(input.specPaths) &&
      input.specPaths.length > 0 &&
      input.specPaths.length <= 64,
    "1..64 actual Task spec paths required",
  );
  const taskIds = new Set();
  let taskTokenReservation = 0;
  const specs = input.specPaths.map((specPath) => {
    const specBytes = bounded(specPath, 65536);
    const spec = parsed(specBytes, "Task spec");
    assert.equal(
      spec.workspace?.sourceRoot,
      cwd,
      "Task spec sourceRoot differs from attempt workspace",
    );
    assert.equal(spec.goalId, "pending", "fresh unbound Task spec required");
    assert.ok(
      typeof spec.taskId === "string" &&
        spec.taskId &&
        !taskIds.has(spec.taskId),
      "distinct Task IDs required",
    );
    taskIds.add(spec.taskId);
    assert.equal(spec.taskRevision, 1, "fresh Task revision required");
    const tokens = spec.policy?.maxTaskTokens;
    assert.ok(
      Number.isSafeInteger(tokens) && tokens > 0,
      "explicit safe Task ceiling required",
    );
    taskTokenReservation += tokens;
    assert.ok(
      Number.isSafeInteger(taskTokenReservation),
      "aggregate Task reservation overflow",
    );
    return {
      file: specPath,
      sha256: bytesDigest(specBytes),
      taskId: spec.taskId,
      maxTaskTokens: tokens,
    };
  });
  return {
    parentSessionFile,
    authorizationEntryId: budget.parent.authorizationEntryId,
    maxTokens: budget.maxTokens,
    taskTokenReservation,
    historicalSessions: budget.history,
    historicalExecutions: budget.executions ?? [],
    preparation: { inputFile: file, inputSha256: bytesDigest(bytes), specs },
  };
}

// A Pi parent toolResult can already contain native subagent usage. Bind the
// exact native result path/run and every component before counting a separately
// supplied child session; scalar equality alone does not establish overlap.
function nestedSubagentLinks(bytes, parentId, afterEntryId = null) {
  const links = [];
  let unbound = false;
  let withinWindow = afterEntryId === null;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parsed(line, "historical session");
    if (!withinWindow) {
      if (entry.id === afterEntryId) withinWindow = true;
      continue;
    }
    const message = entry.message;
    if (
      message?.role !== "toolResult" ||
      message.toolName !== "subagent" ||
      !message.usage
    )
      continue;
    const results = message.details?.results;
    if (
      !Array.isArray(results) ||
      !results.length ||
      typeof message.details?.runId !== "string"
    ) {
      unbound = true;
      continue;
    }
    const recorded = message.usage;
    if (
      results.some(
        (row) =>
          typeof row.sessionFile !== "string" ||
          !path.isAbsolute(row.sessionFile) ||
          !row.usage,
      )
    ) {
      unbound = true;
      continue;
    }
    const totalChild = Object.fromEntries(
      parts.map((key) => [
        key,
        results.reduce((n, row) => n + (row.usage[key] ?? NaN), 0),
      ]),
    );
    if (
      !parts.every(
        (key) =>
          Number.isSafeInteger(totalChild[key]) &&
          totalChild[key] >= 0 &&
          totalChild[key] === recorded[key],
      )
    ) {
      unbound = true;
      continue;
    }
    if (
      recorded.totalTokens !== parts.reduce((n, key) => n + totalChild[key], 0)
    ) {
      unbound = true;
      continue;
    }
    for (const result of results)
      links.push({
        file: result.sessionFile,
        runId: message.details.runId,
        parentId,
        usage: result.usage,
      });
  }
  return { links, unbound };
}

// Closed session snapshots only. Their inventory must cover prior parent/L0/
// Worker/leaf/review attempts, including failures. No scalar carry or reservation
// masquerades as usage. Copies with the same session identity cannot count twice.
export function historicalUsage(sessions, parentSessionId, executions = []) {
  assert.ok(
    Array.isArray(sessions) && sessions.length <= 10000,
    "bounded historical inventory required",
  );
  const ids = new Set([parentSessionId]);
  const totals = Object.fromEntries([...parts, "total"].map((key) => [key, 0]));
  const embeddedLinks = new Map();
  let unboundSubagentUsage = false;
  const sources = sessions.map((source) => {
    const bytes = bounded(source.file);
    assert.equal(
      bytesDigest(bytes),
      source.sha256,
      "historical session bytes changed",
    );
    const measured = source.authorizationEntryId
      ? parentUsage(source.file, source.authorizationEntryId)
      : measureSessionBytes(bytes, { allowEmpty: true });
    if (source.authorizationEntryId)
      assert.equal(
        measured.digest,
        source.sha256,
        "historical anchored snapshot changed",
      );
    assert.ok(
      !ids.has(measured.sessionId),
      "duplicate historical/current parent session identity",
    );
    ids.add(measured.sessionId);
    total(measured.usage);
    const nested = nestedSubagentLinks(
      bytes,
      measured.sessionId,
      source.authorizationEntryId ?? null,
    );
    unboundSubagentUsage ||= nested.unbound;
    for (const link of nested.links) {
      assert.ok(
        !embeddedLinks.has(link.file),
        "native child linked by multiple parent results",
      );
      embeddedLinks.set(link.file, link);
    }
    return { ...source, sessionId: measured.sessionId, usage: measured.usage };
  });
  assert.ok(
    !unboundSubagentUsage || (sessions.length === 1 && executions.length === 0),
    "unbound subagent usage may overlap historical sources; evidence unknown",
  );
  const charge = (usage) => {
    for (const key of [...parts, "total"]) {
      totals[key] += usage[key];
      assert.ok(Number.isSafeInteger(totals[key]), "historical usage overflow");
    }
  };
  const countedInParent = new Map();
  for (const source of sources) {
    const link = embeddedLinks.get(source.file);
    if (link) {
      assert.notEqual(
        link.parentId,
        source.sessionId,
        "self-linked native usage",
      );
      for (const key of parts)
        assert.equal(
          source.usage[key],
          link.usage[key],
          "nested native usage differs from its source",
        );
      countedInParent.set(source.sessionId, {
        runId: link.runId,
        sessionId: link.parentId,
      });
    } else charge(source.usage);
  }
  assert.ok(
    Array.isArray(executions) && executions.length <= 10000,
    "bounded historical execution inventory required",
  );
  const executionIds = new Set();
  const nativeSessionIds = new Set();
  const executionSources = executions.map(({ runtimeRoot, executionId }) => {
    assert.ok(!executionIds.has(executionId), "duplicate historical execution");
    executionIds.add(executionId);
    const { execution, usage } = readClosedExecutionUsage(
      runtimeRoot,
      executionId,
    );
    for (const source of usage.sources) {
      assert.ok(
        !nativeSessionIds.has(source.sessionId),
        "native session identity reused across historical executions",
      );
      nativeSessionIds.add(source.sessionId);
      const previous = sources.find(
        (row) => row.sessionId === source.sessionId,
      );
      if (previous) {
        // A supplied raw snapshot may already cover this exact native session.
        // Check consistency, then count it once; a truncated snapshot is not final.
        assert.equal(
          previous.sha256,
          source.usage.sourceSha256,
          "historical/native session bytes differ",
        );
        for (const key of [...parts, "total"])
          assert.equal(
            previous.usage[key],
            source.usage[key],
            "historical/native usage differs",
          );
        continue;
      }
      assert.ok(
        !ids.has(source.sessionId),
        "historical execution reuses current parent identity",
      );
      ids.add(source.sessionId);
      total(source.usage);
      const link = embeddedLinks.get(source.sessionFile);
      if (link) {
        for (const key of parts)
          assert.equal(
            source.usage[key],
            link.usage[key],
            "nested native execution usage differs from source",
          );
        countedInParent.set(source.sessionId, {
          runId: link.runId,
          sessionId: link.parentId,
        });
      } else charge(source.usage);
      sources.push({
        file: source.sessionFile,
        sha256: source.usage.sourceSha256,
        sessionId: source.sessionId,
        usage: source.usage,
        executionId,
      });
    }
    return {
      runtimeRoot,
      executionId,
      ownerSessionId: execution.ownerSessionId,
      contractDigest: usage.contractDigest,
      sessionIds: usage.sources.map((row) => row.sessionId),
    };
  });
  return {
    sources: sources.map((row) => ({
      ...row,
      ...(countedInParent.has(row.sessionId)
        ? { countedInParent: countedInParent.get(row.sessionId) }
        : {}),
    })),
    totals,
    executions: executionSources,
  };
}

// An owner widget is a reference, not standalone cost proof. Re-read the exact
// receipt and closed native inventory without constructing another controller.
export function reconcileDrainedUsage(rows, ownerSessionId) {
  assert.ok(
    Array.isArray(rows) && rows.length <= 64,
    "bounded drain rows required",
  );
  const refs = rows.map((row) => {
    assert.equal(row.reservationOpen, false, "drain execution remains open");
    const closed = row.closedUsage;
    assert.equal(closed?.status, "measured", "closed Task usage is unknown");
    const { execution, usage } = readClosedExecutionUsage(
      closed.runtimeRoot,
      row.executionId,
    );
    assert.equal(
      execution.ownerSessionId,
      ownerSessionId,
      "drain usage owner changed",
    );
    const expectedRef = path.join(
      closed.runtimeRoot,
      "projects",
      execution.projectId,
      "executions",
      row.executionId,
      "receipts/closed-usage.json",
    );
    assert.equal(
      closed.receiptRef,
      expectedRef,
      "drain usage receipt path changed",
    );
    const receipt = parsed(bounded(expectedRef, 1024 * 1024), "closed usage");
    assert.equal(
      digest(receipt),
      closed.receiptDigest,
      "closed usage receipt changed",
    );
    assert.equal(receipt.schemaVersion, "teams-closed-usage/1");
    assert.equal(receipt.executionId, execution.executionId);
    assert.equal(receipt.ownerSessionId, ownerSessionId);
    assert.equal(receipt.ownerEpoch, execution.ownerEpoch);
    assert.equal(receipt.executionRevision, execution.revision);
    assert.deepEqual(
      receipt.usage,
      usage,
      "closed usage differs from native inventory",
    );
    return { runtimeRoot: closed.runtimeRoot, executionId: row.executionId };
  });
  return historicalUsage([], ownerSessionId, refs);
}

// The launcher attests semantic authorization; the host checks its mechanical
// source, current usage and loaded guidance. Flags such as CANARY are not a
// substitute for the owner's decision, and no answer spec is generated here.
export function buildModelAdmissionContext({
  authorization,
  parent,
  history,
  maxTokens,
  taskTokenReservation,
  preparation,
  request,
  cwd,
  command,
}) {
  assert.ok(
    authorization && preparation?.mode === "request-driven",
    "request-driven authorization required",
  );
  assert.ok(
    ["task-pi", "ordinary", "direct"].includes(authorization.mode),
    "approved execution mode required",
  );
  assert.ok(
    ["create", "resume", "none"].includes(authorization.goalAction),
    "explicit Goal authorization required",
  );
  if (authorization.mode === "task-pi")
    assert.ok(
      authorization.goalAction !== "none",
      "Task Pi needs an authorized Goal",
    );
  else
    assert.equal(
      authorization.goalAction,
      "none",
      "ordinary work cannot infer Goal authorization",
    );
  assert.ok(
    ["verify-only", "approved-integration"].includes(authorization.delivery),
    "delivery authorization required",
  );
  assert.equal(
    authorization.parentAuthorizationEntryId,
    parent.authorizationEntryId,
    "authorization anchor changed",
  );
  assert.equal(
    parent.file,
    authorization.parentSessionFile,
    "authorization source changed",
  );
  assert.equal(
    authorization.unknownUsage,
    0,
    "unknown campaign usage must be reconciled before launch",
  );
  assert.equal(
    authorization.openReservations,
    0,
    "open campaign reservation must be resolved before launch",
  );
  assert.ok(
    authorization.historyProvenance?.file,
    "campaign inventory source required",
  );
  const inventoryBytes = bounded(
    authorization.historyProvenance.file,
    1024 * 1024,
  );
  assert.equal(
    bytesDigest(inventoryBytes),
    authorization.historyProvenance.sha256,
    "campaign inventory evidence changed",
  );
  assert.match(
    preparation.sourceBase,
    /^[0-9a-f]{40,64}$/,
    "source base required",
  );
  assert.equal(
    spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10000,
    }).stdout?.trim(),
    preparation.sourceBase,
    "source base changed before model launch",
  );
  const requestBytes = bounded(preparation.requestFile, 65536);
  assert.equal(
    bytesDigest(requestBytes),
    preparation.requestSha256,
    "request source changed",
  );
  assert.equal(
    requestBytes.toString("utf8"),
    request,
    "model request differs from hashed source",
  );
  const skillIndex = command.indexOf("--skill");
  assert.ok(
    skillIndex > 0 && typeof command[skillIndex + 1] === "string",
    "selected skill was not registered for L0",
  );
  const skillFile = command[skillIndex + 1];
  const skill = bounded(skillFile, 65536);
  assert.ok(
    skill.toString("utf8").startsWith("---\nname: team-flow\n"),
    "selected team-flow skill changed",
  );
  const specFile = fileURLToPath(
    new URL("../../extensions/teams-orchestrator/SPEC.md", import.meta.url),
  );
  const spec = bounded(specFile, 65536);
  const actual = history.totals.total + parent.usage.total;
  assert.ok(
    Number.isSafeInteger(actual) && actual >= 0,
    "campaign usage unavailable",
  );
  const remaining = maxTokens - actual;
  assert.ok(
    Number.isSafeInteger(remaining) && remaining > taskTokenReservation,
    "no coordination and review headroom",
  );
  const admittedAt = new Date().toISOString();
  const context = [
    "HOST-VERIFIED ATTEMPT CONTEXT (the request above is not a prepared Task/solution):",
    `Execution mode: ${authorization.mode}; Goal action expressly approved by owner: ${authorization.goalAction}; delivery: ${authorization.delivery}. This attestation cites user/ask_user entry ${parent.authorizationEntryId} in session ${parent.sessionId}. A canary flag alone grants nothing. Do not silently switch modes if a required capability is absent.`,
    `Source: ${cwd} @ ${preparation.sourceBase}; request SHA-256 ${preparation.requestSha256}. L0 derives Task specs from the request and source. Any supplied artifact has only the authority expressly assigned by that request.`,
    `Admitted at ${admittedAt}. Campaign ceiling ${maxTokens} tokens, same anchor ${parent.authorizationEntryId}. Historical closed usage ${history.totals.total} (${history.sources.length} session sources, ${history.executions.length} closed executions); parent since anchor ${parent.usage.total} from ${parent.file} @ ${parent.digest}. Known committed actual ${actual}; remaining before this L0 and Task reservations ${remaining}. Operator attests unknown usage 0 and open reservations 0 against ${authorization.historyProvenance.file} @ ${authorization.historyProvenance.sha256}; host verifies bytes and listed sessions, not completeness of the operator's campaign membership. Missing evidence is unknown, not zero.`,
    "Full historical source/execution membership and evidence references remain in the SHA-bound campaign inventory cited above; inspect that inventory when needed. They are not duplicated in this bounded prompt. This does not omit usage, reset the accounting window or relax any admission check.",
    `Owner-approved Task planning allocation reserved by this observer: ${taskTokenReservation}, including implementation and final review; leave coordination headroom. This is a planning allocation, not a campaign-wide Task-dispatch hard cap: the present public Task runtime enforces each Task ceiling separately. Do not dispatch Task ceilings totaling more than the approved allocation. Task/role counts and allocations are yours to derive from the requirements.`,
    `Attempt deadline ${authorization.deadlineMs} ms. Follow the currently selected skill and L0 SPEC below, not an archived E2E helper. Exact original request and its interface literals must survive the Task/Worker/leaf handoff.`,
    `SELECTED SKILL ${skillFile} SHA-256 ${bytesDigest(skill)}:\n${skill.toString("utf8")}`,
    `CURRENT L0 SPEC ${specFile} SHA-256 ${bytesDigest(spec)}:\n${spec.toString("utf8")}`,
  ].join("\n\n");
  return {
    context,
    evidence: {
      mode: authorization.mode,
      goalAction: authorization.goalAction,
      delivery: authorization.delivery,
      authorizationEntryId: parent.authorizationEntryId,
      admittedAt,
      inventoryFile: authorization.historyProvenance.file,
      inventorySha256: authorization.historyProvenance.sha256,
      unknownUsage: authorization.unknownUsage,
      openReservations: authorization.openReservations,
      parentDigest: parent.digest,
      requestSha256: preparation.requestSha256,
      sourceBase: preparation.sourceBase,
      skillFile,
      skillSha256: bytesDigest(skill),
      specFile,
      specSha256: bytesDigest(spec),
      actualAtAdmission: actual,
      remainingBeforeL0: remaining,
      taskTokenReservation,
    },
  };
}

export function publicCommand(
  agentDir,
  sessionDir,
  subagentsEntry = null,
  model = readTaskModels().l0,
) {
  modelId(model);
  const extension = (name) => {
    if (name === "pi-subagents" && subagentsEntry) {
      const selected = publicPackage(subagentsEntry);
      assert.equal(
        selected.manifest.name,
        name,
        "public subagents package required",
      );
      assert.equal(
        fs.realpathSync(subagentsEntry),
        fs.realpathSync(
          path.resolve(
            path.dirname(selected.file),
            selected.manifest.pi.extensions[0],
          ),
        ),
        "public subagents extension entry required",
      );
      return fs.realpathSync(subagentsEntry);
    }
    const root = path.join(agentDir, "npm", "node_modules", name);
    const manifest = parsed(
      bounded(path.join(root, "package.json"), 65536),
      "package manifest",
    );
    assert.ok(
      typeof manifest.pi?.extensions?.[0] === "string",
      "public package extension missing",
    );
    return fs.realpathSync(path.resolve(root, manifest.pi.extensions[0]));
  };
  const providerExtensions =
    model.startsWith("antigravity/") &&
    fs.existsSync(path.join(agentDir, "npm", "node_modules", "pi-antigravity"))
      ? ["--extension", extension("pi-antigravity")]
      : [];
  return [
    path.join(path.dirname(process.execPath), "pi"),
    "--model",
    model,
    "--mode",
    "rpc",
    "--no-extensions",
    "--extension",
    extension("pi-goal-x"),
    "--extension",
    extension("pi-subagents"),
    "--extension",
    fileURLToPath(
      new URL("../../extensions/teams-orchestrator/index.mjs", import.meta.url),
    ),
    ...providerExtensions,
    "--no-context-files",
    "--no-skills",
    "--skill",
    fs.realpathSync(path.join(agentDir, "skills", "team-flow", "SKILL.md")),
    "--no-prompt-templates",
    "--session-dir",
    sessionDir,
  ];
}

export async function runRpcAttempt({
  command,
  cwd,
  outputRoot,
  prompt,
  parentSessionFile,
  authorizationEntryId,
  maxTokens,
  taskTokenReservation,
  historicalSessions = [],
  historicalExecutions = [],
  preparation = null,
  authorization = null,
  resumeUndispatched = null,
  deadlineMs,
  env = process.env,
  sampleMs = 1000,
  killGraceMs = 5000,
  statsTimeoutMs = 5000,
  drainTimeoutMs = 0,
  expectedModel = readTaskModels().l0,
  targetConfirm = null,
}) {
  modelId(expectedModel);
  assert.ok(
    targetConfirm === null ||
      (typeof targetConfirm === "function" &&
        authorization?.delivery === "approved-integration"),
    "interactive relay requires explicit approved-integration authority",
  );
  // Never silently turn on confirmation or canary permission, even for tests.
  assert.equal(
    env.PI_GOAL_AUTO_CONFIRM,
    "1",
    "RPC Goal task confirmation requires explicitly approved PI_GOAL_AUTO_CONFIRM=1",
  );
  assert.equal(env.TEAMS_E2E_CANARY, "1", "explicit canary opt-in required");
  assert.ok(
    Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= 5_400_000,
    "bounded deadline required",
  );
  assert.ok(
    Number.isSafeInteger(drainTimeoutMs) &&
      drainTimeoutMs >= 0 &&
      drainTimeoutMs <= 35_000,
    "bounded owner drain timeout required",
  );
  if (drainTimeoutMs)
    assert.ok(
      deadlineMs > drainTimeoutMs + 2 * killGraceMs,
      "deadline must include cleanup reserve",
    );
  assert.ok(
    typeof prompt === "string" &&
      Buffer.byteLength(prompt) <= 65536 &&
      prompt.trim(),
    "bounded prepared prompt required",
  );
  assert.equal(fs.realpathSync(cwd), cwd, "canonical workspace required");
  let resumed = null;
  if (resumeUndispatched) {
    const { observationFile, sessionSha256 } = resumeUndispatched;
    resumed = parsed(bounded(observationFile), "previous observation");
    assert.equal(resumed.cwd, cwd, "resume workspace mismatch");
    assert.equal(
      resumed.processReaped,
      true,
      "previous owner must have exited",
    );
    assert.equal(
      resumed.taskDispatchAttempted ?? resumed.taskDispatchStarted,
      false,
      "dispatched executions require owner recovery",
    );
    assert.deepEqual(
      resumed.executionIds,
      [],
      "resume cannot replay executions",
    );
    assert.equal(
      resumed.taskDrain?.settled,
      true,
      "previous drain must be settled",
    );
    assert.deepEqual(
      resumed.taskDrain.rows,
      [],
      "unexpected previous executions",
    );
    assert.equal(
      resumed.goal?.status,
      "paused",
      "only paused undispatched Goals can resume",
    );
    assert.equal(resumed.expectedModel, expectedModel, "resume model mismatch");
    const sessionBytes = bounded(resumed.sessionFile);
    assert.equal(
      bytesDigest(sessionBytes),
      sessionSha256,
      "resume session changed",
    );
    assert.equal(
      measureSessionBytes(sessionBytes).sessionId,
      resumed.sessionId,
    );
    assert.equal(command.filter((arg) => arg === "--session").length, 1);
    assert.equal(
      command[command.indexOf("--session") + 1],
      resumed.sessionFile,
    );
    assert.ok(
      !historicalSessions.some((source) => source.file === resumed.sessionFile),
      "resumed session is counted in live cumulative stats, not history",
    );
  } else {
    assert.ok(
      !fs.existsSync(path.join(cwd, ".pi", "goals")),
      "fresh workspace without existing Goals required",
    );
  }
  assert.ok(
    path.isAbsolute(outputRoot),
    "absolute new evidence directory required",
  );
  assert.ok(
    path.relative(cwd, outputRoot).startsWith(`..${path.sep}`),
    "evidence must be outside product workspace",
  );
  let parent = parentUsage(parentSessionFile, authorizationEntryId);
  const history = historicalUsage(
    historicalSessions,
    parent.sessionId,
    historicalExecutions,
  );
  assertBudget(
    parent,
    resumed?.rootUsage?.total ?? 0,
    taskTokenReservation,
    maxTokens,
    history.totals.total,
  ); // BEFORE any Pi spawn.
  if (preparation?.mode === "request-driven") {
    assert.ok(
      authorization,
      "request-driven authorization required before launch",
    );
    assert.equal(
      authorization.deadlineMs,
      deadlineMs,
      "authorized deadline changed",
    );
    assert.equal(
      authorization?.goalAction,
      resumed ? "resume" : "create",
      "Goal action differs from actual attempt",
    );
  }
  const admitted =
    preparation?.mode === "request-driven"
      ? buildModelAdmissionContext({
          authorization,
          parent,
          history,
          maxTokens,
          taskTokenReservation,
          preparation,
          request: prompt,
          cwd,
          command,
        })
      : null;
  assert.ok(
    env.TEAMS_E2E_L0_MODE === undefined,
    "L0 mode marker must come from verified admission, not inherited env",
  );
  const launchEnv = { ...env };
  if (admitted?.evidence?.mode === "task-pi")
    launchEnv.TEAMS_E2E_L0_MODE = "task-pi";
  const modelPrompt = admitted ? `${prompt}\n\n${admitted.context}` : prompt;
  assert.ok(
    Buffer.byteLength(modelPrompt) <= 65536,
    "rendered L0 prompt too large",
  );
  // Resolve the public validator from the same host as publicCommand. Do not
  // duplicate Pi's schema semantics or classify a tool's error prose as proof.
  const hostEntry = fs.realpathSync(
    path.join(path.dirname(process.execPath), "pi"),
  );
  const { createJiti } = createRequire(hostEntry)("jiti");
  const { validateToolArguments } = await createJiti(hostEntry).import(
    "@earendil-works/pi-ai",
  );
  assert.equal(
    typeof validateToolArguments,
    "function",
    "public input validator unavailable",
  );
  fs.mkdirSync(outputRoot, { mode: 0o700 }); // Existing attempt is never reused.
  const started = Date.now();
  const report = {
    status: "observing",
    acceptance: "not-assessed",
    command,
    expectedModel,
    cwd,
    parent,
    history,
    preparation,
    promptAdmission: admitted?.evidence ?? null,
    resumeUndispatched,
    maxTokens,
    taskTokenReservation,
    rootUsage: resumed?.rootUsage ?? null,
    goal: null,
    executionIds: [],
    taskDispatchAttempted: false,
    taskDispatchStarted: false,
    faults: [],
    modelPromptSent: false,
    processReaped: false,
  };
  fs.writeFileSync(
    path.join(outputRoot, "admission.json"),
    JSON.stringify(report, null, 2),
  );
  const logs = Object.fromEntries(
    ["stdout", "stderr"].map((name) => [
      name,
      fs.openSync(path.join(outputRoot, `${name}.jsonl`), "wx", 0o600),
    ]),
  );
  let child;
  const taskCalls = new Map();
  const rawNativePending = new Set();
  let deadline,
    sample,
    escalation,
    forcedKill,
    statsDeadline,
    settledStateDeadline,
    drainDeadline;
  let drainRequestId = null;
  const targetConfirmAbort = new AbortController();
  let pendingTargetUiId = null;
  let stopping = false,
    buffer = "",
    receivedBytes = 0,
    loggedBytes = 0,
    pendingStats = false;
  let rootSessionId,
    stopAfterStats,
    finalStatsId,
    usageSequence = 0,
    settledSequence = 0,
    settledProbeId = null,
    rawNativeUnresolved = false,
    lastAssistantError = null;
  const snapshot = () =>
    fs.writeFileSync(
      path.join(outputRoot, "rpc-observation.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  const log = (fd, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Math.min(bytes.length, Math.max(0, MAX_BYTES - loggedBytes));
    if (length) fs.writeSync(fd, bytes.subarray(0, length));
    loggedBytes += length;
    if (length !== bytes.length) {
      report.logTruncated = true;
      stop("output-limit");
    }
  };
  const send = (value) => {
    if (!child?.stdin.destroyed && !child?.stdin.writableEnded)
      child.stdin.write(JSON.stringify(value) + "\n");
  };
  const finishStop = () => {
    clearTimeout(drainDeadline);
    drainRequestId = null;
    child.stdin.end();
    escalation = setTimeout(() => {
      child.kill("SIGTERM");
      forcedKill = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, killGraceMs);
    snapshot();
  };
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    report.stopReason = reason;
    clearInterval(sample);
    clearTimeout(deadline);
    clearTimeout(statsDeadline);
    clearTimeout(settledStateDeadline);
    targetConfirmAbort.abort();
    if (pendingTargetUiId) {
      send({
        type: "extension_ui_response",
        id: pendingTargetUiId,
        cancelled: true,
      });
      pendingTargetUiId = null;
    }
    send({ type: "clear_queue" });
    send({ type: "abort_retry" });
    send({ type: "abort" });
    if (drainTimeoutMs && rootSessionId && report.drainControlReady) {
      drainRequestId = `drain-${Date.now()}`;
      report.taskDrain = {
        settled: false,
        disposition: "requested",
        requestId: drainRequestId,
      };
      send({
        id: "owner-drain",
        type: "prompt",
        message: `/teams-e2e-drain ${JSON.stringify({ requestId: drainRequestId, reason })}`,
      });
      drainDeadline = setTimeout(() => {
        report.taskDrain.disposition = "unknown-timeout";
        report.faults.push(
          "owner drain did not return terminal evidence before cleanup deadline",
        );
        finishStop();
      }, drainTimeoutMs);
      snapshot();
    } else finishStop();
  };
  const onInterrupt = () => stop("signal-SIGINT");
  const onTerminate = () => stop("signal-SIGTERM");
  const fail = (error) => {
    report.faults.push(String(error.message ?? error));
    stop("control-failure");
  };
  const sampleBudget = () => {
    parent = parentUsage(parentSessionFile, authorizationEntryId, parent);
    report.parent = parent;
    const committed =
      history.totals.total +
      parent.usage.total +
      (report.rootUsage?.total ?? 0) +
      taskTokenReservation;
    report.committedTokens = Number.isSafeInteger(committed) ? committed : null;
    assertBudget(
      parent,
      report.rootUsage?.total ?? 0,
      taskTokenReservation,
      maxTokens,
      history.totals.total,
    );
  };
  const requestStats = () => {
    if (!pendingStats && !stopping) {
      pendingStats = `usage-${++usageSequence}`;
      if (stopAfterStats) finalStatsId = pendingStats;
      send({ id: pendingStats, type: "get_session_stats" });
      // Synchronous host checks can legitimately occupy the RPC event loop.
      // A short response deadline applies to admission/final readback, not a
      // running host command; the overall attempt deadline still bounds it.
      if (!report.modelPromptSent || stopAfterStats)
        statsDeadline = setTimeout(
          () => fail(new Error("native usage response timed out")),
          statsTimeoutMs,
        );
    }
  };
  const event = (value) => {
    if (stopping) {
      if (
        drainRequestId &&
        value.type === "extension_ui_request" &&
        value.method === "setWidget" &&
        value.widgetKey === "teams-e2e-drain"
      ) {
        const line = value.widgetLines?.[0];
        assert.ok(
          typeof line === "string" && line.startsWith("TEAMS_E2E_DRAIN:"),
        );
        const receipt = parsed(
          Buffer.from(line.slice("TEAMS_E2E_DRAIN:".length)),
          "owner drain",
        );
        assert.equal(receipt.version, 1);
        assert.equal(receipt.requestId, drainRequestId);
        assert.equal(receipt.ownerSessionId, rootSessionId);
        assert.ok(Array.isArray(receipt.rows) && receipt.rows.length <= 64);
        assert.equal(
          receipt.settled,
          receipt.rows.every((row) => row.reservationOpen === false),
        );
        for (const id of report.executionIds)
          assert.ok(
            receipt.rows.some((row) => row.executionId === id),
            "owner drain omitted a dispatched execution",
          );
        report.taskDrain = receipt;
        if (!receipt.settled)
          report.faults.push(
            "owner drain remains unresolved; reservations were not forced closed",
          );
        finishStop();
      }
      return;
    }
    if (value.type === "response" && value.id === "drain-capability") {
      assert.ok(
        value.success &&
          value.data?.commands?.some(
            (command) => command.name === "teams-e2e-drain",
          ),
        "live owner drain command unavailable",
      );
      report.drainControlReady = true;
      if (rootSessionId) requestStats();
    }
    if (value.type === "response" && value.success === false)
      throw new Error(value.error ?? "RPC command failed");
    if (
      settledProbeId &&
      value.type === "response" &&
      value.id === settledProbeId
    ) {
      clearTimeout(settledStateDeadline);
      settledProbeId = null;
      const state = value.data;
      assert.equal(
        state?.sessionId,
        rootSessionId,
        "settled owner identity changed",
      );
      assert.equal(
        typeof state.isStreaming,
        "boolean",
        "settled streaming state unknown",
      );
      assert.ok(
        Number.isSafeInteger(state.pendingMessageCount) &&
          state.pendingMessageCount >= 0,
        "settled queue state unknown",
      );
      report.settledState = {
        isStreaming: state.isStreaming,
        pendingMessageCount: state.pendingMessageCount,
        rawNativeUnresolved: rawNativeUnresolved || rawNativePending.size > 0,
      };
      if (!state.isStreaming && state.pendingMessageCount === 0) {
        // No Goal-X continuation can be inferred without a Goal. Pi's
        // agent_settled also guarantees no queued retry/continuation remains.
        // A raw native child is not a Task drain row or terminal proof.
        if (report.settledState.rawNativeUnresolved)
          report.faults.push(
            "raw subagent status lacks terminal evidence; reconcile its exact native run",
          );
        stopAfterStats = report.settledState.rawNativeUnresolved
          ? "no-goal-native-child-unknown"
          : (unresolvedCandidateFailure(report) ?? "no-goal-final");
        if (pendingStats) {
          clearTimeout(statsDeadline);
          statsDeadline = setTimeout(
            () => fail(new Error("native usage response timed out")),
            statsTimeoutMs,
          );
        } else requestStats();
      }
      snapshot();
    }
    if (value.type === "response" && value.id === "identity") {
      assert.ok(!rootSessionId, "duplicate initial identity response");
      const state = value.data;
      assert.ok(
        typeof state?.sessionId === "string" &&
          state.sessionId !== parent.sessionId,
        "distinct native L0 identity required",
      );
      assert.equal(
        `${state.model?.provider}/${state.model?.id}`,
        expectedModel,
        "L0 model differs from explicit settings; do not spend tokens on a fallback",
      );
      if (resumed) {
        assert.equal(
          state.sessionId,
          resumed.sessionId,
          "resume session identity mismatch",
        );
        assert.equal(
          state.sessionFile,
          resumed.sessionFile,
          "resume session path mismatch",
        );
        assert.equal(state.isStreaming, false, "resumed owner already running");
      }
      rootSessionId = state.sessionId;
      report.sessionId = rootSessionId;
      report.sessionFile = state.sessionFile;
      snapshot();
      requestStats();
    }
    if (
      value.type === "response" &&
      pendingStats &&
      value.id === pendingStats
    ) {
      const finalSample = value.id === finalStatsId;
      clearTimeout(statsDeadline);
      pendingStats = false;
      assert.equal(
        value.data?.sessionId,
        rootSessionId,
        "native usage identity mismatch",
      );
      const usage = value.data.tokens;
      total(usage);
      if (report.rootUsage)
        assert.ok(
          [...parts, "total"].every(
            (key) => usage[key] >= report.rootUsage[key],
          ),
          "native usage decreased",
        );
      report.rootUsage = usage;
      sampleBudget();
      if (stopAfterStats) {
        if (finalSample) return stop(stopAfterStats);
        requestStats(); // An earlier in-flight sample cannot certify terminal usage.
        return;
      }
      if (!report.modelPromptSent) {
        if (drainTimeoutMs && !report.drainControlReady) return;
        if (!resumed)
          assert.equal(
            usage.total,
            0,
            "L0 already consumed tokens before test prompt",
          );
        report.modelPromptSent = true;
        send({ id: "todo-e2e", type: "prompt", message: modelPrompt });
      }
    }
    if (
      value.type === "tool_execution_start" &&
      ["team_task_dispatch", "team_task_revise"].includes(value.toolName)
    )
      report.taskDispatchAttempted = true;
    if (
      value.type === "tool_execution_start" &&
      value.toolName === "subagent"
    ) {
      report.rawSubagentObserved = true;
      if (typeof value.toolCallId === "string")
        rawNativePending.add(value.toolCallId);
      else rawNativeUnresolved = true; // No trustworthy call identity to clear.
    }
    if (
      value.type === "tool_execution_start" &&
      Object.hasOwn(taskToolParameters, value.toolName) &&
      typeof value.toolCallId === "string"
    ) {
      assert.ok(
        !taskCalls.has(value.toolCallId),
        "duplicate pending Task tool call",
      );
      assert.ok(
        taskCalls.size < 128,
        "bounded pending Task tool calls required",
      );
      const call = { tool: value.toolName, input: structuredClone(value.args) };
      taskCalls.set(value.toolCallId, call);
      try {
        validateToolArguments(
          {
            name: value.toolName,
            parameters: taskToolParameters[value.toolName],
          },
          {
            name: value.toolName,
            id: value.toolCallId,
            arguments: structuredClone(value.args),
          },
        );
      } catch (error) {
        // Only native schema rejection is known to precede tool_call hooks and
        // execution. Validator/load failures themselves must still fail closed.
        if (
          !error.message.startsWith(
            `Validation failed for tool "${value.toolName}":`,
          )
        )
          throw error;
        call.reason = error.message;
      }
    }
    if (value.type === "tool_execution_end") {
      if (value.toolName === "subagent") {
        if (typeof value.toolCallId === "string")
          rawNativePending.delete(value.toolCallId);
        const native = value.result?.details;
        if (
          native?.mode !== "management" &&
          !(
            !value.isError &&
            native?.mode === "single" &&
            typeof native.runId === "string" &&
            Array.isArray(native.results) &&
            native.results.length > 0 &&
            native.results.every(
              (result) =>
                Number.isInteger(result.exitCode) &&
                typeof result.sessionFile === "string",
            )
          )
        )
          rawNativeUnresolved = true;
        report.rawSubagentObserved = true;
      }
      const call = taskCalls.get(value.toolCallId);
      const details = value.result?.details;
      const hostRejection = isInputRejection(
        details?.rejection,
        call,
        value.toolName,
        value.toolCallId,
      );
      const inputCorrection =
        call?.tool === value.toolName
          ? (call.reason ??
            (hostRejection ? details.rejection.phase : undefined))
          : undefined;
      const completedCheckFailure =
        value.isError &&
        isCompletedCheckFailure(
          details?.checkFailure,
          call,
          value.toolName,
          value.toolCallId,
        );
      const completedConflict =
        value.isError &&
        isCompletedIntegrationConflict(
          details?.integrationConflict,
          call,
          value.toolName,
          value.toolCallId,
        );
      taskCalls.delete(value.toolCallId);
      if (completedConflict)
        (report.integrationConflicts ??= []).push(details.integrationConflict);
      if (
        !value.isError &&
        call?.tool === "team_task_accept" &&
        value.toolName === call.tool &&
        unresolvedCandidateFailure(report)
      ) {
        const proof = acceptedRepairProof(details.receipt, call, [
          ...(report.checkFailures ?? []),
          ...(report.integrationConflicts ?? []),
        ]);
        if (proof) (report.acceptedRepairs ??= []).push(proof);
      }
      if (completedCheckFailure) {
        // Give the current L0 loop time to inspect/pause/reconcile. This does
        // not clear the failed check, authorize replay, or permit acceptance.
        (report.checkFailures ??= []).push(details.checkFailure);
      }
      // Native Bash appends this status after captured output. A generated
      // syntax error/nonzero exit has a different suffix; output alone is not
      // a timeout. No new retry or effect classification is granted here.
      const commandTimeout =
        value.isError &&
        value.toolName === "bash" &&
        value.result?.content?.some(
          (block) =>
            block.type === "text" &&
            /(?:^|\n\n)Command timed out after [^\r\n]+ seconds$/.test(
              block.text,
            ),
        );
      if (value.isError) {
        report.faults.push({
          tool: value.toolName,
          result: value.result,
          ...(inputCorrection
            ? {
                disposition:
                  details?.rejection?.phase === "review-seal"
                    ? "review-seal-input"
                    : "pre-dispatch-input",
                reason: inputCorrection,
              }
            : completedCheckFailure || completedConflict
              ? { disposition: "diagnose-only" }
              : {}),
        });
      }
      if (details?.goal) report.goal = details.goal;
      if (
        ["team_task_dispatch", "team_task_revise"].includes(value.toolName) &&
        details?.executionId
      ) {
        report.taskDispatchStarted = true;
        if (!report.executionIds.includes(details.executionId))
          report.executionIds.push(details.executionId);
      }
      if (value.toolName === "team_task_collect" && details?.candidate)
        report.candidateOutcome = details.candidate.outcome;
      snapshot();
      if (
        value.isError &&
        !inputCorrection &&
        !completedCheckFailure &&
        !completedConflict &&
        value.toolName?.startsWith("team_task_")
      )
        stop("task-tool-failure"); // Unknown dispatch/runtime failures still drain immediately.
      else if (commandTimeout) stop("command-timeout");
    }
    if (value.type === "extension_error")
      throw new Error(value.error ?? "extension failure");
    // Pi owns bounded provider/summarization retries. A failed intermediate
    // message is not terminal: classify it only once native agent_settled fires.
    if (value.type === "message_end" && value.message?.role === "assistant")
      lastAssistantError = ["error", "aborted"].includes(
        value.message.stopReason,
      )
        ? value.message.errorMessage || "native assistant request failed"
        : null;
    if (value.type === "compaction_end" && value.errorMessage)
      lastAssistantError = value.errorMessage;
    if (
      value.type === "extension_ui_request" &&
      ["confirm", "select", "input", "editor"].includes(value.method)
    ) {
      if (
        targetConfirm &&
        value.method === "confirm" &&
        value.title === "Apply staged integration?" &&
        !pendingTargetUiId
      ) {
        assert.ok(
          rootSessionId,
          "owner identity required before target confirmation",
        );
        pendingTargetUiId = value.id;
        report.targetConfirmation = {
          status: "waiting",
          requestRef: path.join(outputRoot, "target-confirmation-request.json"),
        };
        snapshot();
        Promise.resolve()
          .then(() =>
            targetConfirm(value, {
              ownerSessionId: rootSessionId,
              signal: targetConfirmAbort.signal,
            }),
          )
          .then((confirmed) => {
            if (stopping) return;
            send({
              type: "extension_ui_response",
              id: value.id,
              confirmed: confirmed === true,
            });
            pendingTargetUiId = null;
            report.targetConfirmation.status =
              confirmed === true ? "approved" : "denied";
            snapshot();
          })
          .catch((error) => {
            if (stopping) return;
            send({
              type: "extension_ui_response",
              id: value.id,
              cancelled: true,
            });
            pendingTargetUiId = null;
            fail(error);
          });
      } else {
        send({ type: "extension_ui_response", id: value.id, cancelled: true });
        throw new Error(`unapproved additional UI request: ${value.title}`);
      }
    }
    if (value.type === "agent_settled") {
      assert.ok(
        !pendingTargetUiId,
        "native target confirmation settled without decision",
      );
      // General tool errors remain in faults. Their semantic recovery belongs
      // to L0, not an irreversible observer latch or arbitrary success matching.
      if (lastAssistantError) {
        report.faults.push({
          type: "provider-error",
          message: lastAssistantError,
        });
        stopAfterStats = "provider-failure";
      } else if (report.goal && report.goal.status !== "active")
        stopAfterStats =
          unresolvedCandidateFailure(report) ?? `goal-${report.goal.status}`;
      else if (!report.goal && !settledProbeId) {
        // Check the public final queue/session state after extension settle
        // handlers, not an earlier sampling response or the assistant prose.
        settledProbeId = `settled-${++settledSequence}`;
        send({ id: settledProbeId, type: "get_state" });
        settledStateDeadline = setTimeout(
          () => fail(new Error("settled native state response timed out")),
          statsTimeoutMs,
        );
      }
      // create_goal also terminates a turn, but its active Goal may continue.
      if (stopAfterStats) {
        if (pendingStats) {
          clearTimeout(statsDeadline);
          statsDeadline = setTimeout(
            () => fail(new Error("native usage response timed out")),
            statsTimeoutMs,
          );
        } else requestStats();
      }
    }
    if (value.type === "message_end" || value.type === "compaction_end")
      requestStats();
  };
  try {
    child = spawn(command[0], command.slice(1), {
      cwd,
      env: launchEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    report.pid = child.pid;
    snapshot(); // Preserve identity even if the observer is subsequently killed.
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.stdin.on("error", (error) => {
      if (!stopping) fail(error);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      log(logs.stdout, text);
      if (stopping && !drainRequestId) return;
      try {
        receivedBytes += Buffer.byteLength(text);
        assert.ok(receivedBytes <= MAX_BYTES, "RPC output limit exceeded");
        buffer += text;
        let newline;
        while (
          (!stopping || drainRequestId) &&
          (newline = buffer.indexOf("\n")) >= 0
        ) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) event(JSON.parse(line));
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (bytes) => log(logs.stderr, bytes));
    const closed = new Promise((resolve) => {
      child.once("error", (error) => {
        report.faults.push(String(error));
      });
      child.once("close", (code, signal) => {
        report.exitCode = code;
        report.signal = signal;
        report.processReaped = Number.isInteger(child.pid);
        if (!stopping) report.stopReason = "unexpected-process-exit";
        resolve();
      });
    });
    deadline = setTimeout(
      () => stop("deadline"),
      deadlineMs - (drainTimeoutMs ? drainTimeoutMs + 2 * killGraceMs : 0),
    );
    sample = setInterval(() => {
      try {
        sampleBudget();
        requestStats();
      } catch (error) {
        fail(error);
      }
    }, sampleMs);
    send({ id: "identity", type: "get_state" });
    if (drainTimeoutMs) send({ id: "drain-capability", type: "get_commands" });
    await closed;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    for (const timer of [
      deadline,
      sample,
      escalation,
      forcedKill,
      statsDeadline,
      settledStateDeadline,
      drainDeadline,
    ])
      clearTimeout(timer);
    for (const fd of Object.values(logs)) fs.closeSync(fd);
    try {
      sampleBudget();
    } catch (error) {
      report.faults.push(String(error.message));
    }
    report.elapsedMs = Date.now() - started;
    report.reportedTokens = report.rootUsage
      ? history.totals.total +
        report.parent.usage.total +
        report.rootUsage.total
      : null;
    report.reportedTokensAreLowerBound = true;
    report.taskUsage = {
      status: "unknown",
      reason: "closed native usage not available",
    };
    if (report.taskDrain?.settled) {
      try {
        const measured = reconcileDrainedUsage(
          report.taskDrain.rows,
          rootSessionId,
        );
        const priorIds = new Set([
          parent.sessionId,
          ...history.sources.map((row) => row.sessionId),
        ]);
        assert.ok(
          measured.sources.every((row) => !priorIds.has(row.sessionId)),
          "current Task usage duplicates history/parent",
        );
        report.taskUsage = { status: "measured", ...measured };
        if (report.reportedTokens !== null) {
          report.reportedTokens += measured.totals.total;
          assert.ok(
            Number.isSafeInteger(report.reportedTokens),
            "reported usage overflow",
          );
        }
      } catch (error) {
        report.taskUsage = {
          status: "unknown",
          reason: String(error.message ?? error).slice(0, 1000),
        };
        report.faults.push({
          type: "task-usage-unknown",
          message: report.taskUsage.reason,
        });
      }
    }
    report.cleanup =
      report.taskDrain?.settled === true
        ? "live owner reported all execution reservations closed before L0 exit; acceptance still requires durable readback"
        : report.taskDispatchAttempted
          ? "Task Pi lifecycle remains unresolved; L0 exit is not worker cleanup"
          : "no Task Pi dispatch observed; verify ledger before claiming no execution";
    // This is transport completeness, not Task/Goal acceptance. A completed
    // Goal alone is insufficient when native drain or usage is unknown.
    const taskObserved =
      report.taskDispatchAttempted || report.executionIds.length > 0;
    report.status =
      report.processReaped &&
      report.exitCode === 0 &&
      report.signal === null &&
      Number.isSafeInteger(report.rootUsage?.total) &&
      !report.logTruncated &&
      !rawNativeUnresolved &&
      ((report.goal &&
        ["complete", "paused", "cancelled"].includes(report.goal.status)) ||
        report.stopReason === "no-goal-final") &&
      (!taskObserved ||
        (report.taskDrain?.settled === true &&
          report.taskUsage.status === "measured"))
        ? "captured"
        : "incomplete";
    snapshot();
  }
  return report;
}

async function main() {
  const env = process.env;
  const required = (name) => {
    assert.ok(env[name], `${name} required`);
    return env[name];
  };
  const outputRoot = path.resolve(process.argv[2] ?? "");
  assert.ok(process.argv[2], "new evidence directory argument required");
  const workspace = fs.realpathSync(required("TEAMS_E2E_WORKSPACE"));
  const inputs = loadAttemptInputs(
    fs.realpathSync(required("TEAMS_E2E_INPUT_FILE")),
    workspace,
    fs.realpathSync(required("PI_SESSION_FILE")),
  );
  if (inputs.preparation.mode === "request-driven")
    assert.equal(
      inputs.authorization.deadlineMs,
      Number(required("TEAMS_E2E_DEADLINE_MS")),
      "authorized deadline differs before workspace preparation",
    );
  const parent = parentUsage(
    inputs.parentSessionFile,
    inputs.authorizationEntryId,
  );
  const history = historicalUsage(
    inputs.historicalSessions,
    parent.sessionId,
    inputs.historicalExecutions,
  );
  assertBudget(
    parent,
    0,
    inputs.taskTokenReservation,
    inputs.maxTokens,
    history.totals.total,
  );
  const preparation = prepareTodoWorkspace(workspace);
  fs.writeFileSync(
    path.join(
      path.dirname(outputRoot),
      `${path.basename(outputRoot)}-workspace.json`,
    ),
    JSON.stringify(preparation, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  if (env.TEAMS_E2E_CONFIRM_BRIDGE)
    assert.ok(
      env.TEAMS_E2E_CONFIRM_BRIDGE === "1" &&
        inputs.authorization?.delivery === "approved-integration",
      "confirmation bridge requires approved-integration attempt and explicit opt-in",
    );
  let confirmationBridge;
  const targetConfirm =
    env.TEAMS_E2E_CONFIRM_BRIDGE === "1"
      ? (ui, { ownerSessionId, signal }) => {
          confirmationBridge ??= createTargetConfirmationBridge({
            outputRoot,
            sourceRoot: workspace,
            parentSessionFile: inputs.parentSessionFile,
            ownerSessionId,
          });
          return confirmationBridge(ui, { signal });
        }
      : null;
  const report = await runRpcAttempt({
    command: publicCommand(
      env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
      path.join(outputRoot, "l0-sessions"),
      env.TEAMS_E2E_SUBAGENTS_EXTENSION,
    ),
    cwd: workspace,
    outputRoot,
    prompt:
      inputs.preparation.mode === "request-driven"
        ? bounded(inputs.preparation.requestFile, 65536).toString("utf8")
        : bounded(
            path.resolve(required("TEAMS_E2E_PROMPT_FILE")),
            65536,
          ).toString("utf8") +
          `\nADMITTED INPUTS: ${JSON.stringify(inputs.preparation.specs)}. Aggregate Task reservation: ${inputs.taskTokenReservation}. Use exactly these Task specs, binding only goalId. The parent, not L0, archives logs and computes final accounting after exit. Read evidence files only at exact paths returned by tools; never read a directory as a file or invent browser-report paths. Do not copy execution/session trees or write accounting summaries during the model run.\n` +
          "\nNATIVE RETRY POLICY (supersedes earlier blanket no-retry instructions): Allow Pi's configured bounded assistant and summarization retries within this same session, budget and deadline. Do not cancel a native retry merely because it starts. This does not authorize Task redispatch, tool-effect replay, source repair, or acceptance bypass. A schema-rejected Task input or a tool's bound teams-input-rejection/1 response permits only its explicitly identified correction in this same agent loop. For review-seal, the completed BLOCKED review remains captured and no candidate was sealed: do not repeat seal/reviewer/old execution; cancel/drain E0, then use the public same-Task revision only if all origin checks pass. For draft dispatch errors no Task was launched, though preparation metadata may exist; never edit a sealed policy or redispatch an existing Task. Missing/mismatched effect facts are not correction permission. Terminal provider failure, exhausted retries, executed/unknown Task failures and failed safety gates still require owner-safe stop/reconciliation.\nWAIT/RESULT CONTRACT (supersedes earlier shell-wait instructions): Use team_task_collect with wait_ms=1200000 for this execution; do not write or run shell/find polling helpers. The tool returns the actual candidate and Worker process observation. RESULT_READY is not success. If candidate.outcome is blocked/failed, cancel only this execution through the public Task tool and pause only its real Goal; never stage, review or accept it. collection=waiting means only this wait window ended; continue bounded collection of the SAME execution when needed. Task deadline reached or missing/unknown native proof remains a stop/reconciliation condition, not permission to redispatch.\n",
    ...inputs,
    preparation:
      inputs.preparation.mode === "request-driven"
        ? { ...inputs.preparation, sourceBase: preparation.baseCommit }
        : inputs.preparation,
    deadlineMs: Number(required("TEAMS_E2E_DEADLINE_MS")),
    drainTimeoutMs: 35_000,
    targetConfirm,
    env,
  });
  console.log(
    JSON.stringify({
      reportFile: path.join(outputRoot, "rpc-observation.json"),
      stopReason: report.stopReason,
      transportStatus: report.status,
      acceptance: report.acceptance,
    }),
  );
  process.exitCode = report.status === "captured" ? 2 : 1; // Only the separate native audit may return 0.
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
