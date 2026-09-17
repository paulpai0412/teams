import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { handoffSchema } from "../handoff-schema.mjs";
import { canonicalBytes, digest } from "./contracts.mjs";
import { readTaskModels, taskRoleModel } from "./capabilities.mjs";

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const writes = (mode) => mode === "mutation" || mode === "check";

function exact(value, keys, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} object required`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} fields changed`,
  );
}

function boundedText(value, limit, label) {
  assert.ok(
    typeof value === "string" &&
      value.trim() &&
      !value.includes("\0") &&
      Buffer.byteLength(value) <= limit,
    `bounded ${label} required`,
  );
}

export function inspectWorktreeBase(cwd, baseCommit) {
  function git(args) {
    const result = spawnSync(
      "git",
      ["--no-optional-locks", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.ok(
      !result.error && result.status === 0,
      `worktree preflight failed: ${args[0]}`,
    );
    return result.stdout;
  }
  assert.equal(
    fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trim()),
    fs.realpathSync(cwd),
    "worktree source must be a repository root",
  );
  assert.equal(
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    "",
    "worktree requires a clean baseline; do not auto stash or commit",
  );
  const head = git(["rev-parse", "HEAD"]).trim();
  assert.equal(head, baseCommit, "worktree baseline changed");
  return head;
}

export function compileRoleWave(children, sessionDir = null) {
  if (sessionDir !== null) {
    assert.ok(
      path.isAbsolute(sessionDir),
      "absolute role session root required",
    );
    children = children.map((child) => {
      assert.match(child.key, keyPattern, "safe role session key required");
      return { ...child, sessionDir: path.join(sessionDir, child.key) };
    });
  }
  const script = [
    `const results = await runs.all(${JSON.stringify(children)});`,
    `if (!Array.isArray(results) || results.length !== ${children.length} || results.some(result => !result || result.ok !== true)) throw new Error("Role wave contains failed or missing child results; preserve native receipts and reconcile.");`,
    "const nativeFields = " +
      JSON.stringify([
        "index",
        "agent",
        "context",
        "exitCode",
        "processSignal",
        "detached",
        "interrupted",
        "timedOut",
        "stopped",
        "error",
        "sessionFile",
        "launchContractDigest",
        "structuredOutput",
        "acceptance",
        "attemptedModels",
        "modelAttempts",
        "children",
        "runner",
        "usage",
      ]) +
      ";",
    "return results.map((result, index) => ({ key: " +
      JSON.stringify(children.map((child) => child.key)) +
      "[index], ok: result.ok, runId: result.runId ?? null, outputReference: result.outputReference ?? null, artifactPaths: result.artifactPaths ?? [], structuredOutput: result.structuredOutput ?? null, nativeResults: result.results?.map(item => Object.fromEntries(nativeFields.filter(field => Object.hasOwn(item, field) && item[field] !== undefined).map(field => [field, item[field]]))) ?? null }));",
  ].join("\n");
  assert.ok(
    Buffer.byteLength(script) <= 1024 * 1024,
    "compiled wave exceeds 1 MiB",
  );
  return script;
}

// Admission and compilation only. Native pi-subagents owns scheduling and worktrees.
export function prepareRoleWave(contract, cwd, wave) {
  assert.equal(
    fs.realpathSync(cwd),
    contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
    "role wave cwd mismatch",
  );
  exact(wave, ["key", "reason", "runs"], "wave");
  assert.match(wave.key, keyPattern, "invalid wave key");
  boundedText(wave.reason, 1000, "wave reason");
  assert.ok(
    Array.isArray(wave.runs) &&
      wave.runs.length > 0 &&
      wave.runs.length <= contract.policy.maxActiveRoleRuns,
    "wave exceeds active role limit",
  );
  assert.ok(canonicalBytes(wave).length <= 32 * 1024, "wave exceeds 32 KiB");
  const keys = new Set();
  const members = wave.runs.map((run) => {
    exact(
      run,
      ["key", "role", "task", "mode", "isolation", "maxTokens"],
      "wave member",
    );
    assert.match(run.key, keyPattern, "invalid member key");
    assert.ok(!keys.has(run.key), "duplicate member key");
    keys.add(run.key);
    assert.ok(
      contract.policy.allowedRoles.includes(run.role),
      `role not allowed: ${run.role}`,
    );
    boundedText(run.task, 16 * 1024, "role task");
    assert.ok(
      ["mutation", "review", "read-only", "check"].includes(run.mode),
      "invalid role mode",
    );
    assert.ok(
      ["shared", "worktree"].includes(run.isolation),
      "invalid role isolation",
    );
    assert.ok(
      contract.schemaVersion !== "teams-task-runtime/3" ||
        !writes(run.mode) ||
        run.isolation === "worktree",
      "v3 mutation/check requires a managed worktree; original target is host-owned",
    );
    assert.ok(
      !writes(run.mode) || contract.workspace.allowedWritePaths.length > 0,
      "mutation/check requires allowed write paths",
    );
    assert.ok(
      Number.isSafeInteger(run.maxTokens) && run.maxTokens > 0,
      "positive maxTokens required",
    );
    return {
      key: run.key,
      role: run.role,
      mode: run.mode,
      isolation: run.isolation,
      maxTokens: run.maxTokens,
      taskDigest: digest(run.task),
    };
  });
  assert.ok(
    canonicalBytes(members).length <= 12 * 1024,
    "wave metadata exceeds the bounded progress receipt",
  );
  // A shared writer also changes the base that managed-worktree siblings would clone.
  assert.ok(
    members.length === 1 ||
      !members.some(
        (member) => writes(member.mode) && member.isolation === "shared",
      ),
    "shared checkout mutation/check must run alone; isolate independent parallel writers",
  );
  const reservedTokens = members.reduce(
    (sum, member) => sum + member.maxTokens,
    0,
  );
  assert.ok(
    Number.isSafeInteger(reservedTokens) &&
      reservedTokens <= contract.policy.maxTaskTokens,
    "task token budget exhausted",
  );
  const worktree = members.some((member) => member.isolation === "worktree");
  const baseCommit = worktree
    ? inspectWorktreeBase(cwd, contract.workspace.baseCommit)
    : null;
  const schema = handoffSchema(
    contract.criteria.map((criterion) => criterion.text),
  );
  const models = readTaskModels();
  const children = wave.runs.map((run) => ({
    key: run.key,
    agent: run.role,
    model: taskRoleModel(run.role, models),
    cwd,
    task: [
      run.task,
      writes(run.mode)
        ? `Allowed write paths relative to your checkout: ${contract.workspace.allowedWritePaths.join(", ") || "none"}. Do not integrate into the shared target.`
        : "Read-only work: do not modify source, fixtures, configuration or caches.",
      ...(run.isolation === "worktree"
        ? [
            `Managed-worktree boundary: verify pwd and git rev-parse --show-toplevel before writing; never cd to contract.workspace.sourceRoot or apply there. Read shared artifacts from the Git common directory, but apply only in this managed checkout and its allowed paths. Stop if the checkout root is not the managed worktree.`,
          ]
        : []),
      ...(contract.policy.review?.authority === "l0-source-bound"
        ? [
            "L0 owns the designated host checks. Keep their criteria indeterminate until evidence arrives; do not invent a mock DOM or substitute harness to claim browser verification. Perform only assigned candidate checks.",
          ]
        : []),
      "Use structured_output for the handoff. Check every required outputSchema field, including value.residualRisks. Native acceptanceReport is a sibling of value, never a substitute for required value fields. Report each criterion once; missing evidence is indeterminate. Parent owns final verification; never claim unreceived host checks or acceptance.",
      `Report correction ceiling: ${contract.policy.maxReportRepairs}. Only an explicitly authorized report-only correction may resubmit existing evidence in the same run; never replay implementation or checks to fix a report. Preserve the rejected submission. Zero allowance, exhausted allowance or a stricter task stop rule means stop and request a decision, not permission to correct.`,
      "Classify errors by their effect: product failure, verification-tool limitation, report-format error or diagnostic. Preserve raw evidence; do not assume a failed check is harmless. Unknown effects, missing required evidence or unsafe state block progression. A supervisor request is not repair approval.",
    ].join("\n"),
    context: "fresh",
    async: false,
    output: `task-role-${wave.key}-${run.key}.json`,
    outputSchema: schema,
    timeoutMs: contract.policy.deadlineMs,
    worktree: run.isolation === "worktree",
  }));
  const workflowScript = compileRoleWave(children);
  return {
    key: wave.key,
    reason: wave.reason,
    members,
    reservedTokens,
    baseCommit,
    children,
    workflowScript,
  };
}
