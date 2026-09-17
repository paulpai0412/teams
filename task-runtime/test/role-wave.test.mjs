import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWorktreeBase, prepareRoleWave } from "../role-wave.mjs";
import { verifyNativeRoleStatus } from "../acceptance.mjs";
import { prepareTodoWorkspace } from "../e2e/run-todo-flow.mjs";
import { captureWorkspace, verifyWorkspaceScope } from "../workspace-scope.mjs";
import { digest } from "../contracts.mjs";

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-wave-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-q");
  fs.writeFileSync(path.join(root, "source.txt"), "baseline\n");
  git("add", "source.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "baseline",
  );
  return { root, head: git("rev-parse", "HEAD") };
}

function contract(root, head) {
  return {
    workspace: {
      sourceRoot: root,
      baseCommit: head,
      allowedWritePaths: ["source.txt"],
    },
    criteria: [{ text: "Produce the requested outcome." }],
    policy: {
      allowedRoles: ["team.implementer"],
      maxActiveRoleRuns: 4,
      maxTaskTokens: 100,
      deadlineMs: 1000,
    },
  };
}

function wave(isolation = "worktree") {
  return {
    key: "independent-slices",
    reason: "Independent source slices with a parent-owned integration step.",
    runs: ["alpha", "beta"].map((key) => ({
      key,
      role: "team.implementer",
      task: `Work only on slice ${key}.`,
      mode: "mutation",
      isolation,
      maxTokens: 20,
    })),
  };
}

test("fresh Todo source admits real Goal metadata without weakening worktree cleanliness", (t) => {
  const { root, head } = repository(t);
  const before = fs.readFileSync(path.join(root, ".git/info/exclude"), "utf8");
  const prepared = prepareTodoWorkspace(root);
  assert.equal(prepared.baseCommit, head);
  assert.ok(
    fs
      .readFileSync(path.join(root, ".git/info/exclude"), "utf8")
      .startsWith(before),
  );
  fs.mkdirSync(path.join(root, ".pi/goals"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pi/goals/active_goal_fixture.md"),
    "control metadata",
  );
  fs.writeFileSync(path.join(root, ".pi/.goals-pool-snapshot.json"), "{}");
  assert.equal(
    prepareRoleWave(contract(root, head), root, wave()).baseCommit,
    head,
  );
  assert.throws(() => prepareTodoWorkspace(root), /before creating a Goal/);
  for (const name of [
    ".pi/other.json",
    ".pi/.goals-pool-snapshot.json.bak",
    "source.txt",
  ]) {
    const file = path.join(root, name);
    const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, "must remain dirty");
    assert.throws(
      () => prepareRoleWave(contract(root, head), root, wave()),
      /clean baseline/,
    );
    if (original) fs.writeFileSync(file, original);
    else fs.unlinkSync(file);
  }
  fs.mkdirSync(path.join(root, "nested/.pi/goals"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "nested/.pi/goals/other.md"),
    "not source-root control data",
  );
  assert.throws(() => inspectWorktreeBase(root, head), /clean baseline/);
});

test("shared Git excludes do not exempt Goal lookalikes in a linked worktree from D6", (t) => {
  const { root, head } = repository(t);
  prepareTodoWorkspace(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "todo-linked-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const linked = path.join(outside, "worktree"),
    runtime = path.join(outside, "runtime");
  fs.mkdirSync(runtime);
  const created = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      linked,
      head,
    ],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const request = {
    ...contract(root, head),
    schemaVersion: "teams-task-runtime/3",
  };
  request.workspace.worktreePath = linked;
  const baseline = captureWorkspace(request, runtime);
  const mailbox = {
    root: path.join(runtime, "projects/p/executions/e"),
    readJson: (file) =>
      file === "bootstrap.json"
        ? { workspaceBaselineDigest: digest(baseline) }
        : baseline,
  };
  fs.mkdirSync(path.join(linked, ".pi/goals"), { recursive: true });
  fs.writeFileSync(
    path.join(linked, ".pi/goals/lookalike.md"),
    "not authorized control data",
  );
  // Git shares info/exclude with worktrees, but the existing scope gate does not use Git ignores.
  assert.equal(inspectWorktreeBase(linked, head), head);
  assert.throws(
    () => verifyWorkspaceScope(request, mailbox),
    /outside allowed write scope/,
  );
});

test("Todo preparation refuses dirty repositories and symlinked Git exclusion files", (t) => {
  const dirty = repository(t);
  fs.writeFileSync(path.join(dirty.root, "source.txt"), "dirty");
  assert.throws(() => prepareTodoWorkspace(dirty.root), /clean baseline/);
  const clean = repository(t);
  const outside = path.join(
    os.tmpdir(),
    `exclude-${process.pid}-${Date.now()}`,
  );
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.unlinkSync(path.join(clean.root, ".git/info/exclude"));
  fs.symlinkSync(outside, path.join(clean.root, ".git/info/exclude"));
  assert.throws(() => prepareTodoWorkspace(clean.root));
  assert.equal(fs.existsSync(outside), false);
});

test("D1 multiple same-role writers compile to native managed worktrees, never auto-merge", async (t) => {
  const { root, head } = repository(t);
  const plan = prepareRoleWave(contract(root, head), root, wave());
  assert.equal(plan.baseCommit, head);
  assert.equal(plan.reservedTokens, 40);
  assert.ok(
    plan.children.every(
      (child) => child.worktree === true && child.baseRef === undefined,
    ),
  );
  assert.deepEqual(
    plan.members.map((member) => member.role),
    ["team.implementer", "team.implementer"],
  );
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    "runs",
    plan.workflowScript,
  );
  let items;
  const results = await run({
    async all(children) {
      items = children;
      return children.map(() => ({
        ok: true,
        runId: "retained",
        artifactPaths: ["native/patch-handoff"],
      }));
    },
  });
  assert.equal(items.length, 2);
  assert.deepEqual(
    results.map((result) => result.key),
    ["alpha", "beta"],
  );
  assert.ok(
    results.every(
      (result) => result.artifactPaths[0] === "native/patch-handoff",
    ),
  );
  await assert.rejects(
    run({
      async all() {
        return [{ ok: true }, { ok: false }];
      },
    }),
    /failed or missing/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "source.txt"), "utf8"),
    "baseline\n",
  );
});

test("D1 worktree admission rejects dirty, stale, nested and non-Git baselines", (t) => {
  const { root, head } = repository(t);
  assert.equal(inspectWorktreeBase(root, head), head);
  assert.throws(
    () => inspectWorktreeBase(root, "0".repeat(40)),
    /baseline changed/,
  );
  fs.writeFileSync(path.join(root, "untracked.txt"), "do not stash\n");
  assert.throws(
    () => prepareRoleWave(contract(root, head), root, wave()),
    /clean baseline/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "untracked.txt"), "utf8"),
    "do not stash\n",
  );
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  assert.throws(() => inspectWorktreeBase(nested, head), /repository root/);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "task-wave-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.throws(() => inspectWorktreeBase(plain, head), /preflight failed/);
});

test("D1 unknown fields, duplicate identities, role caps and unsafe checks reject before compilation", (t) => {
  const { root, head } = repository(t);
  const c = contract(root, head);
  assert.throws(
    () => prepareRoleWave(c, root, { ...wave(), extra: true }),
    /fields changed/,
  );
  const duplicate = wave();
  duplicate.runs[1].key = duplicate.runs[0].key;
  assert.throws(() => prepareRoleWave(c, root, duplicate), /duplicate member/);
  assert.throws(
    () =>
      prepareRoleWave(
        { ...c, policy: { ...c.policy, maxActiveRoleRuns: 1 } },
        root,
        wave(),
      ),
    /active role limit/,
  );
  const checks = wave("shared");
  checks.runs.forEach((run) => {
    run.mode = "check";
  });
  assert.throws(() => prepareRoleWave(c, root, checks), /shared checkout/);
});

test("D1 acceptance refuses missing integration and mismatched native members", (t) => {
  const { root } = repository(t);
  const status = {
    runId: "native",
    cwd: root,
    state: "complete",
    processTerminal: { version: 1, runId: "native", state: "observed" },
    steps: [
      {
        agent: "team.implementer",
        status: "complete",
        acceptance: { status: "checked" },
      },
    ],
  };
  const member = {
    role: "team.implementer",
    mode: "mutation",
    isolation: "worktree",
  };
  assert.throws(
    () =>
      verifyNativeRoleStatus(status, {
        runId: "native",
        cwd: root,
        members: [member],
      }),
    /handoff and integration/,
  );
  assert.throws(
    () =>
      verifyNativeRoleStatus(status, {
        runId: "native",
        cwd: root,
        members: [{ ...member, isolation: "shared", role: "team.reviewer" }],
      }),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      verifyNativeRoleStatus(status, {
        runId: "native",
        cwd: root,
        members: [],
      }),
    /member count/,
  );
});
