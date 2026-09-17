// Pure accounting transitions; RuntimeLedger serializes them with BEGIN IMMEDIATE.
// Estimates reserve capacity, not lifetime caps. Reported consumption is never refunded.
import assert from "node:assert/strict";
import path from "node:path";

export function usesSharedTaskBudget(contract) {
  return (
    contract.schemaVersion === "teams-task-runtime/3" &&
    contract.policy.tokenBudgetMode === "shared"
  );
}

function tokens(value, label, minimum = 0) {
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be safe tokens`,
  );
  return value;
}

export function poolTotals(pool) {
  let used = tokens(pool.priorTokens, "prior usage"),
    held = 0;
  for (const member of Object.values(pool.members)) {
    used = tokens(used + tokens(member.used, "member usage"), "total usage");
    held = tokens(held + tokens(member.hold, "member hold"), "total holds");
  }
  return { used, held, available: pool.ceiling - used - held };
}

export function createPool(contractDigest, ceiling, priorTokens) {
  assert.match(contractDigest, /^[a-f0-9]{64}$/);
  tokens(ceiling, "task ceiling", 1);
  tokens(priorTokens, "prior usage");
  assert.ok(priorTokens < ceiling, "task budget exhausted");
  return {
    version: 1,
    contractDigest,
    ceiling,
    priorTokens,
    members: {},
    revision: 0,
  };
}

function assertIdentity(member, op) {
  assert.equal(
    member.sessionId,
    op.sessionId,
    "budget session identity changed",
  );
  assert.equal(
    member.sessionFile,
    op.sessionFile,
    "budget session path changed",
  );
  assert.ok(member.sessionId && member.sessionFile, "budget session not bound");
}

function register(pool, members) {
  assert.ok(
    Object.values(pool.members).every((row) => !row.unknown),
    "unknown task budget usage",
  );
  assert.ok(
    Array.isArray(members) && members.length > 0,
    "pool members required",
  );
  const keys = new Set();
  let requested = 0;
  for (const member of members) {
    assert.match(member.key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
    assert.ok(
      !Object.hasOwn(pool.members, member.key) && !keys.has(member.key),
      "budget member already registered",
    );
    keys.add(member.key);
    assert.ok(
      path.isAbsolute(member.sessionRoot) &&
        path.resolve(member.sessionRoot) === member.sessionRoot,
      "canonical session root required",
    );
    requested = tokens(
      requested + tokens(member.estimate, "role estimate"),
      "new holds",
    );
  }
  assert.ok(
    Object.keys(pool.members).length + members.length <= 66,
    "pool inventory too large",
  );
  assert.ok(
    poolTotals(pool).available >= requested,
    "task budget unavailable for new reservations",
  );
  for (const { key, estimate, sessionRoot } of members)
    pool.members[key] = {
      estimate,
      sessionRoot,
      used: 0,
      hold: estimate,
      sessionId: null,
      sessionFile: null,
      inFlight: false,
      unknown: false,
      finished: false,
    };
}

// Callers must mutate a transaction-local copy: failed operations never commit.
export function changePool(pool, op) {
  assert.equal(pool.version, 1, "unsupported task pool");
  if (op.type === "register") {
    register(pool, op.members);
  } else {
    assert.ok(
      Object.hasOwn(pool.members, op.key),
      "unregistered budget member",
    );
    const member = pool.members[op.key];
    if (op.type === "bind") {
      assert.match(op.sessionId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
      assert.ok(
        typeof op.sessionFile === "string" &&
          path.isAbsolute(op.sessionFile) &&
          path.resolve(op.sessionFile) === op.sessionFile &&
          op.sessionFile.startsWith(member.sessionRoot + path.sep),
        "budget session outside planned root",
      );
      if (member.sessionId === null) {
        assert.ok(
          !Object.values(pool.members).some(
            (row) =>
              row.sessionId === op.sessionId ||
              row.sessionFile === op.sessionFile,
          ),
          "budget session identity reused",
        );
        member.sessionId = op.sessionId;
        member.sessionFile = op.sessionFile;
      } else assertIdentity(member, op);
    } else {
      assertIdentity(member, op);
      if (op.type === "unknown") member.unknown = true;
      else {
        assert.ok(
          !member.unknown,
          "unknown budget usage; reconcile without refund",
        );
        tokens(op.used, "reported usage");
        assert.ok(op.used >= member.used, "budget usage cannot decrease");
        if (op.type === "request") {
          assert.ok(
            Object.values(pool.members).every((row) => !row.unknown),
            "unknown task budget usage",
          );
          assert.ok(!member.finished, "finished budget member cannot resume");
          assert.ok(
            !member.inFlight,
            "unresolved in-flight request; no budget replay",
          );
          assert.equal(op.used, member.used, "unsettled usage before request");
          tokens(op.allowance, "request allowance", 1);
          const extra = Math.max(0, op.allowance - member.hold);
          assert.ok(
            poolTotals(pool).available >= extra,
            "task budget unavailable for next request",
          );
          member.hold += extra;
          member.inFlight = true;
        } else {
          assert.ok(
            ["settle", "finish"].includes(op.type),
            "unknown pool operation",
          );
          // Even an unexpected provider overshoot stays recorded. It blocks the
          // next admission and final acceptance; never clamp actual usage.
          member.used = op.used;
          member.hold = Math.max(0, member.estimate - member.used);
          member.inFlight = false;
          if (op.type === "finish") {
            member.finished = true;
            member.hold = 0;
          }
        }
      }
    }
  }
  pool.revision = tokens(pool.revision + 1, "pool revision");
  return pool;
}
