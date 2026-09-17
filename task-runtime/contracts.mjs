import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secretPath =
  /(^|[\\/])(auth\.json|credentials(?:\.json)?|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc)([\\/]|$)|\.(pem|key)$/i;

function plain(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalized(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    assert.ok(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      "safe JSON integers required",
    );
    return value;
  }
  if (Array.isArray(value)) return value.map(normalized);
  assert.ok(plain(value), "safe JSON objects required");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        assert.ok(value[key] !== undefined, "undefined is not safe JSON");
        return [key, normalized(value[key])];
      }),
  );
}

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(normalized(value)), "utf8");
}

export function digest(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

export function bytesDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function object(value, name) {
  assert.ok(plain(value), `${name} object required`);
  return value;
}

function exact(value, keys, name) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${name} fields changed`,
  );
}

function text(value, name, max = 4096) {
  assert.ok(typeof value === "string" && value.trim(), `${name} required`);
  assert.ok(Buffer.byteLength(value, "utf8") <= max, `${name} too large`);
  return value;
}

function id(value, name) {
  assert.match(text(value, name, 128), ID, `invalid ${name}`);
  return value;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `invalid ${name}`,
  );
  return value;
}

function unique(values, name) {
  assert.equal(new Set(values).size, values.length, `duplicate ${name}`);
}

function relative(value, name) {
  text(value, name, 1024);
  assert.ok(
    !path.isAbsolute(value) &&
      !value
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === ".."),
    `${name} must be a scoped relative path`,
  );
  assert.ok(
    !secretPath.test(value),
    `${name} cannot reference credential paths`,
  );
  return value;
}

export { relative as validateScopedPath };

function absolute(value, name, mustExist = true) {
  text(value, name, 4096);
  assert.ok(path.isAbsolute(value), `${name} must be absolute`);
  const resolved = path.resolve(value);
  if (mustExist)
    assert.equal(
      fs.realpathSync(resolved),
      resolved,
      `${name} must be canonical`,
    );
  return resolved;
}

function identity(value) {
  object(value, "identity");
  exact(
    value,
    [
      "projectId",
      "goalId",
      "taskId",
      "taskRevision",
      "executionId",
      "ownerEpoch",
    ],
    "identity",
  );
  id(value.projectId, "projectId");
  id(value.goalId, "goalId");
  id(value.taskId, "taskId");
  integer(value.taskRevision, "taskRevision", 1);
  assert.match(
    text(value.executionId, "executionId", 64),
    UUID,
    "invalid executionId",
  );
  integer(value.ownerEpoch, "ownerEpoch", 1);
  return value;
}

function textArray(value, name, maximum = 30) {
  assert.ok(
    Array.isArray(value) && value.length <= maximum,
    `bounded ${name} required`,
  );
  value.forEach((item) => text(item, name, 4096));
  unique(value, name);
  return value;
}

export function validateTaskContract(input) {
  object(input, "contract");
  exact(
    input,
    [
      "schemaVersion",
      "identity",
      "objective",
      "nonGoals",
      "workspace",
      "criteria",
      "checks",
      "policy",
      "contextRefs",
    ],
    "contract",
  );
  assert.ok(
    [
      "teams-task-runtime/1",
      "teams-task-runtime/2",
      "teams-task-runtime/3",
    ].includes(input.schemaVersion),
    "unsupported contract version",
  );
  identity(input.identity);
  text(input.objective, "objective", 8192);
  textArray(input.nonGoals, "nonGoals");

  const workspace = object(input.workspace, "workspace");
  exact(
    workspace,
    [
      "sourceRoot",
      "worktreePath",
      "baseCommit",
      "sourcePaths",
      "allowedWritePaths",
    ],
    "workspace",
  );
  const sourceRoot = absolute(workspace.sourceRoot, "sourceRoot");
  if (workspace.worktreePath !== null)
    absolute(workspace.worktreePath, "worktreePath");
  assert.match(
    text(workspace.baseCommit, "baseCommit", 128),
    /^[a-f0-9]{40,64}$/i,
    "invalid baseCommit",
  );
  assert.ok(
    Array.isArray(workspace.sourcePaths) &&
      workspace.sourcePaths.length > 0 &&
      workspace.sourcePaths.length <= 128,
    "1..128 sourcePaths required",
  );
  workspace.sourcePaths.forEach((item) => relative(item, "source path"));
  unique(workspace.sourcePaths, "source path");
  assert.ok(
    Array.isArray(workspace.allowedWritePaths) &&
      workspace.allowedWritePaths.length <= 128,
    "bounded allowedWritePaths required",
  );
  workspace.allowedWritePaths.forEach((item) => relative(item, "write path"));
  unique(workspace.allowedWritePaths, "write path");

  assert.ok(
    Array.isArray(input.criteria) &&
      input.criteria.length > 0 &&
      input.criteria.length <= 30,
    "1..30 criteria required",
  );
  const criterionIds = new Set();
  for (const criterion of input.criteria) {
    object(criterion, "criterion");
    exact(criterion, ["id", "text", "requiredEvidenceKinds"], "criterion");
    id(criterion.id, "criterion id");
    assert.ok(!criterionIds.has(criterion.id), "duplicate criterion id");
    criterionIds.add(criterion.id);
    text(criterion.text, "criterion text", 4096);
    assert.ok(
      Array.isArray(criterion.requiredEvidenceKinds) &&
        criterion.requiredEvidenceKinds.length > 0 &&
        criterion.requiredEvidenceKinds.length <= 16,
      "criterion evidence kinds required",
    );
    criterion.requiredEvidenceKinds.forEach((kind) =>
      id(kind, "evidence kind"),
    );
    unique(criterion.requiredEvidenceKinds, "evidence kind");
  }

  assert.ok(
    Array.isArray(input.checks) && input.checks.length <= 30,
    "bounded checks required",
  );
  const commandIds = new Set();
  for (const check of input.checks) {
    object(check, "check");
    exact(
      check,
      [
        "commandId",
        "executable",
        "argv",
        "cwd",
        "timeoutMs",
        "expectedExitCode",
        "criterionIds",
      ],
      "check",
    );
    id(check.commandId, "commandId");
    assert.ok(!commandIds.has(check.commandId), "duplicate commandId");
    commandIds.add(check.commandId);
    absolute(check.executable, "check executable");
    assert.ok(
      Array.isArray(check.argv) &&
        check.argv.length <= 128 &&
        check.argv.every(
          (arg) => typeof arg === "string" && !arg.includes("\0"),
        ),
      "bounded argv required",
    );
    assert.equal(
      absolute(check.cwd, "check cwd"),
      sourceRoot,
      "check cwd must equal sourceRoot in v1",
    );
    integer(check.timeoutMs, "check timeoutMs", 1, 2_147_483_647);
    assert.equal(check.expectedExitCode, 0, "v1 checks require exit code 0");
    assert.ok(
      Array.isArray(check.criterionIds) && check.criterionIds.length > 0,
      "check criterionIds required",
    );
    check.criterionIds.forEach((criterionId) =>
      assert.ok(
        criterionIds.has(criterionId),
        `unknown criterion ${criterionId}`,
      ),
    );
    unique(check.criterionIds, "check criterion");
  }

  const policy = object(input.policy, "policy");
  exact(
    policy,
    [
      "risk",
      "allowedRoles",
      "maxActiveRoleRuns",
      "maxRoleSpawnsPerTask",
      "maxProductRepairsPerRole",
      "maxReportRepairs",
      "maxProcessRestarts",
      "maxTaskTokens",
      "deadlineMs",
      "integrationMode",
      ...(input.schemaVersion === "teams-task-runtime/3" ? ["review"] : []),
      ...(input.schemaVersion === "teams-task-runtime/3" &&
      Object.hasOwn(policy, "tokenBudgetMode")
        ? ["tokenBudgetMode"]
        : []),
    ],
    "policy",
  );
  assert.ok(
    ["low", "medium", "high", "critical"].includes(policy.risk),
    "invalid risk",
  );
  assert.ok(
    Array.isArray(policy.allowedRoles) &&
      policy.allowedRoles.length > 0 &&
      policy.allowedRoles.length <= 16,
    "allowedRoles required",
  );
  policy.allowedRoles.forEach((role) =>
    assert.match(
      text(role, "role", 128),
      /^team\.[A-Za-z0-9._-]+$/,
      "invalid role",
    ),
  );
  unique(policy.allowedRoles, "role");
  if (input.schemaVersion === "teams-task-runtime/3") {
    const review = object(policy.review, "review policy");
    exact(
      review,
      ["authority", "allowedRoles", "allowedTools"],
      "review policy",
    );
    assert.equal(
      review.authority,
      "l0-source-bound",
      "unsupported review authority",
    );
    for (const [name, maximum] of [
      ["allowedRoles", 16],
      ["allowedTools", 128],
    ]) {
      assert.ok(
        Array.isArray(review[name]) &&
          review[name].length > 0 &&
          review[name].length <= maximum,
        `bounded review ${name} required`,
      );
      review[name].forEach((value) => id(value, `review ${name}`));
      unique(review[name], `review ${name}`);
    }
    assert.ok(
      review.allowedRoles.every((role) => policy.allowedRoles.includes(role)),
      "review roles exceed task policy",
    );
  }
  integer(
    policy.maxActiveRoleRuns,
    "maxActiveRoleRuns",
    1,
    input.schemaVersion === "teams-task-runtime/1" ? 2 : 64,
  );
  assert.ok(
    policy.maxActiveRoleRuns <= policy.maxRoleSpawnsPerTask,
    "active role limit exceeds spawn budget",
  );
  integer(policy.maxRoleSpawnsPerTask, "maxRoleSpawnsPerTask", 1, 64);
  integer(policy.maxProductRepairsPerRole, "maxProductRepairsPerRole", 0, 3);
  integer(policy.maxReportRepairs, "maxReportRepairs", 0, 1);
  integer(policy.maxProcessRestarts, "maxProcessRestarts", 0, 1);
  integer(policy.maxTaskTokens, "maxTaskTokens", 1);
  if (Object.hasOwn(policy, "tokenBudgetMode"))
    assert.ok(
      ["shared", "member-hard"].includes(policy.tokenBudgetMode),
      "invalid token budget mode",
    );
  integer(policy.deadlineMs, "deadlineMs", 1, 2_147_483_647);
  assert.ok(
    ["verify-only", "approved-integration"].includes(policy.integrationMode),
    "invalid integrationMode",
  );

  assert.ok(
    Array.isArray(input.contextRefs) && input.contextRefs.length <= 30,
    "bounded contextRefs required",
  );
  for (const ref of input.contextRefs) {
    object(ref, "contextRef");
    exact(ref, ["uri", "sha256"], "contextRef");
    relative(ref.uri, "contextRef uri");
    assert.match(
      text(ref.sha256, "contextRef sha256", 64),
      SHA256,
      "invalid contextRef sha256",
    );
  }

  assert.ok(
    canonicalBytes(input).length <= 64 * 1024,
    "contract exceeds 64 KiB",
  );
  return input;
}

export function validateControl(input) {
  object(input, "control");
  exact(
    input,
    [
      "schemaVersion",
      "commandId",
      "executionId",
      "ownerEpoch",
      "requestDigest",
      "type",
      "payload",
    ],
    "control",
  );
  assert.equal(input.schemaVersion, "teams-task-control/1");
  id(input.commandId, "commandId");
  assert.match(input.executionId, UUID, "invalid executionId");
  integer(input.ownerEpoch, "ownerEpoch", 1);
  assert.match(input.requestDigest, SHA256, "invalid requestDigest");
  assert.ok(
    [
      "grant",
      "decision",
      "request_report_repair",
      "cancel",
      "checkpoint",
    ].includes(input.type),
    "invalid control type",
  );
  object(input.payload, "control payload");
  assert.ok(
    canonicalBytes(input).length <= 16 * 1024,
    "control exceeds 16 KiB",
  );
  return input;
}

export function validateEvent(input) {
  object(input, "event");
  exact(
    input,
    [
      "schemaVersion",
      "eventId",
      "executionId",
      "ownerEpoch",
      "workerSessionId",
      "sequence",
      "type",
      "occurredAt",
      "payloadRef",
      "payloadDigest",
    ],
    "event",
  );
  assert.equal(input.schemaVersion, "teams-task-event/1");
  id(input.eventId, "eventId");
  assert.match(input.executionId, UUID, "invalid executionId");
  integer(input.ownerEpoch, "ownerEpoch", 1);
  id(input.workerSessionId, "workerSessionId");
  integer(input.sequence, "sequence", 1);
  assert.ok(
    [
      "booted",
      "bound",
      "heartbeat",
      "progress",
      "decision_required",
      "result_ready",
      "cancelled",
      "failed",
      "command_ack",
    ].includes(input.type),
    "invalid event type",
  );
  assert.ok(
    Number.isFinite(Date.parse(input.occurredAt)),
    "invalid occurredAt",
  );
  relative(input.payloadRef, "payloadRef");
  assert.match(input.payloadDigest, SHA256, "invalid payloadDigest");
  return input;
}

export function validateTaskResult(input, contract, requestDigest) {
  validateTaskContract(contract);
  object(input, "result");
  exact(
    input,
    [
      "schemaVersion",
      "identity",
      "requestDigest",
      "resultRevision",
      "outcome",
      "summary",
      "source",
      "criterionResults",
      "evidence",
      "childRunRefs",
      "unresolvedRunCount",
      "risks",
      "usage",
    ],
    "result",
  );
  assert.equal(input.schemaVersion, "teams-task-result/1");
  identity(input.identity);
  assert.equal(
    digest(input.identity),
    digest(contract.identity),
    "result identity mismatch",
  );
  assert.equal(input.requestDigest, requestDigest, "request digest mismatch");
  integer(input.resultRevision, "resultRevision", 1);
  assert.ok(
    ["ready_for_acceptance", "blocked", "failed", "cancelled"].includes(
      input.outcome,
    ),
    "invalid result outcome",
  );
  text(input.summary, "result summary", 4096);

  object(input.source, "result source");
  exact(
    input.source,
    ["baseCommit", "sourceDigest", "manifestRef"],
    "result source",
  );
  assert.equal(
    input.source.baseCommit,
    contract.workspace.baseCommit,
    "base commit mismatch",
  );
  assert.match(input.source.sourceDigest, SHA256, "invalid source digest");
  relative(input.source.manifestRef, "source manifestRef");

  assert.ok(
    Array.isArray(input.evidence) && input.evidence.length <= 100,
    "bounded evidence required",
  );
  const evidence = new Map();
  for (const item of input.evidence) {
    object(item, "evidence");
    exact(
      item,
      ["evidenceId", "kind", "uri", "sha256", "producedBy", "sourceDigest"],
      "evidence",
    );
    id(item.evidenceId, "evidenceId");
    assert.ok(!evidence.has(item.evidenceId), "duplicate evidenceId");
    id(item.kind, "evidence kind");
    relative(item.uri, "evidence uri");
    assert.match(item.sha256, SHA256, "invalid evidence digest");
    assert.ok(
      ["host", "worker", "subagent"].includes(item.producedBy),
      "invalid evidence producer",
    );
    assert.equal(
      item.sourceDigest,
      input.source.sourceDigest,
      "evidence source mismatch",
    );
    evidence.set(item.evidenceId, item);
  }

  assert.ok(
    Array.isArray(input.criterionResults) &&
      input.criterionResults.length === contract.criteria.length,
    "exact criterion results required",
  );
  const rows = new Map();
  for (const row of input.criterionResults) {
    object(row, "criterion result");
    exact(
      row,
      ["criterionId", "status", "observation", "evidenceIds"],
      "criterion result",
    );
    id(row.criterionId, "criterionId");
    assert.ok(!rows.has(row.criterionId), "duplicate criterion result");
    assert.ok(
      ["met", "not_met", "indeterminate", "needs_user"].includes(row.status),
      "invalid criterion status",
    );
    text(row.observation, "criterion observation", 4096);
    assert.ok(Array.isArray(row.evidenceIds), "criterion evidenceIds required");
    unique(row.evidenceIds, "criterion evidenceId");
    rows.set(row.criterionId, row);
  }
  for (const criterion of contract.criteria) {
    const row = rows.get(criterion.id);
    assert.ok(row, `missing criterion ${criterion.id}`);
    const cited = row.evidenceIds.map((evidenceId) => {
      const item = evidence.get(evidenceId);
      assert.ok(item, `unknown evidence ${evidenceId}`);
      return item;
    });
    if (input.outcome === "ready_for_acceptance") {
      const pendingHost =
        ["teams-task-runtime/2", "teams-task-runtime/3"].includes(
          contract.schemaVersion,
        ) &&
        row.status === "indeterminate" &&
        criterion.requiredEvidenceKinds.includes("host-check");
      assert.ok(
        row.status === "met" || pendingHost,
        `criterion ${criterion.id} is not met or awaiting host verification`,
      );
      for (const kind of criterion.requiredEvidenceKinds.filter(
        (required) => required !== "host-check",
      ))
        assert.ok(
          cited.some((item) => item.kind === kind),
          `criterion ${criterion.id} missing ${kind} evidence`,
        );
    }
  }

  assert.ok(
    Array.isArray(input.childRunRefs) && input.childRunRefs.length <= 64,
    "bounded childRunRefs required",
  );
  input.childRunRefs.forEach((ref) => id(ref, "childRunRef"));
  unique(input.childRunRefs, "childRunRef");
  integer(input.unresolvedRunCount, "unresolvedRunCount", 0, 64);
  if (input.outcome === "ready_for_acceptance")
    assert.equal(
      input.unresolvedRunCount,
      0,
      "ready result has unresolved runs",
    );
  textArray(input.risks, "risks");
  object(input.usage, "usage");
  exact(input.usage, ["inputTokens", "outputTokens"], "usage");
  for (const key of ["inputTokens", "outputTokens"])
    if (input.usage[key] !== null) integer(input.usage[key], key, 0);
  assert.ok(canonicalBytes(input).length <= 64 * 1024, "result exceeds 64 KiB");
  return input;
}
