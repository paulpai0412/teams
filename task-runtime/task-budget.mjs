// Task-owned bindings and the existing Pi request hooks; no model-call tool or controller.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeLedger } from "./ledger.mjs";
import { Mailbox } from "./mailbox.mjs";
import { assertLiveController } from "./role-lifecycle.mjs";
import { digest } from "./contracts.mjs";
import { measureSessionBytes } from "./task-usage.mjs";
import { poolTotals, usesSharedTaskBudget } from "./budget-pool.mjs";

export const TASK_BUDGET_BINDING = "teams.task-budget/1";
export const TASK_BUDGET_EXTENSION = fileURLToPath(
  new URL("../extensions/teams-budget/index.mjs", import.meta.url),
);

export function budgetedChildren(context, children, prefix) {
  if (!usesSharedTaskBudget(context.contract)) return children;
  return children.map((child) => ({
    ...child,
    extensionBindings: {
      [TASK_BUDGET_BINDING]: taskBudgetBinding(
        context,
        `${prefix}.${child.key}`,
      ),
    },
  }));
}

export function assertBudgetHook(resolution) {
  assert.equal(resolution?.ok, true, "shared budget launch preflight failed");
  assert.ok(
    resolution.contract?.tools?.extensionArgs?.includes(TASK_BUDGET_EXTENSION),
    "role lacks the Task budget request hook; refusing unmetered launch",
  );
}

export function taskBudgetBinding({ mailbox, contract }, key) {
  if (!usesSharedTaskBudget(contract)) return null;
  return {
    ledgerPath: path.resolve(mailbox.root, "../../../../ledger.sqlite"),
    executionId: contract.identity.executionId,
    requestDigest: digest(contract),
    key,
  };
}

function withLedger(binding, readOnly, operation) {
  assert.ok(
    binding && path.isAbsolute(binding.ledgerPath),
    "budget binding missing",
  );
  assert.equal(
    fs.realpathSync(binding.ledgerPath),
    binding.ledgerPath,
    "budget ledger path changed",
  );
  const ledger = new RuntimeLedger(binding.ledgerPath, { readOnly });
  try {
    const contract = ledger.getContract(binding.executionId);
    assert.ok(usesSharedTaskBudget(contract), "shared budget not authorized");
    assert.equal(
      digest(contract),
      binding.requestDigest,
      "budget binding contract changed",
    );
    return operation(ledger, contract);
  } finally {
    ledger.close();
  }
}

export function changeTaskBudget(binding, operation) {
  return withLedger(binding, false, (ledger, contract) => {
    if (["register", "bind", "request"].includes(operation.type)) {
      const root = path.join(
        path.dirname(binding.ledgerPath),
        "projects",
        contract.identity.projectId,
        "executions",
        binding.executionId,
      );
      const bootstrap = Mailbox.open(root, binding.executionId).readJson(
        "bootstrap.json",
      );
      assert.equal(
        bootstrap.requestDigest,
        binding.requestDigest,
        "budget bootstrap changed",
      );
      assert.equal(
        bootstrap.controller?.ownerSessionId,
        ledger.getExecution(binding.executionId).ownerSessionId,
        "budget controller changed",
      );
      assertLiveController(root, bootstrap.controller);
    }
    return ledger.changeTaskPool(binding.executionId, binding.requestDigest, {
      ...operation,
      ...(binding.key ? { key: binding.key } : {}),
    });
  });
}

export function readTaskBudget(context) {
  const binding = taskBudgetBinding(context, null);
  return withLedger(binding, true, (ledger) => {
    const pool = ledger.readTaskPool(binding.executionId);
    assert.ok(pool, "shared budget missing");
    assert.equal(
      pool.contractDigest,
      binding.requestDigest,
      "budget proof contract changed",
    );
    assert.equal(
      pool.ceiling,
      context.contract.policy.maxTaskTokens,
      "budget ceiling changed",
    );
    return pool;
  });
}

export function registerTaskBudgetMembers(context, members) {
  if (!usesSharedTaskBudget(context.contract)) return;
  changeTaskBudget(taskBudgetBinding(context, null), {
    type: "register",
    members,
  });
}

// Independently measured native/Worker transcripts remain authoritative. The
// pool proves request admission; neither a soft estimate nor an LLM report does.
export function assertTaskBudgetUsage(
  context,
  sources,
  { complete = false } = {},
) {
  if (!usesSharedTaskBudget(context.contract)) return;
  const pool = readTaskBudget(context);
  assert.ok(
    Object.values(pool.members).every((row) => !row.unknown),
    "unknown shared budget usage",
  );
  const totals = poolTotals(pool);
  assert.ok(
    totals.used + totals.held <= pool.ceiling,
    "shared task budget exceeded",
  );
  for (const source of sources) {
    const members = Object.values(pool.members).filter(
      (row) =>
        row.sessionId === source.sessionId &&
        row.sessionFile === source.sessionFile,
    );
    assert.equal(members.length, 1, "metered session missing from shared pool");
    const member = members[0];
    assert.equal(
      member.used,
      source.usage.total,
      "shared pool differs from authoritative session usage",
    );
    if (source.kind !== "worker" || complete)
      assert.ok(
        member.finished && !member.inFlight && member.hold === 0,
        "shared pool member not settled",
      );
  }
  if (complete) {
    assert.equal(
      sources.length,
      Object.keys(pool.members).length,
      "shared pool inventory incomplete",
    );
    assert.ok(
      Object.values(pool.members).every(
        (row) =>
          row.finished && !row.unknown && !row.inFlight && row.hold === 0,
      ),
      "shared pool not terminal",
    );
  }
  return pool;
}

function publicUsage(ctx) {
  const manager = ctx.sessionManager;
  const entries = manager.getEntries();
  const bytes = Buffer.from(
    [manager.getHeader(), ...entries]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  assert.ok(bytes.length <= 8 * 1024 * 1024, "budget session too large");
  const measured = measureSessionBytes(bytes, { allowEmpty: true });
  assert.equal(
    measured.sessionId,
    manager.getSessionId(),
    "budget public session mismatch",
  );
  return {
    sessionId: measured.sessionId,
    sessionFile: manager.getSessionFile(),
    used: measured.usage.total,
    assistantReports: measured.usage.messages,
    summaryReports: entries.filter(
      (row) => row.type === "compaction" || row.type === "branch_summary",
    ).length,
  };
}

// Text requests reserve their serialized context bytes (a conservative token
// estimate), bounded by the model window, plus its maximum output. Media or
// unavailable context uses the model window. This is NOT a tokenizer/billing
// guarantee; in-flight/transport retries remain held until reported usage arrives.
export function requestAllowance(model, context = null) {
  assert.ok(
    Number.isSafeInteger(model?.contextWindow) &&
      model.contextWindow > 0 &&
      Number.isSafeInteger(model?.maxTokens) &&
      model.maxTokens > 0,
    "unknown model request allowance",
  );
  let input = model.contextWindow;
  if (context) {
    const serialized = JSON.stringify(context);
    if (!/"type":"(?:image|image_url|input_image)"/.test(serialized))
      input = Math.min(input, Buffer.byteLength(serialized));
  }
  const allowance = input + model.maxTokens;
  assert.ok(Number.isSafeInteger(allowance), "request allowance overflow");
  return allowance;
}

export function installTaskBudgetHooks(pi, getBinding, onFailure = () => {}) {
  let identity = null,
    failed = null,
    active = null;
  function binding(ctx) {
    const value = getBinding(ctx);
    if (!value) return null;
    const current = publicUsage(ctx);
    if (!identity) {
      const bound = changeTaskBudget(value, { type: "bind", ...current });
      assert.ok(
        !bound.members[value.key].inFlight && !bound.members[value.key].unknown,
        "budget session has an unresolved request; no reset on reload",
      );
      identity = {
        sessionId: current.sessionId,
        sessionFile: current.sessionFile,
      };
    }
    assert.equal(
      current.sessionId,
      identity.sessionId,
      "budget session replacement forbidden",
    );
    assert.equal(
      current.sessionFile,
      identity.sessionFile,
      "budget session path replacement forbidden",
    );
    return { value, current };
  }
  function fail(error, ctx) {
    if (active !== null && identity) {
      try {
        changeTaskBudget(getBinding(ctx), { type: "unknown", ...identity });
      } catch {
        /* Keep the original failure and the unreleased durable hold. */
      }
    }
    failed ??= error;
    ctx.abort();
    onFailure(error, ctx);
    ctx.ui.setStatus(
      "teams-budget",
      `blocked: ${String(error.message ?? error).slice(0, 300)}`,
    );
  }
  function settle(ctx, finish = false) {
    const bound = binding(ctx);
    if (!bound) return;
    // A prior cumulative total (or an empty initial session) does not prove the
    // latest request cost zero. Require its own reported assistant/summary entry.
    if (active)
      assert.ok(
        bound.current[active.counter] > active.reports,
        "request usage report missing; budget retained",
      );
    changeTaskBudget(bound.value, {
      type: finish ? "finish" : "settle",
      ...bound.current,
    });
    active = null;
  }
  function request(ctx, kind, messages = null) {
    if (failed) throw failed;
    const bound = binding(ctx);
    if (!bound) return;
    assert.equal(active, null, "unsettled in-flight budget request");
    changeTaskBudget(bound.value, { type: "settle", ...bound.current });
    const activeTools = new Set(pi.getActiveTools?.() ?? []);
    const tools = (pi.getAllTools?.() ?? [])
      .filter((tool) => activeTools.has(tool.name))
      .map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
    const context = Array.isArray(messages)
      ? { messages, systemPrompt: ctx.getSystemPrompt(), tools }
      : null;
    // Native compaction can generate a history summary and a split-turn summary.
    const allowance =
      requestAllowance(ctx.model, context) * (kind === "compaction" ? 2 : 1);
    changeTaskBudget(bound.value, {
      type: "request",
      ...bound.current,
      allowance,
    });
    const counter =
      kind === "compaction" ? "summaryReports" : "assistantReports";
    active = { kind, counter, reports: bound.current[counter] };
  }
  pi.on("turn_start", (_event, ctx) => {
    try {
      if (!active) settle(ctx);
    } catch (error) {
      fail(error, ctx);
    }
  });
  pi.on("tool_call", (_event, ctx) => {
    try {
      settle(ctx);
    } catch (error) {
      fail(error, ctx);
      return {
        block: true,
        terminate: true,
        reason: String(error.message ?? error),
      };
    }
  });
  pi.on("context", (event, ctx) => {
    try {
      request(ctx, "assistant", event.messages);
    } catch (error) {
      fail(error, ctx);
    }
  });
  pi.on("turn_end", (_event, ctx) => {
    // Reported error/aborted usage is still usage. Do not block native retries
    // merely because the assistant failed; missing counters fail publicUsage.
    try {
      settle(ctx);
    } catch (error) {
      fail(error, ctx);
    }
  });
  pi.on("session_before_compact", (_event, ctx) => {
    try {
      request(ctx, "compaction");
    } catch (error) {
      fail(error, ctx);
      return { cancel: true };
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    try {
      settle(ctx);
    } catch (error) {
      fail(error, ctx);
    }
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    if (active?.kind !== "compaction") return;
    try {
      const bound = binding(ctx);
      if (bound)
        changeTaskBudget(bound.value, { type: "unknown", ...bound.current });
    } finally {
      fail(new Error("compaction usage unknown; budget retained"), ctx);
    }
  });
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
  ])
    pi.on(event, (_event, ctx) =>
      getBinding(ctx) ? { cancel: true } : undefined,
    );
  pi.on("session_shutdown", (_event, ctx) => {
    if (active !== null || failed) return; // A shutdown is not proof of zero unknown cost.
    try {
      settle(ctx, true);
    } catch (error) {
      fail(error, ctx);
    }
  });
}
