// Parent-owned review transport. Native owns scheduling; no inferred completion,
// report-only relaunch, or acceptance upgrade. A host admission gate is mandatory.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readEvidenceBytes, saveEvidenceJson } from "../host-evidence.mjs";
import { bytesDigest, canonicalBytes, digest } from "./contracts.mjs";
import { publicPackage } from "./capabilities.mjs";
import { compileRoleWave, prepareRoleWave } from "./role-wave.mjs";
import { usesSharedTaskBudget } from "./budget-pool.mjs";
import {
  budgetedChildren,
  assertBudgetHook,
  assertTaskBudgetUsage,
  registerTaskBudgetMembers,
  TASK_BUDGET_BINDING,
} from "./task-budget.mjs";
import {
  readNativeTerminal,
  readNativeStartFailure,
  captureNativeTerminal,
  nativeWorkflowResult,
} from "./role-lifecycle.mjs";
import {
  prepareIntegrationReview,
  readAppliedIntegrationReview,
  integrationReviewSchema,
  validateReviewLaunch,
  validateReviewReport,
} from "./integration-review.mjs";
import { readIntegrationRehearsal } from "./integration.mjs";
import { verifyIntegrationApply } from "./integration-apply.mjs";
import { integrationReviewBinding } from "./integration-authority.mjs";
import {
  measureExecutionUsage,
  measureSessionBytes,
  reviewUsageAdmission,
} from "./task-usage.mjs";

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const runPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const inside = (root, file) =>
  path.isAbsolute(file) && file.startsWith(root + path.sep);
function json(file) {
  try {
    return JSON.parse(readEvidenceBytes(file, 1024 * 1024).toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid review evidence: ${file}`, { cause });
  }
}

// Resolve public peer exports from the running host, not from the separately
// installed extension's npm directory. No dependency patches or version aliases.
// Non-CLI hosts may supply their own module entry; missing peers fail closed.
export async function publicReviewResolver(
  agentDir,
  hostEntry = process.argv[1],
  subagentsEntry = null,
) {
  const selectedPackage = subagentsEntry ? publicPackage(subagentsEntry) : null;
  if (selectedPackage)
    assert.equal(
      selectedPackage.manifest.name,
      "pi-subagents",
      "review package mismatch",
    );
  const base = selectedPackage?.file ?? path.join(agentDir, "npm/package.json");
  const require = createRequire(base);
  const { createJiti } = require("jiti");
  const hostLoader = createJiti(fs.realpathSync(hostEntry));
  const manifest =
    selectedPackage?.manifest ??
    json(path.join(agentDir, "npm/node_modules/pi-subagents/package.json"));
  assert.ok(
    manifest.peerDependencies && typeof manifest.peerDependencies === "object",
    "public peer manifest required",
  );
  const alias = Object.fromEntries(
    Object.keys(manifest.peerDependencies).map((name) => [
      name,
      fileURLToPath(hostLoader.esmResolve(name)),
    ]),
  );
  const api = await createJiti(base, { alias }).import(
    "pi-subagents/preflight",
  );
  assert.equal(
    typeof api.resolveSubagentLaunchContract,
    "function",
    "public review preflight unavailable",
  );
  return api.resolveSubagentLaunchContract;
}

async function locked(context, action) {
  context.assertOwner();
  const root = path.join(context.mailbox.root, "integration/reviews");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(root), root, "canonical review root required");
  const lockPath = path.join(root, "operation.lock");
  const fd = fs.openSync(lockPath, "wx", 0o600);
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        owner: context.ownerSessionId,
        epoch: context.contract.identity.ownerEpoch,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(fd);
    context.assertOwner();
    return await action(root);
  } finally {
    fs.closeSync(fd);
    const current = fs.lstatSync(lockPath);
    assert.ok(
      current.ino === owned.ino && current.dev === owned.dev,
      "review lock replaced; preserve and reconcile",
    );
    fs.unlinkSync(lockPath); // Only this operation's lock; crashes retain it.
  }
}

function assertReviewOpen(root) {
  // Check directory entries, including dangling symlinks or incomplete seals.
  assert.ok(
    !fs
      .readdirSync(path.dirname(root))
      .some((name) =>
        ["review-candidate-intent.json", "review-candidate.json"].includes(
          name,
        ),
      ),
    "review candidate sealed or intent exists; no further review admission",
  );
}

function reviewInventory(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== "operation.lock")
    .map((entry) => {
      assert.ok(
        entry.isDirectory() && keyPattern.test(entry.name),
        "unknown review inventory entry",
      );
      return entry.name;
    })
    .sort();
}

// This seals reviewer evidence only, never native writer gates, target-write
// authority or Task acceptance. All registered waves are mandatory; no selector.
export async function sealReviewCandidate(context) {
  return reviewCandidate(context);
}

export async function readSealedReviewCandidate(context) {
  return reviewCandidate(context, undefined, true);
}

export async function readAppliedReviewCandidate(context, planDigest) {
  assert.match(
    typeof planDigest === "string" ? planDigest : "",
    /^[a-f0-9]{64}$/,
    "explicit apply plan digest required",
  );
  return reviewCandidate(context, planDigest);
}

function readRequest(context, appliedPlanDigest) {
  return appliedPlanDigest === undefined
    ? prepareIntegrationReview(context)
    : readAppliedIntegrationReview(context, appliedPlanDigest);
}

async function reviewCandidate(
  context,
  appliedPlanDigest,
  requireSealed = false,
) {
  return locked(context, async (root) => {
    const file = path.join(path.dirname(root), "review-candidate.json");
    const intentFile = path.join(
      path.dirname(root),
      "review-candidate-intent.json",
    );
    const names = fs.readdirSync(path.dirname(root));
    const sealed = names.includes("review-candidate.json");
    const intended = names.includes("review-candidate-intent.json");
    if (requireSealed || appliedPlanDigest !== undefined) {
      assert.ok(
        sealed && intended,
        "existing sealed review candidate required; final review binding missing",
      );
      assert.ok(
        names.includes("review-request.json") && names.includes("review.patch"),
        "existing frozen review request required",
      );
    }
    assert.ok(
      sealed === intended,
      "incomplete review candidate; preserve and reconcile",
    );
    const keys = reviewInventory(root);
    assert.ok(
      keys.length > 0 &&
        keys.length <= context.contract.policy.maxRoleSpawnsPerTask,
      "bounded nonempty review inventory required",
    );
    const request = readRequest(context, appliedPlanDigest);
    const waves = [],
      identities = new Set();
    for (const key of keys) {
      assert.ok(
        !fs.readdirSync(path.join(root, key)).includes("unknown.json"),
        `unreconciled review wave: ${key}`,
      );
      assert.ok(
        fs.existsSync(path.join(root, key, "complete.json")),
        `uncollected review wave: ${key}`,
      );
      const { plan } = load(context, key, appliedPlanDigest);
      const complete = await collectUnlocked(
        context,
        key,
        plan.planDigest,
        appliedPlanDigest,
      );
      assert.equal(
        complete.verdict,
        "pass",
        `review wave did not pass: ${key}`,
      );
      // Independently check the complete inventory, not a possibly incomplete
      // predecessor projection from any one launch intent.
      for (const identity of [
        `run:${complete.runId}`,
        ...complete.reports.flatMap((row) => [
          `run:${row.runId}`,
          `session:${row.sessionId}`,
          `file:${row.sessionFile}`,
        ]),
      ]) {
        assert.ok(
          !identities.has(identity),
          "review inventory reuses identity",
        );
        identities.add(identity);
      }
      waves.push({
        key,
        planDigest: plan.planDigest,
        completionDigest: digest(complete),
        runId: complete.runId,
      });
    }
    context.assertOwner();
    assert.deepEqual(
      reviewInventory(root),
      keys,
      "review inventory changed during sealing",
    );
    assert.equal(
      readRequest(context, appliedPlanDigest).digest,
      request.digest,
      "review source changed during sealing",
    );
    const body = {
      schemaVersion: "teams-integration-review-candidate/1",
      ownerSessionId: context.ownerSessionId,
      requestDigest: request.digest,
      waves,
      acceptance: "not-assessed",
    };
    const candidate = { ...body, candidateDigest: digest(body) };
    const intent = {
      schemaVersion: "teams-integration-review-candidate-intent/1",
      ownerSessionId: context.ownerSessionId,
      requestDigest: request.digest,
      candidateDigest: candidate.candidateDigest,
    };
    assert.ok(
      canonicalBytes(candidate).length <= 1024 * 1024,
      "review candidate exceeds 1 MiB",
    );
    if (sealed) {
      assert.deepEqual(
        json(intentFile),
        intent,
        "review candidate intent changed",
      );
      assert.deepEqual(json(file), candidate, "review candidate changed");
    } else {
      saveEvidenceJson(intentFile, intent);
      context.assertOwner();
      assert.equal(
        prepareIntegrationReview(context).digest,
        request.digest,
        "review source changed before seal publication",
      );
      assert.deepEqual(
        reviewInventory(root),
        keys,
        "review inventory changed before seal publication",
      );
      saveEvidenceJson(file, candidate);
    }
    if (appliedPlanDigest !== undefined) {
      const applied = verifyIntegrationApply(context, appliedPlanDigest);
      assert.deepEqual(
        applied.reviewBinding,
        integrationReviewBinding(
          context,
          readIntegrationRehearsal(context),
          candidate,
        ),
        "applied review authority binding changed",
      );
    }
    context.assertOwner();
    return candidate;
  });
}

function childrenFor(context, request, wave) {
  const view = {
    ...context.contract,
    workspace: {
      ...context.contract.workspace,
      sourceRoot: request.subject.cwd,
      worktreePath: null,
      allowedWritePaths: [],
    },
  };
  const admitted = prepareRoleWave(view, request.subject.cwd, wave);
  assert.ok(
    admitted.members.every(
      (row) => row.mode === "review" && row.isolation === "shared",
    ),
    "review wave must be read-only on frozen source",
  );
  const schema = integrationReviewSchema(request);
  assert.ok(
    canonicalBytes(schema).length <= 64 * 1024,
    "review schema exceeds native limit",
  );
  const children = wave.runs.map((run, index) => ({
    key: run.key,
    agent: run.role,
    model: admitted.children[index].model,
    agentScope: "user",
    cwd: request.subject.cwd,
    task: [
      run.task,
      `Read the frozen review request at ${path.join(context.mailbox.root, "integration/review-request.json")}.`,
      `Request digest: ${request.digest}. Review the complete merged source and exact patch, including deletions, against every criterion.`,
      "Read-only: do not modify source, fixtures, config, caches or evidence. Do not run side-effectful checks or delegate. Use structured_output for the review report, not a writer acceptanceReport. Missing evidence is blocked or needs-user, never PASS.",
      "Read subject.hostChecks: these controller-verified checks map criterionIds to source-bound receipt/log paths and SHA-256 digests. Read those designated receipts/logs to assess what was actually verified; do not rerun checks. acceptance=not-assessed means final acceptance is pending, not that host checks are absent. A passing check does not replace independent source review.",
      "sourcePaths must use only the frozen relative paths allowed by the output schema. Cite the specification and host evidence in reason/rationale, not as extra sourcePaths. Return needs-user for an unresolved question; this final review does not use supervisor coordination.",
    ].join("\n"),
    context: "fresh",
    // Keep the declared read-only launch identical to public preflight. The
    // native bridge otherwise mutates the agent prompt/tools after preflight.
    intercomBridge: { mode: "off" },
    async: false,
    worktree: false,
    output: false,
    outputMode: "inline",
    outputSchema: schema,
    timeoutMs: context.contract.policy.deadlineMs,
  }));
  return {
    admitted,
    children: budgetedChildren(context, children, `review.${wave.key}`),
  };
}

async function resolveChildren(adapter, request, children, sessionDir) {
  assert.equal(
    typeof adapter?.resolve,
    "function",
    "public review resolver required",
  );
  const contracts = [];
  for (const {
    key,
    worktree: _worktree,
    timeoutMs: _timeout,
    ...input
  } of children) {
    const resolution = await adapter.resolve({
      ...input,
      sessionDir: path.join(sessionDir, key),
    });
    if (input.extensionBindings?.[TASK_BUDGET_BINDING])
      assertBudgetHook(resolution);
    const checked = validateReviewLaunch(request, resolution);
    assert.equal(
      checked.role,
      input.agent,
      "resolved reviewer differs from requested agent",
    );
    assert.ok(
      ["user", "package", "builtin"].includes(resolution.contract.agent.source),
      "source-controlled or unknown review agent is forbidden",
    );
    contracts.push({ key, ...checked, publicContract: resolution.contract });
  }
  return contracts;
}

function load(context, key, appliedPlanDigest) {
  assert.match(key, keyPattern, "invalid review wave key");
  const dir = path.join(context.mailbox.root, "integration/reviews", key);
  const plan = json(path.join(dir, "plan.json"));
  const { planDigest, ...body } = plan;
  assert.equal(plan.schemaVersion, "teams-review-wave-plan/1");
  assert.equal(digest(body), planDigest, "review plan changed");
  assert.equal(
    plan.ownerSessionId,
    context.ownerSessionId,
    "review owner changed",
  );
  assert.equal(
    plan.contractDigest,
    digest(context.contract),
    "review contract changed",
  );
  assert.equal(plan.key, key, "review wave identity changed");
  assert.equal(
    plan.sessionDir,
    path.join(dir, "sessions"),
    "review session root changed",
  );
  const request = readRequest(context, appliedPlanDigest);
  assert.equal(plan.requestDigest, request.digest, "review source changed");
  const rebuilt = childrenFor(context, request, plan.wave);
  assert.deepEqual(
    rebuilt.children,
    plan.children,
    "review launch input changed",
  );
  assert.equal(
    plan.reservedTokens,
    rebuilt.admitted.reservedTokens,
    "review reservation changed",
  );
  return { dir, plan, request };
}

export async function planReviewWave(context, wave, adapter) {
  return locked(context, async (root) => {
    const request = prepareIntegrationReview(context);
    const { admitted, children } = childrenFor(context, request, wave);
    const dir = path.join(root, admitted.key);
    if (fs.existsSync(dir)) {
      const stored = load(context, admitted.key).plan;
      assert.deepEqual(
        stored.wave,
        wave,
        "review key reused with different work",
      );
      return stored; // No repeated preflight or model call for an identical plan.
    }
    assertReviewOpen(root);
    const sessionDir = path.join(dir, "sessions");
    const launches = await resolveChildren(
      adapter,
      request,
      children,
      sessionDir,
    );
    context.assertOwner();
    assert.equal(
      prepareIntegrationReview(context).digest,
      request.digest,
      "review source changed during preflight",
    );
    const body = {
      schemaVersion: "teams-review-wave-plan/1",
      key: admitted.key,
      wave,
      children,
      launches,
      ownerSessionId: context.ownerSessionId,
      nativeOwner: adapter.nativeOwner,
      hostedWorkflow: { version: 1, pid: process.pid },
      contractDigest: digest(context.contract),
      requestDigest: request.digest,
      sessionDir,
      reservedTokens: admitted.reservedTokens,
      acceptance: "not-assessed",
    };
    assert.ok(
      typeof body.nativeOwner === "string" &&
        body.nativeOwner.length > 0 &&
        body.nativeOwner.length <= 4096,
      "native owner identity required",
    );
    const plan = { ...body, planDigest: digest(body) };
    assert.ok(
      canonicalBytes(plan).length <= 1024 * 1024,
      "review plan exceeds 1 MiB",
    );
    fs.mkdirSync(dir, { mode: 0o700 });
    saveEvidenceJson(path.join(dir, "plan.json"), plan);
    return plan;
  });
}

async function assertAllocations(context, root, plan) {
  const progress = context.mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => context.mailbox.readJson(event.payloadRef, 16 * 1024));
  const prior = progress.filter((event) => event.kind === "role-launch-intent");
  const startedMembers = progress
    .filter((event) => event.kind === "role-started")
    .flatMap((event) => {
      assert.ok(Array.isArray(event.members), "prior role inventory unknown");
      return event.members;
    });
  assert.equal(
    prior.length,
    startedMembers.length,
    "prior role admissions incomplete",
  );
  assert.ok(
    startedMembers.every(
      (row) => Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0,
    ),
    "prior started allocation unknown",
  );
  assert.equal(
    prior.reduce((sum, row) => sum + row.maxTokens, 0),
    startedMembers.reduce((sum, row) => sum + row.maxTokens, 0),
    "prior role allocation mismatch",
  );
  assert.ok(
    prior.every(
      (row) => Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0,
    ),
    "prior role allocation unknown",
  );
  let count = prior.length,
    tokens = prior.reduce((sum, row) => sum + row.maxTokens, 0);
  const predecessors = [],
    reviews = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const dir = path.join(root, item.name),
      intent = path.join(dir, "launch-intent.json");
    if (!fs.existsSync(intent)) continue;
    assert.ok(
      fs.existsSync(path.join(dir, "complete.json")),
      "unsettled review wave; reconcile before further dispatch",
    );
    const old = load(context, item.name).plan;
    const complete = await collectUnlocked(context, item.name, old.planDigest);
    assert.equal(
      complete.planDigest,
      old.planDigest,
      "review completion identity changed",
    );
    assert.equal(
      complete.state,
      "bound",
      "review wave lacks bound terminal evidence",
    );
    predecessors.push({ key: old.key, completionDigest: digest(complete) });
    reviews.push(complete);
    // Historical reservations are never refunded, even after failure or a BLOCKED report.
    count += old.children.length;
    tokens += old.reservedTokens;
  }
  assert.ok(
    count + plan.children.length <=
      context.contract.policy.maxRoleSpawnsPerTask,
    "task review spawn budget exhausted",
  );
  assert.ok(
    Number.isSafeInteger(tokens) &&
      (usesSharedTaskBudget(context.contract) ||
        tokens + plan.reservedTokens <= context.contract.policy.maxTaskTokens),
    "task review token allocations exhausted",
  );
  return { predecessors, reviews };
}

function measuredAdmission(context, plan, reviews, previous = null) {
  const staged = readIntegrationRehearsal(context);
  const readNative = (origin, limit) => {
    const matches = staged.captures.filter((row) => row.origin === origin);
    assert.equal(matches.length, 1, "captured native usage source missing");
    const saved = matches[0];
    const bytes = readEvidenceBytes(
      path.join(context.mailbox.root, "integration", saved.saved),
      limit,
    );
    assert.equal(
      bytesDigest(bytes),
      saved.sha256,
      "captured native usage source changed",
    );
    return bytes;
  };
  return reviewUsageAdmission(
    context,
    plan,
    measureExecutionUsage(context, { readNative, reviews, previous }),
  );
}

function dispatchParams(context, plan, request) {
  return {
    workflowScript: compileRoleWave(plan.children, plan.sessionDir),
    cwd: request.subject.cwd,
    agentScope: "user",
    async: true,
    context: "fresh",
    sessionDir: plan.sessionDir,
    mission: {
      title: `Task ${context.contract.identity.executionId} review ${plan.key}`,
    },
    timeoutMs: context.contract.policy.deadlineMs,
    usageBudget: {
      tokens: {
        hard: usesSharedTaskBudget(context.contract)
          ? context.contract.policy.maxTaskTokens
          : plan.reservedTokens,
      },
    },
  };
}

export async function startReviewWave(context, key, planDigest, adapter) {
  return locked(context, async (root) => {
    assertReviewOpen(root);
    const { dir, plan, request } = load(context, key);
    assert.equal(
      plan.planDigest,
      planDigest,
      "explicit review plan digest mismatch",
    );
    const intentPath = path.join(dir, "launch-intent.json");
    if (fs.existsSync(intentPath))
      throw new Error(
        "review launch intent consumed; inspect/reconcile, never replay",
      );
    const { predecessors, reviews } = await assertAllocations(
      context,
      root,
      plan,
    );
    // Allocation is not actual consumption or lifecycle readiness. There is no
    // permissive default: production cannot launch until L0 owns those proofs.
    assert.equal(
      typeof adapter?.assertAdmission,
      "function",
      "review actual-usage/lifecycle admission unavailable (D5/D7)",
    );
    assert.equal(
      typeof adapter?.rpc?.request,
      "function",
      "public review RPC required",
    );
    assert.equal(
      adapter.nativeOwner,
      plan.nativeOwner,
      "native session owner changed",
    );
    assert.ok(
      !fs.existsSync(plan.sessionDir),
      "review session root already exists; reconcile before dispatch",
    );
    const launches = await resolveChildren(
      adapter,
      request,
      plan.children,
      plan.sessionDir,
    );
    assert.deepEqual(
      launches,
      plan.launches,
      "public review launch contract changed before dispatch",
    );
    const beforeAdmission = measuredAdmission(context, plan, reviews);
    // Lifecycle remains a separate required host assertion; metering is not a grant.
    assert.equal(
      await adapter.assertAdmission(context, plan),
      undefined,
      "host admission must assert, not return an approval flag",
    );
    const usageAdmission = measuredAdmission(
      context,
      plan,
      reviews,
      beforeAdmission,
    );
    context.assertOwner();
    assert.equal(
      prepareIntegrationReview(context).digest,
      request.digest,
      "review source changed before dispatch",
    );
    const params = dispatchParams(context, plan, request);
    registerTaskBudgetMembers(
      context,
      plan.wave.runs.map((member) => ({
        key: `review.${key}.${member.key}`,
        estimate: member.maxTokens,
        sessionRoot: path.join(plan.sessionDir, member.key),
      })),
    );
    saveEvidenceJson(intentPath, {
      schemaVersion: "teams-review-launch-intent/2",
      planDigest,
      params,
      paramsDigest: digest(params),
      predecessors,
      usageAdmission,
      usageAdmissionDigest: digest(usageAdmission),
    });
    let startFailure,
      failurePersisted = false;
    try {
      let response;
      try {
        response = await adapter.rpc.request("spawn", params);
      } catch (cause) {
        response = readNativeStartFailure(
          cause,
          {
            sessionDir: plan.sessionDir,
            mode: "wave",
            members: plan.wave.runs.map(({ key, role }) => ({ key, role })),
          },
          [plan.nativeOwner],
        );
        if (!response) throw cause;
        startFailure = cause;
      }
      const runId =
        response?.runId ??
        response?.asyncId ??
        response?.details?.runId ??
        response?.details?.asyncId;
      const asyncDir = response?.asyncDir ?? response?.details?.asyncDir;
      assert.match(runId, runPattern, "native review run id missing");
      assert.ok(
        typeof asyncDir === "string" && path.isAbsolute(asyncDir),
        "native review async directory missing",
      );
      const started = {
        schemaVersion: "teams-review-started/1",
        planDigest,
        runId,
        asyncDir,
        nativeOwner: plan.nativeOwner,
      };
      saveEvidenceJson(path.join(dir, "started.json"), started); // Native run identity, not proof that a process started.
      if (startFailure) {
        captureNativeTerminal(
          context.mailbox,
          {
            ...started,
            sessionDir: plan.sessionDir,
            mode: "wave",
            members: plan.wave.runs.map(({ key, role }) => ({ key, role })),
          },
          [plan.nativeOwner],
          `review-${key}`,
        );
        failurePersisted = true;
        throw startFailure;
      }
      context.assertOwner();
      return started;
    } catch (cause) {
      if (failurePersisted)
        throw new Error(
          `review failed before runner spawn; cancel without retry: ${cause.message}`,
          { cause },
        );
      saveEvidenceJson(path.join(dir, "unknown.json"), {
        planDigest,
        error: String(cause.message ?? cause).slice(0, 2000),
        disposition: "preserved-reconcile-required",
      });
      throw new Error("review launch outcome unknown; reconcile before retry", {
        cause,
      });
    }
  });
}

// Bind the public result projection to a successful structured_output tool call
// in the captured native session. A usage-only or unrelated session is not proof.
function sessionReport(bytes, report) {
  let entries;
  try {
    entries = bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (cause) {
    throw new Error("invalid review session JSON", { cause });
  }
  const header = entries.shift();
  assert.equal(header?.type, "session", "review session header missing");
  assert.equal(header.version, 3, "unsupported review session schema");
  const ids = new Set(),
    callIds = new Set(),
    calls = new Map();
  let submitted = 0;
  for (const entry of entries) {
    assert.notEqual(entry.type, "session", "multiple review session headers");
    assert.ok(
      typeof entry.id === "string" && entry.id && !ids.has(entry.id),
      "review session entry identity missing or repeated",
    );
    ids.add(entry.id);
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const call of message.content ?? []) {
        if (call.type !== "toolCall" || call.name !== "structured_output")
          continue;
        assert.ok(
          typeof call.id === "string" && call.id && !callIds.has(call.id),
          "review submission identity missing or repeated",
        );
        callIds.add(call.id);
        calls.set(call.id, call.arguments?.value);
      }
    }
    if (
      message?.role !== "toolResult" ||
      message.toolName !== "structured_output"
    )
      continue;
    assert.ok(
      calls.has(message.toolCallId),
      "review submission receipt lacks its call",
    );
    const value = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    assert.equal(
      typeof message.isError,
      "boolean",
      "review submission result unknown",
    );
    if (!message.isError) {
      assert.deepEqual(
        value,
        report,
        "native review report differs from session submission",
      );
      submitted++;
    }
  }
  assert.equal(calls.size, 0, "review submission has no terminal tool result");
  assert.equal(submitted, 1, "one successful review submission required");
  return header;
}

function terminal(status, runId, launch = null) {
  assert.equal(status.runId, runId, "review run identity mismatch");
  assert.equal(status.state, "complete", "native review not complete");
  assert.ok(
    !status.error && !status.timedOut && !status.stopped,
    "native review failed",
  );
  const proof = status.processTerminal;
  if (launch?.hostedWorkflow && !Object.hasOwn(status, "processTerminal")) {
    assert.ok(
      readNativeTerminal(launch, launch.owners, () =>
        Buffer.from(JSON.stringify(status)),
      ),
      "hosted review unresolved",
    );
  } else {
    assert.equal(proof?.version, 1, "native review terminal schema missing");
    assert.equal(
      proof.runId,
      runId,
      "native review terminal identity mismatch",
    );
    assert.equal(
      proof.state,
      "observed",
      "native review process not observed terminal",
    );
    assert.match(
      proof.runnerProcessInstanceId,
      runPattern,
      "native review process identity missing",
    );
  }
  assert.notEqual(
    status.usageBudget?.exhausted,
    true,
    "native review budget exhausted",
  );
}

export async function collectReviewWave(context, key, planDigest) {
  return locked(context, () =>
    collectUnlocked(context, key, planDigest, undefined, true),
  );
}

async function collectUnlocked(
  context,
  key,
  planDigest,
  appliedPlanDigest,
  allowRunning = false,
) {
  const { dir, plan, request } = load(context, key, appliedPlanDigest);
  assert.equal(
    plan.planDigest,
    planDigest,
    "explicit review plan digest mismatch",
  );
  const intent = json(path.join(dir, "launch-intent.json"));
  assert.equal(
    intent.schemaVersion,
    "teams-review-launch-intent/2",
    "unknown or unmetered review intent schema",
  );
  assert.equal(intent.planDigest, planDigest, "review intent changed");
  assert.equal(
    digest(intent.usageAdmission),
    intent.usageAdmissionDigest,
    "review usage admission changed",
  );
  assert.deepEqual(
    reviewUsageAdmission(context, plan, intent.usageAdmission),
    intent.usageAdmission,
    "review usage admission policy changed",
  );
  assert.equal(
    intent.paramsDigest,
    digest(intent.params),
    "review dispatch changed",
  );
  assert.deepEqual(
    intent.params,
    dispatchParams(context, plan, request),
    "review dispatch envelope changed",
  );
  const started = json(path.join(dir, "started.json"));
  assert.equal(
    started.schemaVersion,
    "teams-review-started/1",
    "unknown review started schema",
  );
  assert.equal(started.planDigest, planDigest, "native review binding changed");
  assert.equal(
    started.nativeOwner,
    plan.nativeOwner,
    "native review started owner changed",
  );
  assert.match(
    started.runId,
    runPattern,
    "native review started identity missing",
  );
  assert.ok(
    typeof started.asyncDir === "string" &&
      path.isAbsolute(started.asyncDir) &&
      path.resolve(started.asyncDir) === started.asyncDir,
    "canonical native review directory required",
  );
  const completedPath = path.join(dir, "complete.json");
  const capturesPath = path.join(dir, "captures");
  let captured;
  let totalBytes = 0;
  if (fs.existsSync(completedPath)) captured = json(completedPath);
  else {
    assert.equal(
      appliedPlanDigest,
      undefined,
      "after-apply reader requires existing review capture",
    );
    assert.ok(
      !fs.existsSync(capturesPath),
      "incomplete review capture; reconcile before retry",
    );
  }
  const files = new Map();
  function read(file, limit = 1024 * 1024) {
    assert.ok(
      typeof file === "string" && path.isAbsolute(file),
      "absolute native review reference required",
    );
    if (files.has(file)) return files.get(file).bytes;
    const saved = captured?.captures.find((row) => row.origin === file);
    if (captured)
      assert.ok(
        saved && /^captures\/\d+\.bin$/.test(saved.saved),
        "native review capture missing",
      );
    const bytes = readEvidenceBytes(
      saved ? path.join(dir, saved.saved) : file,
      limit,
    );
    if (saved)
      assert.equal(
        bytesDigest(bytes),
        saved.sha256,
        "native review capture changed",
      );
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "review evidence exceeds 64 MiB");
    files.set(file, { origin: file, bytes, sha256: bytesDigest(bytes) });
    return bytes;
  }
  function parsed(file) {
    try {
      return JSON.parse(read(file).toString("utf8"));
    } catch (cause) {
      throw new Error("invalid native review JSON", { cause });
    }
  }
  const status = parsed(path.join(started.asyncDir, "status.json"));
  assert.equal(status.runId, started.runId, "review run identity mismatch");
  assert.equal(status.cwd, request.subject.cwd, "native review cwd changed");
  assert.equal(
    status.sessionId,
    plan.nativeOwner,
    "native review owner mismatch",
  );
  if (allowRunning && !captured && status.state === "running") {
    assert.ok(
      !status.error && !status.timedOut && !status.stopped,
      "native review failed",
    );
    assert.notEqual(
      status.usageBudget?.exhausted,
      true,
      "native review budget exhausted",
    );
    context.assertOwner();
    return {
      state: "running",
      verdict: "pending",
      acceptance: "not-assessed",
      key,
      planDigest,
      runId: started.runId,
    };
  }
  terminal(status, started.runId, {
    ...started,
    hostedWorkflow: plan.hostedWorkflow,
    owners: [plan.nativeOwner],
    mode: "wave",
    members: plan.wave.runs.map(({ key, role }) => ({ key, role })),
  });
  // Hosted workflows expose the public sidecar, not always a status pointer.
  // Do not mask an explicitly invalid reference with a fallback.
  const receipt = parsed(
    Object.hasOwn(status, "workflowReceiptPath")
      ? status.workflowReceiptPath
      : path.join(started.asyncDir, "workflow-receipt.json"),
  );
  assert.equal(receipt.version, 1, "unknown review workflow receipt");
  assert.equal(
    receipt.workflowRunId,
    started.runId,
    "review workflow identity mismatch",
  );
  assert.equal(receipt.state, "complete", "review workflow incomplete");
  const keys = plan.children.map((child) => child.key).sort();
  assert.deepEqual(
    Object.keys(receipt.entries).sort(),
    keys,
    "review receipt inventory mismatch",
  );
  assert.deepEqual(
    status.steps?.map((step) => step.workflowKey).sort(),
    keys,
    "review native step inventory mismatch",
  );
  assert.deepEqual(
    status.workflow?.value?.map((row) => row.key).sort(),
    keys,
    "review compiler inventory mismatch",
  );
  const native = json(
    path.join(context.mailbox.root, "integration/native.json"),
  );
  const producerIds = [
    ...context.result.childRunRefs,
    ...native.lanes.map((lane) => lane.runId),
  ];
  assert.ok(
    !producerIds.includes(started.runId),
    "review root reuses producer identity",
  );
  const ids = new Set([...producerIds, started.runId]);
  const boot = context.mailbox.readJson("receipts/boot.json");
  const sessions = new Set(),
    sessionIds = new Set([context.ownerSessionId, boot.workerSessionId]);
  assert.ok(
    Array.isArray(intent.predecessors) &&
      intent.predecessors.length <=
        context.contract.policy.maxRoleSpawnsPerTask,
    "bounded review predecessors required",
  );
  for (const prior of intent.predecessors) {
    assert.match(prior.key, keyPattern);
    assert.notEqual(prior.key, key);
    const old = json(path.join(path.dirname(dir), prior.key, "complete.json"));
    assert.equal(
      digest(old),
      prior.completionDigest,
      "prior review completion changed",
    );
    assert.ok(!ids.has(old.runId), "review root identity reused across waves");
    ids.add(old.runId);
    for (const row of old.reports) {
      assert.notEqual(
        row.runId,
        started.runId,
        "review root reuses an earlier child identity",
      );
      ids.add(row.runId);
      sessions.add(row.sessionFile);
      sessionIds.add(row.sessionId);
    }
  }
  const reports = [];
  for (const child of plan.children) {
    const row = status.workflow.value.find((value) => value.key === child.key);
    const display = status.steps.find(
      (value) => value.workflowKey === child.key,
    );
    const step =
      plan.hostedWorkflow && !Object.hasOwn(status, "processTerminal")
        ? nativeWorkflowResult(status, display)
        : display;
    const entry = receipt.entries[child.key];
    assert.equal(row.ok, true, "native review child failed");
    assert.match(row.runId, runPattern, "review child run id missing");
    assert.ok(!ids.has(row.runId), "review child identity reused");
    ids.add(row.runId);
    assert.equal(entry.key, child.key);
    assert.equal(entry.agent, child.agent);
    assert.equal(entry.latestRunId, row.runId, "review receipt run mismatch");
    assert.deepEqual(
      entry.continuation?.runIds,
      [row.runId],
      "resumed review cannot prove independence",
    );
    assert.equal(step.runId, row.runId, "review step run mismatch");
    assert.equal(step.agent, child.agent, "reviewer identity mismatch");
    assert.ok(
      ["complete", "completed"].includes(step.status),
      "review step incomplete",
    );
    assert.equal(step.context, "fresh", "native reviewer context not fresh");
    assert.equal(step.exitCode, 0, "reviewer exit not successful");
    assert.ok(
      !step.error &&
        !step.stopped &&
        !step.timedOut &&
        !step.runner &&
        !step.children?.length &&
        (step.modelAttempts?.length ?? 0) <= 1 &&
        (step.attemptedModels?.length ?? 0) <= 1,
      "unsupported/failed reviewer lifecycle",
    );
    if (step.async === true)
      terminal({ ...step, state: "complete" }, row.runId);
    assert.notEqual(
      step.acceptance?.status,
      "rejected",
      "native review rejected",
    );
    assert.ok(
      !step.acceptance?.effectiveAcceptance?.review?.required,
      "reviewer itself has unresolved required review",
    );
    const launch = plan.launches.find((value) => value.key === child.key);
    assert.equal(
      step.launchContractDigest,
      launch.launchContractDigest,
      "actual review launch digest mismatch",
    );
    assert.ok(
      inside(plan.sessionDir, step.sessionFile),
      "review session outside owned root",
    );
    assert.ok(!sessions.has(step.sessionFile), "review session reused");
    sessions.add(step.sessionFile);
    const report = validateReviewReport(request, row.structuredOutput);
    const bytes = read(step.sessionFile, 8 * 1024 * 1024);
    const header = sessionReport(bytes, report);
    assert.equal(header.cwd, request.subject.cwd);
    assert.match(header.id, runPattern, "review session identity missing");
    assert.ok(
      !header.parentSession && !sessionIds.has(header.id),
      "review session is branched or reused",
    );
    sessionIds.add(header.id);
    assert.deepEqual(
      step.structuredOutput,
      report,
      "review result projections disagree",
    );
    reports.push({
      key: child.key,
      runId: row.runId,
      sessionId: header.id,
      sessionFile: step.sessionFile,
      report,
      maxTokens: plan.wave.runs.find((run) => run.key === child.key).maxTokens,
    });
  }
  context.assertOwner();
  assert.equal(
    readRequest(context, appliedPlanDigest).digest,
    request.digest,
    "review source changed at completion",
  );
  if (!captured) {
    fs.mkdirSync(capturesPath, { mode: 0o700 });
    for (const [index, file] of [...files.values()].entries()) {
      const fd = fs.openSync(
        path.join(capturesPath, `${index}.bin`),
        "wx",
        0o600,
      );
      try {
        fs.writeFileSync(fd, file.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  const captures = [...files.values()].map((file, index) => ({
    origin: file.origin,
    saved:
      captured?.captures.find((value) => value.origin === file.origin)?.saved ??
      `captures/${index}.bin`,
    sha256: file.sha256,
  }));
  for (const report of reports) {
    try {
      report.usage = measureSessionBytes(
        files.get(report.sessionFile).bytes,
      ).usage;
    } catch (cause) {
      throw new Error("review usage unknown", { cause });
    }
    assert.ok(
      usesSharedTaskBudget(context.contract) ||
        report.usage.total <= report.maxTokens,
      "review member budget exceeded",
    );
  }
  assert.ok(
    usesSharedTaskBudget(context.contract) ||
      reports.reduce((sum, row) => sum + row.usage.total, 0) <=
        plan.reservedTokens,
    "review wave budget exceeded",
  );
  assertTaskBudgetUsage(
    context,
    reports.map((report) => ({ ...report, kind: "review" })),
  );
  const complete = {
    schemaVersion: "teams-review-wave-completion/1",
    planDigest,
    requestDigest: request.digest,
    runId: started.runId,
    state: "bound",
    usageAdmission: intent.usageAdmission,
    verdict: reports.every((row) => row.report.verdict === "pass")
      ? "pass"
      : "blocked",
    reports,
    captures,
    acceptance: "not-assessed",
  };
  assert.ok(
    canonicalBytes(complete).length <= 1024 * 1024,
    "review completion exceeds 1 MiB",
  );
  context.assertOwner();
  assert.equal(
    readRequest(context, appliedPlanDigest).digest,
    request.digest,
    "review source changed after capture",
  );
  if (captured)
    assert.deepEqual(captured, complete, "review completion changed");
  else saveEvidenceJson(completedPath, complete);
  context.assertOwner();
  return complete;
}
