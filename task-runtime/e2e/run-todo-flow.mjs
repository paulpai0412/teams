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
import { bytesDigest } from "../contracts.mjs";
import { measureSessionBytes } from "../task-usage.mjs";
import { publicPackage, modelId, readTaskModels } from "../capabilities.mjs";
import { taskToolParameters } from "../task-tool-inputs.mjs";

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
  const bytes = bounded(file);
  if (previous) {
    assert.ok(bytes.length >= previous.bytes, "parent transcript shrank");
    assert.equal(
      bytesDigest(bytes.subarray(0, previous.bytes)),
      previous.digest,
      "parent transcript prefix changed",
    );
  }
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim());
  const entries = lines.map((line) => parsed(line, "parent session"));
  const matches = entries.flatMap((entry, index) =>
    entry.id === authorizationEntryId ? [index] : [],
  );
  assert.equal(matches.length, 1, "unique parent authorization entry required");
  const index = matches[0];
  const anchor = entries[index];
  assert.ok(
    index > 0 &&
      anchor.type === "message" &&
      (anchor.message?.role === "user" ||
        (anchor.message?.role === "toolResult" &&
          anchor.message.toolName === "ask_user" &&
          anchor.message.isError !== true)),
    "authorization must reference a user/ask_user entry",
  );
  const measured = measureSessionBytes(
    Buffer.from([lines[0], ...lines.slice(index)].join("\n")),
    { allowEmpty: true },
  );
  return {
    file,
    authorizationEntryId,
    sessionId: measured.sessionId,
    usage: measured.usage,
    bytes: bytes.length,
    digest: bytesDigest(bytes),
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
    preparation: { inputFile: file, inputSha256: bytesDigest(bytes), specs },
  };
}

// Closed session snapshots only. Their inventory must cover prior parent/L0/
// Worker/leaf/review attempts, including failures. No scalar carry or reservation
// masquerades as usage. Copies with the same session identity cannot count twice.
export function historicalUsage(sessions, parentSessionId) {
  assert.ok(
    Array.isArray(sessions) && sessions.length <= 10000,
    "bounded historical inventory required",
  );
  const ids = new Set([parentSessionId]);
  const totals = Object.fromEntries([...parts, "total"].map((key) => [key, 0]));
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
    for (const key of [...parts, "total"]) {
      totals[key] += measured.usage[key];
      assert.ok(Number.isSafeInteger(totals[key]), "historical usage overflow");
    }
    return { ...source, sessionId: measured.sessionId, usage: measured.usage };
  });
  return { sources, totals };
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
  preparation = null,
  deadlineMs,
  env = process.env,
  sampleMs = 1000,
  killGraceMs = 5000,
  statsTimeoutMs = 5000,
  drainTimeoutMs = 0,
  expectedModel = readTaskModels().l0,
}) {
  modelId(expectedModel);
  // Never silently turn on confirmation or canary permission, even for tests.
  assert.equal(
    env.PI_GOAL_AUTO_CONFIRM,
    "1",
    "RPC Goal task confirmation requires explicitly approved PI_GOAL_AUTO_CONFIRM=1",
  );
  assert.equal(env.TEAMS_E2E_CANARY, "1", "explicit canary opt-in required");
  assert.ok(
    Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 1800000,
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
  assert.ok(
    !fs.existsSync(path.join(cwd, ".pi", "goals")),
    "fresh workspace without existing Goals required",
  );
  assert.ok(
    path.isAbsolute(outputRoot),
    "absolute new evidence directory required",
  );
  assert.ok(
    path.relative(cwd, outputRoot).startsWith(`..${path.sep}`),
    "evidence must be outside product workspace",
  );
  let parent = parentUsage(parentSessionFile, authorizationEntryId);
  const history = historicalUsage(historicalSessions, parent.sessionId);
  assertBudget(
    parent,
    0,
    taskTokenReservation,
    maxTokens,
    history.totals.total,
  ); // BEFORE any Pi spawn.
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
    status: "blocked",
    fullE2EPassed: false,
    command,
    expectedModel,
    cwd,
    parent,
    history,
    preparation,
    maxTokens,
    taskTokenReservation,
    rootUsage: null,
    goal: null,
    executionIds: [],
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
  const rejectedInputs = new Map();
  let deadline, sample, escalation, forcedKill, statsDeadline, drainDeadline;
  let drainRequestId = null;
  let stopping = false,
    buffer = "",
    receivedBytes = 0,
    loggedBytes = 0,
    pendingStats = false;
  let rootSessionId,
    stopAfterStats,
    finalStatsId,
    usageSequence = 0,
    endedWithError = false,
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
        assert.equal(
          usage.total,
          0,
          "L0 already consumed tokens before test prompt",
        );
        report.modelPromptSent = true;
        send({ id: "todo-e2e", type: "prompt", message: prompt });
      }
    }
    if (
      value.type === "tool_execution_start" &&
      value.toolName === "team_task_dispatch"
    )
      report.taskDispatchStarted = true;
    if (
      value.type === "tool_execution_start" &&
      Object.hasOwn(taskToolParameters, value.toolName) &&
      typeof value.toolCallId === "string"
    ) {
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
        rejectedInputs.set(value.toolCallId, {
          tool: value.toolName,
          reason: error.message,
        });
      }
    }
    if (value.type === "tool_execution_end") {
      const rejected = rejectedInputs.get(value.toolCallId);
      const inputCorrection =
        rejected?.tool === value.toolName ? rejected.reason : undefined;
      rejectedInputs.delete(value.toolCallId);
      if (value.isError) {
        if (!inputCorrection) endedWithError = true;
        report.faults.push({
          tool: value.toolName,
          result: value.result,
          ...(inputCorrection
            ? { disposition: "pre-dispatch-input", reason: inputCorrection }
            : {}),
        });
      }
      const details = value.result?.details;
      if (details?.goal) report.goal = details.goal;
      if (value.toolName === "team_task_dispatch" && details?.executionId)
        report.executionIds.push(details.executionId);
      if (value.toolName === "team_task_collect" && details?.candidate)
        report.candidateOutcome = details.candidate.outcome;
      snapshot();
      if (
        value.isError &&
        !inputCorrection &&
        value.toolName?.startsWith("team_task_")
      )
        stop("task-tool-failure"); // Unknown dispatch/runtime failures still drain immediately.
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
      send({ type: "extension_ui_response", id: value.id, cancelled: true });
      throw new Error(`unapproved additional UI request: ${value.title}`);
    }
    if (value.type === "agent_settled") {
      if (endedWithError) stopAfterStats = "tool-failure";
      else if (lastAssistantError) {
        report.faults.push({
          type: "provider-error",
          message: lastAssistantError,
        });
        stopAfterStats = "provider-failure";
      } else if (report.goal && report.goal.status !== "active")
        stopAfterStats = `goal-${report.goal.status}`;
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
      env,
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
    report.taskUsage =
      "reserved, not measured; requires existing durable runtime usage/lifecycle evidence";
    report.cleanup =
      report.taskDrain?.settled === true
        ? "live owner reported all execution reservations closed before L0 exit; acceptance still requires durable readback"
        : report.taskDispatchStarted
          ? "Task Pi lifecycle remains unresolved; L0 exit is not worker cleanup"
          : "no Task Pi dispatch observed; verify ledger before claiming no execution";
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
  const parent = parentUsage(
    inputs.parentSessionFile,
    inputs.authorizationEntryId,
  );
  const history = historicalUsage(inputs.historicalSessions, parent.sessionId);
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
  const report = await runRpcAttempt({
    command: publicCommand(
      env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
      path.join(outputRoot, "l0-sessions"),
      env.TEAMS_E2E_SUBAGENTS_EXTENSION,
    ),
    cwd: workspace,
    outputRoot,
    prompt:
      bounded(path.resolve(required("TEAMS_E2E_PROMPT_FILE")), 65536).toString(
        "utf8",
      ) +
      `\nADMITTED INPUTS: ${JSON.stringify(inputs.preparation.specs)}. Aggregate Task reservation: ${inputs.taskTokenReservation}. Use exactly these Task specs, binding only goalId. The parent, not L0, archives logs and computes final accounting after exit. Read evidence files only at exact paths returned by tools; never read a directory as a file or invent browser-report paths. Do not copy execution/session trees or write accounting summaries during the model run.\n` +
      "\nNATIVE RETRY POLICY (supersedes earlier blanket no-retry instructions): Allow Pi's configured bounded assistant and summarization retries within this same session, budget and deadline. Do not cancel a native retry merely because it starts. This does not authorize Task redispatch, tool-effect replay, source repair, or acceptance bypass. A schema-rejected Task input has not executed: preserve it and correct the arguments through the existing agent loop, without redispatching a Task or replaying effects. Terminal provider failure, exhausted retries, executed/unknown Task failures and failed safety gates still require owner-safe stop/reconciliation.\nWAIT/RESULT CONTRACT (supersedes earlier shell-wait instructions): Use team_task_collect with wait_ms=1200000 for this execution; do not write or run shell/find polling helpers. The tool returns the actual candidate and Worker process observation. RESULT_READY is not success. If candidate.outcome is blocked/failed, cancel only this execution through the public Task tool and pause only its real Goal; never stage, review or accept it. A wait timeout or missing/unknown native proof is a stop/reconciliation condition, not permission to redispatch.\n",
    ...inputs,
    deadlineMs: Number(required("TEAMS_E2E_DEADLINE_MS")),
    drainTimeoutMs: 35_000,
    env,
  });
  console.log(
    JSON.stringify({
      reportFile: path.join(outputRoot, "rpc-observation.json"),
      stopReason: report.stopReason,
      fullE2EPassed: false,
    }),
  );
  process.exitCode = 1; // Transport termination is never full E2E acceptance.
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
