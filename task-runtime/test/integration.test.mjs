import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";
import { HostAcceptance } from "../acceptance.mjs";
import { digest } from "../contracts.mjs";
import { inspectNativeHandoffs } from "../native-handoff.mjs";
import { readNativeTerminal, readReviewLifecycle } from "../role-lifecycle.mjs";
import { SubagentsRpcClient } from "../capabilities.mjs";
import {
  measureClosedExecutionUsage,
  measureSessionBytes,
} from "../task-usage.mjs";
import {
  taskBudgetBinding,
  changeTaskBudget,
  registerTaskBudgetMembers,
  readTaskBudget,
  TASK_BUDGET_EXTENSION,
} from "../task-budget.mjs";
import { failingNativeBus } from "./native-launch-fixture.mjs";

function git(cwd, ...args) {
  const r = spawnSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function meteredSession(
  file,
  id,
  cwd,
  usage = { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 10 },
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      { type: "session", version: 3, id, cwd },
      {
        type: "message",
        id: "usage-one",
        message: { role: "assistant", content: [], usage },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  return file;
}

function asHostedStatus(status, declaration) {
  status.mode = "workflow";
  status.pid = declaration.pid;
  delete status.processTerminal;
  delete status.usageBudget;
  delete status.workflowReceiptPath;
  status.workflowChildren = {
    version: 1,
    workflowRunId: status.runId,
    inventoryComplete: true,
    workflowState: "completed",
    children: status.steps.map((step) => ({
      childId: step.workflowKey,
      runId: step.runId,
      agent: step.agent,
      state: "completed",
    })),
  };
  for (const step of status.steps) {
    step.async = false;
    step.status = "completed";
    const row = status.workflow.value.find(
      (row) => row.key === step.workflowKey,
    );
    row.nativeResults = [
      {
        index: 0,
        agent: step.agent,
        context: "fresh",
        exitCode: 0,
        sessionFile: step.sessionFile,
        acceptance: step.acceptance,
        structuredOutput: step.structuredOutput,
        launchContractDigest: step.launchContractDigest,
      },
    ];
  }
}

async function fixture(
  t,
  edits = ["alpha", "beta"],
  checkScript,
  options = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-integration-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  git(source, "init", "-q");
  fs.mkdirSync(path.join(source, "src"));
  fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
  fs.writeFileSync(path.join(source, "src/main.txt"), "base\n");
  fs.writeFileSync(path.join(source, "src/remove.txt"), "remove me\n");
  fs.writeFileSync(
    path.join(source, "src/lines.txt"),
    `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")}\n`,
  );
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const base = git(source, "rev-parse", "HEAD");
  if (options.goalMetadata) {
    fs.appendFileSync(
      path.join(source, ".git/info/exclude"),
      "\n.pi/goals/\n.pi/.goals-pool-snapshot.json\n",
    );
    fs.mkdirSync(path.join(source, ".pi/goals"), { recursive: true });
    fs.writeFileSync(
      path.join(source, ".pi/goals/active_goal_fixture.md"),
      "synthetic Goal pending\n",
    );
    fs.writeFileSync(path.join(source, ".pi/.goals-pool-snapshot.json"), "{}");
  }
  let worker, timer;
  const orchestrator = new TaskOrchestrator({
    runtimeRoot: path.join(
      root,
      options.extensionRuntime ? "teams-task-runtime-v1" : "runtime",
    ),
    ownerSessionId: "owner",
    herdr: {
      async start(input) {
        worker = new WorkerRuntime({ executionRoot: input.executionRoot });
        worker.boot({
          sessionId: "worker",
          ...(options.stoppedWorker
            ? { processId: 99_999_999, processStartedAtTicks: "1" }
            : {}),
          sessionFile: meteredSession(
            path.join(input.executionRoot, "worker-sessions/worker.jsonl"),
            "worker",
            source,
          ),
          cwd: source,
          activeTools: ["read", "team_role_spawn", "team_task_result"],
          extensions: ["teams-worker", "pi-subagents"],
          subagents: {
            compatible: true,
            checks: { protocolV1: true, status: true, spawn: true, stop: true },
            ping: { version: 1 },
          },
        });
        timer = setInterval(() => worker.processControls(), 5);
        return { paneId: "w1:p2", agentName: "worker" };
      },
    },
  });
  t.after(() => {
    clearInterval(timer);
    orchestrator.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepared = orchestrator.prepare({
    ...(options.review ? { schemaVersion: "teams-task-runtime/3" } : {}),
    goalId: "goal",
    taskId: "task",
    taskRevision: 1,
    objective:
      options.integrationMode === "approved-integration"
        ? "Apply isolated changes as a staged diff after explicit confirmation."
        : "Integrate isolated changes without modifying target.",
    nonGoals: ["No publication."],
    workspace: {
      sourceRoot: source,
      worktreePath: null,
      baseCommit: base,
      sourcePaths: options.sourcePaths ?? ["src"],
      allowedWritePaths: ["src"],
    },
    criteria: [
      {
        id: "outcome",
        text: "Merged source passes its check.",
        requiredEvidenceKinds: ["host-check"],
      },
    ],
    checks: [
      {
        commandId: "check",
        executable: process.execPath,
        argv: [
          "-e",
          checkScript ??
            "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('src/main.txt','utf8'),'base\\n');" +
              edits
                .map((edit) =>
                  edit === "binary"
                    ? "a.deepEqual([...fs.readFileSync('src/binary.bin')],[0,255,1,0]);"
                    : `a.ok(fs.existsSync(${JSON.stringify(`src/${edit} space.txt`)}));`,
                )
                .join(""),
        ],
        cwd: source,
        timeoutMs: 3000,
        expectedExitCode: 0,
        criterionIds: ["outcome"],
      },
    ],
    policy: {
      risk: "medium",
      allowedRoles: [
        ...new Set([
          "team.implementer",
          ...(options.review?.allowedRoles ?? []),
        ]),
      ],
      ...(options.review
        ? {
            review: options.review,
            tokenBudgetMode: options.tokenBudgetMode ?? "member-hard",
          }
        : {}),
      maxActiveRoleRuns: 4,
      maxRoleSpawnsPerTask: 4,
      maxProductRepairsPerRole: 1,
      maxReportRepairs: 1,
      maxProcessRestarts: options.maxProcessRestarts ?? 0,
      maxTaskTokens: 1000,
      deadlineMs: 60000,
      integrationMode: options.integrationMode ?? "verify-only",
    },
    contextRefs: [],
  });
  await orchestrator.launch(prepared.executionId, { timeoutMs: 1000 });
  clearInterval(timer);
  const native = path.join(root, "native");
  fs.mkdirSync(native);
  const members = edits.map((_, i) => ({
    key: `lane-${i}`,
    role: "team.implementer",
    mode: "mutation",
    isolation: "worktree",
    maxTokens: options.roleEstimate ?? 100,
    taskDigest: digest("Fixture bounded writer."),
  }));
  const manifests = [];
  const rows = edits.map((edit, i) => {
    const lane = path.join(root, `lane-${i}`);
    git(root, "clone", "-q", "--no-local", source, lane);
    if (edit === "conflict-a" || edit === "conflict-b")
      fs.writeFileSync(path.join(lane, "src/main.txt"), `${edit}\n`);
    else if (edit === "disjoint-a" || edit === "disjoint-b") {
      const file = path.join(lane, "src/lines.txt");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            edit === "disjoint-a" ? "line-0\n" : "line-19\n",
            `${edit}\n`,
          ),
      );
    } else if (edit === "outside")
      fs.writeFileSync(path.join(lane, "outside.txt"), "forbidden\n");
    else if (edit === "symlink")
      fs.symlinkSync("/tmp", path.join(lane, "src/link"));
    else if (edit === "binary") {
      fs.writeFileSync(
        path.join(lane, "src/binary.bin"),
        Buffer.from([0, 255, 1, 0]),
      );
      fs.unlinkSync(path.join(lane, "src/remove.txt"));
    } else
      fs.writeFileSync(
        path.join(lane, `src/${edit} space.txt`),
        edit === "octets" ? Buffer.from([255, 254, 253, 10]) : `${edit}\n`,
      );
    git(lane, "add", "-A");
    const patch = spawnSync(
      "git",
      ["-C", lane, "diff", "--cached", "--binary", "--full-index", base],
      { encoding: "buffer" },
    );
    assert.equal(patch.status, 0);
    const patchPath = path.join(native, `patch-${i}.patch`);
    fs.writeFileSync(patchPath, patch.stdout);
    const runId = `child-${i}`;
    const handoff = {
      version: 1,
      runId,
      mode: "single",
      source: "async",
      cwd: source,
      createdAt: 1,
      updatedAt: 2,
      groups: [
        {
          stepIndex: 0,
          baseCommit: base,
          repoRoot: source,
          children: [
            {
              index: 0,
              taskIndex: 0,
              agent: "team.implementer",
              status: "completed",
              summary: "Synthetic native-format fixture, not a native run.",
              patch: {
                path: patchPath,
                branch: `lane-${i}`,
                changed: true,
                filesChanged: 1,
                insertions: 1,
                deletions: 0,
                diffStat: "fixture",
              },
            },
          ],
          cleanup: {
            state: "complete",
            tasks: [
              {
                index: 0,
                path: lane,
                branch: `lane-${i}`,
                worktreeRemoved: true,
                branchRemoved: true,
              },
            ],
            pruned: true,
          },
        },
      ],
    };
    const manifestPath = path.join(native, `handoff-${i}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(handoff));
    manifests.push({ path: manifestPath, value: handoff, patchPath });
    fs.rmSync(lane, { recursive: true }); // Native worktree no longer needs to exist.
    return {
      key: members[i].key,
      ok: true,
      runId,
      artifactPaths: [manifestPath],
      outputReference: null,
      structuredOutput: null,
    };
  });
  const workflow = {
    version: 1,
    workflowRunId: "wave",
    state: "complete",
    createdAt: 2,
    entries: Object.fromEntries(
      rows.map((row) => [
        row.key,
        {
          key: row.key,
          agent: "team.implementer",
          latestRunId: row.runId,
          continuation: { runIds: [row.runId] },
          resumability: { state: "resumable" },
        },
      ]),
    ),
  };
  const workflowPath = path.join(native, "workflow-receipt.json");
  fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const sessionDir = path.join(prepared.executionRoot, "role-sessions/launch");
  const status = {
    runId: "wave",
    sessionId: "worker",
    cwd: source,
    state: "complete",
    processTerminal: {
      version: 1,
      runId: "wave",
      state: "observed",
      runnerProcessInstanceId: "instance",
    },
    usageBudget: { exhausted: false },
    workflowReceiptPath: workflowPath,
    workflow: { value: rows },
    steps: rows.map((row) => ({
      sessionFile: meteredSession(
        path.join(sessionDir, `${row.runId}.jsonl`),
        row.runId,
        source,
      ),
      agent: "team.implementer",
      workflowKey: row.key,
      runId: row.runId,
      status: "complete",
      acceptance: {
        status:
          options.nativeReviewRequired === false
            ? "checked"
            : "review-required",
        evidenceStatus: "checked",
        effectiveAcceptance: {
          review: { required: options.nativeReviewRequired !== false },
        },
      },
    })),
  };
  const hostedWorkflow = options.hostedWorkflow
    ? {
        version: 1,
        pid: worker.mailbox.readJson("receipts/boot.json").processId,
      }
    : null;
  if (hostedWorkflow) asHostedStatus(status, hostedWorkflow);
  const saveStatus = () =>
    fs.writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
  saveStatus();
  worker.mailbox.writeReceipt("wave-plan-launch", {
    ...(hostedWorkflow ? { hostedWorkflow } : {}),
    key: "writer-wave",
    reason: "Fixture writer isolation.",
    runs: members.map(({ taskDigest: _digest, ...member }) => ({
      ...member,
      task: "Fixture bounded writer.",
    })),
  });
  worker.recordProgress("launch", {
    kind: "role-wave-launch-intent",
    members,
    waveKey: "writer-wave",
  });
  for (const member of members)
    worker.recordProgress(`admission-${member.key}`, {
      kind: "role-launch-intent",
      rootLaunchId: "launch",
      role: member.role,
      mode: member.mode,
      maxTokens: member.maxTokens,
    });
  worker.recordProgress("wave-started", {
    kind: "role-started",
    ...(hostedWorkflow ? { hostedWorkflow } : {}),
    launchId: "launch",
    runId: "wave",
    asyncDir: native,
    sessionDir,
    role: null,
    mode: "wave",
    members,
    baseCommit: base,
  });
  worker.recordProgress("launch-completion", {
    kind: "role-completion",
    launchId: "launch",
    runId: "wave",
    completion: "completed",
  });
  worker.recordProgress("launch-terminal", {
    kind: "role-terminal",
    launchId: "launch",
    runId: "wave",
    completion: "completed",
    processTerminal: status.processTerminal ?? null,
    ...(hostedWorkflow
      ? {
          hostedTerminal: readNativeTerminal(
            {
              runId: "wave",
              asyncDir: native,
              members,
              mode: "wave",
              hostedWorkflow,
            },
            ["worker"],
          ).hostedTerminal,
        }
      : {}),
  });
  options.beforeResult?.({ source, prepared, worker });
  worker.sealResult({
    schemaVersion: "teams-task-result/1",
    identity: prepared.contract.identity,
    requestDigest: prepared.requestDigest,
    resultRevision: 1,
    outcome: options.resultOutcome ?? "ready_for_acceptance",
    summary: "Isolated candidates; host validation pending.",
    source: worker.captureSource(1),
    criterionResults: [
      {
        criterionId: "outcome",
        status: "indeterminate",
        observation: "Pending host checks.",
        evidenceIds: [],
      },
    ],
    evidence: [],
    childRunRefs: ["wave"],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  });
  orchestrator.collect(prepared.executionId);
  return {
    root,
    source,
    base,
    native,
    manifests,
    status,
    saveStatus,
    workflow,
    workflowPath,
    prepared,
    worker,
    orchestrator,
    host: new HostAcceptance({ orchestrator }),
  };
}

async function applyFixture(t) {
  const f = await fixture(t, ["alpha", "binary"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  f.host.stageIntegration(f.prepared.executionId);
  const index = fs.readFileSync(path.join(f.source, ".git/index"));
  const config = fs.readFileSync(path.join(f.source, ".git/config"));
  const plan = f.host.prepareIntegrationApply(f.prepared.executionId);
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, ".git/index")),
    index,
    "planning is index-read-only",
  );
  assert.deepEqual(fs.readFileSync(path.join(f.source, ".git/config")), config);
  return {
    ...f,
    plan,
    applyDir: path.join(f.prepared.executionRoot, "integration/target-apply"),
  };
}

// Trusted fixture shim, not a runtime fault-injection API. All commands still use
// real Git; selected --index applications can probe locks or fail after effects.
function gitShim(t, f, before, after = "") {
  const actual = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(path.isAbsolute(actual));
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  const script = `#!${process.execPath}\nconst fs=require('node:fs'),a=require('node:assert/strict'),{spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2),real=${JSON.stringify(actual)},source=${JSON.stringify(f.source)},base=${JSON.stringify(f.base)},ref=${JSON.stringify(f.plan.before.ref)};\nconst application=args.includes('apply')&&args.includes('--index')&&!args.includes('--reverse');\nif(application){${before}}\nconst r=spawnSync(real,args,{stdio:'inherit'});\nif(application&&r.status===0){${after}}\nprocess.exit(r.status??1);\n`;
  fs.writeFileSync(path.join(bin, "git"), script, { mode: 0o700 });
  const original = process.env.PATH;
  process.env.PATH = bin + path.delimiter + original;
  t.after(() => {
    process.env.PATH = original;
  });
}

test("D3b verify-only and native-required review never grant target-write authority", async (t) => {
  const v = await fixture(t);
  v.host.stageIntegration(v.prepared.executionId);
  assert.throws(
    () => v.host.prepareIntegrationApply(v.prepared.executionId),
    /verify-only/,
  );
  for (const nativeStatus of [
    "review-required",
    "reviewed",
    "missing-policy",
  ]) {
    const f = await fixture(t, ["alpha"], undefined, {
      integrationMode: "approved-integration",
    });
    f.status.steps[0].acceptance.status =
      nativeStatus === "missing-policy" ? "checked" : nativeStatus;
    if (nativeStatus === "missing-policy")
      delete f.status.steps[0].acceptance.effectiveAcceptance.review.required;
    f.saveStatus();
    f.host.stageIntegration(f.prepared.executionId);
    const plan = f.host.prepareIntegrationApply(f.prepared.executionId);
    await assert.rejects(
      () =>
        f.host.applyIntegration(
          f.prepared.executionId,
          plan.planDigest,
          async () =>
            assert.fail("must not prompt through a required review gate"),
        ),
      /review/,
    );
    assert.equal(git(f.source, "status", "--porcelain"), "");
    assert.equal(
      fs.existsSync(
        path.join(
          f.prepared.executionRoot,
          "integration/target-apply/apply-intent.json",
        ),
      ),
      false,
    );
  }
});

test("D3b explicit digest and UI approval are required; changes during confirmation are preserved", async (t) => {
  const f = await applyFixture(t);
  const apply = (hash, confirm) =>
    f.host.applyIntegration(f.prepared.executionId, hash, confirm);
  await assert.rejects(
    () => apply(undefined, async () => true),
    /explicit.*digest/,
  );
  await assert.rejects(
    () => apply("0".repeat(64), async () => true),
    /digest mismatch/,
  );
  await assert.rejects(() => apply(f.plan.planDigest), /confirmation required/);
  assert.equal(
    (await apply(f.plan.planDigest, async () => false)).status,
    "declined",
  );
  assert.equal(
    fs.existsSync(path.join(f.applyDir, "apply-intent.json")),
    false,
  );
  await assert.rejects(
    () =>
      apply(f.plan.planDigest, async () => {
        fs.writeFileSync(
          path.join(f.source, "README.md"),
          "user edit during confirmation\n",
        );
        return true;
      }),
    /target changed during confirmation/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "user edit during confirmation\n",
  );
  assert.equal(
    fs.existsSync(path.join(f.applyDir, "apply-intent.json")),
    false,
  );
});

test("D3b physical baseline rejects assume-unchanged edits outside sourcePaths", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  f.host.stageIntegration(f.prepared.executionId);
  git(f.source, "update-index", "--assume-unchanged", "README.md");
  fs.writeFileSync(path.join(f.source, "README.md"), "hidden user change\n");
  assert.equal(git(f.source, "status", "--porcelain"), "");
  assert.throws(
    () => f.host.prepareIntegrationApply(f.prepared.executionId),
    /complete Git baseline/,
  );
  assert.throws(
    () => f.host.prepareIntegrationApply(f.prepared.executionId),
    /incomplete.*reconcile/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "hidden user change\n",
  );
});

test("D3b dirty rollback and subsequent commits cannot overwrite later work", async (t) => {
  const f = await applyFixture(t);
  await f.host.applyIntegration(
    f.prepared.executionId,
    f.plan.planDigest,
    async () => true,
  );
  fs.writeFileSync(
    path.join(f.source, "src/alpha space.txt"),
    "later user edit\n",
  );
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => assert.fail("dirty rollback must not prompt"),
      ),
    /later edits/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "src/alpha space.txt"), "utf8"),
    "later user edit\n",
  );
  git(f.source, "add", "-A");
  git(
    f.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "user commit after integration",
  );
  const head = git(f.source, "rev-parse", "HEAD");
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /later edits/,
  );
  assert.equal(git(f.source, "rev-parse", "HEAD"), head);
  assert.equal(
    fs.existsSync(path.join(f.applyDir, "rollback-intent.json")),
    false,
  );
});

test("D3b merged patch preserves non-UTF8 text bytes without NUL", async (t) => {
  const f = await fixture(t, ["octets"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  f.host.stageIntegration(f.prepared.executionId);
  const plan = f.host.prepareIntegrationApply(f.prepared.executionId);
  await f.host.applyIntegration(
    f.prepared.executionId,
    plan.planDigest,
    async () => true,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, "src/octets space.txt")),
    Buffer.from([255, 254, 253, 10]),
  );
  await f.host.rollbackIntegration(
    f.prepared.executionId,
    plan.planDigest,
    async () => true,
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D3b a verified same-file merge is applied and reversed as one exact delta", async (t) => {
  const f = await fixture(
    t,
    ["disjoint-a", "disjoint-b"],
    "const a=require('node:assert/strict'),s=require('node:fs').readFileSync('src/lines.txt','utf8');a.ok(s.startsWith('disjoint-a\\n'));a.ok(s.endsWith('disjoint-b\\n'));",
    { integrationMode: "approved-integration", nativeReviewRequired: false },
  );
  const original = fs.readFileSync(path.join(f.source, "src/lines.txt"));
  f.host.stageIntegration(f.prepared.executionId);
  const plan = f.host.prepareIntegrationApply(f.prepared.executionId);
  await f.host.applyIntegration(
    f.prepared.executionId,
    plan.planDigest,
    async () => true,
  );
  const current = fs.readFileSync(path.join(f.source, "src/lines.txt"), "utf8");
  assert.ok(
    current.startsWith("disjoint-a\n") && current.endsWith("disjoint-b\n"),
  );
  await f.host.rollbackIntegration(
    f.prepared.executionId,
    plan.planDigest,
    async () => true,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, "src/lines.txt")),
    original,
  );
});

test("D3b frozen patch, owner and stale HEAD checks happen before intent", async (t) => {
  const f = await applyFixture(t);
  const patch = path.join(f.applyDir, "merged.patch");
  const original = fs.readFileSync(patch);
  fs.appendFileSync(patch, "tamper");
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /patch changed/,
  );
  fs.writeFileSync(patch, original);
  f.orchestrator.ownerSessionId = "foreign";
  await assert.rejects(
    async () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /ownership changed/,
  );
  f.orchestrator.ownerSessionId = "owner";
  git(
    f.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "stale target",
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /later edits/,
  );
  assert.equal(
    fs.existsSync(path.join(f.applyDir, "apply-intent.json")),
    false,
  );
});

test("D3b real Git fence blocks branch updates and HEAD switches while applying", async (t) => {
  const f = await applyFixture(t);
  const marker = path.join(f.root, "lock-probes.json");
  gitShim(
    t,
    f,
    `const branch=spawnSync(real,['-C',source,'update-ref',ref,base,base],{encoding:'utf8'});const head=spawnSync(real,['-C',source,'symbolic-ref','HEAD','refs/heads/other'],{encoding:'utf8'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({branch:branch.status,head:head.status}));a.notEqual(branch.status,0);a.notEqual(head.status,0);`,
  );
  await f.host.applyIntegration(
    f.prepared.executionId,
    f.plan.planDigest,
    async () => true,
  );
  const probes = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.notEqual(probes.branch, 0);
  assert.notEqual(probes.head, 0);
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
});

test("D3b failed command after real effects is observed, never replayed, and can be explicitly rolled back", async (t) => {
  const f = await applyFixture(t);
  gitShim(t, f, "", "process.exit(9);");
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /failed.*reconcile/,
  );
  const observation = f.host.inspectIntegrationApply(
    f.prepared.executionId,
    f.plan.planDigest,
  );
  assert.equal(observation.disposition, "applied");
  assert.equal(observation.commandClosed, true);
  assert.equal(observation.applyReceipt, false);
  assert.equal(observation.locked, false);
  t.diagnostic(
    JSON.stringify({
      classification: "command-failed-after-effects",
      observation,
      command: JSON.parse(
        fs.readFileSync(path.join(f.applyDir, "apply-command.json"), "utf8"),
      ),
    }),
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /reconcile instead of retrying/,
  );
  const rollback = await f.host.rollbackIntegration(
    f.prepared.executionId,
    f.plan.planDigest,
    async () => true,
  );
  assert.equal(rollback.status, "rolled-back");
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D3b signalled mutation is not settled merely because its ref fence closed", async (t) => {
  const f = await applyFixture(t);
  gitShim(t, f, "", "process.kill(process.pid,'SIGTERM');");
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /failed.*reconcile/,
  );
  const command = JSON.parse(
    fs.readFileSync(path.join(f.applyDir, "apply-command.json"), "utf8"),
  );
  assert.equal(command.terminal.observed, true);
  assert.equal(command.mutationTerminal.observed, false);
  assert.equal(command.mutationTerminal.signal, "SIGTERM");
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /mutation command terminal proof/,
  );
});

test("D3b incomplete physical output stays diverged and refuses reverse apply", async (t) => {
  const f = await applyFixture(t);
  gitShim(
    t,
    f,
    "",
    "fs.writeFileSync(source+'/README.md','concurrent change');process.exit(9);",
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /failed.*reconcile/,
  );
  assert.equal(
    f.host.inspectIntegrationApply(f.prepared.executionId, f.plan.planDigest)
      .disposition,
    "diverged",
  );
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /no complete applied state/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "concurrent change",
  );
});

test("D3b failure before effects and missing close proof cannot authorize recovery writes", async (t) => {
  const f = await applyFixture(t);
  gitShim(t, f, "process.exit(9);");
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /failed.*reconcile/,
  );
  assert.equal(
    f.host.inspectIntegrationApply(f.prepared.executionId, f.plan.planDigest)
      .disposition,
    "baseline",
  );
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /no complete applied state/,
  );
  fs.renameSync(
    path.join(f.applyDir, "apply-command.json"),
    path.join(f.applyDir, "preserved-command.json"),
  );
  await assert.rejects(
    () =>
      f.host.rollbackIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /Invalid target-apply evidence/,
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /reconcile/,
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D3b apply readback uses durable native captures after native temp cleanup", async (t) => {
  const f = await applyFixture(t);
  fs.rmSync(f.native, { recursive: true });
  const applied = await f.host.applyIntegration(
    f.prepared.executionId,
    f.plan.planDigest,
    async () => true,
  );
  assert.equal(applied.status, "applied");
  assert.deepEqual(
    await f.host.applyIntegration(
      f.prepared.executionId,
      f.plan.planDigest,
      async () => true,
    ),
    applied,
  );
});

test("D3b incomplete intents, retained locks and receipt tampering fail closed", async (t) => {
  const f = await applyFixture(t);
  const lock = path.join(f.applyDir, "operation.lock");
  fs.writeFileSync(lock, "prior operation");
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(lock, "utf8"), "prior operation");
  fs.unlinkSync(lock); // Fixture only, never a runtime cleanup path.
  await f.host.applyIntegration(
    f.prepared.executionId,
    f.plan.planDigest,
    async () => true,
  );
  const receiptFile = path.join(f.applyDir, "apply-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  fs.writeFileSync(
    receiptFile,
    JSON.stringify({ ...receipt, acceptance: "accepted" }),
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /not acceptance/,
  );
  fs.renameSync(receiptFile, path.join(f.applyDir, "preserved-receipt.json"));
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        f.plan.planDigest,
        async () => true,
      ),
    /reconcile/,
  );
  assert.equal(
    f.host.inspectIntegrationApply(f.prepared.executionId, f.plan.planDigest)
      .disposition,
    "applied",
  );
});

test("D3b approved staged apply and reverse rollback leave HEAD/ref unchanged", async (t) => {
  const f = await fixture(t, ["alpha", "binary"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  const staged = f.host.stageIntegration(f.prepared.executionId);
  const plan = f.host.prepareIntegrationApply(f.prepared.executionId);
  assert.equal(plan.targetRoot, f.source);
  assert.equal(plan.baseCommit, f.base);
  assert.equal(plan.mergedTree, staged.tree);
  let confirmations = 0;
  const confirmed = async () => {
    confirmations++;
    return true;
  };
  const applied = await f.host.applyIntegration(
    f.prepared.executionId,
    plan.planDigest,
    confirmed,
  );
  assert.equal(applied.status, "applied");
  assert.equal(applied.acceptance, "not-assessed");
  assert.equal(git(f.source, "write-tree"), staged.tree);
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(
    await f.host.applyIntegration(
      f.prepared.executionId,
      plan.planDigest,
      confirmed,
    ),
    applied,
  );
  assert.equal(
    confirmations,
    1,
    "idempotent readback does not authorize or execute another write",
  );
  assert.throws(
    () => f.host.accept(f.prepared.executionId),
    /handoff and integration/,
  );
  fs.rmSync(f.native, { recursive: true }); // Rollback uses durable captures.
  const rolledBack = await f.host.rollbackIntegration(
    f.prepared.executionId,
    plan.planDigest,
    confirmed,
  );
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal(
    git(f.source, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(
    await f.host.rollbackIntegration(
      f.prepared.executionId,
      plan.planDigest,
      confirmed,
    ),
    rolledBack,
  );
  assert.equal(confirmations, 2);
  t.diagnostic(
    JSON.stringify({
      classification: "synthetic-native-real-git",
      plan,
      applied,
      rolledBack,
    }),
  );
  await assert.rejects(
    () =>
      f.host.applyIntegration(
        f.prepared.executionId,
        plan.planDigest,
        confirmed,
      ),
    /rolled back|consumed/,
  );
});

test("D3 verify-only integration preserves target and stages native-bound independent patches", async (t) => {
  const f = await fixture(t, ["alpha", "binary"]);
  const originalIndex = fs.readFileSync(path.join(f.source, ".git/index"));
  const originalConfig = fs.readFileSync(path.join(f.source, ".git/config"));
  const staged = f.host.stageIntegration(f.prepared.executionId);
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, ".git/index")),
    originalIndex,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, ".git/config")),
    originalConfig,
  );
  assert.equal(staged.status, "checks-passed");
  assert.equal(staged.targetModified, false);
  assert.equal(staged.acceptance, "not-assessed");
  assert.equal(
    fs.readFileSync(path.join(staged.cwd, "src/alpha space.txt"), "utf8"),
    "alpha\n",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(staged.cwd, "src/binary.bin")),
    Buffer.from([0, 255, 1, 0]),
  );
  assert.equal(fs.existsSync(path.join(staged.cwd, "src/remove.txt")), false);
  assert.equal(
    git(f.source, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.throws(
    () => f.host.accept(f.prepared.executionId),
    /handoff and integration/,
  );
  fs.rmSync(f.native, { recursive: true });
  assert.deepEqual(
    f.host.stageIntegration(f.prepared.executionId),
    staged,
    "idempotent readback uses durable captures, not deleted native temp files",
  );
  fs.writeFileSync(path.join(staged.cwd, "src/alpha space.txt"), "tampered\n");
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /changed|dirty/,
  );
});

test("D3 full staged workspace detects changes hidden from Git and outside sourcePaths", async (t) => {
  const f = await fixture(
    t,
    ["alpha"],
    "require('node:child_process').execFileSync('git',['update-index','--assume-unchanged','README.md']);require('node:fs').writeFileSync('README.md','hidden modification');",
  );
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /workspace changed/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "baseline\n",
  );
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /reconcile/,
  );
});

test("D3 overlapping patches preserve conflict evidence and cannot be blindly replayed", async (t) => {
  const f = await fixture(t, ["conflict-a", "conflict-b"]);
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /apply|conflict/,
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /reconcile/,
  );
  const dir = path.join(f.prepared.executionRoot, "integration");
  assert.ok(fs.existsSync(path.join(dir, "failure.json")));
  assert.ok(fs.existsSync(path.join(dir, "repo")));
});

test("D3 patch scope and symlink changes never reach target or host checks", async (t) => {
  for (const edit of ["outside", "symlink"]) {
    const f = await fixture(t, [edit]);
    assert.throws(
      () => f.host.stageIntegration(f.prepared.executionId),
      /scope|regular|symlink/,
    );
    assert.equal(git(f.source, "status", "--porcelain"), "");
    assert.equal(
      fs.existsSync(
        path.join(f.prepared.executionRoot, "integration/check-check.json"),
      ),
      false,
    );
  }
});

test("D3 public workflow sidecar and completed steps retain strict native bindings", async (t) => {
  const f = await fixture(t, ["alpha"]);
  // The recorded hosted run uses these path/status shapes. This fixture's
  // separate process proof is synthetic; it does not repair that old run.
  delete f.status.workflowReceiptPath;
  f.status.steps[0].status = "completed";
  f.saveStatus();
  const inspect = () =>
    inspectNativeHandoffs(f.worker.mailbox, f.prepared.contract, ["wave"]);
  assert.equal(inspect().lanes.length, 1);
  for (const state of [
    "pending",
    "running",
    "failed",
    "stopped",
    "rejected",
    "unknown",
  ]) {
    f.status.steps[0].status = state;
    f.saveStatus();
    assert.throws(inspect, /native child incomplete/);
  }
  f.status.steps[0].status = "completed";
  for (const ref of [
    null,
    "",
    "relative.json",
    path.join(f.native, "missing.json"),
  ]) {
    f.status.workflowReceiptPath = ref;
    f.saveStatus();
    assert.throws(inspect, /Invalid or unavailable native artifact/);
  }
  delete f.status.workflowReceiptPath;
  f.saveStatus();
  const receipt = fs.readFileSync(f.workflowPath);
  fs.writeFileSync(
    f.workflowPath,
    JSON.stringify({ ...f.workflow, workflowRunId: "foreign" }),
  );
  assert.throws(inspect, /workflow receipt identity mismatch/);
  fs.unlinkSync(f.workflowPath);
  assert.throws(inspect, /Invalid or unavailable native artifact/);
  const other = path.join(f.native, "other-receipt.json");
  fs.writeFileSync(other, receipt);
  fs.symlinkSync(other, f.workflowPath);
  assert.throws(inspect, /Invalid or unavailable native artifact/);
  fs.unlinkSync(f.workflowPath);
  fs.writeFileSync(f.workflowPath, receipt);
  delete f.status.processTerminal;
  f.saveStatus();
  assert.throws(inspect, /native terminal version missing/);
});

test("D3 native bindings reject identity, base, future schema, missing patch and unobserved terminal", async (t) => {
  const f = await fixture(t);
  const inspect = () =>
    inspectNativeHandoffs(f.worker.mailbox, f.prepared.contract, ["wave"]);
  assert.equal(inspect().lanes.length, 2);
  const manifest = f.manifests[0];
  const save = () =>
    fs.writeFileSync(manifest.path, JSON.stringify(manifest.value));
  manifest.value.runId = "foreign";
  save();
  assert.throws(inspect, /identity/);
  manifest.value.runId = "child-0";
  manifest.value.groups[0].baseCommit = "0".repeat(40);
  save();
  assert.throws(inspect, /base/);
  manifest.value.groups[0].baseCommit = f.base;
  manifest.value.version = 2;
  save();
  assert.throws(inspect, /version/);
  manifest.value.version = 1;
  save();
  f.status.processTerminal.state = "unknown";
  f.saveStatus();
  assert.throws(inspect, /terminal/);
  f.status.processTerminal.state = "observed";
  f.status.workflow.value[0].runId = "foreign";
  f.saveStatus();
  assert.throws(inspect, /identity/);
  f.status.workflow.value[0].runId = "child-0";
  f.saveStatus();
  f.workflow.entries["lane-0"].agent = "team.foreign";
  fs.writeFileSync(f.workflowPath, JSON.stringify(f.workflow));
  assert.throws(inspect, /agent identity/);
  f.workflow.entries["lane-0"].agent = "team.implementer";
  fs.writeFileSync(f.workflowPath, JSON.stringify(f.workflow));
  fs.renameSync(manifest.patchPath, `${manifest.patchPath}.original`);
  fs.symlinkSync(`${manifest.patchPath}.original`, manifest.patchPath);
  assert.throws(inspect, /symlink/);
  fs.unlinkSync(manifest.patchPath);
  assert.throws(inspect, /ENOENT|patch/);
});

test("D3 same-file nonoverlapping lanes merge through native Git three-way apply", async (t) => {
  const f = await fixture(
    t,
    ["disjoint-a", "disjoint-b"],
    "const a=require('node:assert/strict'),s=require('node:fs').readFileSync('src/lines.txt','utf8');a.ok(s.startsWith('disjoint-a\\n'));a.ok(s.endsWith('disjoint-b\\n'));",
  );
  const staged = f.host.stageIntegration(f.prepared.executionId);
  assert.equal(staged.status, "checks-passed");
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D3 shared single-reader roots need no worktree receipt and do not impose a fixed role pipeline", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, "reader");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({
      runId: "reader",
      cwd: f.source,
      state: "complete",
      processTerminal: { version: 1, runId: "reader", state: "observed" },
      steps: [{ agent: "team.implementer", status: "complete" }],
    }),
  );
  f.worker.recordProgress("reader-started", {
    kind: "role-started",
    runId: "reader",
    asyncDir: dir,
    members: [
      {
        key: "role",
        role: "team.implementer",
        mode: "read-only",
        isolation: "shared",
      },
    ],
  });
  assert.equal(
    inspectNativeHandoffs(f.worker.mailbox, f.prepared.contract, [
      "wave",
      "reader",
    ]).lanes.length,
    2,
  );
  const statusFile = path.join(dir, "status.json");
  const readerStatus = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  readerStatus.steps[0].status = "completed";
  fs.writeFileSync(statusFile, JSON.stringify(readerStatus));
  assert.equal(
    inspectNativeHandoffs(f.worker.mailbox, f.prepared.contract, [
      "wave",
      "reader",
    ]).lanes.length,
    2,
  );
  readerStatus.steps[0].status = "running";
  fs.writeFileSync(statusFile, JSON.stringify(readerStatus));
  assert.throws(
    () =>
      inspectNativeHandoffs(f.worker.mailbox, f.prepared.contract, [
        "wave",
        "reader",
      ]),
    /shared reader incomplete/,
  );
});

test("D3 foreign controller is rejected before creating an integration checkout", async (t) => {
  const f = await fixture(t);
  f.orchestrator.ownerSessionId = "foreign";
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /ownership changed/,
  );
  assert.equal(
    fs.existsSync(path.join(f.prepared.executionRoot, "integration")),
    false,
  );
});

test("D3 durable capture tampering invalidates a successful rehearsal", async (t) => {
  const f = await fixture(t);
  const staged = f.host.stageIntegration(f.prepared.executionId);
  const captured = path.join(
    f.prepared.executionRoot,
    "integration",
    staged.captures[0].saved,
  );
  fs.appendFileSync(captured, "tampered");
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /captured native artifact changed/,
  );
});

test("D3 failed host checks retain their intent and never replay automatically", async (t) => {
  const f = await fixture(t, ["alpha"], "process.exit(7)");
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /host check failed/,
  );
  const checkFile = path.join(
    f.prepared.executionRoot,
    "integration/check-check.json",
  );
  const original = fs.readFileSync(checkFile);
  assert.ok(fs.existsSync(`${checkFile}.intent`));
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /reconcile/,
  );
  assert.deepEqual(fs.readFileSync(checkFile), original);
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D3 stale/dirty targets and existing incomplete intents reject without retry", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.source, "untracked.txt"), "user change");
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /clean baseline/,
  );
  assert.equal(
    fs.existsSync(path.join(f.prepared.executionRoot, "integration")),
    false,
  );
  fs.unlinkSync(path.join(f.source, "untracked.txt"));
  git(
    f.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "concurrent change",
  );
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /baseline changed/,
  );
  const g = await fixture(t);
  fs.mkdirSync(path.join(g.prepared.executionRoot, "integration"));
  fs.writeFileSync(
    path.join(g.prepared.executionRoot, "integration/intent.json"),
    "{}\n",
  );
  assert.throws(
    () => g.host.stageIntegration(g.prepared.executionId),
    /reconcile/,
  );
});

const reviewPolicy = {
  authority: "l0-source-bound",
  allowedRoles: ["team.reviewer"],
  allowedTools: ["read", "structured_output"],
};

test("C2 candidate readiness permits pending host criteria without accepting blocked work", async (t) => {
  for (const outcome of ["blocked", "failed", "ready_for_acceptance"]) {
    await t.test(outcome, async (t) => {
      // Separate executions; never rewrite a sealed result to make it acceptable.
      const f = await fixture(t, ["alpha"], undefined, {
        review: reviewPolicy,
        resultOutcome: outcome,
      });
      const id = f.prepared.executionId;
      const { candidate } = f.orchestrator.collect(id, {
        includeCandidate: true,
      });
      assert.equal(candidate.outcome, outcome);
      assert.equal(candidate.unresolvedRunCount, 0);
      assert.equal(candidate.criterionResults[0].status, "indeterminate");
      assert.deepEqual(candidate.evidence, []);
      if (outcome === "ready_for_acceptance") {
        const staged = f.host.stageIntegration(id);
        assert.equal(staged.status, "checks-passed");
        const review = f.host.prepareIntegrationReview(id);
        assert.equal(review.acceptance, "not-assessed");
        await assert.rejects(
          async () => f.host.accept(id),
          /final review binding/,
        );
      } else {
        assert.throws(
          () => f.host.stageIntegration(id),
          /requires a ready candidate/,
        );
        assert.equal(
          fs.existsSync(path.join(f.prepared.executionRoot, "integration")),
          false,
        );
      }
      assert.equal(
        f.orchestrator.ledger.getExecution(id).state,
        "RESULT_READY",
      );
      assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
      assert.equal(git(f.source, "status", "--porcelain"), "");
    });
  }
});

test("D6 baseline-to-result-to-host checks bind the whole workspace", async (t) => {
  const f = await fixture(t, ["alpha"], "process.exit(0)", {
    review: reviewPolicy,
    sourcePaths: ["src/main.txt"],
  });
  const id = f.prepared.executionId;
  assert.equal(f.host.runChecks(id)[0].status, "verified");
  assert.equal(f.host.runChecks(id)[0].status, "verified");
  f.host.stageIntegration(id);
  // This file is allowed to change but deliberately absent from sourcePaths.
  fs.writeFileSync(path.join(f.source, "src/lines.txt"), "late change\n");
  for (const action of [
    () => f.orchestrator.collect(id),
    () => f.host.runChecks(id),
    () => f.host.stageIntegration(id),
  ])
    assert.throws(action, /workspace changed after result sealing/);
});

test("D6 hidden out-of-scope source changes block all host entrypoints", async (t) => {
  const f = await fixture(t, ["alpha"], "process.exit(0)", {
    review: reviewPolicy,
  });
  const id = f.prepared.executionId;
  f.host.runChecks(id);
  git(f.source, "update-index", "--assume-unchanged", "README.md");
  fs.writeFileSync(path.join(f.source, "README.md"), "hidden\n");
  assert.equal(git(f.source, "status", "--porcelain"), "");
  for (const action of [
    () => f.orchestrator.collect(id),
    () => f.host.runChecks(id),
    () => f.host.stageIntegration(id),
    () => f.host.accept(id),
  ])
    assert.throws(action, /workspace.*scope/);
});

test("D6 Worker rejects an out-of-scope candidate before publishing a result", async (t) => {
  let box;
  await assert.rejects(
    fixture(t, ["alpha"], undefined, {
      review: reviewPolicy,
      beforeResult({ source, worker }) {
        box = worker.mailbox;
        fs.writeFileSync(path.join(source, "outside.txt"), "not authorized\n");
      },
    }),
    /workspace.*scope/,
  );
  assert.equal(box.listResults().length, 0);
  assert.equal(
    fs.existsSync(path.join(box.root, "receipts/workspace-r1.json")),
    false,
  );
});

test("D6 a successful check cannot mutate untracked workspace files or replay itself", async (t) => {
  for (const file of ["outside.txt", "src/check-cache.txt"]) {
    await t.test(file, async (t) => {
      const f = await fixture(
        t,
        ["alpha"],
        `require('node:fs').appendFileSync(${JSON.stringify(file)},'x')`,
        { review: reviewPolicy, sourcePaths: ["src/main.txt"] },
      );
      assert.throws(
        () => f.host.runChecks(f.prepared.executionId),
        /workspace/,
      );
      assert.throws(
        () => f.host.runChecks(f.prepared.executionId),
        /workspace/,
      );
      assert.equal(fs.readFileSync(path.join(f.source, file), "utf8"), "x");
    });
  }
});

test("D6 missing or foreign result snapshots are never reconstructed", async (t) => {
  const f = await fixture(t, ["alpha"], "process.exit(0)", {
    review: reviewPolicy,
  });
  const file = path.join(
    f.prepared.executionRoot,
    "receipts/workspace-r1.json",
  );
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.resultDigest = "a".repeat(64);
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(
    () => f.orchestrator.collect(f.prepared.executionId),
    /workspace result binding/,
  );
  fs.unlinkSync(file);
  assert.throws(() => f.host.runChecks(f.prepared.executionId));
  assert.equal(fs.existsSync(file), false);
});

test("D4a freezes an opt-in review subject without granting apply or acceptance", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    review: reviewPolicy,
    integrationMode: "approved-integration",
  });
  const id = f.prepared.executionId;
  const targetIndex = fs.readFileSync(path.join(f.source, ".git/index"));
  f.host.stageIntegration(id);
  const request = f.host.prepareIntegrationReview(id);
  assert.deepEqual(
    fs.readFileSync(path.join(f.source, ".git/index")),
    targetIndex,
  );
  assert.equal(request.schemaVersion, "teams-integration-review-request/1");
  assert.equal(request.acceptance, "not-assessed");
  assert.equal(request.subject.identity.executionId, id);
  assert.deepEqual(request.subject.writerRoles, ["team.implementer"]);
  assert.deepEqual(f.host.prepareIntegrationReview(id), request);
  const plan = f.host.prepareIntegrationApply(id); // A plan is not write authority.
  let confirmationCalled = false;
  await assert.rejects(
    f.host.applyIntegration(id, plan.planDigest, () => {
      confirmationCalled = true;
      return true;
    }),
    /final review binding/,
  );
  assert.equal(confirmationCalled, false);
  await assert.rejects(f.host.accept(id), /final review binding/);
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.equal(git(f.source, "status", "--porcelain"), "");
  fs.rmSync(f.native, { recursive: true });
  assert.deepEqual(f.host.prepareIntegrationReview(id), request);
  fs.writeFileSync(
    path.join(request.subject.cwd, "README.md"),
    "hidden change\n",
  );
  assert.throws(() => f.host.prepareIntegrationReview(id), /workspace changed/);
});

test("C3 review receives verified host evidence through the frozen request without rerunning checks", async (t) => {
  const { bytesDigest } = await import("../contracts.mjs");
  const { validateReviewReport } = await import("../integration-review.mjs");
  const f = await reviewWaveFixture(t, 1);
  const checks = f.host.runChecks(f.id);
  const frozen = JSON.parse(
    fs.readFileSync(
      path.join(f.prepared.executionRoot, "integration/review-request.json"),
    ),
  );
  assert.ok(
    Array.isArray(frozen.subject.hostChecks),
    "verified host checks must reach reviewer input",
  );
  assert.equal(frozen.subject.hostChecks.length, 1);
  const [evidence] = frozen.subject.hostChecks;
  assert.equal(evidence.commandId, "check");
  assert.deepEqual(evidence.criterionIds, ["outcome"]);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.sourceDigest, frozen.subject.sourceDigest);
  assert.equal(evidence.receipt.path, checks[0].receipt);
  const receiptBytes = fs.readFileSync(evidence.receipt.path);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(evidence.receipt.sha256, bytesDigest(receiptBytes));
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.input.cwd, frozen.subject.cwd);
  assert.equal(evidence.log.path, `${evidence.receipt.path}.log`);
  assert.equal(
    evidence.log.sha256,
    bytesDigest(fs.readFileSync(evidence.log.path)),
  );
  assert.equal(evidence.log.sha256, receipt.logSha256);
  assert.match(f.plan.children[0].task, /subject.hostChecks/);
  const report = {
    schemaVersion: "teams-integration-review-report/1",
    requestDigest: frozen.digest,
    verdict: "pass",
    criteria: {
      outcome: {
        status: "met",
        reason: `Source matches the requirement; host check ${evidence.commandId}, receipt ${evidence.receipt.sha256}, verifies execution on this source.`,
        sourcePaths: ["src/main.txt"],
      },
    },
    findings: [],
  };
  assert.equal(validateReviewReport(frozen, report).verdict, "pass");
  const changed = structuredClone(frozen);
  changed.subject.hostChecks[0].receipt.sha256 = "0".repeat(64);
  changed.digest = digest(changed.subject);
  assert.throws(
    () => validateReviewReport(changed, report),
    /subject mismatch/,
  );
  assert.deepEqual(f.host.prepareIntegrationReview(f.id), frozen);
  assert.deepEqual(fs.readFileSync(evidence.receipt.path), receiptBytes);
  assert.equal(frozen.acceptance, "not-assessed");
  assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
  assert.equal(f.counts().spawns, 0);
});

test("C3 review refuses missing, failed, foreign and changed host evidence before launch", async (t) => {
  for (const fault of [
    "missing",
    "failed",
    "foreign",
    "log",
    "receipt-bytes",
    "source",
  ]) {
    await t.test(fault, async (t) => {
      const f = await reviewWaveFixture(t, 1);
      const file = path.join(
        f.prepared.executionRoot,
        "integration/check-check.json",
      );
      const frozenFile = path.join(
        f.prepared.executionRoot,
        "integration/review-request.json",
      );
      const frozenBytes = fs.readFileSync(frozenFile);
      const receipt = JSON.parse(fs.readFileSync(file));
      if (fault === "missing") fs.unlinkSync(file);
      if (fault === "failed") {
        receipt.status = "failed";
        receipt.exitCode = 7;
        fs.writeFileSync(file, JSON.stringify(receipt));
      }
      if (fault === "foreign") {
        const other = await fixture(t, ["alpha"], undefined, {
          review: reviewPolicy,
        });
        other.host.stageIntegration(other.prepared.executionId);
        fs.copyFileSync(
          path.join(
            other.prepared.executionRoot,
            "integration/check-check.json",
          ),
          file,
        );
      }
      if (fault === "log") fs.appendFileSync(`${file}.log`, "tampered");
      if (fault === "receipt-bytes") fs.appendFileSync(file, " ");
      if (fault === "source")
        fs.appendFileSync(
          path.join(f.request.subject.cwd, "src/main.txt"),
          "drift",
        );
      await assert.rejects(
        f.host.startIntegrationReview(
          f.id,
          f.wave.key,
          f.plan.planDigest,
          f.adapter,
        ),
      );
      assert.equal(f.counts().spawns, 0);
      assert.deepEqual(fs.readFileSync(frozenFile), frozenBytes);
      assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
      if (fault === "missing") assert.equal(fs.existsSync(file), false);
    });
  }
});

test("D4a refuses legacy policy, foreign owner and modified review request", async (t) => {
  const legacy = await fixture(t);
  legacy.host.stageIntegration(legacy.prepared.executionId);
  assert.throws(
    () => legacy.host.prepareIntegrationReview(legacy.prepared.executionId),
    /new v3/,
  );
  const f = await fixture(t, ["alpha"], undefined, { review: reviewPolicy });
  const id = f.prepared.executionId;
  f.host.stageIntegration(id);
  const request = f.host.prepareIntegrationReview(id);
  const wrong = new HostAcceptance({
    orchestrator: {
      ledger: f.orchestrator.ledger,
      runtimeRoot: f.orchestrator.runtimeRoot,
      ownerSessionId: "foreign",
      assertController: () => {
        throw new Error("foreign owner");
      },
    },
  });
  assert.throws(() => wrong.prepareIntegrationReview(id), /foreign owner/);
  const file = path.join(
    f.prepared.executionRoot,
    "integration/review-request.json",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ ...request, acceptance: "accepted" }),
  );
  assert.throws(
    () => f.host.prepareIntegrationReview(id),
    /review request changed/,
  );
});

test("D4a public launch contract requires fresh approved read-only exposure", async (t) => {
  const { validateReviewLaunch } = await import("../integration-review.mjs");
  const f = await fixture(t, ["alpha"], undefined, {
    review: {
      ...reviewPolicy,
      allowedRoles: ["team.reviewer", "team.implementer"],
    },
  });
  f.host.stageIntegration(f.prepared.executionId);
  const request = f.host.prepareIntegrationReview(f.prepared.executionId);
  const launch = {
    version: 2,
    agent: { name: "team.reviewer", definitionDigest: "b".repeat(64) },
    context: "fresh",
    roots: { cwd: request.subject.cwd },
    launchContractDigest: "c".repeat(64),
    diagnostics: [],
    tools: {
      explicitAllowlist: true,
      effectiveAllowlist: ["read", "structured_output"],
      effectiveMcpTools: [],
      disableAmbientExtensions: true,
      fanoutAuthorized: false,
    },
  };
  const result = validateReviewLaunch(request, { ok: true, contract: launch });
  assert.equal(result.launchContractDigest, launch.launchContractDigest);
  assert.equal(result.acceptance, "not-assessed");
  for (const change of [
    (c) => {
      c.context = "fork";
    },
    (c) => {
      c.agent.name = "team.implementer";
    }, // Approved but not independent.
    (c) => {
      c.agent.name = "team.unknown";
    },
    (c) => {
      c.roots.cwd = f.source;
    },
    (c) => {
      c.tools.effectiveAllowlist.push("write");
    },
    (c) => {
      c.tools.effectiveMcpTools.push("unknown_mutator");
    },
    (c) => {
      c.tools.explicitAllowlist = false;
    },
    (c) => {
      c.tools.disableAmbientExtensions = false;
    },
    (c) => {
      c.tools.fanoutAuthorized = true;
    },
    (c) => {
      c.launchContractDigest = "";
    },
    (c) => {
      c.version = 999;
    },
    (c) => {
      c.diagnostics = [{ severity: "host-required" }];
    },
  ]) {
    const bad = structuredClone(launch);
    change(bad);
    assert.throws(() =>
      validateReviewLaunch(request, { ok: true, contract: bad }),
    );
  }
  assert.throws(() =>
    validateReviewLaunch(request, { ok: false, code: "unavailable" }),
  );
});

test("D4a report format binds every criterion and digest, but is not native proof", async (t) => {
  const { integrationReviewSchema, validateReviewReport } = await import(
    "../integration-review.mjs"
  );
  const f = await fixture(t, ["alpha"], undefined, { review: reviewPolicy });
  f.host.stageIntegration(f.prepared.executionId);
  const request = f.host.prepareIntegrationReview(f.prepared.executionId);
  const schema = integrationReviewSchema(request);
  assert.equal(schema.properties.requestDigest.const, request.digest);
  assert.equal(schema.additionalProperties, false);
  const allowedPaths = [
    ...new Set([
      ...request.subject.sourceFiles,
      ...request.subject.changedPaths,
    ]),
  ].sort();
  const criterionPaths =
    schema.properties.criteria.properties.outcome.properties.sourcePaths;
  const findingPaths = schema.properties.findings.items.properties.sourcePaths;
  assert.deepEqual(criterionPaths.items.enum, allowedPaths);
  assert.deepEqual(findingPaths.items.enum, allowedPaths);
  // Real ninth-run failure: evidence/specification references are not source.
  for (const invalid of [
    "/tmp/host-evidence/browser-report.json",
    "SPEC.md",
    "../escape",
    "src/missing.txt",
  ]) {
    assert.ok(!criterionPaths.items.enum.includes(invalid));
  }
  const { digest } = await import("../contracts.mjs");
  const oversized = structuredClone(request);
  oversized.subject.objective = "x".repeat(1024 * 1024);
  oversized.digest = digest(oversized.subject);
  assert.throws(() => integrationReviewSchema(oversized), /exceeds 1 MiB/);
  const report = {
    schemaVersion: "teams-integration-review-report/1",
    requestDigest: request.digest,
    verdict: "pass",
    criteria: {
      outcome: {
        status: "met",
        reason: "Reviewed the source against the outcome.",
        sourcePaths: ["src/main.txt"],
      },
    },
    findings: [],
  };
  assert.equal(validateReviewReport(request, report).verdict, "pass");
  for (const change of [
    (r) => {
      r.requestDigest = "d".repeat(64);
    },
    (r) => {
      r.acceptance = "accepted";
    },
    (r) => {
      delete r.criteria.outcome;
    },
    (r) => {
      r.criteria.extra = r.criteria.outcome;
    },
    (r) => {
      r.criteria.outcome.reason = " ";
    },
    (r) => {
      r.criteria.outcome.reason = "x".repeat(1024 * 1024);
    },
    (r) => {
      r.criteria.outcome.sourcePaths = ["../escape"];
    },
    (r) => {
      r.criteria.outcome.sourcePaths = ["src/missing.txt"];
    },
    (r) => {
      r.criteria.outcome.status = "blocked";
    },
    (r) => {
      r.findings.push({
        severity: "blocker",
        issue: "Wrong logic",
        rationale: "Source contradicts requirement.",
        sourcePaths: ["src/main.txt"],
      });
    },
  ]) {
    const bad = structuredClone(report);
    change(bad);
    assert.throws(() => validateReviewReport(request, bad));
  }
  const blocked = structuredClone(report);
  blocked.verdict = "blocked";
  blocked.criteria.outcome.status = "blocked";
  assert.equal(validateReviewReport(request, blocked).verdict, "blocked");
});

test("D4a exact review policy is opt-in and cannot upgrade legacy contracts", async (t) => {
  const { validateTaskContract } = await import("../contracts.mjs");
  const f = await fixture(t, ["alpha"], undefined, { review: reviewPolicy });
  for (const change of [
    (c) => {
      c.schemaVersion = "teams-task-runtime/2";
    },
    (c) => {
      delete c.policy.review;
    },
    (c) => {
      c.policy.review.authority = "native";
    },
    (c) => {
      c.policy.review.allowedRoles = ["team.unknown"];
    },
    (c) => {
      c.policy.review.allowedTools = [];
    },
    (c) => {
      c.policy.review.allowedTools = ["read", "read"];
    },
    (c) => {
      c.policy.review.approved = true;
    },
  ]) {
    const bad = structuredClone(f.prepared.contract);
    change(bad);
    assert.throws(() => validateTaskContract(bad));
  }
});

test("D4a retains exact merged patch bytes and refuses damaged or partial preparation", async (t) => {
  const f = await fixture(t, ["binary", "octets"], undefined, {
    review: reviewPolicy,
  });
  const id = f.prepared.executionId;
  f.host.stageIntegration(id);
  const request = f.host.prepareIntegrationReview(id);
  assert.ok(request.subject.changedPaths.includes("src/remove.txt"));
  assert.ok(!request.subject.sourceFiles.includes("src/remove.txt"));
  const patch = fs.readFileSync(request.subject.patch.path);
  assert.ok(patch.includes(Buffer.from([255, 254, 253])));
  fs.appendFileSync(request.subject.patch.path, "tampered");
  assert.throws(
    () => f.host.prepareIntegrationReview(id),
    /review patch changed/,
  );
  fs.writeFileSync(request.subject.patch.path, patch);
  const file = path.join(
    f.prepared.executionRoot,
    "integration/review-request.json",
  );
  fs.writeFileSync(file, "{");
  assert.throws(
    () => f.host.prepareIntegrationReview(id),
    /invalid saved review request/,
  );
  fs.unlinkSync(file); // Simulate a crash after patch fsync but before request completion.
  assert.throws(
    () => f.host.prepareIntegrationReview(id),
    /incomplete review preparation/,
  );
  assert.deepEqual(fs.readFileSync(request.subject.patch.path), patch);
});

// Simulated public preflight/RPC producer; actual Git/FS, never a model launch.
async function reviewWaveFixture(t, count = 2, options = {}) {
  const { digest } = await import("../contracts.mjs");
  const f = await fixture(t, ["alpha"], options.checkScript, {
    ...options,
    review: reviewPolicy,
  });
  const id = f.prepared.executionId;
  if (options.writerEvidence) {
    f.status.usageBudget = {
      version: 1,
      source: "reported",
      exhausted: false,
      tokens: {
        hard: options.tokenBudgetMode === "shared" ? 1000 : 100,
        used: 20,
        outcome: "within-budget",
      },
    };
    for (const step of f.status.steps) {
      step.exitCode = 0;
      Object.assign(step.acceptance, {
        childReport: { changedFiles: ["src/alpha space.txt"] },
        runtimeChecks: [
          { id: "changed-files", status: "passed", message: "fixture" },
        ],
        verifyRuns: [],
        criteria: [],
      });
      Object.assign(step.acceptance.effectiveAcceptance, {
        level: "checked",
        criteria: [],
        evidence: ["changed-files"],
        verify: [],
      });
    }
    options.mutateWriter?.(f.status);
    f.saveStatus();
  }
  await options.mutateMeter?.(f);
  f.host.stageIntegration(id);
  const request = f.host.prepareIntegrationReview(id);
  const wave = {
    key: "review-one",
    reason: "Independent views of the frozen integration.",
    runs: Array.from({ length: count }, (_, i) => ({
      key: `view-${i}`,
      role: "team.reviewer",
      task: `Review criterion correctness, angle ${i}.`,
      mode: "review",
      isolation: "shared",
      maxTokens: options.reviewEstimate ?? 100,
    })),
  };
  let resolves = 0,
    spawns = 0,
    admissions = 0;
  let plan;
  const adapter = {
    nativeOwner: "owner",
    resolve: async (input) => {
      resolves++;
      assert.equal(input.model, "antigravity/gemini-3.8-flash");
      return {
        ok: true,
        contract: {
          version: 2,
          agent: {
            name: input.agent,
            source: "user",
            definitionDigest: digest(input.agent),
          },
          context: input.context,
          roots: { cwd: input.cwd },
          diagnostics: [],
          launchContractDigest: digest({
            agent: input.agent,
            model: input.model,
            task: input.task,
            schema: input.outputSchema,
          }),
          tools: {
            explicitAllowlist: true,
            effectiveAllowlist: ["read", "structured_output"],
            effectiveMcpTools: [],
            internalTools: ["structured_output"],
            ...(options.tokenBudgetMode === "shared"
              ? { extensionArgs: [TASK_BUDGET_EXTENSION] }
              : {}),
            disableAmbientExtensions: true,
            fanoutAuthorized: false,
          },
        },
      };
    },
    assertAdmission: () => {
      admissions++;
    }, // Fixture assertion, not production usage proof.
    rpc: {
      request: async (method, params) => {
        assert.equal(method, "spawn");
        spawns++;
        assert.equal(params.sessionDir, plan.sessionDir);
        assert.ok(
          params.workflowScript.includes(
            '"model":"antigravity/gemini-3.8-flash"',
          ),
        );
        return {
          runId: "review-root",
          asyncDir: path.join(f.root, "native-review"),
        };
      },
    },
  };
  plan = await f.host.planIntegrationReview(id, wave, adapter);
  const native = path.join(f.root, "native-review");
  function publish(
    mutate = () => {},
    usage = {
      input: 4,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 10,
    },
  ) {
    fs.mkdirSync(native, { recursive: true });
    const rows = plan.children.map((child, i) => ({
      key: child.key,
      ok: true,
      runId: `review-child-${i}`,
      structuredOutput: {
        schemaVersion: "teams-integration-review-report/1",
        requestDigest: request.digest,
        verdict: "pass",
        criteria: {
          outcome: {
            status: "met",
            reason: "Synthetic review of the frozen source.",
            sourcePaths: ["src/main.txt"],
          },
        },
        findings: [],
      },
    }));
    const entries = Object.fromEntries(
      rows.map((row, i) => [
        row.key,
        {
          key: row.key,
          agent: plan.children[i].agent,
          latestRunId: row.runId,
          continuation: { runIds: [row.runId] },
        },
      ]),
    );
    const workflow = {
      version: 1,
      workflowRunId: "review-root",
      state: "complete",
      entries,
    };
    const workflowReceiptPath = path.join(native, "workflow.json");
    const steps = rows.map((row, i) => {
      const sessionFile = path.join(
        plan.sessionDir,
        options.tokenBudgetMode === "shared" ? plan.children[i].key : row.runId,
        "session.jsonl",
      );
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: `session-${i}`,
            cwd: request.subject.cwd,
          }),
          JSON.stringify({
            type: "message",
            id: "message-one",
            message: {
              role: "assistant",
              usage,
              content: [
                {
                  type: "toolCall",
                  id: "submit-one",
                  name: "structured_output",
                  arguments: { value: row.structuredOutput },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "result-one",
            message: {
              role: "toolResult",
              toolCallId: "submit-one",
              toolName: "structured_output",
              isError: false,
              details: {},
            },
          }),
          "",
        ].join("\n"),
      );
      return {
        workflowKey: row.key,
        runId: row.runId,
        agent: "team.reviewer",
        context: "fresh",
        status: "complete",
        exitCode: 0,
        sessionFile,
        launchContractDigest: plan.launches[i].launchContractDigest,
        structuredOutput: row.structuredOutput,
      };
    });
    const status = {
      runId: "review-root",
      cwd: request.subject.cwd,
      sessionId: "owner",
      state: "complete",
      processTerminal: {
        version: 1,
        state: "observed",
        runId: "review-root",
        runnerProcessInstanceId: "review-runner",
      },
      usageBudget: { exhausted: false },
      workflowReceiptPath,
      steps,
      workflow: { value: rows },
    };
    mutate(status, workflow);
    fs.writeFileSync(workflowReceiptPath, JSON.stringify(workflow));
    fs.writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
    return status;
  }
  return {
    ...f,
    id,
    wave,
    plan,
    request,
    adapter,
    reviewNative: native,
    publish,
    counts: () => ({ resolves, spawns, admissions }),
  };
}

test("public review collection observes running without capturing or sealing, then binds the same completed run", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const running = () =>
    f.publish((status) => {
      status.state = "running";
      delete status.processTerminal;
    });
  running();
  const counts = f.counts();
  const pending = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(pending.state, "running");
  assert.equal(pending.verdict, "pending");
  assert.equal(pending.acceptance, "not-assessed");
  assert.equal(pending.key, f.wave.key);
  assert.deepEqual(f.counts(), counts);
  const dir = path.dirname(f.plan.sessionDir);
  assert.equal(fs.existsSync(path.join(dir, "captures")), false);
  assert.equal(fs.existsSync(path.join(dir, "complete.json")), false);
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /uncollected review wave/,
  );
  for (const [field, value, error] of [
    ["sessionId", "foreign", /owner mismatch/],
    ["runId", "foreign", /identity mismatch/],
    ["error", "failed", /native review failed/],
    ["state", "unknown", /not complete/],
  ]) {
    const status = running();
    status[field] = value;
    fs.writeFileSync(
      path.join(f.reviewNative, "status.json"),
      JSON.stringify(status),
    );
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      error,
    );
  }
  f.publish();
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(complete.state, "bound");
  assert.equal(complete.runId, pending.runId);
  assert.deepEqual(f.counts(), counts);
});

test("D4b public workflow sidecar and completed review steps preserve terminal and capture gates", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const status = f.publish((value) => {
    value.steps[0].status = "completed";
  });
  const explicitPath = status.workflowReceiptPath;
  const sidecar = path.join(f.reviewNative, "workflow-receipt.json");
  fs.copyFileSync(explicitPath, sidecar);
  const save = () =>
    fs.writeFileSync(
      path.join(f.reviewNative, "status.json"),
      JSON.stringify(status),
    );
  const collect = () =>
    f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  // An explicit malformed or missing reference must not fall back to a good sidecar.
  for (const ref of [
    null,
    "",
    "relative.json",
    path.join(f.reviewNative, "missing.json"),
  ]) {
    status.workflowReceiptPath = ref;
    save();
    await assert.rejects(collect(), /invalid native review JSON/);
  }
  delete status.workflowReceiptPath;
  const proof = status.processTerminal;
  delete status.processTerminal;
  save();
  await assert.rejects(collect(), /hosted process identity changed/);
  status.processTerminal = proof;
  for (const state of [
    "pending",
    "running",
    "failed",
    "stopped",
    "rejected",
    "unknown",
  ]) {
    status.steps[0].status = state;
    save();
    await assert.rejects(collect(), /review step incomplete/);
  }
  // The alias is also valid for an independently proved async review child.
  status.steps[0].status = "completed";
  status.steps[0].async = true;
  save();
  await assert.rejects(collect(), /native review terminal schema missing/);
  status.steps[0].processTerminal = { ...proof, runId: status.steps[0].runId };
  save();
  const receipt = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  fs.writeFileSync(
    sidecar,
    JSON.stringify({ ...receipt, workflowRunId: "foreign" }),
  );
  await assert.rejects(collect(), /review workflow identity mismatch/);
  fs.writeFileSync(sidecar, JSON.stringify(receipt));
  const complete = await collect();
  assert.equal(complete.state, "bound");
  assert.equal(complete.acceptance, "not-assessed");
  assert.ok(complete.captures.some((row) => row.origin === sidecar));
  fs.rmSync(f.reviewNative, { recursive: true });
  fs.rmSync(f.plan.sessionDir, { recursive: true });
  assert.deepEqual(await collect(), complete);
});

test("hosted writer and reviewer use public result evidence through final verified-patch acceptance", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    hostedWorkflow: true,
    writerEvidence: true,
    stoppedWorker: true,
    mutateWriter(status) {
      delete status.usageBudget;
      delete status.steps[0].acceptance.effectiveAcceptance.review;
      status.steps[0].acceptance.status = "checked";
    },
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish((status, workflow) => {
    asHostedStatus(status, f.plan.hostedWorkflow);
    fs.writeFileSync(
      path.join(f.reviewNative, "workflow-receipt.json"),
      JSON.stringify(workflow),
    );
    for (const step of status.steps) {
      delete step.acceptance;
      delete step.exitCode;
      delete step.context;
      delete step.launchContractDigest;
      delete step.structuredOutput;
    }
  });
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(complete.verdict, "pass");
  await f.host.sealIntegrationReview(f.id);
  await f.host.runChecks(f.id);
  const { receipt } = await f.host.accept(f.id);
  assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
  assert.equal(receipt.finalEvidence.delivery.targetModified, false);
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D4b dynamic review plans and native-bound capture survive native cleanup without replay", async (t) => {
  const f = await reviewWaveFixture(t);
  assert.equal(f.plan.children.length, 2);
  const { compileRoleWave } = await import("../role-wave.mjs");
  t.diagnostic(
    JSON.stringify({
      classification: "review-wave-compiler-probe",
      script: compileRoleWave(f.plan.children),
    }),
  );
  assert.ok(
    f.plan.children.every(
      (child) =>
        child.agentScope === "user" &&
        child.output === false &&
        child.context === "fresh" &&
        child.intercomBridge?.mode === "off",
    ),
  );
  assert.deepEqual(
    await f.host.planIntegrationReview(f.id, f.wave, f.adapter),
    f.plan,
  );
  assert.equal(f.counts().resolves, 2);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  assert.deepEqual(f.counts(), { resolves: 4, spawns: 1, admissions: 1 });
  f.publish();
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(complete.state, "bound");
  assert.equal(complete.verdict, "pass");
  assert.equal(complete.acceptance, "not-assessed");
  assert.deepEqual(
    complete.reports.map((row) => row.usage.total),
    [10, 10],
  );
  fs.rmSync(f.reviewNative, { recursive: true });
  fs.rmSync(f.plan.sessionDir, { recursive: true });
  assert.deepEqual(
    await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
    complete,
  );
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /consumed/,
  );
  assert.equal(f.counts().spawns, 1);
  assert.throws(() => f.host.accept(f.id), /final review binding/);
});

test("D5 host-owned review admission requires Worker exit and still uses raw usage gates", async (t) => {
  const alive = await reviewWaveFixture(t, 1);
  alive.adapter.assertAdmission = () =>
    alive.orchestrator.assertReviewAdmission(alive.id);
  await assert.rejects(
    alive.host.startIntegrationReview(
      alive.id,
      alive.wave.key,
      alive.plan.planDigest,
      alive.adapter,
    ),
    /Worker must exit/,
  );
  assert.equal(alive.counts().spawns, 0);
  assert.ok(
    !fs.existsSync(
      path.join(
        alive.prepared.executionRoot,
        "integration/reviews/review-one/launch-intent.json",
      ),
    ),
  );
  const stopped = await reviewWaveFixture(t, 1, { stoppedWorker: true });
  stopped.adapter.assertAdmission = () =>
    stopped.orchestrator.assertReviewAdmission(stopped.id);
  await stopped.host.startIntegrationReview(
    stopped.id,
    stopped.wave.key,
    stopped.plan.planDigest,
    stopped.adapter,
  );
  assert.equal(stopped.counts().spawns, 1);
  const exhausted = await reviewWaveFixture(t, 1, {
    stoppedWorker: true,
    mutateMeter(f) {
      const boot = f.worker.mailbox.readJson("receipts/boot.json");
      meteredSession(boot.workerSessionFile, boot.workerSessionId, f.source, {
        input: 950,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 950,
      });
    },
  });
  exhausted.adapter.assertAdmission = () =>
    exhausted.orchestrator.assertReviewAdmission(exhausted.id);
  await assert.rejects(
    exhausted.host.startIntegrationReview(
      exhausted.id,
      exhausted.wave.key,
      exhausted.plan.planDigest,
      exhausted.adapter,
    ),
    /usage|budget/,
  );
  assert.equal(exhausted.counts().spawns, 0);
});

test("D5 a recreated L0 with the same session cannot inherit fresh review admission", async (t) => {
  const f = await reviewWaveFixture(t, 1, { stoppedWorker: true });
  f.orchestrator.assertReviewAdmission(f.id);
  const replacement = new TaskOrchestrator({
    runtimeRoot: f.orchestrator.runtimeRoot,
    ownerSessionId: f.orchestrator.ownerSessionId,
  });
  try {
    assert.throws(
      () => replacement.assertReviewAdmission(f.id),
      /fresh L0 instance admission unavailable/,
    );
  } finally {
    replacement.close();
  }
  f.orchestrator.assertReviewAdmission(f.id);
});

test("D5 one retry carries closed Worker/leaf/review usage and allocations after native cleanup", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    stoppedWorker: true,
    maxProcessRestarts: 1,
  });
  f.adapter.assertAdmission = () => f.orchestrator.assertReviewAdmission(f.id);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  f.orchestrator.requestCancel(f.id, "fixture retry");
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  assert.equal(f.orchestrator.reconcile(f.id).execution.reservationOpen, false);
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  fs.rmSync(f.plan.sessionDir, { recursive: true });
  const contract = f.prepared.contract;
  const nextSpec = { ...contract, ...contract.identity, taskRevision: 2 };
  const next = f.orchestrator.prepare(nextSpec);
  const prior = JSON.parse(
    fs.readFileSync(
      path.join(next.executionRoot, "receipts/prior-usage.json"),
      "utf8",
    ),
  );
  assert.equal(prior.totals.total, 30);
  assert.equal(prior.spawnCount, 2);
  assert.equal(prior.reservedTokens, 200);
  let worker, timer;
  t.after(() => clearInterval(timer));
  f.orchestrator.herdr = {
    async start() {
      worker = new WorkerRuntime({ executionRoot: next.executionRoot });
      worker.boot({
        sessionId: "retry-worker",
        sessionFile: meteredSession(
          path.join(next.executionRoot, "worker-sessions/next.jsonl"),
          "retry-worker",
          f.source,
        ),
        cwd: f.source,
        activeTools: ["read", "team_role_spawn", "team_task_result"],
        extensions: [],
        subagents: { compatible: true, checks: {}, ping: { version: 1 } },
      });
      timer = setInterval(() => worker.processControls(), 5);
      return { paneId: "fixture:retry" };
    },
  };
  await f.orchestrator.launch(next.executionId, { timeoutMs: 1000 });
  clearInterval(timer);
  const { RoleController } = await import("../role-controller.mjs");
  const roles = new RoleController({
    runtime: worker,
    cwd: f.source,
    rpc: {
      request() {
        assert.fail("no native dispatch expected");
      },
    },
  });
  assert.equal(roles.admitTurn().usage.taskTotals.total, 40);
  await assert.rejects(
    roles.spawn({
      role: "team.implementer",
      task: "Read.",
      mode: "read-only",
      maxTokens: 850,
    }),
    /cumulative task allocations/,
  );
  await assert.rejects(
    roles.spawnWave({
      key: "too-many",
      reason: "Fixture only.",
      runs: [0, 1, 2].map((i) => ({
        key: `leaf-${i}`,
        role: "team.implementer",
        task: "Read.",
        mode: "read-only",
        isolation: "shared",
        maxTokens: 10,
      })),
    }),
    /cumulative task spawn/,
  );
  fs.appendFileSync(
    worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
    JSON.stringify({
      type: "message",
      id: "budget-edge",
      message: {
        role: "assistant",
        usage: {
          input: 960,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 960,
        },
      },
    }) + "\n",
  );
  assert.throws(() => roles.admitTurn(), /budget exhausted/);
  assert.throws(() => f.orchestrator.prepare(nextSpec), /restart budget/);
  prior.totals.total--;
  fs.writeFileSync(
    path.join(next.executionRoot, "receipts/prior-usage.json"),
    JSON.stringify(prior),
  );
  assert.throws(() => roles.admitTurn(), /prior usage digest/);
});

test("D5 failed review cost carries without a passing report, but foreign sessions cannot fund a retry", async (t) => {
  for (const foreign of [false, true]) {
    const f = await reviewWaveFixture(t, 1, {
      stoppedWorker: true,
      maxProcessRestarts: 1,
    });
    await f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    );
    const status = f.publish((status) => {
      status.state = "failed";
      status.steps[0].status = "failed";
      status.steps[0].exitCode = 1;
    });
    meteredSession(
      status.steps[0].sessionFile,
      "failed-review-session",
      foreign ? path.join(f.root, "foreign") : f.request.subject.cwd,
      { input: 0, output: 0, cacheRead: 20, cacheWrite: 0, totalTokens: 20 },
    );
    f.orchestrator.requestCancel(f.id, "fixture failed review");
    f.worker.processControls();
    f.worker.confirmCancelled(0);
    f.orchestrator.herdr = {
      closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
    };
    f.orchestrator.reconcile(f.id);
    const next = () =>
      f.orchestrator.prepare({
        ...f.prepared.contract,
        ...f.prepared.contract.identity,
        taskRevision: 2,
      });
    if (foreign) assert.throws(next, /previous review usage unavailable/);
    else {
      const prepared = next();
      const prior = JSON.parse(
        fs.readFileSync(
          path.join(prepared.executionRoot, "receipts/prior-usage.json"),
          "utf8",
        ),
      );
      assert.equal(prior.totals.total, 40);
      assert.equal(prior.totals.cacheRead, 24);
      assert.equal(prior.spawnCount, 2);
    }
  }
});

test("D5 missing or altered historical usage blocks retry before reservation", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    stoppedWorker: true,
    maxProcessRestarts: 1,
  });
  f.orchestrator.requestCancel(f.id, "fixture close");
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  f.orchestrator.reconcile(f.id);
  const native = f.worker.mailbox.readJson("integration/native.json");
  const saved = native.captures.find((row) =>
    row.origin.endsWith("status.json"),
  );
  fs.writeFileSync(
    path.join(f.prepared.executionRoot, "integration", saved.saved),
    "{}",
  );
  assert.throws(
    () =>
      f.orchestrator.prepare({
        ...f.prepared.contract,
        ...f.prepared.contract.identity,
        taskRevision: 2,
      }),
    /historical usage bytes changed/,
  );
  assert.equal(
    f.orchestrator.ledger.listTaskExecutions(
      f.prepared.projectId,
      "goal",
      "task",
    ).length,
    1,
  );
});

test("D4b live admission has no permissive default or approval flag", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  const { assertAdmission: _gate, ...missing } = f.adapter;
  await assert.rejects(
    f.host.startIntegrationReview(f.id, f.wave.key, f.plan.planDigest, missing),
    /admission unavailable/,
  );
  await assert.rejects(
    f.host.startIntegrationReview(f.id, f.wave.key, f.plan.planDigest, {
      ...f.adapter,
      assertAdmission: () => true,
    }),
    /approval flag/,
  );
  await assert.rejects(
    f.host.startIntegrationReview(f.id, f.wave.key, "a".repeat(64), f.adapter),
    /digest mismatch/,
  );
  const changed = {
    ...f.adapter,
    resolve: async (input) => {
      const r = await f.adapter.resolve(input);
      r.contract.launchContractDigest = "b".repeat(64);
      return r;
    },
  };
  await assert.rejects(
    f.host.startIntegrationReview(f.id, f.wave.key, f.plan.planDigest, changed),
    /contract changed/,
  );
  const projectOverride = {
    ...f.adapter,
    resolve: async (input) => {
      const r = await f.adapter.resolve(input);
      r.contract.agent.source = "project";
      return r;
    },
  };
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      projectOverride,
    ),
    /source-controlled/,
  );
  fs.mkdirSync(f.plan.sessionDir);
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /session root already exists/,
  );
  assert.equal(f.counts().spawns, 0);
  assert.ok(
    !fs.existsSync(
      path.join(
        f.prepared.executionRoot,
        "integration/reviews",
        f.wave.key,
        "launch-intent.json",
      ),
    ),
  );
});

test("D4b unknown launch and active wave cannot be retried or hidden by a new key", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await assert.rejects(
    f.host.startIntegrationReview(f.id, f.wave.key, f.plan.planDigest, {
      ...f.adapter,
      rpc: {
        request: async () => {
          throw new Error("ambiguous RPC timeout");
        },
      },
    }),
    /outcome unknown/,
  );
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /consumed/,
  );
  const second = await f.host.planIntegrationReview(
    f.id,
    { ...f.wave, key: "second" },
    f.adapter,
  );
  await assert.rejects(
    f.host.startIntegrationReview(f.id, "second", second.planDigest, f.adapter),
    /unsettled/,
  );
  assert.equal(f.counts().spawns, 0);
});

test("D4b rejects native identity, continuation, process, launch and report mismatches", async (t) => {
  const f = await reviewWaveFixture(t);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  for (const mutate of [
    (s) => {
      s.state = "unknown";
    },
    (s) => {
      s.processTerminal.state = "unknown";
    },
    (s) => {
      s.processTerminal.runnerProcessInstanceId = "";
    },
    (s) => {
      s.sessionId = "foreign";
    },
    (s) => {
      s.usageBudget.exhausted = true;
    },
    (s) => {
      s.steps[0].context = "fork";
    },
    (s) => {
      s.steps[0].launchContractDigest = "a".repeat(64);
    },
    (s) => {
      s.steps[0].exitCode = 1;
    },
    (s) => {
      s.steps[0].modelAttempts = [{}, {}];
    },
    (s) => {
      s.steps[0].acceptance = { status: "rejected" };
    },
    (s) => {
      s.steps[1].sessionFile = s.steps[0].sessionFile;
    },
    (s) => {
      s.steps[0].sessionFile = path.join(f.root, "unowned.jsonl");
    },
    (s) => {
      s.workflow.value[0].runId = "child-0";
    }, // Original writer identity.
    (_s, w) => {
      w.entries["view-0"].continuation.runIds.push("old-child");
    },
    (s) => {
      s.workflow.value[0].structuredOutput.requestDigest = "a".repeat(64);
    },
  ]) {
    f.publish(mutate);
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
    );
  }
  f.publish();
  assert.equal(
    (await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest))
      .verdict,
    "pass",
  );
});

test("D4b unknown or excessive usage is not zero and source/capture tampering blocks readback", async (t) => {
  for (const usage of [
    { input: 1, output: 1, cacheWrite: 0, totalTokens: 2 },
    { input: 101, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 102 },
  ]) {
    const f = await reviewWaveFixture(t, 1);
    await f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    );
    f.publish(() => {}, usage);
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      /usage unknown|budget exceeded/,
    );
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      /incomplete review capture/,
    );
  }
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  const completed = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  const file = path.join(
    f.prepared.executionRoot,
    "integration/reviews",
    f.wave.key,
    completed.captures[0].saved,
  );
  fs.appendFileSync(file, "tamper");
  await assert.rejects(
    f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
    /invalid native review JSON/,
  );
});

test("D4b blocked judgments are preserved, and retained locks/source edits prevent launch", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  const lock = path.join(
    f.prepared.executionRoot,
    "integration/reviews/operation.lock",
  );
  fs.writeFileSync(lock, "other-owner");
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(lock, "utf8"), "other-owner");
  fs.unlinkSync(lock); // Fixture-owned foreign lock.
  const file = path.join(f.request.subject.cwd, "README.md"),
    before = fs.readFileSync(file);
  fs.writeFileSync(file, "changed\n");
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /workspace changed/,
  );
  fs.writeFileSync(file, before);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const status = f.publish((s) => {
    s.workflow.value[0].structuredOutput.verdict = "blocked";
    s.workflow.value[0].structuredOutput.criteria.outcome.status = "blocked";
  });
  // A genuinely BLOCKED review submits that same judgment in its own session.
  const session = status.steps[0].sessionFile;
  const entries = fs
    .readFileSync(session, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  entries[1].message.content[0].arguments.value =
    status.workflow.value[0].structuredOutput;
  fs.writeFileSync(session, entries.map(JSON.stringify).join("\n") + "\n");
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(complete.verdict, "blocked");
  assert.equal(complete.acceptance, "not-assessed");
});

test("D4b prior reservations and identities survive wave boundaries", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  const tooMany = {
    ...f.wave,
    key: "over-budget",
    runs: [0, 1, 2].map((i) => ({ ...f.wave.runs[0], key: `extra-${i}` })),
  };
  const over = await f.host.planIntegrationReview(f.id, tooMany, f.adapter);
  await assert.rejects(
    f.host.startIntegrationReview(f.id, over.key, over.planDigest, f.adapter),
    /spawn budget exhausted/,
  );
  const second = await f.host.planIntegrationReview(
    f.id,
    { ...f.wave, key: "second" },
    f.adapter,
  );
  await f.host.startIntegrationReview(f.id, second.key, second.planDigest, {
    ...f.adapter,
    rpc: {
      request: async () => ({ runId: "review-root", asyncDir: f.reviewNative }),
    },
  });
  await assert.rejects(
    f.host.collectIntegrationReview(f.id, second.key, second.planDigest),
    /identity reused across waves/,
  );
});

test("D4b report requires a successful matching submission in its own native session", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  for (const [label, mutate] of [
    [
      "usage-only unrelated session",
      (entries) => {
        entries[1].message.content = [];
        entries.pop();
      },
    ],
    [
      "failed submission",
      (entries) => {
        entries[2].message.isError = true;
      },
    ],
    [
      "invented tool receipt",
      (entries) => {
        entries[2].message.toolCallId = "foreign";
      },
    ],
    [
      "different report",
      (entries) => {
        entries[1].message.content[0].arguments.value.criteria.outcome.reason =
          "other report";
      },
    ],
    [
      "future session schema",
      (entries) => {
        entries[0].version = 99;
      },
    ],
    [
      "parent session",
      (entries) => {
        entries[0].parentSession = "/parent.jsonl";
      },
    ],
    [
      "second session header",
      (entries) => {
        entries.push(entries[0]);
      },
    ],
    [
      "duplicate message identity",
      (entries) => {
        entries.push(entries[1]);
      },
    ],
    [
      "reused submission identity",
      (entries) => {
        const call = structuredClone(entries[1]),
          result = structuredClone(entries[2]);
        call.id = "earlier-call";
        result.id = "earlier-result";
        result.message.isError = true;
        entries.splice(1, 0, call, result);
      },
    ],
  ]) {
    const status = f.publish();
    const session = status.steps[0].sessionFile;
    const entries = fs
      .readFileSync(session, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    mutate(entries);
    fs.writeFileSync(session, entries.map(JSON.stringify).join("\n") + "\n");
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      undefined,
      label,
    );
  }
  f.publish();
  assert.equal(
    (await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest))
      .state,
    "bound",
  );
});

test("D4b full dispatch envelope and started identity are checked before native capture", async (t) => {
  const { digest } = await import("../contracts.mjs");
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  const dir = path.join(
    f.prepared.executionRoot,
    "integration/reviews",
    f.wave.key,
  );
  const intentFile = path.join(dir, "launch-intent.json"),
    startedFile = path.join(dir, "started.json");
  const intent = JSON.parse(fs.readFileSync(intentFile)),
    started = JSON.parse(fs.readFileSync(startedFile));
  for (const [label, mutate] of [
    [
      "cwd",
      (p) => {
        p.cwd = f.source;
      },
    ],
    [
      "context",
      (p) => {
        p.context = "fork";
      },
    ],
    [
      "budget",
      (p) => {
        p.usageBudget.tokens.hard++;
      },
    ],
    [
      "extra authority",
      (p) => {
        p.worktree = true;
      },
    ],
  ]) {
    const changed = structuredClone(intent);
    mutate(changed.params);
    changed.paramsDigest = digest(changed.params);
    fs.writeFileSync(intentFile, JSON.stringify(changed));
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      undefined,
      label,
    );
  }
  fs.writeFileSync(intentFile, JSON.stringify(intent));
  for (const [label, mutate] of [
    [
      "unknown start schema",
      (s) => {
        s.schemaVersion = "future";
      },
    ],
    [
      "changed owner",
      (s) => {
        s.nativeOwner = "other-owner";
      },
    ],
    [
      "noncanonical async root",
      (s) => {
        s.asyncDir += "/../native-review";
      },
    ],
  ]) {
    const changed = structuredClone(started);
    mutate(changed);
    fs.writeFileSync(startedFile, JSON.stringify(changed));
    await assert.rejects(
      f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
      undefined,
      label,
    );
  }
  fs.writeFileSync(startedFile, JSON.stringify(started));
  assert.equal(
    (await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest))
      .state,
    "bound",
  );
});

test("D4c seals all review evidence, survives cleanup, and closes further admission without acceptance", async (t) => {
  const f = await reviewWaveFixture(t, 2);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  const candidate = await f.host.sealIntegrationReview(f.id);
  assert.equal(candidate.schemaVersion, "teams-integration-review-candidate/1");
  assert.equal(candidate.requestDigest, f.request.digest);
  assert.equal(candidate.acceptance, "not-assessed");
  assert.equal(candidate.waves.length, 1);
  assert.equal(candidate.waves[0].planDigest, f.plan.planDigest);
  const counts = f.counts();
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  fs.rmSync(f.plan.sessionDir, { recursive: true });
  assert.deepEqual(await f.host.sealIntegrationReview(f.id), candidate);
  assert.deepEqual(
    await f.host.planIntegrationReview(f.id, f.wave, f.adapter),
    f.plan,
  );
  await assert.rejects(
    f.host.planIntegrationReview(
      f.id,
      { ...f.wave, key: "late-review" },
      f.adapter,
    ),
    /review candidate.*sealed|review candidate.*intent/,
  );
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /review candidate.*sealed|review candidate.*intent/,
  );
  assert.deepEqual(
    f.counts(),
    counts,
    "sealing never resolves or dispatches reviewers",
  );
  await assert.rejects(f.host.accept(f.id), /native budget version missing/);
  assert.equal(f.orchestrator.ledger.getExecution(f.id).state, "RESULT_READY");
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D4c does not select only PASS: unstarted, unknown and blocked waves prevent a candidate", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  const file = path.join(
    f.prepared.executionRoot,
    "integration/review-candidate.json",
  );
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /uncollected review wave/,
  );
  assert.equal(fs.existsSync(file), false);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /uncollected review wave/,
  );
  const status = f.publish((s) => {
    s.workflow.value[0].structuredOutput.verdict = "blocked";
    s.workflow.value[0].structuredOutput.criteria.outcome.status = "blocked";
  });
  const session = status.steps[0].sessionFile;
  const entries = fs
    .readFileSync(session, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  entries[1].message.content[0].arguments.value =
    status.workflow.value[0].structuredOutput;
  fs.writeFileSync(session, entries.map(JSON.stringify).join("\n") + "\n");
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /review wave did not pass/,
  );
  assert.equal(fs.existsSync(file), false);
});

test("source-bound review preserves native no-start failure for cancellation and accounting", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  const bus = failingNativeBus({
    owner: f.plan.nativeOwner,
    members: f.wave.runs,
  });
  f.adapter.rpc = new SubagentsRpcClient(bus);
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /failed before runner spawn/,
  );
  const dir = path.join(
    f.prepared.executionRoot,
    "integration/reviews",
    f.wave.key,
  );
  assert.ok(fs.existsSync(path.join(dir, "started.json")));
  assert.ok(!fs.existsSync(path.join(dir, "unknown.json")));
  assert.ok(!fs.existsSync(path.join(dir, "complete.json")));
  const mailbox = f.worker.mailbox;
  const lifecycle = readReviewLifecycle(mailbox, f.prepared.contract, "owner");
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].terminal, true);
  assert.equal(lifecycle[0].proof.completion, "failed");
  assert.equal(
    lifecycle[0].proof.processTerminal.reason,
    "spawn-not-attempted",
  );
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /intent consumed/,
  );
  await assert.rejects(f.host.sealIntegrationReview(f.id), /uncollected/);
  assert.equal(bus.count(), 1);
  const context = {
    mailbox,
    contract: f.prepared.contract,
    ownerSessionId: "owner",
    assertOwner() {},
    assertStopped() {},
  };
  const usage = measureClosedExecutionUsage(context);
  assert.equal(usage.sources.filter((s) => s.kind === "review").length, 0);
  assert.ok(usage.totals.total > 0, "prior Worker/leaf cost is retained");
});

test("D4c all planned waves are mandatory, with no automatic collection or new preflight", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  await f.host.planIntegrationReview(
    f.id,
    { ...f.wave, key: "second-view" },
    f.adapter,
  );
  const counts = f.counts();
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /uncollected review wave/,
  );
  assert.deepEqual(f.counts(), counts);
});

test("D4c revalidates source, captures, inventory and the immutable seal; partial intent never replays", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  const candidate = await f.host.sealIntegrationReview(f.id);
  const dir = path.join(f.prepared.executionRoot, "integration");
  const file = path.join(dir, "review-candidate.json");
  const saved = fs.readFileSync(file);
  const counts = f.counts();
  const source = path.join(f.request.subject.cwd, "src/main.txt");
  const sourceBytes = fs.readFileSync(source);
  fs.appendFileSync(source, "drift");
  await assert.rejects(f.host.sealIntegrationReview(f.id), /changed/);
  fs.writeFileSync(source, sourceBytes);
  const captured = path.join(
    dir,
    "reviews",
    f.wave.key,
    complete.captures[0].saved,
  );
  const capturedBytes = fs.readFileSync(captured);
  fs.appendFileSync(captured, "tampered");
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    (error) =>
      error.cause?.message.includes("native review capture changed") === true,
  );
  fs.writeFileSync(captured, capturedBytes);
  const unknown = path.join(dir, "reviews", f.wave.key, "unknown.json");
  fs.writeFileSync(
    unknown,
    JSON.stringify({ disposition: "preserved-reconcile-required" }),
  );
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /unreconciled review wave/,
  );
  fs.unlinkSync(unknown); // Restore this test's injected unresolved marker only.
  const extra = path.join(dir, "reviews/foreign");
  fs.mkdirSync(extra);
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /uncollected review wave/,
  );
  fs.rmdirSync(extra); // Restore this test's deliberate filesystem corruption only.
  fs.writeFileSync(
    file,
    JSON.stringify({ ...candidate, requestDigest: "0".repeat(64) }),
  );
  await assert.rejects(f.host.sealIntegrationReview(f.id), /candidate changed/);
  fs.writeFileSync(file, saved);
  assert.deepEqual(await f.host.sealIntegrationReview(f.id), candidate);
  fs.unlinkSync(file); // Simulate crash after durable intent but before completion.
  await assert.rejects(
    f.host.sealIntegrationReview(f.id),
    /incomplete review candidate/,
  );
  await assert.rejects(
    f.host.planIntegrationReview(f.id, { ...f.wave, key: "late" }, f.adapter),
    /review candidate.*intent/,
  );
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /review candidate.*intent/,
  );
  assert.equal(
    fs.existsSync(file),
    false,
    "partial candidate is never reconstructed",
  );
  assert.deepEqual(f.counts(), counts);
});

for (const reuse of ["none", "root", "run", "session"]) {
  test(`D4c sequential wave inventory independently validates ${reuse} identity reuse`, async (t) => {
    const f = await reviewWaveFixture(t, 1);
    await f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    );
    f.publish();
    await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
    const second = await f.host.planIntegrationReview(
      f.id,
      { ...f.wave, key: "second" },
      f.adapter,
    );
    const native = path.join(f.root, "second-native");
    fs.mkdirSync(native);
    await f.host.startIntegrationReview(f.id, second.key, second.planDigest, {
      ...f.adapter,
      rpc: {
        request: async () => ({
          runId: reuse === "root" ? "review-root" : "second-root",
          asyncDir: native,
        }),
      },
    });
    if (reuse !== "none") {
      // Fault injection: corrupt the predecessor projection to hide an old identity.
      const file = path.join(
        f.prepared.executionRoot,
        "integration/reviews",
        second.key,
        "launch-intent.json",
      );
      const intent = JSON.parse(fs.readFileSync(file));
      intent.predecessors = [];
      fs.writeFileSync(file, JSON.stringify(intent));
    }
    // Reuse the same synthetic public producer, relocating all run/session IDs.
    const status = f.publish((s, w) => {
      s.runId =
        s.processTerminal.runId =
        w.workflowRunId =
          reuse === "root" ? "review-root" : "second-root";
      s.workflowReceiptPath = path.join(native, "workflow.json");
      const row = s.workflow.value[0],
        step = s.steps[0],
        entry = w.entries[row.key];
      row.runId =
        step.runId =
        entry.latestRunId =
          reuse === "run" ? "review-child-0" : "second-child";
      entry.continuation.runIds = [row.runId];
      const entries = fs
        .readFileSync(step.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      entries[0].id = reuse === "session" ? "session-0" : "second-session";
      step.sessionFile = path.join(
        second.sessionDir,
        row.runId,
        "session.jsonl",
      );
      step.launchContractDigest = second.launches[0].launchContractDigest;
      fs.mkdirSync(path.dirname(step.sessionFile), { recursive: true });
      fs.writeFileSync(
        step.sessionFile,
        entries.map(JSON.stringify).join("\n") + "\n",
      );
    });
    fs.copyFileSync(
      path.join(f.reviewNative, "workflow.json"),
      status.workflowReceiptPath,
    );
    fs.writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
    await f.host.collectIntegrationReview(f.id, second.key, second.planDigest);
    if (reuse !== "none") {
      await assert.rejects(
        f.host.sealIntegrationReview(f.id),
        /review inventory reuses identity/,
      );
      return;
    }
    const candidate = await f.host.sealIntegrationReview(f.id);
    assert.deepEqual(
      candidate.waves.map((wave) => wave.key),
      [f.wave.key, second.key].sort(),
    );
    assert.equal(new Set(candidate.waves.map((wave) => wave.runId)).size, 2);
    assert.deepEqual(await f.host.sealIntegrationReview(f.id), candidate);
  });
}

for (const action of [
  "seal-review",
  "read-applied-review",
  "final-acceptance",
  "verified-patch",
]) {
  test(`${action === "seal-review" ? "D4c" : "D4d"} public ${action} consumes actual host evidence without RPC spawn or model access`, async (t) => {
    const { default: extension } = await import(
      "../../extensions/teams-orchestrator/index.mjs"
    );
    const f =
      action === "verified-patch"
        ? await sealedReviewFixture(t, {
            extensionRuntime: true,
            stoppedWorker: true,
          })
        : action === "seal-review"
          ? await reviewWaveFixture(t, 1, { extensionRuntime: true })
          : await appliedReviewFixture(t, {
              extensionRuntime: true,
              stoppedWorker: action === "final-acceptance",
            });
    if (["final-acceptance", "verified-patch"].includes(action))
      f.host.runChecks(f.id);
    if (action === "seal-review") {
      await f.host.startIntegrationReview(
        f.id,
        f.wave.key,
        f.plan.planDigest,
        f.adapter,
      );
      f.publish();
      await f.host.collectIntegrationReview(
        f.id,
        f.wave.key,
        f.plan.planDigest,
      );
    }
    for (const name of ["pi-subagents", "pi-goal-x"]) {
      const dir = path.join(f.root, "npm/node_modules", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          version: "fixture",
          pi: { extensions: ["entry.mjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "entry.mjs"),
        "// Manifest fixture only; never loaded.\n",
      );
    }
    const tools = new Map(),
      handlers = new Map(),
      replies = new Map(),
      rpcCalls = [];
    extension({
      registerTool: (tool) => tools.set(tool.name, tool),
      on: (name, handler) => handlers.set(name, handler),
      getActiveTools: () => ["update_goal_task", "update_goal"],
      getAllTools: () => [
        {
          name: "update_goal",
          parameters: { properties: { status: { enum: ["complete"] } } },
        },
        {
          name: "update_goal_task",
          parameters: {
            properties: {
              task_id: { type: "string" },
              status: { enum: ["complete"] },
              updates: {
                items: {
                  properties: {
                    task_id: { type: "string" },
                    status: { enum: ["complete"] },
                  },
                },
              },
            },
          },
        },
      ],
      events: {
        on: (name, handler) => {
          replies.set(name, handler);
          return () => replies.delete(name);
        },
        emit: (_name, request) => {
          rpcCalls.push(request.method);
          assert.equal(
            request.method,
            "ping",
            "no native spawn/control in this test",
          );
          replies.get(`subagents:rpc:v1:reply:${request.requestId}`)({
            version: 1,
            requestId: request.requestId,
            success: true,
            data: {},
          });
        },
      },
    });
    const previous = Object.fromEntries(
      ["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID"].map((name) => [
        name,
        process.env[name],
      ]),
    );
    process.env.PI_CODING_AGENT_DIR = f.root;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    try {
      const ctx = {
        cwd: f.source,
        sessionManager: { getSessionId: () => "owner" },
        modelRegistry: {
          getAvailable() {
            throw new Error("seal must not query models");
          },
        },
        ui: { setStatus() {} },
      };
      await handlers.get("session_start")({}, ctx); // Isolated temp ledger; no runtime reload.
      if (["final-acceptance", "verified-patch"].includes(action)) {
        const accepted = await tools
          .get("team_task_accept")
          .execute("accept", { execution_id: f.id }, undefined, undefined, ctx);
        assert.equal(
          accepted.details.receipt.schemaVersion,
          action === "verified-patch"
            ? "teams-task-acceptance/3"
            : "teams-task-acceptance/2",
        );
        if (action === "verified-patch")
          assert.match(
            accepted.content[0].text,
            /Verified patch: .*; target unchanged/,
          );
        const event = {
          toolName: "update_goal_task",
          toolCallId: "goal-write",
          input: { task_id: "task", status: "complete" },
        };
        assert.equal(await handlers.get("tool_call")(event), undefined);
        assert.equal(
          event.input.evidence,
          `task-runtime:${accepted.details.receipt.acceptanceId}`,
        );
        const receipt = accepted.details.receipt;
        receipt.finalEvidence.sourceDigest = "0".repeat(64);
        fs.writeFileSync(receipt.receiptRef, JSON.stringify(receipt));
        const blocked = await handlers.get("tool_call")({
          ...event,
          toolCallId: "second-write",
        });
        assert.equal(
          blocked.block,
          true,
          "a rejected async verifier must BLOCK, not throw through Pi",
        );
        const reply = await handlers.get("tool_result")({
          toolCallId: "goal-write",
          isError: false,
          content: [],
          details: {
            goal: {
              id: "goal",
              taskList: {
                tasks: [
                  {
                    id: "task",
                    status: "complete",
                    evidence: event.input.evidence,
                  },
                ],
              },
            },
          },
        });
        assert.ok(reply.content[0].text.includes("reconciliation failed"));
        assert.equal(
          f.orchestrator.ledger.getExecution(f.id).goalCommitState,
          "committed",
        );
        assert.equal(
          f.orchestrator.ledger.getExecution(f.id).reservationOpen,
          true,
        );
        assert.deepEqual(rpcCalls, ["ping"]);
        return;
      }
      const tool = tools.get("team_task_stage_integration");
      assert.ok(tool.parameters.properties.action.enum.includes(action));
      const params = {
        execution_id: f.id,
        action,
        ...(f.applyPlan ? { plan_digest: f.applyPlan.planDigest } : {}),
      };
      const result = await tool.execute(
        "seal-one",
        params,
        undefined,
        undefined,
        ctx,
      );
      const candidate = result.details.candidate ?? result.details;
      assert.equal(candidate.acceptance, "not-assessed");
      assert.match(
        result.content[0].text,
        /final acceptance remains? blocked|No writes or acceptance/,
      );
      assert.deepEqual(
        candidate,
        f.candidate ?? (await f.host.sealIntegrationReview(f.id)),
      );
      await assert.rejects(
        tool.execute(
          "selector",
          { ...params, key: "only-good" },
          undefined,
          undefined,
          ctx,
        ),
        /no wave selectors/,
      );
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        tool.execute("cancelled", params, aborted.signal, undefined, ctx),
        /cancelled/,
      );
      assert.deepEqual(rpcCalls, ["ping"]);
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).state,
        "RESULT_READY",
      );
    } finally {
      handlers.get("session_shutdown")();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

test("D4d applied proof rejects retained locks and forged terminal/baseline fields on idempotent readback", async (t) => {
  const { digest } = await import("../contracts.mjs");
  const f = await applyFixture(t),
    id = f.prepared.executionId;
  const receipt = await f.host.applyIntegration(
    id,
    f.plan.planDigest,
    () => true,
  );
  const commandFile = path.join(f.applyDir, "apply-command.json");
  const receiptFile = path.join(f.applyDir, "apply-receipt.json");
  const intentFile = path.join(f.applyDir, "apply-intent.json");
  const command = JSON.parse(fs.readFileSync(commandFile)),
    intent = JSON.parse(fs.readFileSync(intentFile));
  for (const mutate of [
    (c) => {
      c.mutationTerminal.signal = "SIGTERM";
    },
    (c) => {
      c.mutationTerminal.error = "ETIMEDOUT";
    },
    (c) => {
      c.observationError = "target observation failed";
    },
  ]) {
    const changed = structuredClone(command);
    mutate(changed);
    fs.writeFileSync(commandFile, JSON.stringify(changed));
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({ ...receipt, commandDigest: digest(changed) }),
    );
    await assert.rejects(
      f.host.applyIntegration(id, f.plan.planDigest, () => {
        throw Error("must not confirm");
      }),
    );
  }
  fs.writeFileSync(commandFile, JSON.stringify(command));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.writeFileSync(
    intentFile,
    JSON.stringify({
      ...intent,
      before: { ...intent.before, workspaceDigest: "0".repeat(64) },
    }),
  );
  fs.writeFileSync(
    receiptFile,
    JSON.stringify({
      ...receipt,
      before: { ...intent.before, workspaceDigest: "0".repeat(64) },
    }),
  );
  await assert.rejects(
    f.host.applyIntegration(id, f.plan.planDigest, () => true),
    /baseline/,
  );
  fs.writeFileSync(intentFile, JSON.stringify(intent));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.writeFileSync(path.join(f.applyDir, "operation.lock"), "retained");
  await assert.rejects(
    f.host.applyIntegration(id, f.plan.planDigest, () => true),
    /lock/,
  );
  fs.unlinkSync(path.join(f.applyDir, "operation.lock")); // Restore injected fixture fault.
  assert.deepEqual(
    f.host.verifyIntegrationApply(id, f.plan.planDigest),
    receipt,
  );
});

test("D5a worker cache and unknown usage block review before dispatch", async (t) => {
  for (const fault of ["cache", "missing", "foreign", "malformed"])
    await t.test(fault, async (sub) => {
      const f = await reviewWaveFixture(sub, 1);
      const file =
        f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile;
      if (fault === "cache")
        meteredSession(file, "worker", f.source, {
          input: 1,
          output: 1,
          cacheRead: 900,
          cacheWrite: 0,
          totalTokens: 902,
        });
      if (fault === "missing") meteredSession(file, "worker", f.source, {});
      if (fault === "foreign") meteredSession(file, "somebody-else", f.source);
      if (fault === "malformed") fs.appendFileSync(file, "{partial");
      await assert.rejects(
        f.host.startIntegrationReview(
          f.id,
          f.wave.key,
          f.plan.planDigest,
          f.adapter,
        ),
        /usage|budget|session/i,
      );
      assert.equal(f.counts().spawns, 0);
      assert.equal(
        fs.existsSync(
          path.join(
            f.prepared.executionRoot,
            "integration/reviews",
            f.wave.key,
            "launch-intent.json",
          ),
        ),
        false,
      );
    });
});

test("D5a usage is re-read after the asynchronous lifecycle hook", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  f.adapter.assertAdmission = async () => {
    const file =
      f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile;
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "message",
        id: "more-usage",
        message: {
          role: "assistant",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 980,
            cacheWrite: 0,
            totalTokens: 980,
          },
        },
      }) + "\n",
    );
  };
  await assert.rejects(
    f.host.startIntegrationReview(
      f.id,
      f.wave.key,
      f.plan.planDigest,
      f.adapter,
    ),
    /budget/,
  );
  assert.equal(f.counts().spawns, 0);
});

test("D5a native usage rejects malformed, inherited, reused and over-budget sessions", async (t) => {
  for (const fault of [
    "unknown",
    "duplicate",
    "inherited",
    "reused",
    "overflow",
    "budget",
    "pending",
  ])
    await t.test(fault, async (sub) => {
      const f = await reviewWaveFixture(sub, 1, {
        mutateMeter(fixture) {
          const file = fixture.status.steps[0].sessionFile;
          const rows = fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse);
          if (fault === "unknown")
            rows.push({ type: "future-usage", id: "future" });
          if (fault === "duplicate") rows.push(rows[1]);
          if (fault === "inherited")
            rows[0].parentSession = "/not-a-fresh-session";
          if (fault === "reused") rows[0].id = "worker";
          if (fault === "pending") rows[1].message.stopReason = "pending";
          if (["overflow", "budget"].includes(fault))
            rows[1].message.usage = {
              input: fault === "overflow" ? Number.MAX_SAFE_INTEGER : 101,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 102,
            };
          fs.writeFileSync(
            file,
            rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          );
        },
      });
      await assert.rejects(
        f.host.startIntegrationReview(
          f.id,
          f.wave.key,
          f.plan.planDigest,
          f.adapter,
        ),
        /usage|budget|session/,
      );
      assert.equal(f.counts().spawns, 0);
    });
});

test("D5a truncation during admission and unavailable prior-execution usage cannot reset a budget", async (t) => {
  for (const fault of ["truncate", "prior", "missing-history"])
    await t.test(fault, async (sub) => {
      const f = await reviewWaveFixture(sub, 1);
      if (fault === "truncate")
        f.adapter.assertAdmission = () => {
          meteredSession(
            f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
            "worker",
            f.source,
            {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
            },
          );
        };
      else {
        const file = path.join(f.prepared.executionRoot, "bootstrap.json");
        const boot = JSON.parse(fs.readFileSync(file));
        if (fault === "prior") boot.priorExecutionId = "previous-execution";
        else delete boot.priorExecutionId;
        fs.writeFileSync(file, JSON.stringify(boot));
      }
      await assert.rejects(
        f.host.startIntegrationReview(
          f.id,
          f.wave.key,
          f.plan.planDigest,
          f.adapter,
        ),
        /usage|budget/,
      );
      assert.equal(f.counts().spawns, 0);
    });
});

test("D5a blocked previous review still consumes the next admission budget", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish(
    (status) => {
      for (const step of status.steps) {
        step.structuredOutput.verdict = "blocked";
        const rows = fs
          .readFileSync(step.sessionFile, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        rows[1].message.content[0].arguments.value.verdict = "blocked";
        fs.writeFileSync(
          step.sessionFile,
          rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
      }
    },
    { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 99 },
  );
  const completed = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(completed.verdict, "blocked");
  const next = await f.host.planIntegrationReview(
    f.id,
    { ...f.wave, key: "next-review" },
    f.adapter,
  );
  const file =
    f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile;
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "message",
      id: "more",
      message: {
        role: "assistant",
        usage: {
          input: 850,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 850,
        },
      },
    }) + "\n",
  );
  await assert.rejects(
    f.host.startIntegrationReview(f.id, next.key, next.planDigest, f.adapter),
    /budget/,
  );
  assert.equal(f.counts().spawns, 1);
});

test("D5a unknown review entries cannot silently omit usage", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish((status) => {
    fs.appendFileSync(
      status.steps[0].sessionFile,
      JSON.stringify({
        type: "future-usage",
        id: "unrecognized",
        usage: { input: 900 },
      }) + "\n",
    );
  });
  await assert.rejects(
    f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest),
    /usage/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        f.prepared.executionRoot,
        "integration/reviews",
        f.wave.key,
        "complete.json",
      ),
    ),
    false,
  );
});

test("D5a native failure costs are measurable without claiming acceptance", async (t) => {
  const { measureExecutionUsage } = await import("../task-usage.mjs");
  const f = await fixture(t, ["alpha"]);
  f.status.state = "failed";
  f.status.steps[0].status = "failed";
  f.saveStatus();
  const measured = measureExecutionUsage({
    mailbox: f.worker.mailbox,
    contract: f.prepared.contract,
    result: { childRunRefs: ["wave"] },
    assertOwner: () =>
      f.orchestrator.assertController(f.prepared.contract.identity.projectId),
  });
  assert.equal(measured.totals.total, 20);
  assert.equal(measured.sources[1].status, "failed");
  assert.equal(measured.acceptance, "not-assessed");
});

test("D5a launch intent records measured worker and native sessions, never a model estimate", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  fs.rmSync(path.join(f.prepared.executionRoot, "role-sessions"), {
    recursive: true,
  });
  fs.rmSync(f.native, { recursive: true });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const intent = JSON.parse(
    fs.readFileSync(
      path.join(
        f.prepared.executionRoot,
        "integration/reviews",
        f.wave.key,
        "launch-intent.json",
      ),
    ),
  );
  assert.equal(intent.usageAdmission.totals.total, 20);
  assert.equal(intent.usageAdmission.totals.cacheRead, 4);
  assert.equal(intent.usageAdmission.sources.length, 2);
  assert.equal(intent.usageAdmission.nextReservation, 100);
  assert.equal(intent.usageAdmission.acceptance, "not-assessed");
});

test("D7 review cancellation counts pending, failed and captured native runs", async (t) => {
  const { readReviewLifecycle } = await import("../role-lifecycle.mjs");
  const f = await reviewWaveFixture(t);
  const read = () =>
    readReviewLifecycle(
      f.worker.mailbox,
      f.prepared.contract,
      f.orchestrator.ownerSessionId,
    )[0];
  assert.equal(read().disposition, "not-started");
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  assert.equal(read().terminal, false);
  f.publish((status) => {
    status.state = "failed";
    status.steps[0].status = "failed";
  });
  assert.equal(read().terminal, true);
  assert.equal(read().proof.completion, "failed");
  for (const mutate of [
    (status) => {
      status.sessionId = "foreign-owner";
    },
    (status) => {
      status.steps.pop();
    },
    (status) => {
      status.steps[0].children = [{ status: "running" }];
    },
    (status) => {
      status.processTerminal.state = "unknown";
    },
    (status) => {
      status.steps[0].status = "running";
    },
  ]) {
    f.publish(mutate);
    assert.equal(read().terminal, false);
  }
  f.publish();
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  fs.rmSync(f.reviewNative, { recursive: true, force: true });
  assert.equal(read().terminal, true); // The existing SHA-bound capture outlives native temp files.
  const capture = complete.captures.find((row) =>
    row.origin.endsWith("/status.json"),
  );
  fs.appendFileSync(
    path.join(
      f.prepared.executionRoot,
      "integration/reviews",
      f.wave.key,
      capture.saved,
    ),
    " ",
  );
  assert.equal(read().terminal, false);
  assert.match(read().error, /capture changed/);
});

test("D7 review spawn without an acknowledged run never counts as zero", async (t) => {
  const { readReviewLifecycle } = await import("../role-lifecycle.mjs");
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  fs.unlinkSync(
    path.join(
      f.prepared.executionRoot,
      "integration/reviews",
      f.wave.key,
      "started.json",
    ),
  );
  const runs = readReviewLifecycle(
    f.worker.mailbox,
    f.prepared.contract,
    f.orchestrator.ownerSessionId,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].terminal, false);
  assert.equal(runs[0].runId, null);
  assert.equal(f.counts().spawns, 1);
});

test("D6 Goal metadata updates survive both final delivery modes and readback without hiding other pi files", async (t) => {
  const { createGoalGuard } = await import("../goal-guard.mjs");
  for (const applied of [false, true])
    await t.test(applied ? "applied-target" : "verified-patch", async (sub) => {
      const options = { stoppedWorker: true, goalMetadata: true };
      const f = applied
        ? await appliedReviewFixture(sub, options)
        : await sealedReviewFixture(sub, options);
      const goalFile = path.join(f.source, ".pi/goals/active_goal_fixture.md");
      fs.writeFileSync(goalFile, "synthetic Goal accounting update\n");
      fs.writeFileSync(
        path.join(f.source, ".pi/.goals-pool-snapshot.json"),
        '{"updated":true}',
      );
      f.host.runChecks(f.id);
      const { receipt } = await f.host.accept(f.id);
      const guard = createGoalGuard(f.orchestrator, f.source);
      const input = { goalId: "goal", taskId: "task" };
      assert.equal((await guard.beforeTaskCompletion(input)).ok, true);
      const foreign = path.join(f.source, ".pi/not-goal.json");
      fs.writeFileSync(foreign, "unexpected");
      await assert.rejects(
        guard.beforeTaskCompletion(input),
        /outside allowed write scope/,
      );
      fs.unlinkSync(foreign);
      fs.writeFileSync(goalFile, "synthetic Goal complete\n");
      let closes = 0;
      f.orchestrator.herdr = {
        closeIdle(paneId) {
          closes++;
          return { paneId, disposition: "closed" };
        },
      };
      await guard.afterTaskCompletion({
        ...input,
        evidence: `task-runtime:${receipt.acceptanceId}`,
      });
      assert.equal(closes, 1);
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).reservationOpen,
        false,
      );
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).goalCommitState,
        "committed",
      );
    });
});

test("D4 final applied acceptance binds checks and terminal usage, then verifies Goal readback", async (t) => {
  const f = await appliedReviewFixture(t, { stoppedWorker: true });
  f.host.runChecks(f.id);
  const accepted = await f.host.accept(f.id);
  assert.equal(accepted.receipt.schemaVersion, "teams-task-acceptance/2");
  assert.equal(accepted.execution.state, "ACCEPTED");
  assert.equal(accepted.execution.reservationOpen, true);
  assert.equal(accepted.receipt.finalEvidence.usage.taskTotals.total, 30);
  assert.equal(f.status.steps[0].acceptance.status, "review-required");
  assert.deepEqual((await f.host.accept(f.id)).receipt, accepted.receipt);
  const { createGoalGuard } = await import("../goal-guard.mjs");
  const guard = createGoalGuard(f.orchestrator, f.source);
  const input = { goalId: "goal", taskId: "task" };
  assert.equal((await guard.beforeTaskCompletion(input)).ok, true);
  fs.appendFileSync(path.join(f.source, "src/main.txt"), "drift\n");
  await assert.rejects(guard.beforeTaskCompletion(input));
  assert.equal(f.orchestrator.ledger.getExecution(f.id).reservationOpen, true);
  await assert.rejects(
    guard.afterTaskCompletion({
      ...input,
      evidence: `task-runtime:${accepted.receipt.acceptanceId}`,
    }),
  );
  assert.equal(
    f.orchestrator.ledger.getExecution(f.id).goalCommitState,
    "committed",
  );
  assert.equal(f.orchestrator.ledger.getExecution(f.id).reservationOpen, true);
  // Do not restore Git stat/index to fake freshness. This accepted case stops here.
});

test("D4 final Goal readback closes once; ambiguous cleanup never releases or replays", async (t) => {
  const { createGoalGuard } = await import("../goal-guard.mjs");
  for (const ambiguous of [false, true]) {
    const f = await appliedReviewFixture(t, { stoppedWorker: true });
    f.host.runChecks(f.id);
    const { receipt } = await f.host.accept(f.id);
    const guard = createGoalGuard(f.orchestrator, f.source);
    const args = {
      goalId: "goal",
      taskId: "task",
      evidence: `task-runtime:${receipt.acceptanceId}`,
    };
    let closes = 0,
      idle = false;
    f.orchestrator.herdr = {
      isIdle: () => idle,
      closeIdle(paneId) {
        closes++;
        if (ambiguous) throw Error("fixture lost close reply");
        return { paneId, disposition: "closed" };
      },
    };
    await assert.rejects(guard.afterTaskCompletion(args), /not idle/);
    assert.equal(
      fs.existsSync(
        path.join(
          f.prepared.executionRoot,
          "receipts/accepted-pane-intent.json",
        ),
      ),
      false,
    );
    idle = true;
    if (ambiguous) {
      await assert.rejects(guard.afterTaskCompletion(args), /lost close reply/);
      await assert.rejects(guard.afterTaskCompletion(args), /outcome unknown/);
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).reservationOpen,
        true,
      );
    } else {
      await guard.afterTaskCompletion(args);
      await guard.afterTaskCompletion(args);
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).reservationOpen,
        false,
      );
      assert.equal(guard.beforeGoalCompletion({ goalId: "goal" }).ok, true);
    }
    assert.equal(closes, 1);
    assert.equal(
      f.orchestrator.ledger.getExecution(f.id).goalCommitState,
      "committed",
    );
  }
});

test("D4 final acceptance rejects missing checks, late budget, manifest and review capture tampering", async (t) => {
  for (const fault of ["checks", "budget", "manifest", "review"]) {
    const f = await appliedReviewFixture(t, { stoppedWorker: true });
    if (fault !== "checks") f.host.runChecks(f.id);
    if (fault === "budget")
      fs.appendFileSync(
        f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        JSON.stringify({
          type: "message",
          id: "late-cost",
          message: {
            role: "assistant",
            usage: {
              input: 1000,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1000,
            },
          },
        }) + "\n",
      );
    if (fault === "manifest") {
      const stored = f.orchestrator.ledger.getLatestResult(f.id);
      const result = JSON.parse(fs.readFileSync(stored.resultRef));
      const manifest = f.worker.mailbox.readJson(result.source.manifestRef);
      manifest.files.pop();
      fs.writeFileSync(
        path.join(f.prepared.executionRoot, result.source.manifestRef),
        JSON.stringify(manifest),
      );
    }
    if (fault === "review") {
      const complete = f.worker.mailbox.readJson(
        "integration/reviews/review-one/complete.json",
      );
      fs.writeFileSync(
        path.join(
          f.prepared.executionRoot,
          "integration/reviews/review-one",
          complete.captures[0].saved,
        ),
        "{}",
      );
    }
    await assert.rejects(f.host.accept(f.id));
    assert.equal(
      f.orchestrator.ledger.getExecution(f.id).state,
      "RESULT_READY",
    );
    assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
  }
});

test("D4 final checks cannot hide exit-zero writes outside sourcePaths or replay them", async (t) => {
  const f = await appliedReviewFixture(t, {
    stoppedWorker: true,
    checkScript:
      "if(require('node:path').basename(process.cwd())==='source') require('node:fs').appendFileSync('README.md','one-final-check\\n')",
  });
  assert.throws(() => f.host.runChecks(f.id));
  assert.throws(() => f.host.runChecks(f.id));
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "baseline\none-final-check\n",
  );
  assert.throws(() => f.host.accept(f.id));
  assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
});

test("D4 final acceptance cannot publish through an owner change at the ledger commit", async (t) => {
  const f = await appliedReviewFixture(t, { stoppedWorker: true });
  f.host.runChecks(f.id);
  const original = f.orchestrator.ledger.transition.bind(f.orchestrator.ledger);
  f.orchestrator.ledger.transition = (...args) => {
    const value = original(...args);
    if (args[3] === "VALIDATING")
      f.orchestrator.ledger.db
        .prepare(
          "UPDATE controllers SET owner_epoch = owner_epoch + 1 WHERE project_id = ?",
        )
        .run(f.prepared.projectId);
    return value;
  };
  await assert.rejects(f.host.accept(f.id), /controller epoch changed/);
  assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
  assert.equal(f.orchestrator.ledger.getExecution(f.id).reservationOpen, true);
});

test("D4 verify-only rejects stale, partial, unmetered or mislabelled deliveries", async (t) => {
  for (const fault of [
    "patch",
    "staged",
    "target",
    "check",
    "seal",
    "apply-journal",
    "budget",
    "delivery",
    "schema",
    "patch-after-accept",
  ]) {
    await t.test(fault, async (sub) => {
      const f = await sealedReviewFixture(sub, { stoppedWorker: true });
      const root = path.join(f.prepared.executionRoot, "integration");
      const accepted = ["delivery", "schema", "patch-after-accept"].includes(
        fault,
      )
        ? await f.host.accept(f.id)
        : null;
      if (fault.startsWith("patch"))
        fs.appendFileSync(path.join(root, "review.patch"), "tampered");
      if (fault === "staged")
        fs.appendFileSync(path.join(root, "repo/README.md"), "hidden");
      if (fault === "target")
        fs.appendFileSync(path.join(f.source, "src/main.txt"), "changed");
      if (fault === "check") fs.unlinkSync(path.join(root, "check-check.json"));
      if (fault === "seal")
        fs.unlinkSync(path.join(root, "review-candidate.json"));
      if (fault === "apply-journal")
        fs.mkdirSync(path.join(root, "target-apply"));
      if (fault === "budget")
        fs.appendFileSync(
          f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
          JSON.stringify({
            type: "message",
            id: "late-cost",
            message: {
              role: "assistant",
              usage: {
                input: 1000,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 1000,
              },
            },
          }) + "\n",
        );
      if (["delivery", "schema"].includes(fault)) {
        const changed = structuredClone(accepted.receipt);
        if (fault === "delivery")
          changed.finalEvidence.delivery.targetModified = true;
        else changed.schemaVersion = "teams-task-acceptance/2";
        fs.writeFileSync(changed.receiptRef, JSON.stringify(changed));
      }
      await assert.rejects(async () => f.host.accept(f.id));
      assert.equal(
        f.orchestrator.ledger.getExecution(f.id).reservationOpen,
        true,
      );
      if (accepted) {
        const { createGoalGuard } = await import("../goal-guard.mjs");
        await assert.rejects(
          createGoalGuard(f.orchestrator, f.source).beforeTaskCompletion({
            goalId: "goal",
            taskId: "task",
          }),
        );
        assert.equal(
          f.orchestrator.ledger.getExecution(f.id).goalCommitState,
          "prepared",
        );
      } else assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
    });
  }
});

test("shared Task pool accepts writers and source-bound reviewers beyond soft estimates, then readback closes", async (t) => {
  // Synthetic native records / reported usage; real ledger, Git, host checks,
  // review consumer and AcceptanceReceipt seam. SDK request gating is tested separately.
  function finishMeter(context, key, sessionFile, estimate, register = true) {
    const measured = measureSessionBytes(fs.readFileSync(sessionFile));
    if (register)
      registerTaskBudgetMembers(context, [
        { key, estimate, sessionRoot: path.dirname(sessionFile) },
      ]);
    const binding = taskBudgetBinding(context, key);
    const identity = { sessionId: measured.sessionId, sessionFile };
    changeTaskBudget(binding, { type: "bind", ...identity });
    changeTaskBudget(binding, {
      type: "request",
      ...identity,
      used: 0,
      allowance: 20,
    });
    changeTaskBudget(binding, {
      type: "settle",
      ...identity,
      used: measured.usage.total,
    });
    changeTaskBudget(binding, {
      type: "finish",
      ...identity,
      used: measured.usage.total,
    });
  }
  const f = await reviewWaveFixture(t, 1, {
    tokenBudgetMode: "shared",
    roleEstimate: 1,
    reviewEstimate: 1,
    stoppedWorker: true,
    writerEvidence: true,
    mutateMeter(f) {
      const context = {
        contract: f.prepared.contract,
        mailbox: f.worker.mailbox,
      };
      finishMeter(
        context,
        "worker",
        f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        0,
        false,
      );
      finishMeter(
        context,
        "role.launch.lane-0",
        f.status.steps[0].sessionFile,
        1,
      );
    },
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const status = f.publish();
  const context = { contract: f.prepared.contract, mailbox: f.worker.mailbox };
  finishMeter(
    context,
    `review.${f.wave.key}.view-0`,
    status.steps[0].sessionFile,
    1,
    false,
  );
  const complete = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(complete.verdict, "pass");
  assert.equal(complete.reports[0].usage.total, 10);
  assert.equal(complete.reports[0].maxTokens, 1);
  await f.host.sealIntegrationReview(f.id);
  const { receipt } = await f.host.accept(f.id);
  assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
  assert.equal(receipt.finalEvidence.delivery.targetModified, false);
  assert.equal(readTaskBudget(context).members["role.launch.lane-0"].used, 10);
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  assert.deepEqual((await f.host.accept(f.id)).receipt, receipt);
  const { createGoalGuard } = await import("../goal-guard.mjs");
  const guard = createGoalGuard(f.orchestrator, f.source);
  const args = { goalId: "goal", taskId: "task" };
  const gate = await guard.beforeTaskCompletion(args);
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      return { paneId, disposition: "closed" };
    },
  };
  await guard.afterTaskCompletion({ ...args, evidence: gate.evidence });
  assert.equal(f.orchestrator.ledger.getExecution(f.id).reservationOpen, false);
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D4 verify-only accepts a durable reviewed patch without applying or rerunning checks", async (t) => {
  const f = await sealedReviewFixture(t, { stoppedWorker: true });
  const index = fs.readFileSync(path.join(f.source, ".git/index"));
  const staged = f.worker.mailbox.readJson("integration/receipt.json");
  const check = path.join(
    f.prepared.executionRoot,
    "integration/check-check.json",
  );
  const before = fs.readFileSync(check);
  const checks = f.host.runChecks(f.id);
  assert.equal(checks[0].sourceDigest, staged.sourceDigest);
  const { receipt } = await f.host.accept(f.id);
  assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
  assert.equal(receipt.finalEvidence.delivery.kind, "verified-patch");
  assert.equal(receipt.finalEvidence.delivery.targetModified, false);
  assert.equal(
    receipt.finalEvidence.delivery.patchRef,
    path.join(f.prepared.executionRoot, "integration/review.patch"),
  );
  assert.equal(receipt.sourceDigest, staged.sourceDigest);
  assert.notEqual(receipt.sourceDigest, receipt.candidateSourceDigest);
  assert.deepEqual(fs.readFileSync(check), before);
  assert.deepEqual(fs.readFileSync(path.join(f.source, ".git/index")), index);
  assert.equal(git(f.source, "status", "--porcelain"), "");
  assert.equal(
    fs.existsSync(
      path.join(f.prepared.executionRoot, "integration/target-apply"),
    ),
    false,
  );
  assert.equal(f.status.steps[0].acceptance.status, "review-required");
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  assert.deepEqual((await f.host.accept(f.id)).receipt, receipt);
  const { createGoalGuard } = await import("../goal-guard.mjs");
  const guard = createGoalGuard(f.orchestrator, f.source);
  const args = { goalId: "goal", taskId: "task" };
  const gate = await guard.beforeTaskCompletion(args);
  let closed = 0;
  f.orchestrator.herdr = {
    closeIdle(paneId) {
      closed++;
      return { paneId, disposition: "closed" };
    },
  };
  await guard.afterTaskCompletion({ ...args, evidence: gate.evidence });
  assert.equal(closed, 1);
  assert.equal(f.orchestrator.ledger.getExecution(f.id).reservationOpen, false);
});

// Real L0 apply consumer and Git/journal; native producer/admission and UI replies
// remain isolated fixtures, not live launch authority.
test("D6 native fractional cost telemetry binds exact bytes through final acceptance", async (t) => {
  const { bytesDigest } = await import("../contracts.mjs");
  const f = await sealedReviewFixture(t, {
    stoppedWorker: true,
    mutateWriter(status) {
      status.totalCost = { costUsd: 0.019441760000000002 };
    },
  });
  await f.host.runChecks(f.id);
  const accepted = await f.host.accept(f.id);
  assert.equal(accepted.receipt.schemaVersion, "teams-task-acceptance/3");
  assert.equal(accepted.receipt.finalEvidence.delivery.targetModified, false);
  assert.equal(
    accepted.receipt.finalEvidence.reviewBinding.writerEvidenceDigest,
    digest([
      {
        runId: "wave",
        statusDigest: bytesDigest(
          fs.readFileSync(path.join(f.native, "status.json")),
        ),
      },
    ]),
  );
  await f.host.verifyAccepted(f.id);
  // Exact native bytes stay protected; the task canonical integer rule stays strict.
  assert.throws(() => digest(f.status), /safe JSON integers required/);
  const receipt = f.worker.mailbox.readJson("integration/receipt.json");
  const capture = receipt.captures.find(
    (row) => row.origin === path.join(f.native, "status.json"),
  );
  fs.appendFileSync(
    path.join(f.worker.mailbox.root, "integration", capture.saved),
    " ",
  );
  await assert.rejects(f.host.verifyAccepted(f.id), /capture|changed/);
});

async function sealedReviewFixture(t, options = {}) {
  const f = await reviewWaveFixture(t, 1, { ...options, writerEvidence: true });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  const candidate = await f.host.sealIntegrationReview(f.id);
  return { ...f, candidate };
}

async function appliedReviewFixture(t, options = {}) {
  const f = await sealedReviewFixture(t, {
    ...options,
    integrationMode: "approved-integration",
  });
  const { candidate } = f;
  const applyPlan = f.host.prepareIntegrationApply(f.id);
  const application = await f.host.applyIntegration(
    f.id,
    applyPlan.planDigest,
    () =>
      options.confirm ? options.confirm({ ...f, candidate, applyPlan }) : true,
  );
  return { ...f, candidate, applyPlan, application };
}

test("D4d reads a sealed review against actual applied target proof, without re-sealing or acceptance", async (t) => {
  const f = await appliedReviewFixture(t);
  const before = fs.readFileSync(
    path.join(f.prepared.executionRoot, "integration/review-candidate.json"),
  );
  assert.throws(() => f.host.prepareIntegrationReview(f.id), /clean|dirty/);
  assert.deepEqual(
    await f.host.readAppliedIntegrationReview(f.id, f.applyPlan.planDigest),
    f.candidate,
  );
  assert.deepEqual(
    f.host.verifyIntegrationApply(f.id, f.applyPlan.planDigest),
    f.application,
  );
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  fs.rmSync(f.plan.sessionDir, { recursive: true });
  assert.deepEqual(
    await f.host.readAppliedIntegrationReview(f.id, f.applyPlan.planDigest),
    f.candidate,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(f.prepared.executionRoot, "integration/review-candidate.json"),
    ),
    before,
  );
  await assert.rejects(f.host.accept(f.id), /Worker must exit/);
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
});

test("D4d after-apply readback refuses missing/foreign proof, target drift and rollback", async (t) => {
  const f = await appliedReviewFixture(t);
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, "0".repeat(64)),
    /digest mismatch/,
  );
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, undefined),
    /explicit apply plan digest/,
  );
  for (const [name, error] of [
    ["README.md", /workspace.*scope/],
    ["src/alpha space.txt", /target changed/],
  ]) {
    // Drift cases must not alter the separate successful rollback fixture's index/stat state.
    const changed = await appliedReviewFixture(t);
    fs.appendFileSync(path.join(changed.source, name), "hidden later edit");
    await assert.rejects(
      async () =>
        changed.host.readAppliedIntegrationReview(
          changed.id,
          changed.applyPlan.planDigest,
        ),
      error,
    );
  }
  const dir = path.join(f.prepared.executionRoot, "integration/target-apply");
  const receipt = path.join(dir, "apply-receipt.json"),
    saved = fs.readFileSync(receipt);
  fs.unlinkSync(receipt);
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, f.applyPlan.planDigest),
  );
  assert.equal(fs.existsSync(receipt), false, "reader must not replay apply");
  fs.writeFileSync(receipt, saved);
  await f.host.rollbackIntegration(f.id, f.applyPlan.planDigest, () => true);
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, f.applyPlan.planDigest),
    /rolled back|consumed/,
  );
});

test("D4d readback cannot create a candidate or accept a model-provided application flag", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    integrationMode: "approved-integration",
  });
  const plan = f.host.prepareIntegrationApply(f.id);
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, plan.planDigest),
    /sealed review candidate/,
  );
  await assert.rejects(
    f.host.readAppliedIntegrationReview(f.id, true),
    /explicit apply plan digest/,
  );
  assert.equal(
    fs.existsSync(
      path.join(f.prepared.executionRoot, "integration/review-candidate.json"),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        f.prepared.executionRoot,
        "integration/target-apply/apply-intent.json",
      ),
    ),
    false,
  );
});

test("D4e real L0 apply binds sealed review and preserves original native ledger", async (t) => {
  const f = await appliedReviewFixture(t);
  const binding = f.application.reviewBinding;
  assert.equal(binding.candidateDigest, f.candidate.candidateDigest);
  assert.equal(binding.requestDigest, f.request.digest);
  assert.match(binding.writerEvidenceDigest, /^[a-f0-9]{64}$/);
  const dir = path.join(f.prepared.executionRoot, "integration/target-apply");
  for (const phase of ["intent", "command", "receipt"])
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, `apply-${phase}.json`)))
        .reviewBinding,
      binding,
    );
  assert.equal(f.status.steps[0].acceptance.status, "review-required");
  assert.equal(
    f.status.steps[0].acceptance.effectiveAcceptance.review.required,
    true,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.native, "status.json"))),
    f.status,
  );
  assert.deepEqual(
    await f.host.applyIntegration(f.id, f.applyPlan.planDigest, () => {
      throw Error("must not confirm idempotent apply");
    }),
    f.application,
  );
  await assert.rejects(f.host.accept(f.id), /Worker must exit/);
});

test("D4e complete reviews without a seal cannot authorize apply or auto-seal", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    writerEvidence: true,
    integrationMode: "approved-integration",
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  const plan = f.host.prepareIntegrationApply(f.id);
  let confirmed = false;
  await assert.rejects(
    f.host.applyIntegration(f.id, plan.planDigest, () => {
      confirmed = true;
      return true;
    }),
    /sealed review candidate/,
  );
  assert.equal(confirmed, false);
  assert.equal(
    fs.existsSync(
      path.join(f.prepared.executionRoot, "integration/review-candidate.json"),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        f.prepared.executionRoot,
        "integration/target-apply/apply-intent.json",
      ),
    ),
    false,
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("D4e independent PASS never rescues rejected, missing or contradictory writer evidence", async (t) => {
  const faults = {
    rejected: (s) => {
      s.acceptance.status = "rejected";
    },
    attested: (s) => {
      s.acceptance.evidenceStatus = "attested";
    },
    missingLevel: (s) => {
      delete s.acceptance.effectiveAcceptance.level;
    },
    missingExit: (s) => {
      delete s.exitCode;
    },
    missingReport: (s) => {
      delete s.acceptance.childReport;
    },
    parseError: (s) => {
      s.acceptance.childReportParseError = "bad envelope";
    },
    runtimeFailed: (s) => {
      s.acceptance.runtimeChecks[0].status = "failed";
    },
    runtimeUnknown: (s) => {
      s.acceptance.runtimeChecks[0].status = "future";
    },
    parentRejected: (s) => {
      s.acceptance.parentDecision = { status: "rejected" };
    },
    reviewBlockers: (s) => {
      s.acceptance.reviewResult = { status: "blockers", findings: [] };
    },
    inconsistentRequired: (s) => {
      s.acceptance.effectiveAcceptance.review.required = false;
    },
    requiredUnmet: (s) => {
      s.acceptance.criteria = [{ id: "must", severity: "required" }];
      s.acceptance.effectiveAcceptance.criteria = s.acceptance.criteria;
      s.acceptance.childReport.criteriaSatisfied = [
        { id: "must", status: "not-satisfied" },
      ];
    },
    verifyFailed: (s) => {
      s.acceptance.effectiveAcceptance.verify = [
        { id: "check", command: "false" },
      ];
      s.acceptance.verifyRuns = [
        { id: "check", command: "false", status: "failed", exitCode: 1 },
      ];
    },
  };
  for (const [name, fault] of Object.entries(faults))
    await t.test(name, async (sub) => {
      let confirms = 0;
      await assert.rejects(
        appliedReviewFixture(sub, {
          mutateWriter: (status) => fault(status.steps[0]),
          confirm: () => {
            confirms++;
            return true;
          },
        }),
        /native/,
      );
      assert.equal(
        confirms,
        0,
        "writer evidence must fail before UI confirmation",
      );
    });
  for (const fault of ["missing", "exceeded", "unknown"])
    await t.test(`budget-${fault}`, async (sub) => {
      let confirms = 0;
      await assert.rejects(
        appliedReviewFixture(sub, {
          mutateWriter: (s) => {
            if (fault === "missing") delete s.usageBudget.tokens;
            if (fault === "exceeded") s.usageBudget.tokens.used = 101;
            if (fault === "unknown") s.usageBudget.tokens.outcome = "unknown";
          },
          confirm: () => {
            confirms++;
            return true;
          },
        }),
        /native reported/,
      );
      assert.equal(confirms, 0);
    });
});

test("D4e confirmation wait cannot substitute review or writer evidence", async (t) => {
  for (const fault of ["review", "writer"])
    await t.test(fault, async (sub) => {
      let fixture,
        confirms = 0;
      await assert.rejects(
        appliedReviewFixture(sub, {
          confirm: (f) => {
            fixture = f;
            confirms++;
            const dir = path.join(f.prepared.executionRoot, "integration");
            const file =
              fault === "review"
                ? path.join(dir, "review-candidate.json")
                : path.join(
                    dir,
                    f.host
                      .stageIntegration(f.id)
                      .captures.find(
                        (row) =>
                          row.origin === path.join(f.native, "status.json"),
                      ).saved,
                  );
            fs.appendFileSync(file, " "); // Even JSON-equivalent captured bytes must remain frozen.
            if (fault === "review") {
              const candidate = JSON.parse(fs.readFileSync(file));
              candidate.candidateDigest = "0".repeat(64);
              fs.writeFileSync(file, JSON.stringify(candidate));
            }
            return true;
          },
        }),
      );
      assert.equal(confirms, 1);
      assert.equal(git(fixture.source, "status", "--porcelain"), "");
      assert.equal(
        fs.existsSync(
          path.join(
            fixture.prepared.executionRoot,
            "integration/target-apply/apply-intent.json",
          ),
        ),
        false,
      );
    });
});

test("D4e readback rejects altered binding even with recomputed command digest", async (t) => {
  const { digest } = await import("../contracts.mjs");
  const f = await appliedReviewFixture(t);
  const dir = path.join(f.prepared.executionRoot, "integration/target-apply");
  const intent = JSON.parse(
    fs.readFileSync(path.join(dir, "apply-intent.json")),
  );
  const command = JSON.parse(
    fs.readFileSync(path.join(dir, "apply-command.json")),
  );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(dir, "apply-receipt.json")),
  );
  for (const key of [
    "candidateDigest",
    "requestDigest",
    "writerEvidenceDigest",
  ]) {
    const i = structuredClone(intent),
      c = structuredClone(command),
      r = structuredClone(receipt);
    for (const row of [i, c, r]) row.reviewBinding[key] = "0".repeat(64);
    r.commandDigest = digest(c);
    for (const [phase, row] of [
      ["intent", i],
      ["command", c],
      ["receipt", r],
    ])
      fs.writeFileSync(
        path.join(dir, `apply-${phase}.json`),
        JSON.stringify(row),
      );
    await assert.rejects(
      f.host.readAppliedIntegrationReview(f.id, f.applyPlan.planDigest),
      /authority binding changed/,
    );
    await assert.rejects(
      f.host.applyIntegration(f.id, f.applyPlan.planDigest, () => {
        throw Error("must not confirm");
      }),
      /authority binding changed/,
    );
  }
});
