import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskOrchestrator } from "../orchestrator.mjs";
import { WorkerRuntime } from "../worker-runtime.mjs";
import { RoleController } from "../role-controller.mjs";
import { HostAcceptance } from "../acceptance.mjs";
import { digest, bytesDigest } from "../contracts.mjs";
import {
  CompletedIntegrationConflict,
  completedIntegrationConflict,
  conflictRepairCommand,
  isCompletedIntegrationConflict,
} from "../integration-conflict.mjs";
import { runCheck, snapshot } from "../../host-evidence.mjs";
import { taskDeadlineAt, taskMemberTimeoutMs } from "../task-deadline.mjs";
import { inspectNativeHandoffs } from "../native-handoff.mjs";
import {
  integrationReviewSchema,
  validateReviewReport,
} from "../integration-review.mjs";
import { readCompletedReviewWave } from "../review-runs.mjs";
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
import {
  publicTaskFixture,
  observePublicTaskEvents,
} from "./public-task-fixture.mjs";
import { isInputRejection } from "../input-rejection.mjs";
import { modelToolOutput } from "./public-recovery-fixture.mjs";
import {
  installReconstructionHooks,
  reconstructionBinding,
} from "../reconstruction-input.mjs";

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

function meterMember(
  context,
  key,
  file,
  estimate,
  register = true,
  finish = true,
) {
  const measured = measureSessionBytes(fs.readFileSync(file));
  if (register)
    registerTaskBudgetMembers(context, [
      { key, estimate, sessionRoot: path.dirname(file) },
    ]);
  const binding = taskBudgetBinding(context, key);
  const identity = { sessionId: measured.sessionId, sessionFile: file };
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
  if (finish)
    changeTaskBudget(binding, {
      type: "finish",
      ...identity,
      used: measured.usage.total,
    });
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
  if (!options.emptyBase) {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
    fs.writeFileSync(path.join(source, "src/main.txt"), "base\n");
    fs.writeFileSync(path.join(source, "src/remove.txt"), "remove me\n");
    fs.writeFileSync(
      path.join(source, "src/lines.txt"),
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")}\n`,
    );
    git(source, "add", ".");
  }
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    ...(options.emptyBase ? ["--allow-empty"] : []),
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
  let worker,
    publicWorker,
    timer,
    launchCount = 0;
  const herdr = {
    async start(input) {
      const sessionId =
        options.distinctWorkerSessions && launchCount++
          ? `worker-${launchCount}`
          : "worker";
      const sessionFile = meteredSession(
        path.join(input.executionRoot, "worker-sessions/worker.jsonl"),
        sessionId,
        source,
      );
      if (options.publicSeam && sessionId === "worker") {
        const { publicWorkerFixture } = await import(
          "./public-recovery-fixture.mjs"
        );
        publicWorker = await publicWorkerFixture(t, {
          executionRoot: input.executionRoot,
          source,
          sessionFile,
          stoppedWorker: options.stoppedWorker,
        });
        worker = publicWorker.runtime;
      } else {
        worker = new WorkerRuntime({ executionRoot: input.executionRoot });
        worker.boot({
          sessionId,
          ...(options.stoppedWorker
            ? { processId: 99_999_999, processStartedAtTicks: "1" }
            : {}),
          sessionFile,
          cwd: source,
          activeTools: ["read", "team_role_spawn", "team_task_result"],
          extensions: ["teams-worker", "pi-subagents"],
          subagents: {
            compatible: true,
            checks: { protocolV1: true, status: true, spawn: true, stop: true },
            ping: { version: 1 },
          },
        });
      }
      const launchedWorker = worker;
      timer = setInterval(() => launchedWorker.processControls(), 5);
      return { paneId: "w1:p2", agentName: "worker" };
    },
  };
  const publicApi = options.publicEntry
    ? await publicTaskFixture(t, {
        root,
        source,
        herdr,
        nativeGoal: options.publicSeam,
      })
    : null;
  let orchestrator = publicApi
    ? null
    : new TaskOrchestrator({
        runtimeRoot: path.join(
          root,
          options.extensionRuntime ? "teams-task-runtime-v1" : "runtime",
        ),
        ownerSessionId: "owner",
        herdr,
      });
  t.after(async () => {
    clearInterval(timer);
    await publicWorker?.close();
    orchestrator?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const spec = {
    ...(options.review ? { schemaVersion: "teams-task-runtime/3" } : {}),
    goalId: publicApi?.goalFixture?.id ?? "goal",
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
      allowedWritePaths: options.allowedWritePaths ?? ["src"],
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
              (options.extraOldFeature ? [...edits, "beta"] : edits)
                .filter((edit) => edit !== null)
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
      ...(options.workerAllowedRoles
        ? { workerAllowedRoles: options.workerAllowedRoles }
        : {}),
      maxActiveRoleRuns: 4,
      maxRoleSpawnsPerTask: options.maxRoleSpawnsPerTask ?? 4,
      maxProductRepairsPerRole: 1,
      maxReportRepairs: 1,
      maxProcessRestarts: options.maxProcessRestarts ?? 0,
      ...(options.reviewProductRevision
        ? { reviewProductRevision: "within-scope-once" }
        : {}),
      maxTaskTokens: 1000,
      deadlineMs: options.deadlineMs ?? 60000,
      integrationMode: options.integrationMode ?? "verify-only",
    },
    contextRefs: [],
  };
  let prepared;
  if (publicApi) {
    const specPath = path.join(source, ".git/public-task.json");
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const event = await publicApi.call("team_task_dispatch", {
      spec_path: specPath,
      benefit: "worktree-isolation",
      benefit_detail: "Offline public handler and native handoff regression.",
    });
    assert.equal(event.isError, false, JSON.stringify(event.result));
    orchestrator = publicApi.orchestrator;
    prepared = publicApi.prepared;
    assert.equal(event.result.details.executionId, prepared.executionId);
  } else {
    prepared = orchestrator.prepare(spec);
    await orchestrator.launch(prepared.executionId, { timeoutMs: 1000 });
  }
  clearInterval(timer);
  const native = path.join(root, "native");
  fs.mkdirSync(native);
  const members = edits.map((_, i) => ({
    key: `lane-${i}`,
    role: "team.implementer",
    mode: options.roleMode ?? "mutation",
    isolation: options.roleIsolation ?? "worktree",
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
    else if (edit === "remove-all") git(lane, "rm", "-qr", ".");
    else if (edit === "binary") {
      fs.writeFileSync(
        path.join(lane, "src/binary.bin"),
        Buffer.from([0, 255, 1, 0]),
      );
      fs.unlinkSync(path.join(lane, "src/remove.txt"));
    } else if (edit !== null) {
      if (options.extraOldFeature)
        fs.writeFileSync(path.join(lane, "src/beta space.txt"), "beta\n");
      const file = path.join(lane, `src/${edit} space.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        edit === "octets" ? Buffer.from([255, 254, 253, 10]) : `${edit}\n`,
      );
    }
    git(lane, "add", "-A");
    const patch = spawnSync(
      "git",
      ["-C", lane, "diff", "--cached", "--binary", "--full-index", base],
      { encoding: "buffer" },
    );
    assert.equal(patch.status, 0);
    const changedFiles = git(
      lane,
      "diff",
      "--cached",
      "--name-only",
      "-z",
      base,
    )
      .split("\0")
      .filter(Boolean);
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
                changed: patch.stdout.length > 0,
                filesChanged: changedFiles.length,
                insertions: patch.stdout.length ? 1 : 0,
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
    manifests.push({
      path: manifestPath,
      value: handoff,
      patchPath,
      changedFiles,
    });
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
    state: options.failedRoot ? "failed" : "complete",
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
  if (options.writerEvidence) {
    status.steps.forEach((step, i) => {
      step.exitCode = 0;
      Object.assign(step.acceptance, {
        childReport: { changedFiles: manifests[i].changedFiles },
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
    });
  }
  if (hostedWorkflow) asHostedStatus(status, hostedWorkflow);
  if (options.failedRoot) {
    status.state = "failed";
    if (hostedWorkflow) status.workflowChildren.workflowState = "failed";
  }
  if (options.failedMember !== undefined) {
    const i = options.failedMember;
    status.steps[i].status = "failed";
    status.steps[i].exitCode = 1;
    rows[i].ok = false;
    if (hostedWorkflow) {
      status.workflowChildren.children[i].state = "failed";
      rows[i].nativeResults[0].exitCode = 1;
    }
  }
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
    completion: options.failedRoot ? "failed" : "completed",
  });
  worker.recordProgress("launch-terminal", {
    kind: "role-terminal",
    launchId: "launch",
    runId: "wave",
    completion: options.failedRoot ? "failed" : "completed",
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
  const candidateWorker = worker;
  await options.beforeResult?.({
    root,
    source,
    base,
    prepared,
    worker,
    orchestrator,
    native,
    members,
    manifests,
    status,
    saveStatus,
    publicApi,
    publicWorker,
    getActiveWorker: () => worker,
  });
  worker = candidateWorker;
  const candidate = {
    schemaVersion: "teams-task-result/1",
    identity: prepared.contract.identity,
    requestDigest: prepared.requestDigest,
    resultRevision: 1,
    outcome: options.resultOutcome ?? "ready_for_acceptance",
    summary: "Isolated candidates; host validation pending.",
    source: publicWorker ? null : worker.captureSource(1),
    criterionResults: [
      {
        criterionId: "outcome",
        status: options.criterionStatus ?? "indeterminate",
        observation: options.criterionObservation ?? "Pending host checks.",
        evidenceIds: [],
      },
    ],
    evidence: [],
    childRunRefs: worker.mailbox
      .listEvents()
      .filter((event) => event.type === "progress")
      .map((event) => worker.mailbox.readJson(event.payloadRef))
      .filter((row) => row.kind === "role-started")
      .map((row) => row.runId),
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  };
  if (publicWorker) {
    const {
      resultRevision,
      outcome,
      summary,
      criterionResults,
      evidence,
      risks,
      usage,
    } = candidate;
    const sealed = await publicWorker.call("team_task_result", {
      resultRevision,
      outcome,
      summary,
      criterionResults,
      evidence,
      risks,
      usage,
    });
    assert.equal(sealed.isError, false, JSON.stringify(sealed.result));
    // Real ctx.shutdown drains Worker hooks before L0 collect/accept/Goal close.
    await publicWorker.close();
  } else worker.sealResult(candidate);
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
    getActiveWorker: () => worker,
    orchestrator,
    host: new HostAcceptance({ orchestrator }),
    publicApi,
  };
}

// Fresh synthetic native-format handoff for a revised execution: new run,
// sessions and artifact refs, with the same legitimate patch content. The
// known defect in this fixture is the old host checker, not that patch.
function publishRepairedCandidate(f, worker, prepared, options = {}) {
  const native = path.join(f.root, "revision-native");
  fs.mkdirSync(native);
  const patchPath = path.join(native, "repaired.patch");
  fs.copyFileSync(options.patchPath ?? f.manifests[0].patchPath, patchPath);
  const handoff = structuredClone(f.manifests[0].value);
  handoff.runId = "repair-leaf";
  handoff.groups[0].children[0].patch.path = patchPath;
  handoff.groups[0].children[0].patch.branch = "repair-lane";
  const manifest = path.join(native, "handoff.json");
  fs.writeFileSync(manifest, JSON.stringify(handoff));
  const workflow = {
    version: 1,
    workflowRunId: "repair-wave",
    state: "complete",
    entries: {
      repair: {
        key: "repair",
        agent: "team.implementer",
        latestRunId: "repair-leaf",
        continuation: { runIds: ["repair-leaf"] },
      },
    },
  };
  const workflowReceiptPath = path.join(native, "workflow.json");
  fs.writeFileSync(workflowReceiptPath, JSON.stringify(workflow));
  const sessionDir = path.join(
    prepared.executionRoot,
    "role-sessions/repair-launch",
  );
  const roleSession = meteredSession(
    path.join(sessionDir, "repair-leaf.jsonl"),
    "repair-leaf",
    f.source,
  );
  if (options.repairCommand) {
    if (options.rejectedReconstruction) {
      const entries = [],
        hooks = new Map();
      const input = {
        command: "incorrect reconstruction input (never executed)",
      };
      const ctx = {
        sessionManager: {
          getSessionId: () => "repair-leaf",
          getBranch: () => entries,
        },
        abort() {
          assert.fail("a pre-tool rejection must not abort this writer");
        },
      };
      installReconstructionHooks(
        {
          on: (name, handler) => hooks.set(name, handler),
          appendEntry: (customType, data) =>
            entries.push({ type: "custom", customType, data }),
        },
        () =>
          reconstructionBinding(
            options.repairCommand,
            `TASK_PI_REVIEW_PRODUCT_BASE_READY:${options.oldTree}\n`,
          ),
      );
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
          content: [
            {
              type: "toolCall",
              id: "rejected-reconstruction",
              name: "bash",
              arguments: input,
            },
          ],
        },
      });
      const blocked = hooks.get("tool_call")(
        { toolName: "bash", toolCallId: "rejected-reconstruction", input },
        ctx,
      );
      assert.equal(blocked.block, true);
      entries.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "rejected-reconstruction",
          isError: true,
          content: [{ type: "text", text: blocked.reason }],
        },
      });
      fs.appendFileSync(
        roleSession,
        entries
          .map((e, index) =>
            JSON.stringify({ id: `input-rejection-${index}`, ...e }),
          )
          .join("\n") + "\n",
      );
    }
    fs.appendFileSync(
      roleSession,
      [
        {
          type: "message",
          id: "reconstruct-call",
          message: {
            role: "assistant",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
            },
            content: [
              {
                type: "toolCall",
                id: "reconstruct-one",
                name: "bash",
                arguments: { command: options.repairCommand },
              },
            ],
          },
        },
        {
          type: "message",
          id: "reconstruct-result",
          message: {
            role: "toolResult",
            toolCallId: "reconstruct-one",
            toolName: "bash",
            isError: false,
            content: [
              {
                type: "text",
                text:
                  options.repairOutput ??
                  `TASK_PI_REVIEW_PRODUCT_BASE_READY:${options.oldTree}\n`,
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
  }
  const status = structuredClone(f.status);
  status.runId = "repair-wave";
  status.sessionId = worker.workerSessionId;
  status.processTerminal.runId = "repair-wave";
  status.workflowReceiptPath = workflowReceiptPath;
  status.workflow = {
    value: [
      {
        key: "repair",
        ok: true,
        runId: "repair-leaf",
        artifactPaths: [manifest],
        outputReference: null,
        structuredOutput: null,
      },
    ],
  };
  status.steps = [
    {
      ...status.steps[0],
      workflowKey: "repair",
      runId: "repair-leaf",
      sessionFile: roleSession,
    },
  ];
  const saveStatus = () =>
    fs.writeFileSync(path.join(native, "status.json"), JSON.stringify(status));
  saveStatus();
  const member = {
    key: "repair",
    role: "team.implementer",
    mode: "mutation",
    isolation: "worktree",
    maxTokens: 100,
    taskDigest: digest("Fixture bounded writer."),
  };
  worker.mailbox.writeReceipt("wave-plan-repair-launch", {
    key: "repair-writer",
    reason: "Fresh candidate for corrected host check.",
    runs: [{ ...member, task: "Fixture bounded writer." }],
  });
  worker.recordProgress("repair-launch", {
    kind: "role-wave-launch-intent",
    members: [member],
    waveKey: "repair-writer",
  });
  worker.recordProgress("repair-admission", {
    kind: "role-launch-intent",
    rootLaunchId: "repair-launch",
    role: member.role,
    mode: member.mode,
    maxTokens: member.maxTokens,
  });
  worker.recordProgress("repair-started", {
    kind: "role-started",
    launchId: "repair-launch",
    runId: "repair-wave",
    asyncDir: native,
    sessionDir,
    role: null,
    mode: "wave",
    members: [member],
    baseCommit: f.base,
  });
  worker.recordProgress("repair-completion", {
    kind: "role-completion",
    launchId: "repair-launch",
    runId: "repair-wave",
    completion: "completed",
  });
  worker.recordProgress("repair-terminal", {
    kind: "role-terminal",
    launchId: "repair-launch",
    runId: "repair-wave",
    completion: "completed",
    processTerminal: status.processTerminal,
  });
  worker.sealResult({
    schemaVersion: "teams-task-result/1",
    identity: prepared.contract.identity,
    requestDigest: prepared.requestDigest,
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary:
      "New candidate; corrected host check and independent review still required.",
    source: worker.captureSource(1),
    criterionResults: [
      {
        criterionId: "outcome",
        status: "indeterminate",
        observation: "Pending host check.",
        evidenceIds: [],
      },
    ],
    evidence: [],
    childRunRefs: ["repair-wave"],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  });
  f.orchestrator.collect(prepared.executionId);
  return { native, status, saveStatus, roleSession };
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

test("D3b approved apply refreshes stale index stat data only after confirmation", async (t) => {
  const f = await fixture(
    t,
    ["conflict-a"],
    "require('node:assert/strict').equal(require('node:fs').readFileSync('src/main.txt','utf8'),'conflict-a\\n')",
    {
      integrationMode: "approved-integration",
      nativeReviewRequired: false,
    },
  );
  const id = f.prepared.executionId;
  const file = path.join(f.source, "src/main.txt");
  const index = path.join(f.source, ".git/index");
  fs.writeFileSync(file, "base\n");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  const originalIndex = fs.readFileSync(index);
  f.host.stageIntegration(id);
  const plan = f.host.prepareIntegrationApply(id);
  assert.deepEqual(
    fs.readFileSync(index),
    originalIndex,
    "read-only gates must not refresh the target index",
  );
  assert.equal(
    (await f.host.applyIntegration(id, plan.planDigest, () => false)).status,
    "declined",
  );
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  const applied = await f.host.applyIntegration(
    id,
    plan.planDigest,
    () => true,
  );
  assert.equal(applied.status, "applied");
  assert.deepEqual(
    f.worker.mailbox.readJson("integration/target-apply/apply-command.json")
      .indexRefreshTerminal,
    { observed: true, code: 0, signal: null, error: null },
  );
  assert.equal(fs.readFileSync(file, "utf8"), "conflict-a\n");
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.equal(
    f.host.inspectIntegrationApply(id, plan.planDigest).disposition,
    "applied",
  );
});

test("D3b scratch Git baseline preserves tracked file and directory modes under umask 077", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  f.host.stageIntegration(f.prepared.executionId);
  const original = process.umask(0o077);
  let plan;
  try {
    plan = f.host.prepareIntegrationApply(f.prepared.executionId);
  } finally {
    process.umask(original);
  }
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  const baseline = path.join(
    f.prepared.executionRoot,
    "integration/target-apply/baseline",
  );
  assert.equal(
    fs.statSync(path.join(baseline, "README.md")).mode & 0o777,
    0o644,
  );
  assert.equal(fs.statSync(path.join(baseline, "src")).mode & 0o777, 0o755);
  assert.equal(git(f.source, "status", "--porcelain"), "");
  assert.equal(
    fs.readFileSync(path.join(f.source, "README.md"), "utf8"),
    "baseline\n",
  );
});

test("D3b restrictive umask keeps pre-existing Git modes through stage, plan, approved apply and readback", async (t) => {
  const f = await fixture(t, ["new/task"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  const original = process.umask(0o077);
  try {
    const id = f.prepared.executionId;
    assert.equal(f.host.stageIntegration(id).status, "checks-passed");
    const plan = f.host.prepareIntegrationApply(id);
    assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
    const applied = await f.host.applyIntegration(
      id,
      plan.planDigest,
      async () => true,
    );
    assert.equal(applied.status, "applied");
    const observed = f.host.inspectIntegrationApply(id, plan.planDigest);
    assert.equal(observed.disposition, "applied");
    assert.equal(observed.applyReceipt, true);
    assert.equal(
      fs.statSync(path.join(f.source, "README.md")).mode & 0o777,
      0o644,
    );
    assert.equal(
      fs.statSync(path.join(f.source, "src/new")).mode & 0o777,
      0o700,
    );
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.source, "write-tree"), plan.mergedTree);
  } finally {
    process.umask(original);
  }
});

test("D3b canonical scratch modes do not hide an unscoped target chmod", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    integrationMode: "approved-integration",
    nativeReviewRequired: false,
  });
  f.host.stageIntegration(f.prepared.executionId);
  fs.chmodSync(path.join(f.source, "README.md"), 0o600);
  assert.equal(git(f.source, "status", "--porcelain"), "");
  const original = process.umask(0o077);
  try {
    assert.throws(
      () => f.host.prepareIntegrationApply(f.prepared.executionId),
      /complete Git baseline/,
    );
  } finally {
    process.umask(original);
  }
  assert.equal(
    fs.existsSync(
      path.join(f.prepared.executionRoot, "integration/target-apply/plan.json"),
    ),
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
  const { CompletedCheckFailure, checkFailureReply, isCompletedCheckFailure } =
    await import("../check-failure.mjs");
  const f = await fixture(t, ["alpha"], "process.exit(7)");
  let failure;
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    (error) => {
      failure = error;
      return error instanceof CompletedCheckFailure;
    },
  );
  const args = { execution_id: f.prepared.executionId, action: "stage" };
  const reply = checkFailureReply(failure, "check-1", args);
  assert.equal(reply.isError, true);
  assert.equal(reply.details.checkFailure.exitCode, 7);
  assert.equal(
    isCompletedCheckFailure(
      reply.details.checkFailure,
      { tool: "team_task_stage_integration", input: args },
      "team_task_stage_integration",
      "check-1",
    ),
    true,
  );
  assert.throws(() => f.host.prepareIntegrationReview(f.prepared.executionId));
  assert.throws(() => f.host.accept(f.prepared.executionId));
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

test("R31-H a failed staged check permits only one source-bound, cost-carrying candidate revision", async (t) => {
  const { buildTaskPrompt } = await import("../worker-runtime.mjs");
  const { bytesDigest } = await import("../contracts.mjs");
  const f = await fixture(t, ["alpha"], "process.exit(7)", {
    review: {
      authority: "l0-source-bound",
      allowedRoles: ["team.reviewer"],
      allowedTools: ["read", "structured_output"],
    },
    tokenBudgetMode: "shared",
    maxProcessRestarts: 1,
    stoppedWorker: true,
  });
  const previousId = f.prepared.executionId;
  const previousResult = f.worker.mailbox.listResults().at(-1);
  const checkRef = path.join(
    f.prepared.executionRoot,
    "integration/check-check.json",
  );
  assert.throws(
    () => f.host.stageIntegration(previousId),
    /check.*exit|check|failed/i,
  );
  const before = fs.readFileSync(checkRef);
  const failureSha = bytesDigest(before);
  const revised = {
    ...f.prepared.contract,
    ...f.prepared.contract.identity,
    taskRevision: 2,
    checks: f.prepared.contract.checks.map((check) => ({
      ...check,
      argv: [
        "-e",
        "require('node:assert/strict').ok(require('node:fs').existsSync('src/alpha space.txt'))",
      ],
    })),
  };
  const repair = {
    previousExecutionId: previousId,
    expectedPreviousResultDigest: digest(previousResult),
    failureReceiptRef: checkRef,
    failureReceiptSha256: failureSha,
    repairReason:
      "Inspect the failed integration check and repair the candidate or check without weakening criteria.",
  };
  assert.throws(
    () => f.orchestrator.prepare(revised, { repairOf: repair }),
    /closed after failure/,
  );
  f.orchestrator.requestCancel(
    previousId,
    "candidate check failed; preserve evidence",
  );
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  assert.equal(
    f.orchestrator.reconcile(previousId).execution.reservationOpen,
    false,
  );
  for (const [variant, message] of [
    [
      { ...repair, expectedPreviousResultDigest: "f".repeat(64) },
      /previous result changed/,
    ],
    [
      { ...repair, failureReceiptSha256: "f".repeat(64) },
      /failure receipt changed/,
    ],
  ])
    assert.throws(
      () => f.orchestrator.prepare(revised, { repairOf: variant }),
      message,
    );
  assert.throws(
    () =>
      f.orchestrator.prepare(
        { ...revised, policy: { ...revised.policy, maxTaskTokens: 1001 } },
        { repairOf: repair },
      ),
    /repair policy changed/,
  );
  assert.throws(
    () =>
      f.orchestrator.prepare(revised, {
        repairOf: {
          ...repair,
          failureReceiptRef: path.join(
            f.prepared.executionRoot,
            "results/r0001.json",
          ),
        },
      }),
    /only an integration failed-check receipt/,
  );
  fs.writeFileSync(path.join(f.source, "src/main.txt"), "drift\n");
  assert.throws(
    () => f.orchestrator.prepare(revised, { repairOf: repair }),
    /candidate source changed|baseline drifted/,
  );
  fs.writeFileSync(path.join(f.source, "src/main.txt"), "base\n");
  assert.throws(
    () => f.orchestrator.prepare(revised),
    /failed sealed integration requires explicit candidate revision/,
  );
  assert.throws(
    () =>
      f.orchestrator.prepare({
        ...revised,
        policy: { ...revised.policy, maxTaskTokens: 1001 },
      }),
    /failed sealed integration requires explicit candidate revision/,
  );
  const { candidateRepairIntent } = await import("../task-revision.mjs");
  assert.throws(
    () =>
      candidateRepairIntent({
        previous: f.orchestrator.ledger.getExecution(previousId),
        oldContract: f.prepared.contract,
        previousMailbox: f.worker.mailbox,
        spec: revised,
        revision: repair,
        ownerSessionId: "foreign",
        baseline: f.worker.mailbox.readJson("receipts/workspace-baseline.json"),
      }),
    /repair owner changed/,
  );
  const next = f.orchestrator.prepare(revised, { repairOf: repair });
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(next.executionRoot, "receipts/repair-intent.json"),
      "utf8",
    ),
  );
  const boot = JSON.parse(
    fs.readFileSync(path.join(next.executionRoot, "bootstrap.json"), "utf8"),
  );
  const prior = JSON.parse(
    fs.readFileSync(
      path.join(next.executionRoot, "receipts/prior-usage.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.previousExecutionId, previousId);
  assert.equal(receipt.failureReceiptSha256, failureSha);
  assert.equal(boot.repairIntentDigest, digest(receipt));
  assert.equal(prior.totals.total, 20); // Worker and native leaf; no new allocation resets it.
  assert.equal(
    f.orchestrator.ledger.readTaskPool(next.executionId).priorTokens,
    prior.totals.total,
  );
  assert.match(
    buildTaskPrompt(
      next.contract,
      path.join(next.executionRoot, "task-request.json"),
      path.join(next.executionRoot, "receipts/repair-intent.json"),
    ),
    /Bounded candidate revision/,
  );
  assert.deepEqual(fs.readFileSync(checkRef), before);
  assert.throws(
    () =>
      f.orchestrator.prepare(
        { ...revised, taskRevision: 3 },
        { repairOf: { ...repair, previousExecutionId: next.executionId } },
      ),
    /restart budget/,
  );
  let repairedWorker;
  f.orchestrator.herdr = {
    async start(input) {
      repairedWorker = new WorkerRuntime({
        executionRoot: input.executionRoot,
      });
      repairedWorker.boot({
        sessionId: "repaired-worker",
        processId: 99_999_999,
        processStartedAtTicks: "1",
        sessionFile: meteredSession(
          path.join(input.executionRoot, "worker-sessions/repaired.jsonl"),
          "repaired-worker",
          f.source,
        ),
        cwd: f.source,
        activeTools: ["read", "team_role_spawn", "team_task_result"],
        extensions: ["teams-worker", "pi-subagents"],
        subagents: {
          compatible: true,
          checks: { protocolV1: true, status: true, spawn: true, stop: true },
          ping: { version: 1 },
        },
      });
      return { paneId: "w3:p4", agentName: "worker" };
    },
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  const bindingTimer = setInterval(() => repairedWorker?.processControls(), 5);
  t.after(() => clearInterval(bindingTimer));
  const launched = await f.orchestrator.launch(next.executionId, {
    timeoutMs: 1000,
  });
  assert.equal(launched.state, "RUNNING");
  assert.match(repairedWorker.taskPrompt(), /Bounded candidate revision/);
  repairedWorker.assertAdmission();
  const oldCandidateFile = path.join(
    f.prepared.executionRoot,
    "integration/repo/src/main.txt",
  );
  const oldCandidateBytes = fs.readFileSync(oldCandidateFile);
  fs.writeFileSync(oldCandidateFile, "late drift\n");
  assert.throws(
    () => repairedWorker.taskPrompt(),
    /previous staged candidate changed/,
  );
  assert.throws(
    () => repairedWorker.assertAdmission(),
    /previous staged candidate changed/,
  );
  fs.writeFileSync(oldCandidateFile, oldCandidateBytes);
  repairedWorker.assertAdmission();
  assert.throws(
    () => f.host.accept(next.executionId),
    /sealed patch review|result|candidate|integration/i,
  );
  const fresh = publishRepairedCandidate(f, repairedWorker, next);
  f.prepared = next;
  f.worker = repairedWorker;
  f.native = fresh.native;
  f.status = fresh.status;
  f.saveStatus = fresh.saveStatus;
  const meter = { contract: next.contract, mailbox: repairedWorker.mailbox };
  function finish(key, file, estimate, register = true) {
    const measured = measureSessionBytes(fs.readFileSync(file));
    if (register)
      registerTaskBudgetMembers(meter, [
        { key, estimate, sessionRoot: path.dirname(file) },
      ]);
    const binding = taskBudgetBinding(meter, key);
    const identity = { sessionId: measured.sessionId, sessionFile: file };
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
  finish(
    "worker",
    repairedWorker.mailbox.readJson("receipts/boot.json").workerSessionFile,
    0,
    false,
  );
  finish("role.repair-launch.repair", fresh.roleSession, 100);
  const reviewed = await reviewWaveFixture(t, 1, {
    existing: f,
    tokenBudgetMode: "shared",
    stoppedWorker: true,
    writerEvidence: true,
    reviewSourcePaths: ["src/alpha space.txt"],
  });
  const newCheck = reviewed.worker.mailbox.readJson(
    "integration/check-check.json",
  );
  assert.equal(
    newCheck.status,
    "verified",
    "corrected checker must recover the original alpha candidate behavior",
  );
  assert.deepEqual(
    fs.readFileSync(checkRef),
    before,
    "old failed check remains sealed",
  );
  reviewed.adapter.assertAdmission = () =>
    f.orchestrator.assertReviewAdmission(next.executionId);
  await f.host.startIntegrationReview(
    next.executionId,
    reviewed.wave.key,
    reviewed.plan.planDigest,
    reviewed.adapter,
  );
  const reviewStatus = reviewed.publish();
  finish(
    `review.${reviewed.wave.key}.view-0`,
    reviewStatus.steps[0].sessionFile,
    100,
    false,
  );
  const collectedReview = await f.host.collectIntegrationReview(
    next.executionId,
    reviewed.wave.key,
    reviewed.plan.planDigest,
  );
  assert.equal(collectedReview.verdict, "pass");
  await f.host.sealIntegrationReview(next.executionId);
  const { receipt: accepted } = await f.host.accept(next.executionId);
  assert.equal(accepted.schemaVersion, "teams-task-acceptance/3");
  assert.equal(accepted.finalEvidence.delivery.targetModified, false);
  assert.equal(f.orchestrator.ledger.getAcceptance(previousId), null);
  assert.equal(
    f.orchestrator.ledger.getExecution(next.executionId).state,
    "ACCEPTED",
  );
  // Simulated matching external Goal tool result, not a real Goal-X readback.
  const { createGoalGuard } = await import("../goal-guard.mjs");
  const guard = createGoalGuard(f.orchestrator, f.source);
  const goalGate = await guard.beforeTaskCompletion({
    goalId: "goal",
    taskId: "task",
  });
  assert.equal(goalGate.ok, true);
  await guard.afterTaskCompletion({
    goalId: "goal",
    taskId: "task",
    evidence: goalGate.evidence,
  });
  assert.equal(
    f.orchestrator.ledger.getExecution(next.executionId).reservationOpen,
    false,
  );
  const { historicalUsage } = await import("../e2e/run-todo-flow.mjs");
  const campaign = historicalUsage([], "separate-parent", [
    { runtimeRoot: f.orchestrator.runtimeRoot, executionId: previousId },
    { runtimeRoot: f.orchestrator.runtimeRoot, executionId: next.executionId },
  ]);
  assert.equal(
    campaign.totals.total,
    50,
    "old 20 plus fresh 30; new priorUsage must not count twice",
  );
});

test("R31-H unknown/check-signal and half-published revision cannot become a second repaired candidate", async (t) => {
  const review = {
    authority: "l0-source-bound",
    allowedRoles: ["team.reviewer"],
    allowedTools: ["read", "structured_output"],
  };
  const options = {
    review,
    tokenBudgetMode: "shared",
    maxProcessRestarts: 1,
    stoppedWorker: true,
  };
  const signaled = await fixture(
    t,
    ["alpha"],
    "process.kill(process.pid, 'SIGTERM')",
    options,
  );
  const signalId = signaled.prepared.executionId;
  assert.throws(() => signaled.host.stageIntegration(signalId));
  const signalRef = path.join(
    signaled.prepared.executionRoot,
    "integration/check-check.json",
  );
  const signalBytes = fs.readFileSync(signalRef);
  signaled.orchestrator.requestCancel(
    signalId,
    "signaled check is not a completed product defect",
  );
  signaled.worker.processControls();
  signaled.worker.confirmCancelled(0);
  signaled.orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  assert.equal(
    signaled.orchestrator.reconcile(signalId).execution.reservationOpen,
    false,
  );
  const signaledSpec = {
    ...signaled.prepared.contract,
    ...signaled.prepared.contract.identity,
    taskRevision: 2,
  };
  const signalResult = signaled.worker.mailbox.listResults().at(-1);
  const signalRepair = {
    previousExecutionId: signalId,
    expectedPreviousResultDigest: digest(signalResult),
    failureReceiptRef: signalRef,
    failureReceiptSha256: (await import("../contracts.mjs")).bytesDigest(
      signalBytes,
    ),
    repairReason:
      "A signal is unknown, never treat it as a product check failure.",
  };
  assert.throws(
    () =>
      signaled.orchestrator.prepare(signaledSpec, { repairOf: signalRepair }),
    /not a completed nonzero check|signaled check/,
  );
  assert.equal(
    signaled.orchestrator.ledger.listTaskExecutions(
      signaled.prepared.projectId,
      "goal",
      "task",
    ).length,
    1,
  );
  assert.deepEqual(fs.readFileSync(signalRef), signalBytes);

  const partial = await fixture(t, ["alpha"], "process.exit(7)", options);
  const oldId = partial.prepared.executionId;
  assert.throws(() => partial.host.stageIntegration(oldId));
  const failureRef = path.join(
    partial.prepared.executionRoot,
    "integration/check-check.json",
  );
  partial.orchestrator.requestCancel(oldId, "fixture candidate failure");
  partial.worker.processControls();
  partial.worker.confirmCancelled(0);
  partial.orchestrator.herdr = {
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  };
  assert.equal(
    partial.orchestrator.reconcile(oldId).execution.reservationOpen,
    false,
  );
  const original = partial.worker.mailbox.listResults().at(-1);
  const revision = {
    ...partial.prepared.contract,
    ...partial.prepared.contract.identity,
    taskRevision: 2,
  };
  const intent = {
    previousExecutionId: oldId,
    expectedPreviousResultDigest: digest(original),
    failureReceiptRef: failureRef,
    failureReceiptSha256: (await import("../contracts.mjs")).bytesDigest(
      fs.readFileSync(failureRef),
    ),
    repairReason: "Precisely correct the known check failure.",
  };
  const reserved = partial.orchestrator.prepare(revision, { repairOf: intent });
  fs.unlinkSync(
    path.join(reserved.executionRoot, "receipts/repair-intent.json"),
  ); // disposable crash seam only
  assert.throws(
    () =>
      new WorkerRuntime({ executionRoot: reserved.executionRoot }).taskPrompt(),
    /ENOENT|repair-intent/,
  );
  assert.equal(
    partial.orchestrator.ledger.getExecution(reserved.executionId)
      .reservationOpen,
    true,
  );
  assert.throws(
    () =>
      partial.orchestrator.prepare(
        { ...revision, taskRevision: 3 },
        { repairOf: { ...intent, previousExecutionId: reserved.executionId } },
      ),
    /restart budget/,
  );
  assert.equal(
    partial.orchestrator.ledger.getAcceptance(reserved.executionId),
    null,
  );
});

test("D3 signaled checks and nonzero checks that mutate source stay runtime failures", async (t) => {
  const { CompletedCheckFailure } = await import("../check-failure.mjs");
  for (const script of [
    "process.kill(process.pid, 'SIGTERM')",
    "require('node:fs').writeFileSync('src/main.txt','changed');process.exit(7)",
  ]) {
    const f = await fixture(t, ["alpha"], script);
    assert.throws(
      () => f.host.stageIntegration(f.prepared.executionId),
      (error) => {
        assert.equal(error instanceof CompletedCheckFailure, false);
        return true;
      },
    );
    assert.throws(
      () => f.host.stageIntegration(f.prepared.executionId),
      /reconcile/,
    );
  }
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

test("fresh output directory absent at baseline survives Worker result and verify-only staging", async (t) => {
  const f = await fixture(t, ["new/task"], undefined, {
    review: reviewPolicy,
    sourcePaths: ["src/new"],
  });
  const id = f.prepared.executionId;
  const sourceManifest = f.worker.mailbox.readJson(
    "receipts/source-manifest-r0001.json",
  );
  assert.deepEqual(sourceManifest.files, [{ path: "src/new", kind: "absent" }]);
  assert.equal(fs.existsSync(path.join(f.source, "src/new")), false);
  const staged = f.host.stageIntegration(id);
  assert.equal(staged.status, "checks-passed");
  assert.equal(staged.targetModified, false);
  assert.equal(
    fs.readFileSync(path.join(staged.cwd, "src/new/task space.txt"), "utf8"),
    "new/task\n",
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
  // Git ignores an empty directory, but its appearance invalidates the sealed absence.
  fs.mkdirSync(path.join(f.source, "src/new"));
  assert.throws(
    () => f.host.stageIntegration(id),
    /workspace changed|source changed|candidate source/,
  );
});

test("a genuinely empty Git base can stage a nonempty native candidate without weakening target freshness", async (t) => {
  const f = await fixture(
    t,
    ["new/task"],
    "const fs=require('node:fs'),a=require('node:assert/strict');a.ok(fs.existsSync('src/new/task space.txt'));",
    { review: reviewPolicy, emptyBase: true, sourcePaths: ["src/new"] },
  );
  assert.equal(git(f.source, "ls-tree", "HEAD"), "");
  const id = f.prepared.executionId;
  const sourceManifest = f.worker.mailbox.readJson(
    "receipts/source-manifest-r0001.json",
  );
  assert.deepEqual(sourceManifest.files, [{ path: "src/new", kind: "absent" }]);
  const staged = f.host.stageIntegration(id);
  assert.equal(staged.status, "checks-passed");
  assert.equal(staged.targetModified, false);
  assert.equal(
    fs.readFileSync(path.join(staged.cwd, "src/new/task space.txt"), "utf8"),
    "new/task\n",
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("staging still rejects an empty candidate tree after removing all tracked files", async (t) => {
  const f = await fixture(t, ["remove-all"], "process.exit(0)", {
    review: reviewPolicy,
    allowedWritePaths: ["README.md", "src"],
  });
  assert.throws(
    () => f.host.stageIntegration(f.prepared.executionId),
    /bounded nonempty Git tree required/,
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("absent source entries stay scoped and reject symlink ancestors and credential paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-absent-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = snapshot(root, ["app"]);
  assert.deepEqual(before.files, [{ path: "app", kind: "absent" }]);
  fs.symlinkSync("not-created", path.join(root, "link"));
  assert.throws(
    () => snapshot(root, ["link/app"]),
    /source path parent|symlink|ENOENT/,
  );
  assert.throws(() => snapshot(root, ["../escape"]), /relative source path/);
  assert.throws(() => snapshot(root, [".env"]), /credential paths/);
  fs.mkdirSync(path.join(root, "app"));
  assert.notEqual(snapshot(root, ["app"]).digest, before.digest);
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

test("review plan input correction preserves source, policy and unconsumed launch intent", async (t) => {
  const { TaskInputRejection } = await import("../input-rejection.mjs");
  const f = await reviewWaveFixture(t, 1);
  const wave = { ...f.wave, key: "second-view" };
  const dir = path.join(
    f.prepared.executionRoot,
    "integration/reviews",
    wave.key,
  );
  const requestBytes = fs.readFileSync(
    path.join(f.prepared.executionRoot, "integration/review-request.json"),
  );
  await assert.rejects(
    f.host.planIntegrationReview(f.id, { ...wave, reason: "" }, f.adapter),
    (error) =>
      error instanceof TaskInputRejection && error.phase === "review-wave",
  );
  const resolve = f.adapter.resolve;
  f.adapter.resolve = async (input) => {
    const value = await resolve(input);
    value.contract.tools.effectiveAllowlist.push("extra_builtin");
    value.contract.tools.effectiveMcpTools.push("resolved_mcp_reader");
    return value;
  };
  await assert.rejects(
    f.host.planIntegrationReview(f.id, wave, f.adapter),
    (error) => {
      assert.ok(error instanceof TaskInputRejection);
      assert.deepEqual(error.diagnostics.excess, [
        "extra_builtin",
        "resolved_mcp_reader",
      ]);
      assert.ok(error.diagnostics.effective.includes("structured_output"));
      return true;
    },
  );
  assert.equal(fs.existsSync(dir), false);
  assert.equal(f.counts().spawns, 0);
  // Restore the fixture's authorized profile, not a changed contract/ceiling.
  f.adapter.resolve = resolve;
  const plan = await f.host.planIntegrationReview(f.id, wave, f.adapter);
  assert.equal(plan.key, wave.key);
  assert.equal(fs.existsSync(path.join(dir, "launch-intent.json")), false);
  assert.deepEqual(
    fs.readFileSync(
      path.join(f.prepared.executionRoot, "integration/review-request.json"),
    ),
    requestBytes,
  );
  assert.equal(f.counts().spawns, 0);
  await assert.rejects(
    f.host.planIntegrationReview(
      f.id,
      { ...wave, reason: "changed" },
      f.adapter,
    ),
    (error) => !(error instanceof TaskInputRejection),
  );
  fs.writeFileSync(
    path.join(f.prepared.executionRoot, "integration/check-check.json"),
    "{",
  );
  await assert.rejects(
    f.host.planIntegrationReview(
      f.id,
      { ...wave, key: "third-view" },
      f.adapter,
    ),
    (error) => !(error instanceof TaskInputRejection),
  );
  assert.equal(
    f.counts().spawns,
    0,
    "corrupt host evidence never becomes input-repair permission",
  );
});

test("closed usage includes the final native leaf and review; history reuses it without a controller", async (t) => {
  const { readClosedExecutionUsage } = await import("../orchestrator.mjs");
  const { historicalUsage, reconcileDrainedUsage } = await import(
    "../e2e/run-todo-flow.mjs"
  );
  const f = await reviewWaveFixture(t, 1, { stoppedWorker: true });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  Object.assign(f.orchestrator.herdr, {
    isIdle: () => true,
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  });
  assert.throws(
    () => readClosedExecutionUsage(f.orchestrator.runtimeRoot, f.id),
    /not closed/,
  );
  const cancelled = await f.orchestrator.cancel(f.id, "fixture complete");
  assert.equal(cancelled.execution.reservationOpen, false);
  const closed = f.orchestrator.captureClosedUsage(f.id);
  assert.deepEqual(
    closed.usage.sources.map((row) => row.kind),
    ["worker", "leaf", "review"],
  );
  assert.equal(closed.usage.totals.total, 30);
  assert.deepEqual(f.orchestrator.captureClosedUsage(f.id), closed);
  const refs = [{ runtimeRoot: f.orchestrator.runtimeRoot, executionId: f.id }];
  const worker = closed.usage.sources[0];
  const oldSnapshot = [
    { file: worker.sessionFile, sha256: worker.usage.sourceSha256 },
  ];
  const history = historicalUsage(oldSnapshot, "parent", refs);
  assert.equal(history.sources.length, 3);
  assert.equal(
    history.totals.total,
    30,
    "neither omitted final roles nor double-charged Worker",
  );
  const rows = [
    { executionId: f.id, reservationOpen: false, closedUsage: closed },
  ];
  assert.equal(reconcileDrainedUsage(rows, "owner").totals.total, 30);
  assert.throws(
    () => historicalUsage([], "parent", [...refs, ...refs]),
    /duplicate historical execution/,
  );
  assert.throws(() => reconcileDrainedUsage(rows, "foreign"), /owner changed/);
  f.orchestrator.close();
  assert.equal(
    readClosedExecutionUsage(refs[0].runtimeRoot, f.id).usage.totals.total,
    30,
  );
  assert.throws(
    () => f.orchestrator.captureClosedUsage(f.id),
    /original live instance/,
  );
  fs.writeFileSync(closed.receiptRef, "{}");
  assert.throws(() => reconcileDrainedUsage(rows, "owner"), /receipt changed/);
  fs.unlinkSync(worker.sessionFile);
  assert.throws(
    () => historicalUsage([], "parent", refs),
    /ENOENT|no such file/,
  );
});

test("original owner retains unstaged terminal evidence before native temp cleanup; history stays read-only", async (t) => {
  const { readClosedExecutionUsage } = await import("../orchestrator.mjs");
  const f = await fixture(t, ["alpha"], undefined, {
    stoppedWorker: true,
    resultOutcome: "blocked",
    review: reviewPolicy,
  });
  Object.assign(f.orchestrator.herdr, {
    isIdle: () => true,
    closeIdle: (paneId) => ({ paneId, disposition: "closed" }),
  });
  const id = f.prepared.executionId;
  await f.orchestrator.cancel(id, "fixture blocked without stage");
  const nativeCapture = path.join(
    f.prepared.executionRoot,
    "receipts/cancel-native-role-launch.json",
  );
  assert.equal(
    readClosedExecutionUsage(f.orchestrator.runtimeRoot, id).usage.totals.total,
    20,
  );
  assert.equal(
    fs.existsSync(nativeCapture),
    false,
    "historical reader cannot backfill owner evidence",
  );
  const closed = f.orchestrator.captureClosedUsage(id);
  assert.equal(fs.existsSync(nativeCapture), true);
  fs.rmSync(f.native, { recursive: true });
  assert.deepEqual(
    readClosedExecutionUsage(f.orchestrator.runtimeRoot, id).usage,
    closed.usage,
  );
  assert.deepEqual(
    f.orchestrator.captureClosedUsage(id),
    closed,
    "sealed usage survives temporary runner cleanup",
  );
  fs.writeFileSync(nativeCapture, "{}");
  assert.throws(
    () => readClosedExecutionUsage(f.orchestrator.runtimeRoot, id),
    /binding changed/,
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
  assert.deepEqual(result.toolDiagnostics.effective, [
    "read",
    "structured_output",
  ]);
  assert.deepEqual(result.toolDiagnostics.excess, []);
  launch.tools.internalTools = ["structured_output"];
  assert.deepEqual(
    validateReviewLaunch(request, { ok: true, contract: launch })
      .toolDiagnostics.internalTools,
    ["structured_output"],
  );
  for (const change of [
    (c) => {
      c.tools.internalTools = ["write"];
    }, // Internal capabilities have no ceiling exemption.
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
  const f =
    options.existing ??
    (await fixture(t, ["alpha"], options.checkScript, {
      ...options,
      review: reviewPolicy,
    }));
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
    for (const [index, step] of f.status.steps.entries()) {
      step.exitCode = 0;
      Object.assign(step.acceptance, {
        childReport: { changedFiles: f.manifests[index].changedFiles },
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
    key: options.reviewKey ?? "review-one",
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
  const reviewPrefix = options.reviewRunPrefix ?? "review";
  let resolves = 0,
    spawns = 0,
    admissions = 0;
  let plan;
  const adapter = {
    nativeOwner: "owner",
    resolve: async (input) => {
      resolves++;
      assert.equal(input.model, "openai-codex/gpt-5.6-luna");
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
          params.workflowScript.includes('"model":"openai-codex/gpt-5.6-luna"'),
        );
        return {
          runId: `${reviewPrefix}-root`,
          asyncDir: path.join(f.root, `native-${reviewPrefix}`),
        };
      },
    },
  };
  plan = await f.host.planIntegrationReview(id, wave, adapter);
  const native = path.join(f.root, `native-${reviewPrefix}`);
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
      runId: `${reviewPrefix}-child-${i}`,
      structuredOutput: {
        schemaVersion: "teams-integration-review-report/1",
        requestDigest: request.digest,
        verdict: "pass",
        criteria: {
          outcome: {
            status: "met",
            reason: "Synthetic review of the frozen source.",
            sourcePaths: options.reviewSourcePaths ?? ["src/main.txt"],
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
      workflowRunId: `${reviewPrefix}-root`,
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
            id: options.reviewRunPrefix
              ? `${reviewPrefix}-session-${i}`
              : `session-${i}`,
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
      runId: `${reviewPrefix}-root`,
      cwd: request.subject.cwd,
      sessionId: "owner",
      state: "complete",
      processTerminal: {
        version: 1,
        state: "observed",
        runId: `${reviewPrefix}-root`,
        runnerProcessInstanceId: `${reviewPrefix}-runner`,
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

test("zero-write isolated read-only handoff reaches staged checks, source-bound review and fixture acceptance", async (t) => {
  // Real temporary Git/filesystem and host boundaries; synthetic native records,
  // not a model run or an independent review of a live product.
  const f = await fixture(t, [null], undefined, {
    review: reviewPolicy,
    allowedWritePaths: [],
    roleMode: "read-only",
    nativeReviewRequired: false,
    stoppedWorker: true,
  });
  const id = f.prepared.executionId;
  const candidate = f.worker.mailbox.readJson("results/r0001.json");
  assert.equal(candidate.criterionResults[0].status, "indeterminate");
  assert.equal(fs.readFileSync(f.manifests[0].patchPath).length, 0);
  const r = await reviewWaveFixture(t, 1, {
    existing: f,
    writerEvidence: true,
  });
  const staged = f.host.stageIntegration(id);
  assert.equal(staged.status, "checks-passed");
  assert.equal(staged.tree, git(f.source, "rev-parse", `${f.base}^{tree}`));
  assert.deepEqual(staged.lanes[0].changedPaths, []);
  assert.equal(staged.lanes[0].mode, "read-only");
  const checkPath = path.join(
    f.prepared.executionRoot,
    "integration/check-check.json",
  );
  const checkBytes = fs.readFileSync(checkPath);
  assert.equal(JSON.parse(checkBytes).status, "verified");
  assert.throws(() => f.host.accept(id), /review/);
  assert.deepEqual(r.request.subject.changedPaths, []);
  assert.deepEqual(r.request.subject.writerRoles, []);
  assert.equal(r.request.subject.tree, staged.tree);
  r.adapter.assertAdmission = () => f.orchestrator.assertReviewAdmission(id);
  await f.host.startIntegrationReview(
    id,
    r.wave.key,
    r.plan.planDigest,
    r.adapter,
  );
  r.publish();
  const review = await f.host.collectIntegrationReview(
    id,
    r.wave.key,
    r.plan.planDigest,
  );
  assert.equal(review.verdict, "pass");
  await f.host.sealIntegrationReview(id);
  await f.host.runChecks(id);
  const accepted = await f.host.accept(id);
  assert.equal(accepted.receipt.decision, "accepted");
  assert.equal(accepted.receipt.schemaVersion, "teams-task-acceptance/3");
  assert.deepEqual(
    fs.readFileSync(checkPath),
    checkBytes,
    "stored host check is verified, not replayed",
  );
  assert.equal(
    f.worker.mailbox.readJson("results/r0001.json").criterionResults[0].status,
    "indeterminate",
    "host evidence does not rewrite the Worker claim",
  );
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("read-only integration rejects changed source and shared-only handoffs", async (t) => {
  for (const [name, edits, options, error] of [
    [
      "zero write scope",
      ["alpha"],
      { allowedWritePaths: [] },
      /read-only lane changed source/,
    ],
    [
      "write scope does not grant a reader writes",
      ["alpha"],
      { allowedWritePaths: ["src"] },
      /read-only lane changed source/,
    ],
    [
      "shared is not an isolated candidate",
      [null],
      { allowedWritePaths: [], roleIsolation: "shared" },
      /isolated lane inventory required/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, edits, undefined, {
        review: reviewPolicy,
        roleMode: "read-only",
        ...options,
      });
      assert.throws(
        () => f.host.stageIntegration(f.prepared.executionId),
        error,
      );
      assert.equal(
        fs.existsSync(path.join(f.prepared.executionRoot, "integration")),
        false,
      );
      assert.equal(git(f.source, "status", "--porcelain"), "");
    });
  }
});

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
  assert.throws(
    () =>
      f.orchestrator.prepare({
        ...nextSpec,
        policy: {
          ...nextSpec.policy,
          maxTaskTokens: nextSpec.policy.maxTaskTokens + 1,
        },
      }),
    /process restart policy changed; new authority required/,
  );
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
  assert.equal(over.allocationDiagnostics.roleSpawns, 1);
  assert.equal(over.allocationDiagnostics.reviewSpawns, 1);
  assert.equal(over.allocationDiagnostics.requestedSpawns, 3);
  assert.equal(over.allocationDiagnostics.spawnFits, false);
  assert.equal(over.allocationDiagnostics.admission, "not-assessed");
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
  const complete = path.join(
    f.prepared.executionRoot,
    "integration/reviews",
    f.wave.key,
    "complete.json",
  );
  const before = fs.readFileSync(complete);
  await assert.rejects(f.host.sealIntegrationReview(f.id), (error) => {
    assert.equal(error.phase, "review-seal");
    assert.match(
      error.message,
      /BLOCKED review wave.*cannot be sealed as PASS/,
    );
    return true;
  });
  assert.deepEqual(fs.readFileSync(complete), before);
  assert.equal(fs.existsSync(file), false);
  assert.equal(
    fs.existsSync(
      path.join(path.dirname(file), "review-candidate-intent.json"),
    ),
    false,
  );
  await f.host.planIntegrationReview(
    f.id,
    {
      ...f.wave,
      key: "second-uncollected",
      runs: [{ ...f.wave.runs[0], key: "second-view" }],
    },
    f.adapter,
  );
  await assert.rejects(f.host.sealIntegrationReview(f.id), (error) => {
    assert.notEqual(error.phase, "review-seal");
    assert.match(error.message, /uncollected review wave: second-uncollected/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(complete), before);
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
  "check-failure",
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
      action === "check-failure"
        ? await fixture(t, ["alpha"], "process.exit(7)", {
            extensionRuntime: true,
          })
        : action === "verified-patch"
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
      registerCommand() {},
      registerShortcut() {},
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
        sessionManager: {
          getSessionId: () => "owner",
          getBranch: () => [
            {
              type: "custom",
              customType: "pi-goal-focus",
              data: { version: 1, focusedGoalId: "goal" },
            },
          ],
        },
        modelRegistry: {
          getAvailable() {
            throw new Error("seal must not query models");
          },
        },
        ui: { setStatus() {} },
      };
      await handlers.get("session_start")({}, ctx); // Isolated temp ledger; no runtime reload.
      if (action === "check-failure") {
        const input = { execution_id: f.prepared.executionId, action: "stage" };
        const reply = await tools
          .get("team_task_stage_integration")
          .execute("check-public", input, undefined, undefined, ctx);
        const { isCompletedCheckFailure } = await import(
          "../check-failure.mjs"
        );
        assert.equal(reply.isError, true);
        assert.equal(
          isCompletedCheckFailure(
            reply.details.checkFailure,
            { tool: "team_task_stage_integration", input },
            "team_task_stage_integration",
            "check-public",
          ),
          true,
        );
        assert.equal(reply.details.checkFailure.exitCode, 7);
        const bytes = fs.readFileSync(reply.details.checkFailure.receiptRef);
        await assert.rejects(
          tools
            .get("team_task_stage_integration")
            .execute("no-replay", input, undefined, undefined, ctx),
          /reconcile/,
        );
        assert.deepEqual(
          fs.readFileSync(reply.details.checkFailure.receiptRef),
          bytes,
        );
        assert.deepEqual(rpcCalls, ["ping"]);
        return;
      }
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
        assert.equal(await handlers.get("tool_call")(event, ctx), undefined);
        assert.equal(
          event.input.evidence,
          `task-runtime:${accepted.details.receipt.acceptanceId}`,
        );
        const receipt = accepted.details.receipt;
        receipt.finalEvidence.sourceDigest = "0".repeat(64);
        fs.writeFileSync(receipt.receiptRef, JSON.stringify(receipt));
        const blocked = await handlers.get("tool_call")(
          {
            ...event,
            toolCallId: "second-write",
          },
          ctx,
        );
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

test("R31-H read-only sealed BLOCKED review revalidates native capture without old writes", async (t) => {
  const f = await reviewWaveFixture(t, 1);
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish((status) => {
    status.steps[0].structuredOutput.verdict = "blocked";
    status.workflow.value[0].structuredOutput.verdict = "blocked";
    const file = status.steps[0].sessionFile;
    const rows = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    rows[1].message.content[0].arguments.value.verdict = "blocked";
    fs.writeFileSync(
      file,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  });
  const original = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(original.verdict, "blocked");
  const dir = path.join(
    f.worker.mailbox.root,
    "integration/reviews",
    f.wave.key,
  );
  const before = fs.readdirSync(dir).sort();
  const context = {
    mailbox: f.worker.mailbox,
    contract: f.prepared.contract,
    result: f.worker.mailbox.listResults().at(-1),
    ownerSessionId: "owner",
    assertOwner: () => f.orchestrator.assertController(f.prepared.projectId),
  };
  // Public collect adds visible result/completion selectors; the sealed reader
  // returns the underlying native completion without those presentation fields.
  const {
    resultDigest,
    resultOutcome,
    completionRef,
    completionSha256,
    ...nativeCompletion
  } = original;
  assert.equal(resultDigest, digest(context.result));
  assert.equal(resultOutcome, context.result.outcome);
  assert.equal(completionRef, path.join(dir, "complete.json"));
  assert.equal(completionSha256, bytesDigest(fs.readFileSync(completionRef)));
  assert.deepEqual(
    await readCompletedReviewWave(context, f.wave.key, f.plan.planDigest),
    nativeCompletion,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.ok(!fs.existsSync(path.join(dir, "operation.lock")));
  const file = path.join(dir, original.captures[0].saved);
  const originalBytes = fs.readFileSync(file);
  fs.writeFileSync(file, "tampered");
  await assert.rejects(
    readCompletedReviewWave(context, f.wave.key, f.plan.planDigest),
    (error) =>
      error.message === "invalid native review JSON" &&
      error.cause?.message?.includes("native review capture changed"),
  );
  fs.writeFileSync(file, originalBytes);
  assert.deepEqual(
    await readCompletedReviewWave(context, f.wave.key, f.plan.planDigest),
    nativeCompletion,
  );
});

test("R31-H report-only closed BLOCKED review stages the same writer/check without another role", async (t) => {
  function finishMeter(context, key, file, estimate, register = true) {
    const measured = measureSessionBytes(fs.readFileSync(file));
    if (register)
      registerTaskBudgetMembers(context, [
        { key, estimate, sessionRoot: path.dirname(file) },
      ]);
    const binding = taskBudgetBinding(context, key);
    const identity = { sessionId: measured.sessionId, sessionFile: file };
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
    writerEvidence: true,
    nativeReviewRequired: false,
    stoppedWorker: true,
    maxProcessRestarts: 1,
    tokenBudgetMode: "shared",
    distinctWorkerSessions: true,
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
        100,
      );
    },
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const oldReviewStatus = f.publish((status) => {
    for (const step of status.steps) {
      step.structuredOutput.verdict = "blocked";
      step.structuredOutput.findings = [
        {
          severity: "blocker",
          issue: "The report omitted the checked behavior.",
          rationale:
            "The source is unchanged; explain the check before acceptance.",
          sourcePaths: ["src/main.txt"],
        },
      ];
      const rows = fs
        .readFileSync(step.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      rows[1].message.content[0].arguments.value = step.structuredOutput;
      fs.writeFileSync(
        step.sessionFile,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      status.workflow.value.find(
        (row) => row.key === step.workflowKey,
      ).structuredOutput = step.structuredOutput;
    }
  });
  finishMeter(
    { contract: f.prepared.contract, mailbox: f.worker.mailbox },
    `review.${f.wave.key}.view-0`,
    oldReviewStatus.steps[0].sessionFile,
    100,
    false,
  );
  const blocked = await f.host.collectIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
  );
  assert.equal(blocked.verdict, "blocked");
  const oldBytes = fs.readFileSync(
    path.join(
      f.worker.mailbox.root,
      "integration/reviews",
      f.wave.key,
      "complete.json",
    ),
  );
  f.orchestrator.requestCancel(f.id, "sealed report is blocked");
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr.closeIdle = (paneId) => ({
    paneId,
    disposition: "closed",
  });
  const closed = f.orchestrator.reconcile(f.id);
  assert.equal(closed.execution.state, "CANCELLED");
  assert.equal(closed.execution.reservationOpen, false);
  await assert.rejects(async () => f.host.accept(f.id));
  assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
  assert.equal(f.orchestrator.ledger.getExecution(f.id).state, "CANCELLED");
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        f.worker.mailbox.root,
        "integration/reviews",
        f.wave.key,
        "complete.json",
      ),
    ),
    oldBytes,
  );
  const original = f.prepared.contract;
  const spec = {
    ...original,
    goalId: original.identity.goalId,
    taskId: original.identity.taskId,
    taskRevision: 2,
  };
  const revisionInput = {
    previousExecutionId: f.id,
    expectedPreviousResultDigest: digest(f.worker.mailbox.listResults().at(-1)),
    reviewFailureRef: path.join(
      f.worker.mailbox.root,
      "integration/reviews",
      f.wave.key,
      "complete.json",
    ),
    reviewFailureSha256: f.worker.mailbox.digestRelative(
      `integration/reviews/${f.wave.key}/complete.json`,
    ),
    reportReason:
      "Add the missing checked-behavior explanation without changing source.",
  };
  await assert.rejects(
    f.orchestrator.prepareReviewProductRevision(spec, {
      ...revisionInput,
      repairReason:
        "Attempt unauthorized product modification from a report-only predecessor.",
    }),
    /did not authorize review-origin product repair/,
  );
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, {
      ...revisionInput,
      expectedPreviousResultDigest: "0".repeat(64),
    }),
    /previous result|Expected values to be strictly equal/,
  );
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, {
      ...revisionInput,
      reviewFailureSha256: "0".repeat(64),
    }),
    /Expected values to be strictly equal|review/,
  );
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, {
      ...revisionInput,
      reviewFailureRef: path.join(f.root, "forged.json"),
    }),
    /sealed review completion reference/,
  );
  const halfPublished = path.join(
    f.worker.mailbox.root,
    "integration/review-candidate-intent.json",
  );
  fs.writeFileSync(halfPublished, "{}");
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, revisionInput),
    /old review has failure, seal or target journal/,
  );
  fs.unlinkSync(halfPublished);
  const unknownWave = path.join(
    f.worker.mailbox.root,
    "integration/reviews/unknown-wave",
  );
  fs.mkdirSync(unknownWave);
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, revisionInput),
    /another\/unknown wave/,
  );
  fs.rmdirSync(unknownWave);
  await assert.rejects(
    f.orchestrator.prepareReportRevision(
      {
        ...spec,
        policy: {
          ...spec.policy,
          maxTaskTokens: spec.policy.maxTaskTokens + 1,
        },
      },
      revisionInput,
    ),
    /report revision policy changed/,
  );
  await assert.rejects(
    f.orchestrator.prepareReportRevision(
      {
        ...spec,
        workspace: {
          ...spec.workspace,
          allowedWritePaths: ["src", "README.md"],
        },
      },
      revisionInput,
    ),
    /report revision workspace changed/,
  );
  const unchanged = fs.readFileSync(path.join(f.source, "src/main.txt"));
  fs.writeFileSync(path.join(f.source, "src/main.txt"), "late drift\n");
  await assert.rejects(
    f.orchestrator.prepareReportRevision(spec, revisionInput),
    /baseline drifted/,
  );
  fs.writeFileSync(path.join(f.source, "src/main.txt"), unchanged);
  assert.equal(
    f.orchestrator.ledger.listTaskExecutions(
      f.prepared.projectId,
      "goal",
      "task",
    ).length,
    1,
  );
  const revision = await f.orchestrator.prepareReportRevision(
    spec,
    revisionInput,
  );
  assert.equal(
    f.orchestrator.ledger.getExecution(revision.executionId).state,
    "RESERVED",
  );
  await f.orchestrator.launch(revision.executionId, { timeoutMs: 1000 });
  const next = f.getActiveWorker();
  assert.notEqual(next, f.worker);
  finishMeter(
    { contract: revision.contract, mailbox: next.mailbox },
    "worker",
    next.mailbox.readJson("receipts/boot.json").workerSessionFile,
    0,
    false,
  );
  let nativeDispatches = 0;
  const roles = new RoleController({
    runtime: next,
    cwd: f.source,
    rpc: {
      request: async () => {
        nativeDispatches++;
      },
    },
  });
  await assert.rejects(
    roles.spawn({
      role: "team.implementer",
      task: "Do not spawn",
      mode: "mutation",
      maxTokens: 100,
    }),
    /report-only revision cannot dispatch/,
  );
  assert.equal(nativeDispatches, 0);
  const corrected = {
    schemaVersion: "teams-task-result/1",
    identity: revision.contract.identity,
    requestDigest: revision.requestDigest,
    resultRevision: 1,
    outcome: "ready_for_acceptance",
    summary: "Corrected report cites the original check.",
    source: next.captureSource(1),
    criterionResults: [
      {
        criterionId: "outcome",
        status: "indeterminate",
        observation: "Original check proven; new review pending.",
        evidenceIds: [],
      },
    ],
    evidence: [],
    childRunRefs: [],
    unresolvedRunCount: 0,
    risks: [],
    usage: { inputTokens: null, outputTokens: null },
  };
  assert.throws(
    () => next.sealResult({ ...corrected, childRunRefs: ["invented"] }),
    /report-only revision cannot claim writer runs/,
  );
  next.sealResult(corrected);
  f.orchestrator.collect(revision.executionId);
  const stage = f.host.stageIntegration(revision.executionId);
  assert.equal(
    stage.tree,
    f.worker.mailbox.readJson("integration/receipt.json").tree,
  );
  assert.equal(stage.inheritedFrom.previousExecutionId, f.id);
  assert.ok(
    !fs.existsSync(
      path.join(next.mailbox.root, "integration/check-check.json"),
    ),
    "report revision must not rerun the check",
  );
  assert.equal(f.host.runChecks(revision.executionId)[0].status, "verified");
  assert.throws(
    () => f.host.accept(revision.executionId),
    /sealed patch review|review candidate|final review binding/,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        f.worker.mailbox.root,
        "integration/reviews",
        f.wave.key,
        "complete.json",
      ),
    ),
    oldBytes,
  );
  const revised = await reviewWaveFixture(t, 1, {
    existing: { ...f, prepared: revision, worker: next },
    tokenBudgetMode: "shared",
    reviewRunPrefix: "fresh",
    reviewSourcePaths: ["src/main.txt"],
  });
  assert.equal(
    revised.request.subject.priorBlockedReview.rootRunId,
    "review-root",
  );
  assert.equal(
    revised.request.subject.reportRevision.resultDigest,
    digest(next.mailbox.listResults().at(-1)),
  );
  await revised.host.startIntegrationReview(
    revised.id,
    revised.wave.key,
    revised.plan.planDigest,
    revised.adapter,
  );
  const status = revised.publish((status) => {
    for (const step of status.steps) {
      step.structuredOutput.priorResolutions = {
        "view-0:0":
          "Original source/check were correct; the corrected Worker result now identifies the checked behavior without changing the tree.",
      };
      const rows = fs
        .readFileSync(step.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      rows[1].message.content[0].arguments.value = step.structuredOutput;
      fs.writeFileSync(
        step.sessionFile,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    }
  });
  assert.ok(
    integrationReviewSchema(revised.request).required.includes(
      "priorResolutions",
    ),
  );
  const missingResolution = structuredClone(status.steps[0].structuredOutput);
  delete missingResolution.priorResolutions;
  assert.throws(
    () => validateReviewReport(revised.request, missingResolution),
    /review fields changed/,
  );
  assert.throws(
    () =>
      validateReviewReport(revised.request, {
        ...status.steps[0].structuredOutput,
        priorResolutions: { "view-0:0": "" },
      }),
    /bounded review explanation/,
  );
  finishMeter(
    { contract: revision.contract, mailbox: next.mailbox },
    `review.${revised.wave.key}.view-0`,
    status.steps[0].sessionFile,
    100,
    false,
  );
  const reviewed = await revised.host.collectIntegrationReview(
    revised.id,
    revised.wave.key,
    revised.plan.planDigest,
  );
  assert.equal(reviewed.verdict, "pass");
  await revised.host.sealIntegrationReview(revised.id);
  const accepted = await revised.host.accept(revised.id);
  assert.equal(accepted.receipt.schemaVersion, "teams-task-acceptance/3");
  assert.equal(accepted.receipt.finalEvidence.delivery.targetModified, false);
  assert.equal(
    accepted.receipt.finalEvidence.checks[0].receiptRef,
    path.join(f.worker.mailbox.root, "integration/check-check.json"),
  );
  assert.equal(
    accepted.receipt.finalEvidence.reviewBinding.writerEvidenceDigest,
    next.mailbox.readJson("receipts/report-revision-intent.json")
      .writerEvidenceDigest,
  );
  assert.equal(
    accepted.receipt.finalEvidence.usage.taskTotals.total,
    next.mailbox.readJson("receipts/prior-usage.json").totals.total + 20,
  );
  assert.equal(f.orchestrator.ledger.getAcceptance(f.id), null);
  const { createGoalGuard } = await import("../goal-guard.mjs");
  const gate = await createGoalGuard(
    f.orchestrator,
    f.source,
  ).beforeTaskCompletion({ goalId: "goal", taskId: "task" });
  assert.ok(gate.evidence, "synthetic Goal matching gate needs new acceptance");
  fs.rmSync(f.native, { recursive: true });
  fs.rmSync(f.reviewNative, { recursive: true });
  assert.deepEqual(
    (await revised.host.accept(revised.id)).receipt,
    accepted.receipt,
  );
  const sealedCapture = path.join(
    f.worker.mailbox.root,
    "integration/reviews",
    f.wave.key,
    blocked.captures[0].saved,
  );
  const captureBytes = fs.readFileSync(sealedCapture);
  fs.writeFileSync(sealedCapture, "late drift");
  await assert.rejects(
    revised.host.accept(revised.id),
    /native review capture changed|invalid native review JSON/,
  );
  fs.writeFileSync(sealedCapture, captureBytes);
  assert.deepEqual(
    (await revised.host.accept(revised.id)).receipt,
    accepted.receipt,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        f.worker.mailbox.root,
        "integration/reviews",
        f.wave.key,
        "complete.json",
      ),
    ),
    oldBytes,
  );
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

test("approved-integration never runs final host checks on the original target before apply", async (t) => {
  const f = await sealedReviewFixture(t, {
    integrationMode: "approved-integration",
  });
  const staged = JSON.parse(
    fs.readFileSync(
      path.join(f.prepared.executionRoot, "integration/receipt.json"),
    ),
  );
  assert.equal(staged.status, "checks-passed");
  const originalCheck = path.join(
    f.prepared.executionRoot,
    "evidence/host-check-check.json",
  );
  assert.throws(
    () => f.host.runChecks(f.id),
    /approved-integration.*apply.*before.*checks/i,
  );
  assert.equal(
    fs.existsSync(originalCheck),
    false,
    "pre-apply must have no host-check effect",
  );
  assert.equal(git(f.source, "status", "--porcelain"), "");
  const plan = f.host.prepareIntegrationApply(f.id);
  await f.host.applyIntegration(f.id, plan.planDigest, () => true);
  const checks = f.host.runChecks(f.id);
  assert.equal(checks[0].status, "verified");
  assert.match(checks[0].receipt, /host-final-check-check\.json$/);
});

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

test("public completed check failure stays diagnostic, but invalid later conflict input stays unclassified", async (t) => {
  for (const kind of ["check", "invalid-lane"])
    await t.test(kind, async (sub) => {
      const f = await fixture(
        sub,
        kind === "check" ? ["alpha"] : ["conflict-a", "conflict-b", "outside"],
        "process.exit(7)",
        {
          publicEntry: true,
          stoppedWorker: true,
          review: reviewPolicy,
          tokenBudgetMode: "shared",
          maxProcessRestarts: 1,
        },
      );
      const event = await f.publicApi.call("team_task_stage_integration", {
        execution_id: f.prepared.executionId,
        action: "stage",
      });
      assert.equal(event.isError, true, JSON.stringify(event.result));
      const known = kind === "check";
      assert.equal(Boolean(event.result.details?.checkFailure), known);
      assert.equal(event.result.details?.integrationConflict, undefined);
      const failure = f.worker.mailbox.readJson("integration/failure.json");
      assert.equal(
        failure.conflict,
        undefined,
        "a later invalid input must not be hidden by the earlier merge conflict",
      );
      const observed = await observePublicTaskEvents(
        f.root,
        f.source,
        f.publicApi.events,
        `public-${kind}`,
      );
      assert.equal(
        observed.stopReason,
        known ? "check-failed" : "task-tool-failure",
      );
      assert.equal(git(f.source, "status", "--porcelain"), "");
    });
});

test("known isolated conflict returns through public L0 revision to one full candidate and fresh acceptance", async (t) => {
  for (const integrationMode of ["verify-only", "approved-integration"])
    await t.test(integrationMode, async (t) => {
      const checkScript =
        "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('src/main.txt','utf8'),'conflict-a\\nconflict-b\\n');for(const n of ['alpha','gamma'])a.equal(fs.readFileSync('src/'+n+' space.txt','utf8'),n+'\\n')";
      const f = await fixture(
        t,
        ["alpha", "conflict-a", "conflict-b", "gamma"],
        checkScript,
        {
          publicEntry: true,
          stoppedWorker: true,
          distinctWorkerSessions: true,
          review: reviewPolicy,
          nativeReviewRequired: false,
          tokenBudgetMode: "shared",
          maxProcessRestarts: 1,
          maxRoleSpawnsPerTask: 6,
          integrationMode,
        },
      );
      const original = f.prepared.contract,
        id = f.prepared.executionId;
      const oldWorker = f.worker;
      const oldContext = { contract: original, mailbox: oldWorker.mailbox };
      meterMember(
        oldContext,
        "worker",
        oldWorker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        0,
        false,
      );
      for (const [i, step] of f.status.steps.entries())
        meterMember(oldContext, `role.launch.lane-${i}`, step.sessionFile, 100);
      const indexBefore = fs.readFileSync(path.join(f.source, ".git/index"));
      const sourceBefore = snapshot(f.source, ["src"]);
      const event = await f.publicApi.call("team_task_stage_integration", {
        execution_id: id,
        action: "stage",
      });
      assert.equal(event.isError, true);
      const fact = event.result.details?.integrationConflict;
      assert.equal(
        isCompletedIntegrationConflict(
          fact,
          {
            tool: event.toolName,
            input: { execution_id: id, action: "stage" },
          },
          event.toolName,
          event.toolCallId,
        ),
        true,
        JSON.stringify(event.result),
      );
      assert.deepEqual(fact.conflictPaths, ["src/main.txt"]);
      const failureBytes = fs.readFileSync(fact.receiptRef);
      assert.equal(bytesDigest(failureBytes), fact.receiptSha256);
      const failure = JSON.parse(failureBytes);
      assert.equal(failure.conflict.failedLaneIndex, 2);
      assert.equal(
        failure.conflict.lanes.length,
        4,
        "pending contributions must be captured before the conflict",
      );
      assert.equal(
        fs.existsSync(
          path.join(oldWorker.mailbox.root, "integration/receipt.json"),
        ),
        false,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.source, ".git/index")),
        indexBefore,
      );
      assert.deepEqual(snapshot(f.source, ["src"]), sourceBefore);
      assert.throws(
        () => f.host.stageIntegration(id),
        /failed integration; reconcile/,
      );
      assert.throws(() => f.host.prepareIntegrationReview(id));
      assert.throws(() => f.host.accept(id));
      const publicInput = {
        origin: "integration-conflict",
        previous_execution_id: id,
        expected_previous_result_digest: digest(
          oldWorker.mailbox.listResults().at(-1),
        ),
        failure_receipt_ref: fact.receiptRef,
        failure_receipt_sha256: fact.receiptSha256,
        repair_reason:
          "Resolve both conflicting contributions, preserving alpha and the unapplied gamma lane.",
      };
      const revision = {
        origin: publicInput.origin,
        previousExecutionId: id,
        expectedPreviousResultDigest:
          publicInput.expected_previous_result_digest,
        failureReceiptRef: fact.receiptRef,
        failureReceiptSha256: fact.receiptSha256,
        repairReason: publicInput.repair_reason,
        additionalChecks: [],
      };
      await assert.rejects(
        f.orchestrator.prepareProductRevision(null, revision),
        /closed|reservation|still|open/,
      );
      const cancelTimer = setInterval(() => {
        if (oldWorker.processControls().cancelRequested)
          oldWorker.confirmCancelled(0);
      }, 5);
      try {
        const cancelled = await f.publicApi.call("team_task_cancel", {
          execution_id: id,
          reason: "Preserve the known isolated conflict before bounded repair.",
        });
        assert.equal(
          cancelled.isError,
          false,
          JSON.stringify(cancelled.result),
        );
        assert.equal(cancelled.result.details.closedUsage.status, "measured");
      } finally {
        clearInterval(cancelTimer);
      }
      const ownerInstance = f.orchestrator.instanceId;
      f.orchestrator.instanceId = "different-live-instance";
      try {
        await assert.rejects(
          f.orchestrator.prepareProductRevision(null, revision),
          /fresh L0 instance/,
        );
      } finally {
        f.orchestrator.instanceId = ownerInstance;
      }
      const oldBootRef = path.join(
        oldWorker.mailbox.root,
        "receipts/boot.json",
      );
      const oldBootBytes = fs.readFileSync(oldBootRef);
      fs.writeFileSync(
        oldBootRef,
        JSON.stringify({
          ...JSON.parse(oldBootBytes),
          processId: process.pid,
          processStartedAtTicks: null,
        }),
      );
      try {
        await assert.rejects(
          f.orchestrator.prepareProductRevision(null, revision),
          /not terminal|termination|usage/,
        );
      } finally {
        fs.writeFileSync(oldBootRef, oldBootBytes);
      }
      const time = t.mock.method(
        Date,
        "now",
        () =>
          Date.parse(f.orchestrator.ledger.getExecution(id).createdAt) +
          original.policy.deadlineMs +
          1,
      );
      try {
        await assert.rejects(
          f.orchestrator.prepareProductRevision(null, revision),
          /deadline exhausted/,
        );
      } finally {
        time.mock.restore();
      }
      const { identity, ...fields } = structuredClone(original);
      const bad = {
        ...fields,
        goalId: identity.goalId,
        taskId: identity.taskId,
        taskRevision: identity.taskRevision + 1,
        objective: "Changed scope is forbidden.",
      };
      fs.writeFileSync(path.join(f.source, "src/main.txt"), "external drift\n");
      await assert.rejects(
        f.orchestrator.prepareProductRevision(bad, {
          ...revision,
          additionalChecks: undefined,
        }),
        (error) => {
          assert.notEqual(
            error.name,
            "TaskInputRejection",
            `source drift must not be downgraded to a draft error: ${error.message}`,
          );
          return /baseline|source|clean|drift/.test(error.message);
        },
      );
      fs.writeFileSync(path.join(f.source, "src/main.txt"), "base\n");
      for (const change of [
        { goalId: "foreign-goal" },
        { taskId: "foreign-task" },
        {
          workspace: {
            ...original.workspace,
            sourceRoot: path.join(f.root, "unowned-missing-source"),
          },
        },
      ])
        await assert.rejects(
          f.orchestrator.prepareProductRevision(
            { ...bad, objective: original.objective, ...change },
            { ...revision, additionalChecks: undefined },
          ),
          (error) => error.name === "TaskInputRejection",
        );
      assert.equal(
        f.orchestrator.ledger.db
          .prepare("SELECT count(*) AS total FROM controllers")
          .get().total,
        1,
        "legacy draft cannot select a different controller/workspace",
      );
      await assert.rejects(
        f.orchestrator.prepareProductRevision(null, {
          ...revision,
          failureReceiptSha256: "0".repeat(64),
        }),
        /receipt changed/,
      );
      const latePatch = path.join(
        oldWorker.mailbox.root,
        "integration",
        oldWorker.mailbox
          .readJson("integration/native.json")
          .captures.find((row) => row.origin === f.manifests[3].patchPath)
          .saved,
      );
      const lateBytes = fs.readFileSync(latePatch);
      fs.appendFileSync(latePatch, "tampered");
      await assert.rejects(
        f.orchestrator.prepareProductRevision(null, revision),
        /capture changed/,
      );
      fs.writeFileSync(latePatch, lateBytes);
      const draftPath = path.join(f.source, ".git/bad-conflict-draft.json");
      fs.writeFileSync(draftPath, JSON.stringify(bad));
      const rejected = await f.publicApi.call("team_task_revise", {
        ...publicInput,
        spec_path: draftPath,
      });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.result.details.rejection.phase, "task-spec");
      assert.equal(
        f.orchestrator.ledger.listTaskExecutions(
          identity.projectId,
          identity.goalId,
          identity.taskId,
        ).length,
        1,
      );
      const revised = await f.publicApi.call("team_task_revise", {
        ...publicInput,
        additional_checks: [],
      });
      assert.equal(revised.isError, false, JSON.stringify(revised.result));
      const next = f.publicApi.prepared,
        nextWorker = f.getActiveWorker();
      assert.notEqual(next.executionId, id);
      for (const key of [
        "objective",
        "nonGoals",
        "workspace",
        "criteria",
        "checks",
        "policy",
        "contextRefs",
      ])
        assert.deepEqual(next.contract[key], original[key]);
      const intent = nextWorker.mailbox.readJson("receipts/repair-intent.json");
      assert.equal(intent.schemaVersion, "teams-candidate-repair-intent/3");
      assert.equal(intent.patches.length, 4);
      assert.equal(
        f.orchestrator.ledger.readTaskPool(next.executionId).priorTokens,
        50,
      );
      assert.equal(
        taskDeadlineAt(
          f.orchestrator.ledger,
          f.orchestrator.ledger.getExecution(next.executionId),
          next.contract,
        ),
        intent.deadlineAt,
      );
      assert.match(nextWorker.taskPrompt(), /Conflict-origin product revision/);
      const script = conflictRepairCommand(intent, next.contract);
      const wide = {
        ...intent,
        patches: Array.from({ length: 64 }, () => ({
          ...intent.patches[0],
          path: `/long/${"a".repeat(500)}`,
        })),
      };
      assert.ok(
        Buffer.byteLength(conflictRepairCommand(wide, next.contract)) < 4096,
        "large captured inventories must remain references, not overflow the 16 KiB role task",
      );
      const repairedRoot = path.join(f.root, "resolved-writer");
      git(f.root, "clone", "-q", "--no-local", f.source, repairedRoot);
      const reconstructed = spawnSync("bash", ["-c", script], {
        cwd: repairedRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(f.source, ".git"),
          GIT_WORK_TREE: repairedRoot,
          GIT_INDEX_FILE: path.join(f.source, ".git/index"),
        },
      });
      assert.equal(reconstructed.status, 0, reconstructed.stderr);
      assert.match(reconstructed.stdout, /TASK_PI_CONFLICT_BASE_READY/);
      assert.deepEqual(
        fs.readFileSync(path.join(f.source, ".git/index")),
        indexBefore,
        "Git overrides cannot redirect reconstruction into target index",
      );
      assert.equal(
        fs.readFileSync(path.join(repairedRoot, "src/main.txt"), "utf8"),
        "base\n",
      );
      assert.equal(
        spawnSync("bash", ["-c", script], { cwd: repairedRoot }).status,
        1,
        "reconstruction is not replayable over the partial index",
      );
      fs.writeFileSync(
        path.join(repairedRoot, "src/main.txt"),
        "conflict-a\nconflict-b\n",
      );
      git(repairedRoot, "add", "src/main.txt");
      git(
        repairedRoot,
        "checkout-index",
        "--force",
        "--",
        "src/alpha space.txt",
      );
      assert.notEqual(
        spawnSync(process.execPath, original.checks[0].argv, {
          cwd: repairedRoot,
        }).status,
        0,
        "a conflict-only resolution still lacks the later lane",
      );
      git(repairedRoot, "apply", "--index", "--binary", intent.patches[3].path);
      assert.equal(
        spawnSync(process.execPath, original.checks[0].argv, {
          cwd: repairedRoot,
        }).status,
        0,
      );
      const patchPath = path.join(f.root, "full-resolved.patch");
      fs.writeFileSync(
        patchPath,
        git(
          repairedRoot,
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          f.base,
        ) + "\n",
      );
      const fresh = publishRepairedCandidate(f, nextWorker, next, {
        patchPath,
        repairCommand: script,
        repairOutput: reconstructed.stdout,
      });
      const nativeSession = fs.readFileSync(fresh.roleSession);
      fs.writeFileSync(
        fresh.roleSession,
        nativeSession
          .toString()
          .split("\n")
          .filter((line) => !line.includes("reconstruct-"))
          .join("\n"),
      );
      assert.throws(
        () => f.host.stageIntegration(next.executionId),
        /reconstruction|proof/,
      );
      assert.equal(
        fs.existsSync(path.join(next.executionRoot, "integration")),
        false,
      );
      fs.writeFileSync(fresh.roleSession, nativeSession);
      const context = { contract: next.contract, mailbox: nextWorker.mailbox };
      meterMember(
        context,
        "worker",
        nextWorker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        0,
        false,
      );
      meterMember(context, "role.repair-launch.repair", fresh.roleSession, 100);
      f.prepared = next;
      f.worker = nextWorker;
      f.native = fresh.native;
      f.status = fresh.status;
      f.saveStatus = fresh.saveStatus;
      const checked = await reviewWaveFixture(t, 1, {
        existing: f,
        tokenBudgetMode: "shared",
        writerEvidence: true,
        nativeReviewRequired: false,
        reviewRunPrefix: "resolved-review",
        mutateWriter(status) {
          status.steps[0].acceptance.childReport.changedFiles = [
            "src/main.txt",
            "src/alpha space.txt",
            "src/gamma space.txt",
          ];
        },
      });
      assert.equal(
        checked.request.subject.conflictRevision.inputPatches.length,
        4,
      );
      assert.match(
        checked.plan.children[0].task,
        /ALL original captured lane patches/,
      );
      assert.throws(
        () => checked.host.accept(next.executionId),
        /review|candidate|sealed/,
      );
      await checked.host.startIntegrationReview(
        next.executionId,
        checked.wave.key,
        checked.plan.planDigest,
        checked.adapter,
      );
      const reviewed = checked.publish();
      meterMember(
        context,
        `review.${checked.wave.key}.view-0`,
        reviewed.steps[0].sessionFile,
        100,
        false,
      );
      assert.equal(
        (
          await checked.host.collectIntegrationReview(
            next.executionId,
            checked.wave.key,
            checked.plan.planDigest,
          )
        ).verdict,
        "pass",
      );
      await checked.host.sealIntegrationReview(next.executionId);
      if (integrationMode === "approved-integration") {
        const plan = checked.host.prepareIntegrationApply(next.executionId);
        assert.equal(
          (
            await checked.host.applyIntegration(
              next.executionId,
              plan.planDigest,
              () => true,
            )
          ).status,
          "applied",
        );
        await checked.host.readAppliedIntegrationReview(
          next.executionId,
          plan.planDigest,
        );
        assert.equal(checked.host.runChecks(next.executionId).length, 1);
      }
      const acceptedEvent = await f.publicApi.call("team_task_accept", {
        execution_id: next.executionId,
      });
      assert.equal(
        acceptedEvent.isError,
        false,
        JSON.stringify(acceptedEvent.result),
      );
      const accepted = acceptedEvent.result.details.receipt;
      assert.equal(
        accepted.schemaVersion,
        integrationMode === "verify-only"
          ? "teams-task-acceptance/3"
          : "teams-task-acceptance/2",
      );
      assert.equal(
        accepted.finalEvidence.conflictRevision.previousExecutionId,
        id,
      );
      assert.equal(
        accepted.finalEvidence.conflictRevision.repairedTree,
        git(repairedRoot, "write-tree"),
      );
      if (integrationMode === "verify-only")
        assert.equal(accepted.finalEvidence.delivery.targetModified, false);
      assert.equal(f.orchestrator.ledger.getAcceptance(id), null);
      assert.deepEqual(fs.readFileSync(fact.receiptRef), failureBytes);
      assert.deepEqual(fs.readFileSync(latePatch), lateBytes);
      if (integrationMode === "verify-only") {
        assert.deepEqual(snapshot(f.source, ["src"]), sourceBefore);
        assert.equal(git(f.source, "status", "--porcelain"), "");
      } else {
        assert.equal(
          git(f.source, "rev-parse", "HEAD"),
          f.base,
          "fixture apply never commits",
        );
        assert.equal(
          spawnSync(process.execPath, original.checks[0].argv, {
            cwd: f.source,
          }).status,
          0,
        );
      }
      const { createGoalGuard } = await import("../goal-guard.mjs");
      assert.equal(
        (
          await createGoalGuard(f.orchestrator, f.source).beforeTaskCompletion({
            goalId: identity.goalId,
            taskId: identity.taskId,
          })
        ).ok,
        true,
      );
      const observer = await observePublicTaskEvents(
        f.root,
        f.source,
        f.publicApi.events,
        "conflict-recovered",
        { finalStatus: "complete" },
      );
      assert.equal(
        observer.stopReason,
        "goal-complete",
        JSON.stringify(observer.faults),
      );
      assert.equal(
        observer.integrationConflicts.length,
        1,
        "failure evidence remains visible",
      );
      assert.equal(observer.acceptedRepairs[0].executionId, next.executionId);
      const withoutAcceptance = f.publicApi.events.filter(
        (row) => row.toolName !== "team_task_accept",
      );
      const falseCompletion = await observePublicTaskEvents(
        f.root,
        f.source,
        withoutAcceptance,
        "conflict-false-complete",
        { finalStatus: "complete" },
      );
      assert.equal(
        falseCompletion.stopReason,
        "integration-conflict",
        "Goal/prose alone must not clear the failure",
      );
      assert.equal(
        f.orchestrator.ledger.listTaskExecutions(
          identity.projectId,
          identity.goalId,
          identity.taskId,
        ).length,
        2,
      );
      await assert.rejects(
        f.orchestrator.prepareProductRevision(null, revision),
        /revision|latest|one/,
      );
      for (const result of [
        { status: null, signal: "SIGTERM", error: null },
        { status: 1, signal: null, error: new Error("ETIMEDOUT") },
        { status: 128, signal: null, error: null },
      ]) {
        assert.throws(
          () =>
            completedIntegrationConflict({ contract: original }, { result }),
          (error) => !(error instanceof CompletedIntegrationConflict),
        );
      }
    });
});

test("review-only product defect cannot pass acceptance or target gates even after a PASS review", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    writerEvidence: true,
    nativeReviewRequired: false,
    stoppedWorker: true,
    integrationMode: "verify-only",
    resultOutcome: "ready_for_review",
    criterionStatus: "not_met",
    criterionObservation: "A disclosed product defect remains.",
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  await f.host.sealIntegrationReview(f.id);
  assert.throws(() => f.host.prepareIntegrationApply(f.id), /ready candidate/);
  await assert.rejects(
    f.host.applyIntegration(f.id, "a".repeat(64), () => true),
    /ready candidate/,
  );
  await assert.rejects(
    Promise.resolve().then(() => f.host.runChecks(f.id)),
    /ready candidate/,
  );
  await assert.rejects(Promise.resolve().then(() => f.host.accept(f.id)));
  assert.equal(
    fs.existsSync(path.join(f.worker.mailbox.root, "integration/target-apply")),
    false,
  );
  assert.equal(
    fs
      .readdirSync(path.join(f.worker.mailbox.root, "receipts"))
      .some((name) => name.startsWith("acceptance-")),
    false,
  );
  assert.equal(f.orchestrator.ledger.getExecution(f.id).state, "RESULT_READY");
});

test("review-origin product revision preserves complete old candidate, reruns new checks and accepts same Task", async (t) => {
  for (const integrationMode of ["verify-only", "approved-integration"])
    await t.test(integrationMode, async (sub) => {
      const { reviewRepairCommand } = await import(
        "../review-product-lineage.mjs"
      );
      const f = await reviewWaveFixture(sub, 1, {
        writerEvidence: true,
        nativeReviewRequired: false,
        stoppedWorker: true,
        maxProcessRestarts: 1,
        tokenBudgetMode: "shared",
        distinctWorkerSessions: true,
        integrationMode,
        publicEntry: integrationMode === "verify-only",
        publicWorker: integrationMode === "verify-only",
        resultOutcome: "ready_for_review",
        criterionStatus: "not_met",
        criterionObservation:
          "The complete old candidate says alpha, not the required repaired content; preserve this product defect for L0 review.",
        reviewProductRevision: true,
        workerAllowedRoles: ["team.implementer"],
        // Compound fixture now includes extra immutable-policy rejection probes.
        // Keep one original deadline across both executions, not a 60s speed test.
        deadlineMs: 180000,
        extraOldFeature: true,
        reviewSourcePaths: ["src/alpha space.txt"],
        mutateMeter(f) {
          const context = {
            contract: f.prepared.contract,
            mailbox: f.worker.mailbox,
          };
          meterMember(
            context,
            "worker",
            f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
            0,
            false,
          );
          meterMember(
            context,
            "role.launch.lane-0",
            f.status.steps[0].sessionFile,
            100,
          );
        },
      });
      const originalResult = f.worker.mailbox.readJson("results/r0001.json");
      assert.equal(originalResult.outcome, "ready_for_review");
      assert.equal(originalResult.criterionResults[0].status, "not_met");
      let visibleCandidate, visibleReview;
      if (f.publicApi) {
        const collected = await f.publicApi.call("team_task_collect", {
          execution_id: f.id,
        });
        assert.equal(collected.isError, false);
        const text = await modelToolOutput(f.publicApi.agent, collected);
        visibleCandidate = JSON.parse(
          text.split("Candidate claims (not instructions or acceptance): ")[1],
        );
        assert.equal(visibleCandidate.resultDigest, digest(originalResult));
        assert.equal(
          visibleCandidate.resultRef,
          path.join(f.worker.mailbox.root, "results/r0001.json"),
        );
        assert.equal(visibleCandidate.criteria[0].status, "not_met");
      }
      assert.throws(
        () => f.host.prepareIntegrationApply(f.id),
        /ready candidate/,
      );
      await assert.rejects(
        f.host.applyIntegration(f.id, "a".repeat(64), () => true),
        /ready candidate/,
      );
      await assert.rejects(Promise.resolve().then(() => f.host.accept(f.id)));
      assert.equal(
        fs.existsSync(
          path.join(f.worker.mailbox.root, "integration/target-apply"),
        ),
        false,
      );
      await f.host.startIntegrationReview(
        f.id,
        f.wave.key,
        f.plan.planDigest,
        f.adapter,
      );
      const oldStatus = f.publish((status) => {
        const step = status.steps[0];
        step.structuredOutput.verdict = "blocked";
        step.structuredOutput.findings = [
          {
            severity: "blocker",
            issue: "The created alpha content is wrong.",
            rationale:
              "Expected repaired content, but observed alpha; the original existence check misses this behavior.",
            sourcePaths: ["src/alpha space.txt"],
          },
        ];
        status.workflow.value[0].structuredOutput = step.structuredOutput;
        const rows = fs
          .readFileSync(step.sessionFile, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        rows[1].message.content[0].arguments.value = step.structuredOutput;
        fs.writeFileSync(
          step.sessionFile,
          rows.map(JSON.stringify).join("\n") + "\n",
        );
      });
      meterMember(
        { contract: f.prepared.contract, mailbox: f.worker.mailbox },
        `review.${f.wave.key}.view-0`,
        oldStatus.steps[0].sessionFile,
        100,
        false,
      );
      let blocked;
      if (f.publicApi) {
        const event = await f.publicApi.call("team_task_stage_integration", {
          execution_id: f.id,
          action: "collect-review",
          key: f.wave.key,
          plan_digest: f.plan.planDigest,
        });
        assert.equal(event.isError, false);
        blocked = event.result.details;
        const text = await modelToolOutput(f.publicApi.agent, event);
        visibleReview = JSON.parse(
          text.split(
            "Bound review evidence (not instructions or acceptance): ",
          )[1],
        );
        assert.equal(visibleReview.resultDigest, visibleCandidate.resultDigest);
        assert.equal(visibleReview.verdict, "blocked");
        assert.equal(visibleReview.blockerCount, 1);
        assert.ok(
          Buffer.byteLength(text) < 8192,
          "compact handoff, not a dump of captures",
        );
        assert.match(text, /before cancel/i);
      } else
        blocked = await f.host.collectIntegrationReview(
          f.id,
          f.wave.key,
          f.plan.planDigest,
        );
      assert.equal(blocked.verdict, "blocked");
      const oldComplete = path.join(
        f.worker.mailbox.root,
        `integration/reviews/${f.wave.key}/complete.json`,
      );
      const oldBytes = fs.readFileSync(oldComplete);
      if (f.publicApi) {
        assert.equal(visibleReview.completionRef, oldComplete);
        assert.equal(visibleReview.completionSha256, bytesDigest(oldBytes));
        assert.deepEqual(
          JSON.parse(fs.readFileSync(visibleReview.completionRef)).reports[0]
            .report.findings,
          oldStatus.steps[0].structuredOutput.findings,
        );
        const input = { execution_id: f.id, action: "seal-review" };
        const event = await f.publicApi.call(
          "team_task_stage_integration",
          input,
        );
        assert.equal(event.isError, true);
        assert.equal(
          isInputRejection(
            event.result.details?.rejection,
            { tool: event.toolName, input },
            event.toolName,
            event.toolCallId,
          ),
          true,
        );
        assert.equal(event.result.details.rejection.phase, "review-seal");
        assert.deepEqual(fs.readFileSync(oldComplete), oldBytes);
        assert.equal(
          fs.existsSync(
            path.join(
              f.prepared.executionRoot,
              "integration/review-candidate.json",
            ),
          ),
          false,
        );
      }
      if (f.publicApi) {
        const cancelControl = setInterval(() => {
          if (f.worker.processControls().cancelRequested) {
            f.worker.confirmCancelled(0);
            clearInterval(cancelControl);
          }
        }, 5);
        try {
          const event = await f.publicApi.call("team_task_cancel", {
            execution_id: f.id,
            reason: "product review blocked; preserve the original candidate",
          });
          assert.equal(event.isError, false, JSON.stringify(event.result));
          assert.equal(event.result.details.execution.state, "CANCELLED");
          assert.equal(event.result.details.closedUsage.status, "measured");
          assert.match(
            await modelToolOutput(f.publicApi.agent, event),
            /do not collect.*closed/i,
          );
          const status = await f.publicApi.call("team_task_status", {
            execution_id: f.id,
          });
          assert.ok(
            (await modelToolOutput(f.publicApi.agent, status)).includes(
              visibleCandidate.resultDigest,
            ),
          );
          assert.throws(
            () =>
              f.host.collectIntegrationReview(
                f.id,
                f.wave.key,
                f.plan.planDigest,
              ),
            /expected execution state/,
          );
          assert.deepEqual(
            fs.readFileSync(visibleReview.completionRef),
            oldBytes,
          );
        } finally {
          clearInterval(cancelControl);
        }
      } else {
        f.orchestrator.requestCancel(
          f.id,
          "product review blocked; preserve the original candidate",
        );
        f.worker.processControls();
        f.worker.confirmCancelled(0);
        f.orchestrator.herdr.closeIdle = (paneId) => ({
          paneId,
          disposition: "closed",
        });
        assert.equal(
          f.orchestrator.reconcile(f.id).execution.state,
          "CANCELLED",
        );
      }
      const original = f.prepared.contract;
      const regression = {
        ...original.checks[0],
        commandId: "content-regression",
        argv: [
          "-e",
          "require('node:assert/strict').equal(require('node:fs').readFileSync('src/alpha space.txt','utf8'),'repaired\\n')",
        ],
      };
      const spec = {
        ...original,
        goalId: "goal",
        taskId: "task",
        taskRevision: 2,
        checks: [...original.checks, regression],
      };
      const revisionInput = {
        previousExecutionId: f.id,
        expectedPreviousResultDigest: digest(
          f.worker.mailbox.listResults().at(-1),
        ),
        reviewFailureRef: oldComplete,
        reviewFailureSha256: f.worker.mailbox.digestRelative(
          `integration/reviews/${f.wave.key}/complete.json`,
        ),
        repairReason:
          "Repair the incorrect alpha content while preserving the original feature and checking it.",
      };
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(
          { ...spec, checks: [regression] },
          revisionInput,
        ),
        /original checks changed/,
      );
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(spec, {
          ...revisionInput,
          reviewFailureSha256: "0".repeat(64),
        }),
        /Expected values to be strictly equal|review artifact/,
      );
      assert.throws(
        () => f.orchestrator.prepare(spec),
        /reviewed execution requires explicit review revision/,
      );
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(spec, {
          ...revisionInput,
          reviewFailureRef: path.join(f.root, "unrelated-complete.json"),
        }),
        /frozen BLOCKED review completion required/,
      );
      const oldPatchRef = path.join(
        f.worker.mailbox.root,
        "integration/review.patch",
      );
      const oldPatchBytes = fs.readFileSync(oldPatchRef);
      fs.appendFileSync(oldPatchRef, "tampered");
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(spec, revisionInput),
        /patch|capture|changed/,
      );
      fs.writeFileSync(oldPatchRef, oldPatchBytes);
      const partialReview = path.join(
        f.worker.mailbox.root,
        "integration/reviews/uncollected-wave",
      );
      fs.mkdirSync(partialReview);
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(spec, revisionInput),
        /plan\.json|unknown|review/,
      );
      fs.rmdirSync(partialReview);
      const targetJournal = path.join(
        f.worker.mailbox.root,
        "integration/target-apply",
      );
      fs.mkdirSync(targetJournal);
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(spec, revisionInput),
        /review seal|target journal/,
      );
      fs.rmdirSync(targetJournal);
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(
          { ...spec, policy: { ...spec.policy, maxTaskTokens: 1001 } },
          revisionInput,
        ),
        /policy changed/,
      );
      for (const roles of [
        spec.policy.allowedRoles,
        ["team.reviewer"],
        undefined,
      ]) {
        const changed = { ...spec, policy: { ...spec.policy } };
        if (roles === undefined) delete changed.policy.workerAllowedRoles;
        else changed.policy.workerAllowedRoles = roles;
        await assert.rejects(
          f.orchestrator.prepareReviewProductRevision(changed, revisionInput),
          /policy changed/,
        );
      }
      const hiddenDrift = path.join(f.source, ".hidden-drift");
      fs.writeFileSync(hiddenDrift, "unrelated target change\n");
      await assert.rejects(
        f.orchestrator.prepareReviewProductRevision(
          { ...spec, objective: "wrong draft as well" },
          revisionInput,
        ),
        (error) =>
          error.phase === undefined &&
          /baseline|workspace|clean/.test(error.message),
      );
      fs.unlinkSync(hiddenDrift);
      let nextWorker;
      f.orchestrator.herdr.start = async (input) => {
        nextWorker = new WorkerRuntime({ executionRoot: input.executionRoot });
        nextWorker.boot({
          sessionId: "worker-2",
          processId: 99_999_999,
          processStartedAtTicks: "1",
          sessionFile: meteredSession(
            path.join(input.executionRoot, "worker-sessions/worker-2.jsonl"),
            "worker-2",
            f.source,
          ),
          cwd: f.source,
          activeTools: ["read", "team_role_spawn", "team_task_result"],
          extensions: ["teams-worker", "pi-subagents"],
          subagents: {
            compatible: true,
            checks: { protocolV1: true, status: true, spawn: true, stop: true },
            ping: { version: 1 },
          },
        });
        return { paneId: "w2:p2", agentName: "worker" };
      };
      const timer = setInterval(() => nextWorker?.processControls(), 5);
      sub.after(() => clearInterval(timer));
      let next;
      if (f.publicApi) {
        const input = {
          previous_execution_id: f.id,
          // Selectors come ONLY from the provider-visible handoff, not details/files/ledger.
          expected_previous_result_digest: visibleCandidate.resultDigest,
          origin: "blocked-review",
          review_failure_ref: visibleReview.completionRef,
          review_failure_sha256: visibleReview.completionSha256,
          repair_reason: revisionInput.repairReason,
        };
        const draft = path.join(f.source, ".git/revision-draft.json");
        fs.writeFileSync(
          draft,
          JSON.stringify({
            ...spec,
            objective: "accidentally rewritten scope",
          }),
        );
        const wrong = { ...input, spec_path: draft };
        const rejected = await f.publicApi.call("team_task_revise", wrong);
        assert.equal(rejected.isError, true);
        assert.equal(
          isInputRejection(
            rejected.result.details?.rejection,
            { tool: rejected.toolName, input: wrong },
            rejected.toolName,
            rejected.toolCallId,
          ),
          true,
        );
        assert.match(rejected.result.content[0].text, /objective changed/);
        assert.equal(
          f.orchestrator.ledger.listTaskExecutions(
            original.identity.projectId,
            "goal",
            "task",
          ).length,
          1,
        );
        assert.equal(
          f.orchestrator.ledger.getExecution(f.id).reservationOpen,
          false,
        );
        const repaired = await f.publicApi.call("team_task_revise", {
          ...input,
          additional_checks: [regression],
        });
        assert.equal(repaired.isError, false, JSON.stringify(repaired.result));
        next = f.publicApi.prepared;
        assert.equal(repaired.result.details.executionId, next.executionId);
        for (const key of [
          "objective",
          "nonGoals",
          "workspace",
          "criteria",
          "policy",
          "contextRefs",
        ])
          assert.deepEqual(
            next.contract[key],
            original[key],
            `host inherited ${key} exactly`,
          );
        assert.deepEqual(next.contract.checks, spec.checks);
      } else
        next = await f.orchestrator.prepareReviewProductRevision(
          spec,
          revisionInput,
        );
      const intent =
        f.orchestrator.ledger.getContract(next.executionId) &&
        (await import("../mailbox.mjs")).Mailbox.open(
          next.executionRoot,
          next.executionId,
        ).readJson("receipts/repair-intent.json");
      assert.equal(
        intent.oldTree,
        f.worker.mailbox.readJson("integration/receipt.json").tree,
      );
      assert.equal(intent.waves[0].findings[0].severity, "blocker");
      assert.equal(
        f.orchestrator.ledger.readTaskPool(next.executionId).priorTokens,
        30,
      );
      const script = reviewRepairCommand(intent, next.contract);
      const temp = path.join(f.root, "repair-tree");
      git(f.root, "clone", "-q", "--no-local", f.source, temp);
      const command = spawnSync("bash", ["-c", script], {
        cwd: temp,
        encoding: "utf8",
      });
      assert.equal(command.status, 0, command.stderr);
      assert.match(command.stdout, new RegExp(intent.oldTree));
      assert.equal(git(temp, "write-tree"), intent.oldTree);
      assert.equal(
        fs.readFileSync(path.join(temp, "src/beta space.txt"), "utf8"),
        "beta\n",
      );
      const red = spawnSync(process.execPath, regression.argv, { cwd: temp });
      assert.notEqual(
        red.status,
        0,
        "the old candidate must reproduce the incorrect content",
      );
      fs.writeFileSync(path.join(temp, "src/alpha space.txt"), "repaired\n");
      git(temp, "add", "-A");
      const patch = spawnSync(
        "git",
        ["-C", temp, "diff", "--cached", "--binary", "--full-index", f.base],
        { encoding: "buffer" },
      );
      assert.equal(patch.status, 0);
      const patchPath = path.join(f.root, "complete-repair.patch");
      fs.writeFileSync(patchPath, patch.stdout);
      assert.ok(
        patch.stdout.includes(Buffer.from("src/alpha space.txt")),
        "complete patch retains old feature",
      );
      assert.ok(
        patch.stdout.includes(Buffer.from("src/beta space.txt")),
        "complete patch retains untouched feature",
      );
      assert.equal(
        spawnSync(process.execPath, regression.argv, { cwd: temp }).status,
        0,
        "repaired behavior is GREEN",
      );
      const newTree = git(temp, "write-tree");
      const delta = spawnSync(
        "git",
        [
          "-C",
          temp,
          "diff",
          "--binary",
          "--full-index",
          intent.oldTree,
          newTree,
        ],
        { encoding: "buffer" },
      );
      assert.equal(delta.status, 0);
      const deltaOnly = path.join(f.root, "delta-only");
      git(f.root, "clone", "-q", "--no-local", f.source, deltaOnly);
      const deltaApply = spawnSync(
        "git",
        ["-C", deltaOnly, "apply", "--index", "--binary", "-"],
        { input: delta.stdout },
      );
      assert.notEqual(
        deltaApply.status,
        0,
        "C0→C1 delta is not the complete B→C1 candidate",
      );
      const doubled = path.join(f.root, "double-patch");
      git(f.root, "clone", "-q", "--no-local", f.source, doubled);
      assert.equal(
        spawnSync("git", ["-C", doubled, "apply", "--index", "--binary", "-"], {
          input: oldPatchBytes,
        }).status,
        0,
      );
      assert.notEqual(
        spawnSync("git", ["-C", doubled, "apply", "--index", "--binary", "-"], {
          input: patch.stdout,
        }).status,
        0,
        "P0+P1 would duplicate the inherited feature",
      );
      const omitted = path.join(f.root, "omitted-feature");
      git(f.root, "clone", "-q", "--no-local", f.source, omitted);
      fs.writeFileSync(path.join(omitted, "src/alpha space.txt"), "repaired\n");
      assert.notEqual(
        spawnSync(process.execPath, original.checks[0].argv, { cwd: omitted })
          .status,
        0,
        "original required check catches loss of the untouched feature",
      );
      if (!f.publicApi)
        await f.orchestrator.launch(next.executionId, { timeoutMs: 1000 });
      assert.match(nextWorker.taskPrompt(), /Review-origin product revision/);
      assert.match(nextWorker.taskPrompt(), /SAME live writer/);
      const fresh = publishRepairedCandidate(f, nextWorker, next, {
        patchPath,
        repairCommand: script,
        oldTree: intent.oldTree,
        rejectedReconstruction: integrationMode === "verify-only",
      });
      fs.appendFileSync(oldComplete, " ");
      assert.throws(
        () => f.host.stageIntegration(next.executionId),
        /old review artifact inventory changed|review|changed/,
      );
      assert.equal(
        fs.existsSync(path.join(next.executionRoot, "integration")),
        false,
      );
      fs.writeFileSync(oldComplete, oldBytes);
      const writerSession = fs.readFileSync(fresh.roleSession, "utf8");
      assert.match(writerSession, /TASK_PI_REVIEW_PRODUCT_BASE_READY/);
      fs.writeFileSync(
        fresh.roleSession,
        writerSession.replace(
          "TASK_PI_REVIEW_PRODUCT_BASE_READY",
          "NOT_BASE_READY",
        ),
      );
      assert.throws(
        () => f.host.stageIntegration(next.executionId),
        /reconstruction|proof|native|capture/,
      );
      assert.equal(
        fs.existsSync(path.join(next.executionRoot, "integration")),
        false,
        "missing native C0 reconstruction must reject before stage intent",
      );
      fs.writeFileSync(fresh.roleSession, writerSession);
      meterMember(
        { contract: next.contract, mailbox: nextWorker.mailbox },
        "worker",
        nextWorker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        0,
        false,
      );
      meterMember(
        { contract: next.contract, mailbox: nextWorker.mailbox },
        "role.repair-launch.repair",
        fresh.roleSession,
        100,
      );
      f.prepared = next;
      f.worker = nextWorker;
      f.native = fresh.native;
      f.status = fresh.status;
      f.saveStatus = fresh.saveStatus;
      if (integrationMode === "approved-integration") {
        const originalUmask = process.umask(0o077);
        sub.after(() => process.umask(originalUmask));
      }
      const checked = await reviewWaveFixture(sub, 1, {
        existing: f,
        tokenBudgetMode: "shared",
        writerEvidence: true,
        nativeReviewRequired: false,
        reviewRunPrefix: "new-review",
        reviewSourcePaths: ["src/alpha space.txt"],
      });
      assert.equal(
        checked.worker.mailbox.readJson(
          "integration/check-content-regression.json",
        ).status,
        "verified",
      );
      assert.equal(
        checked.request.subject.productRevision.oldTree,
        intent.oldTree,
      );
      assert.equal(
        checked.request.subject.productRevision.oldPatchRef,
        intent.oldPatchRef,
      );
      assert.equal(
        checked.request.subject.productRevision.oldCandidateRoot,
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(intent.oldPatchRef), "receipt.json"),
            "utf8",
          ),
        ).cwd,
      );
      assert.equal(
        checked.request.subject.priorBlockedReview.reports.length,
        1,
      );
      assert.ok(
        integrationReviewSchema(checked.request).required.includes(
          "priorResolutions",
        ),
      );
      await checked.host.startIntegrationReview(
        next.executionId,
        checked.wave.key,
        checked.plan.planDigest,
        checked.adapter,
      );
      const newStatus = checked.publish((status) => {
        const step = status.steps[0];
        step.structuredOutput.priorResolutions = {
          "review-one/view-0:0": {
            reason:
              "Changed alpha content to repaired while retaining the original creation behavior; the new regression proves content and the original check proves existence.",
            sourcePaths: ["src/alpha space.txt"],
            checkIds: ["check", "content-regression"],
          },
        };
        status.workflow.value[0].structuredOutput = step.structuredOutput;
        const rows = fs
          .readFileSync(step.sessionFile, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        rows[1].message.content[0].arguments.value = step.structuredOutput;
        fs.writeFileSync(
          step.sessionFile,
          rows.map(JSON.stringify).join("\n") + "\n",
        );
      });
      const fullReport = newStatus.steps[0].structuredOutput;
      assert.doesNotThrow(() =>
        validateReviewReport(checked.request, fullReport),
      );
      const missingCheck = structuredClone(fullReport);
      missingCheck.priorResolutions["review-one/view-0:0"].checkIds = [
        "old-only",
      ];
      assert.throws(
        () => validateReviewReport(checked.request, missingCheck),
        /missing or failed new check/,
      );
      const twoWaveSubject = structuredClone(checked.request.subject);
      twoWaveSubject.priorBlockedReview.reports.push({
        ...twoWaveSubject.priorBlockedReview.reports[0],
        key: "review-two/view-1",
      });
      const twoWaveRequest = {
        ...checked.request,
        subject: twoWaveSubject,
        digest: digest(twoWaveSubject),
      };
      const missingSecond = structuredClone(fullReport);
      missingSecond.requestDigest = twoWaveRequest.digest;
      assert.throws(
        () => validateReviewReport(twoWaveRequest, missingSecond),
        /review fields changed/,
      );
      meterMember(
        { contract: next.contract, mailbox: nextWorker.mailbox },
        `review.${checked.wave.key}.view-0`,
        newStatus.steps[0].sessionFile,
        100,
        false,
      );
      assert.equal(
        (
          await checked.host.collectIntegrationReview(
            next.executionId,
            checked.wave.key,
            checked.plan.planDigest,
          )
        ).verdict,
        "pass",
      );
      await checked.host.sealIntegrationReview(next.executionId);
      if (integrationMode === "approved-integration") {
        assert.throws(
          () => checked.host.runChecks(next.executionId),
          /approved-integration.*apply.*before.*checks/i,
        );
        const plan = checked.host.prepareIntegrationApply(next.executionId);
        const application = await checked.host.applyIntegration(
          next.executionId,
          plan.planDigest,
          () => true,
        );
        assert.equal(application.status, "applied");
        await checked.host.readAppliedIntegrationReview(
          next.executionId,
          plan.planDigest,
        );
        assert.equal(checked.host.runChecks(next.executionId).length, 2);
      }
      let accepted;
      if (f.publicApi) {
        const event = await f.publicApi.call("team_task_accept", {
          execution_id: next.executionId,
        });
        assert.equal(event.isError, false, JSON.stringify(event.result));
        accepted = event.result.details;
      } else accepted = await checked.host.accept(next.executionId);
      assert.equal(
        accepted.receipt.schemaVersion,
        integrationMode === "approved-integration"
          ? "teams-task-acceptance/2"
          : "teams-task-acceptance/3",
      );
      assert.equal(
        accepted.receipt.finalEvidence.productRevision.schemaVersion,
        "teams-review-product-lineage/1",
      );
      assert.equal(
        accepted.receipt.finalEvidence.productRevision.oldTree,
        intent.oldTree,
      );
      assert.equal(
        accepted.receipt.finalEvidence.productRevision.repairedTree,
        git(temp, "write-tree"),
      );
      assert.equal(
        f.orchestrator.ledger.getAcceptance(revisionInput.previousExecutionId),
        null,
      );
      assert.deepEqual(fs.readFileSync(oldComplete), oldBytes);
      const { createGoalGuard } = await import("../goal-guard.mjs");
      const guard = createGoalGuard(f.orchestrator, f.source);
      const gate = await guard.beforeTaskCompletion({
        goalId: "goal",
        taskId: "task",
      });
      assert.equal(gate.ok, true);
      if (f.publicApi) {
        const corrected = await observePublicTaskEvents(
          f.root,
          f.source,
          f.publicApi.events,
          "corrected",
        );
        assert.equal(
          corrected.stopReason,
          "goal-paused",
          JSON.stringify(corrected.faults),
        );
        assert.deepEqual(
          corrected.faults.map((row) => row.disposition),
          ["review-seal-input", "pre-dispatch-input"],
        );
        assert.deepEqual(corrected.executionIds, [
          revisionInput.previousExecutionId,
          next.executionId,
        ]);
        // An intentionally duplicated, known-completed revision is NOT a draft
        // correction. Its real native error must stop the observer and reserve nothing.
        const duplicate = await f.publicApi.call("team_task_revise", {
          previous_execution_id: revisionInput.previousExecutionId,
          expected_previous_result_digest:
            revisionInput.expectedPreviousResultDigest,
          origin: "blocked-review",
          additional_checks: [],
          review_failure_ref: oldComplete,
          review_failure_sha256: revisionInput.reviewFailureSha256,
          repair_reason: revisionInput.repairReason,
        });
        assert.equal(duplicate.isError, true);
        assert.equal(duplicate.result.details?.rejection, undefined);
        const stopped = await observePublicTaskEvents(
          f.root,
          f.source,
          f.publicApi.events,
          "duplicate",
        );
        assert.equal(stopped.stopReason, "task-tool-failure");
        assert.equal(
          f.orchestrator.ledger.listTaskExecutions(
            original.identity.projectId,
            "goal",
            "task",
          ).length,
          2,
        );
      }
    });
});

test("review-origin inventory binds every BLOCKED wave and cannot reserve a second successor", async (t) => {
  const f = await reviewWaveFixture(t, 1, {
    writerEvidence: true,
    stoppedWorker: true,
    tokenBudgetMode: "shared",
    reviewProductRevision: true,
    maxProcessRestarts: 1,
    maxRoleSpawnsPerTask: 5,
    extraOldFeature: true,
    mutateMeter(f) {
      const ctx = { contract: f.prepared.contract, mailbox: f.worker.mailbox };
      for (const [key, file, register] of [
        [
          "worker",
          f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
          false,
        ],
        ["role.launch.lane-0", f.status.steps[0].sessionFile, true],
      ]) {
        const read = measureSessionBytes(fs.readFileSync(file));
        if (register)
          registerTaskBudgetMembers(ctx, [
            { key, estimate: 100, sessionRoot: path.dirname(file) },
          ]);
        const binding = taskBudgetBinding(ctx, key),
          identity = { sessionId: read.sessionId, sessionFile: file };
        for (const change of [
          { type: "bind", ...identity },
          { type: "request", ...identity, used: 0, allowance: 20 },
          { type: "settle", ...identity, used: read.usage.total },
          { type: "finish", ...identity, used: read.usage.total },
        ])
          changeTaskBudget(binding, change);
      }
    },
  });
  async function collectBlocked(view, issue) {
    await f.host.startIntegrationReview(
      f.id,
      view.wave.key,
      view.plan.planDigest,
      view.adapter,
    );
    const status = view.publish((entry) => {
      const step = entry.steps[0];
      step.structuredOutput.verdict = "blocked";
      step.structuredOutput.findings = [
        {
          severity: "blocker",
          issue,
          rationale:
            "Existing check verifies presence only; repair must be independently reviewed.",
          sourcePaths: [
            issue === "alpha" ? "src/alpha space.txt" : "src/beta space.txt",
          ],
        },
      ];
      entry.workflow.value[0].structuredOutput = step.structuredOutput;
      const rows = fs
        .readFileSync(step.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      rows[1].message.content[0].arguments.value = step.structuredOutput;
      fs.writeFileSync(
        step.sessionFile,
        rows.map(JSON.stringify).join("\n") + "\n",
      );
    });
    const ctx = { contract: f.prepared.contract, mailbox: f.worker.mailbox };
    const file = status.steps[0].sessionFile,
      key = `review.${view.wave.key}.view-0`;
    const read = measureSessionBytes(fs.readFileSync(file)),
      binding = taskBudgetBinding(ctx, key);
    const identity = { sessionId: read.sessionId, sessionFile: file };
    for (const change of [
      { type: "bind", ...identity },
      { type: "request", ...identity, used: 0, allowance: 20 },
      { type: "settle", ...identity, used: read.usage.total },
      { type: "finish", ...identity, used: read.usage.total },
    ])
      changeTaskBudget(binding, change);
    assert.equal(
      (
        await f.host.collectIntegrationReview(
          f.id,
          view.wave.key,
          view.plan.planDigest,
        )
      ).verdict,
      "blocked",
    );
  }
  await collectBlocked(f, "alpha");
  const second = await reviewWaveFixture(t, 1, {
    existing: f,
    tokenBudgetMode: "shared",
    writerEvidence: true,
    reviewKey: "review-two",
    reviewRunPrefix: "different-review",
    reviewSourcePaths: ["src/beta space.txt"],
  });
  await collectBlocked(second, "beta");
  const firstComplete = path.join(
    f.worker.mailbox.root,
    "integration/reviews/review-one/complete.json",
  );
  f.orchestrator.requestCancel(f.id, "preserve both product blockers");
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr.closeIdle = (paneId) => ({
    paneId,
    disposition: "closed",
  });
  assert.equal(f.orchestrator.reconcile(f.id).execution.reservationOpen, false);
  const spec = {
    ...f.prepared.contract,
    goalId: "goal",
    taskId: "task",
    taskRevision: 2,
  };
  const input = {
    previousExecutionId: f.id,
    expectedPreviousResultDigest: digest(f.worker.mailbox.listResults().at(-1)),
    reviewFailureRef: firstComplete,
    reviewFailureSha256: f.worker.mailbox.digestRelative(
      "integration/reviews/review-one/complete.json",
    ),
    repairReason:
      "Correct alpha and beta behaviors while retaining both originally requested capabilities.",
  };
  const next = await f.orchestrator.prepareReviewProductRevision(spec, input);
  const { Mailbox } = await import("../mailbox.mjs");
  const intent = Mailbox.open(next.executionRoot, next.executionId).readJson(
    "receipts/repair-intent.json",
  );
  assert.deepEqual(
    intent.waves.map((row) => row.key),
    ["review-one", "review-two"],
  );
  assert.deepEqual(
    intent.waves.flatMap((row) => row.findings.map((finding) => finding.id)),
    ["review-one/view-0:0", "review-two/view-0:0"],
  );
  await assert.rejects(
    f.orchestrator.prepareReviewProductRevision(spec, input),
    /successor|active|reserved|latest|revision|already/i,
  );
});

test("review-origin rejects a captured needs-user report even when its aggregate wave is BLOCKED", async (t) => {
  function meter(f, key, file, register = true) {
    const context = {
      contract: f.prepared.contract,
      mailbox: f.worker.mailbox,
    };
    const read = measureSessionBytes(fs.readFileSync(file));
    if (register)
      registerTaskBudgetMembers(context, [
        { key, estimate: 100, sessionRoot: path.dirname(file) },
      ]);
    const binding = taskBudgetBinding(context, key);
    const identity = { sessionId: read.sessionId, sessionFile: file };
    for (const change of [
      { type: "bind", ...identity },
      { type: "request", ...identity, used: 0, allowance: 20 },
      { type: "settle", ...identity, used: read.usage.total },
      { type: "finish", ...identity, used: read.usage.total },
    ])
      changeTaskBudget(binding, change);
  }
  const f = await reviewWaveFixture(t, 1, {
    writerEvidence: true,
    stoppedWorker: true,
    tokenBudgetMode: "shared",
    maxProcessRestarts: 1,
    reviewProductRevision: true,
    mutateMeter(f) {
      meter(
        f,
        "worker",
        f.worker.mailbox.readJson("receipts/boot.json").workerSessionFile,
        false,
      );
      meter(f, "role.launch.lane-0", f.status.steps[0].sessionFile);
    },
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  const status = f.publish((entry) => {
    const step = entry.steps[0];
    step.structuredOutput.verdict = "needs-user";
    step.structuredOutput.findings = [
      {
        severity: "blocker",
        issue: "Cannot distinguish product defect without owner clarification.",
        rationale: "A missing requirement decision cannot be auto-repaired.",
        sourcePaths: ["src/main.txt"],
      },
    ];
    entry.workflow.value[0].structuredOutput = step.structuredOutput;
    const rows = fs
      .readFileSync(step.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    rows[1].message.content[0].arguments.value = step.structuredOutput;
    fs.writeFileSync(
      step.sessionFile,
      rows.map(JSON.stringify).join("\n") + "\n",
    );
  });
  meter(f, `review.${f.wave.key}.view-0`, status.steps[0].sessionFile, false);
  assert.equal(
    (await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest))
      .verdict,
    "blocked",
  );
  f.orchestrator.requestCancel(f.id, "review needs owner clarification");
  f.worker.processControls();
  f.worker.confirmCancelled(0);
  f.orchestrator.herdr.closeIdle = (paneId) => ({
    paneId,
    disposition: "closed",
  });
  assert.equal(f.orchestrator.reconcile(f.id).execution.reservationOpen, false);
  const spec = {
    ...f.prepared.contract,
    goalId: "goal",
    taskId: "task",
    taskRevision: 2,
  };
  const reviewFailureRef = path.join(
    f.worker.mailbox.root,
    "integration/reviews/review-one/complete.json",
  );
  await assert.rejects(
    f.orchestrator.prepareReviewProductRevision(spec, {
      previousExecutionId: f.id,
      expectedPreviousResultDigest: digest(
        f.worker.mailbox.listResults().at(-1),
      ),
      reviewFailureRef,
      reviewFailureSha256: f.worker.mailbox.digestRelative(
        "integration/reviews/review-one/complete.json",
      ),
      repairReason:
        "Do not pretend a needs-user report is a diagnosed product repair.",
    }),
    /needs-user or unknown review is not product revision/,
  );
  assert.equal(
    f.orchestrator.ledger.listTaskExecutions(
      f.prepared.projectId,
      "goal",
      "task",
    ).length,
    1,
    "uncertain review must not reserve a successor",
  );
});

test("product successor uses original absolute deadline and host checks cannot run past it", (t) => {
  const now = Date.now();
  const contract = {
    policy: { deadlineMs: 60000, reviewProductRevision: "within-scope-once" },
    identity: { ownerEpoch: 1 },
  };
  const oldTime = new Date(now - 5000).toISOString();
  const first = {
    executionId: "old",
    projectId: "p",
    goalId: "g",
    taskId: "t",
    taskRevision: 1,
    createdAt: oldTime,
    ownerEpoch: 1,
  };
  const successor = {
    ...first,
    executionId: "new",
    taskRevision: 2,
    createdAt: new Date(now).toISOString(),
  };
  const ledger = {
    listTaskExecutions: () => [first, successor],
    getContract(id) {
      assert.equal(id, "old");
      return contract;
    },
  };
  const intentDeadline = Date.parse(oldTime) + 60000;
  assert.equal(taskDeadlineAt(ledger, successor, contract), intentDeadline);
  assert.ok(taskMemberTimeoutMs(ledger, successor, contract) <= 55000);
  assert.throws(
    () => taskDeadlineAt(ledger, { ...successor, ownerEpoch: 2 }, contract),
    /strictly equal/,
  );
  assert.equal(
    taskDeadlineAt(ledger, successor, { policy: { deadlineMs: 60000 } }),
    Date.parse(successor.createdAt) + 60000,
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "task-deadline-host-check-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "source");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "file.txt"), "unchanged\n");
  const input = {
    cwd,
    sourcePaths: ["file.txt"],
    argv: [process.execPath, "-e", "setTimeout(()=>{},5000)"],
    timeoutMs: 5000,
  };
  assert.throws(
    () =>
      runCheck(input, path.join(root, "expired.json"), {
        hardDeadlineAt: Date.now() - 1,
      }),
    /deadline expired/,
  );
  assert.ok(!fs.existsSync(path.join(root, "expired.json.intent")));
  const start = Date.now();
  const receipt = runCheck(input, path.join(root, "bounded.json"), {
    hardDeadlineAt: start + 900,
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.errorCode, "ETIMEDOUT");
  assert.ok(
    receipt.durationMs < 2500,
    "a 5s check must be killed within the original remaining window",
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "file.txt"), "utf8"),
    "unchanged\n",
  );
});

for (const { tokenBudgetMode, failedRoot, publicSeam = false } of [
  ...["member-hard", "shared"].flatMap((tokenBudgetMode) =>
    [false, true].map((failedRoot) => ({ tokenBudgetMode, failedRoot })),
  ),
  { tokenBudgetMode: "shared", failedRoot: true, publicSeam: true },
])
  test(`parallel Task recovery retains a healthy sibling and completes fresh checks/review/Goal gates (${tokenBudgetMode}, failed root=${failedRoot}${publicSeam ? ", public seam" : ""})`, async (t) => {
    const { RoleController } = await import("../role-controller.mjs");
    const { readRoleLifecycle } = await import("../role-lifecycle.mjs");
    const { measureExecutionUsage, reviewUsageAdmission } = await import(
      "../task-usage.mjs"
    );
    const { createGoalGuard } = await import("../goal-guard.mjs");
    let replacement, healthySha, failedSha, siblingReceipt, gate, control;
    const f = await fixture(
      t,
      ["alpha", "beta"],
      "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('src/alpha space.txt','utf8'),'alpha\\n');a.equal(f.readFileSync('src/beta space.txt','utf8'),'recovered\\n');",
      {
        review: reviewPolicy,
        nativeReviewRequired: false,
        hostedWorkflow: true,
        writerEvidence: true,
        stoppedWorker: true,
        distinctWorkerSessions: true,
        failedMember: 1,
        failedRoot,
        publicEntry: publicSeam,
        publicSeam,
        ...(publicSeam ? { workerAllowedRoles: ["team.implementer"] } : {}),
        tokenBudgetMode,
        maxRoleSpawnsPerTask: 5,
        async beforeResult(x) {
          const { worker, prepared, orchestrator } = x;
          const mailbox = worker.mailbox,
            contract = prepared.contract;
          if (tokenBudgetMode === "shared") {
            const budgetContext = { mailbox, contract };
            meterMember(
              budgetContext,
              "worker",
              mailbox.readJson("receipts/boot.json").workerSessionFile,
              100,
              false,
              false,
            );
            x.status.steps.forEach((step, i) =>
              meterMember(
                budgetContext,
                `role.launch.lane-${i}`,
                step.sessionFile,
                100,
              ),
            );
          }
          healthySha = bytesDigest(fs.readFileSync(x.manifests[0].patchPath));
          failedSha = bytesDigest(
            fs.readFileSync(path.join(x.native, "status.json")),
          );
          gate = createGoalGuard(orchestrator, x.source);
          orchestrator.herdr.closeIdle = (paneId) => ({
            paneId,
            disposition: "closed",
          });
          // A second Task really progresses while this Task contains a failed branch.
          const b = orchestrator.prepare({
            schemaVersion: contract.schemaVersion,
            goalId: contract.identity.goalId,
            taskId: "independent",
            taskRevision: 1,
            objective: "Deliver the independent gamma patch",
            nonGoals: contract.nonGoals,
            workspace: contract.workspace,
            criteria: contract.criteria,
            policy: contract.policy,
            contextRefs: [],
            checks: [
              {
                ...contract.checks[0],
                argv: [
                  "-e",
                  "require('node:assert/strict').equal(require('node:fs').readFileSync('src/gamma.txt','utf8'),'gamma\\n')",
                ],
              },
            ],
          });
          await orchestrator.launch(b.executionId, { timeoutMs: 1000 });
          const bWorker = x.getActiveWorker();
          assert.equal(
            orchestrator.ledger.getExecution(prepared.executionId).state,
            "RUNNING",
          );
          const gamma = path.join(x.root, "gamma-source");
          git(x.root, "clone", "-q", "--no-local", x.source, gamma);
          fs.writeFileSync(path.join(gamma, "src/gamma.txt"), "gamma\n");
          git(gamma, "add", ".");
          const gammaPatch = path.join(x.root, "gamma.patch");
          fs.writeFileSync(
            gammaPatch,
            git(gamma, "diff", "--cached", "--binary", "--full-index", x.base) +
              "\n",
          );
          const bFixture = {
            ...x,
            prepared: b,
            worker: bWorker,
            host: new HostAcceptance({ orchestrator }),
            status: {
              runId: "wave",
              cwd: x.source,
              sessionId: bWorker.workerSessionId,
              state: "complete",
              steps: [structuredClone(x.status.steps[0])],
              usageBudget: {
                version: 1,
                source: "reported",
                exhausted: false,
                tokens: {
                  hard: tokenBudgetMode === "shared" ? 1000 : 100,
                  used: 10,
                  outcome: "within-budget",
                },
              },
              processTerminal: {
                version: 1,
                state: "observed",
                runId: "wave",
                runnerProcessInstanceId: "fixture-instance",
              },
            },
          };
          bFixture.status.steps[0].acceptance.childReport.changedFiles = [
            "src/gamma.txt",
          ];
          const bNative = publishRepairedCandidate(bFixture, bWorker, b, {
            patchPath: gammaPatch,
          });
          const bContext = { mailbox: bWorker.mailbox, contract: b.contract };
          if (tokenBudgetMode === "shared") {
            meterMember(
              bContext,
              "worker",
              bWorker.mailbox.readJson("receipts/boot.json").workerSessionFile,
              100,
              false,
            );
            meterMember(
              bContext,
              "role.repair-launch.repair",
              bNative.roleSession,
              100,
            );
          }
          const rb = await reviewWaveFixture(t, 1, {
            existing: bFixture,
            reviewRunPrefix: "independent",
            tokenBudgetMode,
          });
          if (publicSeam) {
            // Live canary regression: a transposed UUID must not stop either
            // Task or recreate the already produced healthy contribution.
            const tool = "team_task_stage_integration";
            const input = {
              execution_id: "486ecc9d-1305-4e67-aa07-c3ee5b1b443e",
            };
            const rejected = await x.publicApi.call(tool, input);
            assert.equal(rejected.isError, true);
            assert.equal(
              isInputRejection(
                rejected.result.details?.rejection,
                { tool, input },
                tool,
                rejected.toolCallId,
              ),
              true,
            );
            assert.equal(
              orchestrator.ledger.getExecution(prepared.executionId).state,
              "RUNNING",
            );
            assert.equal(
              orchestrator.ledger.getExecution(b.executionId).reservationOpen,
              true,
            );
            const checkedBefore = fs.readFileSync(
              path.join(
                b.executionRoot,
                "integration/check-" + b.contract.checks[0].commandId + ".json",
              ),
            );
            const corrected = await x.publicApi.call(tool, {
              execution_id: b.executionId,
            });
            assert.equal(
              corrected.isError,
              false,
              JSON.stringify(corrected.result),
            );
            assert.deepEqual(
              fs.readFileSync(
                path.join(
                  b.executionRoot,
                  "integration/check-" +
                    b.contract.checks[0].commandId +
                    ".json",
                ),
              ),
              checkedBefore,
            );
          }
          const pb = await rb.host.planIntegrationReview(
            b.executionId,
            rb.wave,
            rb.adapter,
          );
          await rb.host.startIntegrationReview(
            b.executionId,
            pb.key,
            pb.planDigest,
            rb.adapter,
          );
          const bReview = rb.publish();
          if (tokenBudgetMode === "shared")
            meterMember(
              bContext,
              `review.${rb.wave.key}.view-0`,
              bReview.steps[0].sessionFile,
              100,
              false,
            );
          await rb.host.collectIntegrationReview(
            b.executionId,
            pb.key,
            pb.planDigest,
            rb.adapter,
          );
          await rb.host.sealIntegrationReview(b.executionId);
          await rb.host.runChecks(b.executionId);
          if (publicSeam) {
            const accepted = await x.publicApi.call("team_task_accept", {
              execution_id: b.executionId,
            });
            assert.equal(
              accepted.isError,
              false,
              JSON.stringify(accepted.result),
            );
            siblingReceipt = accepted.result.details.receipt;
            const completed = await x.publicApi.call("update_goal_task", {
              task_id: "independent",
              status: "complete",
            });
            assert.equal(
              completed.isError,
              false,
              JSON.stringify(completed.result),
            );
            const disk = x.publicApi.goalFixture.readDisk();
            assert.equal(
              disk.taskList.tasks.find((row) => row.id === "independent")
                .status,
              "complete",
            );
            assert.equal(
              disk.taskList.tasks.find((row) => row.id === "task").status,
              "pending",
            );
            assert.equal(
              (await x.publicApi.call("update_goal", { status: "complete" }))
                .isError,
              true,
            );
            assert.equal(x.publicApi.goalFixture.auditCalls, 0);
          } else {
            siblingReceipt = (await rb.host.accept(b.executionId)).receipt;
            const readyB = await gate.beforeTaskCompletion({
              goalId: contract.identity.goalId,
              taskId: "independent",
            });
            assert.equal(readyB.ok, true);
            await gate.afterTaskCompletion({
              goalId: contract.identity.goalId,
              taskId: "independent",
              evidence: readyB.evidence,
            });
          }
          assert.equal(
            gate.beforeGoalCompletion({ goalId: contract.identity.goalId }).ok,
            false,
          );
          assert.equal(worker.state, "RUNNING");

          const original = readRoleLifecycle(
            mailbox,
            contract,
            worker.workerSessionId,
          )[0];
          const context = {
            mailbox,
            contract,
            result: { childRunRefs: ["wave"] },
            assertOwner() {},
          };
          const prior = reviewUsageAdmission(
            context,
            { members: [], reservedTokens: 0 },
            measureExecutionUsage(context),
            { checkpointOnly: true },
          );
          mailbox.writeReceipt("fixture-role-usage", prior);
          original.usageAdmissionRef = "receipts/fixture-role-usage.json";
          original.usageAdmissionDigest = digest(prior);
          const controlOptions = {
            runtime: worker,
            cwd: x.source,
            resolve: async () => ({
              ok: true,
              contract: { tools: { extensionArgs: [TASK_BUDGET_EXTENSION] } },
            }),
            rpc: {
              async request(method, params) {
                assert.equal(method, "spawn");
                const launch = control.snapshot().launches.at(-1);
                const dir = path.join(x.root, "replacement-native");
                fs.mkdirSync(dir);
                const checkout = path.join(x.root, "replacement-source");
                git(x.root, "clone", "-q", "--no-local", x.source, checkout);
                fs.writeFileSync(
                  path.join(checkout, "src/beta space.txt"),
                  "recovered\n",
                );
                git(checkout, "add", ".");
                const patchPath = path.join(dir, "fixed.patch");
                fs.writeFileSync(
                  patchPath,
                  git(
                    checkout,
                    "diff",
                    "--cached",
                    "--binary",
                    "--full-index",
                    x.base,
                  ) + "\n",
                );
                const handoff = structuredClone(x.manifests[1].value);
                handoff.runId = "replacement-leaf";
                handoff.groups[0].children[0].patch.path = patchPath;
                const manifest = path.join(dir, "handoff.json");
                fs.writeFileSync(manifest, JSON.stringify(handoff));
                const row = {
                  key: "replacement",
                  ok: true,
                  runId: "replacement-leaf",
                  artifactPaths: [manifest],
                };
                const status = {
                  runId: "replacement-wave",
                  sessionId: worker.workerSessionId,
                  cwd: x.source,
                  state: "complete",
                  workflow: { value: [row] },
                  steps: [
                    {
                      ...structuredClone(x.status.steps[0]),
                      workflowKey: row.key,
                      runId: row.runId,
                      sessionFile: meteredSession(
                        path.join(
                          params.sessionDir,
                          ...(tokenBudgetMode === "shared"
                            ? ["replacement"]
                            : []),
                          "leaf.jsonl",
                        ),
                        row.runId,
                        x.source,
                      ),
                    },
                  ],
                };
                if (tokenBudgetMode === "shared")
                  meterMember(
                    { mailbox, contract },
                    `role.${launch.launchId}.replacement`,
                    status.steps[0].sessionFile,
                    100,
                    false,
                  );
                status.steps[0].acceptance.childReport.changedFiles = [
                  "src/beta space.txt",
                ];
                asHostedStatus(status, launch.hostedWorkflow);
                fs.writeFileSync(
                  path.join(dir, "status.json"),
                  JSON.stringify(status),
                );
                fs.writeFileSync(
                  path.join(dir, "workflow-receipt.json"),
                  JSON.stringify({
                    version: 1,
                    workflowRunId: status.runId,
                    state: "complete",
                    entries: {
                      replacement: {
                        key: row.key,
                        agent: "team.implementer",
                        latestRunId: row.runId,
                        continuation: { runIds: [row.runId] },
                      },
                    },
                  }),
                );
                return { runId: status.runId, asyncDir: dir };
              },
            },
          };
          if (publicSeam) {
            const inspected = await x.publicWorker.call("team_role_control", {
              action: "status",
            });
            assert.equal(
              inspected.isError,
              false,
              JSON.stringify(inspected.result),
            );
            control = x.publicWorker.controller;
            // Controlled native predecessor and preflight producer, not a
            // replacement of tool routing, branch guards or dispatch logic.
            control.resolve = controlOptions.resolve;
            x.publicWorker.setRpc(controlOptions.rpc.request);
          } else control = new RoleController(controlOptions);
          control.launches.set(original.launchId, original);
          control.memberCount = original.members.length;
          control.reservedTokens = original.maxTokens;
          const repair = {
            action: "repair",
            runId: "wave",
            key: "lane-1",
            reason: "Beta emits the wrong value; alpha already succeeds.",
            task: "Fix beta and check its value; retain alpha unchanged.",
            maxTokens: 100,
          };
          await assert.rejects(
            control.control({ ...repair, runId: "another-task" }),
            /not owned/,
          );
          const oldStatusFile = path.join(x.native, "status.json"),
            oldBytes = fs.readFileSync(oldStatusFile);
          for (const change of [
            ...[
              "interrupted",
              "stopped",
              "turnBudgetExceeded",
              "toolBudgetBlocked",
              "detached",
            ].map((flag) => (s) => {
              s.steps[1].exitCode = 0;
              Object.assign(s.workflow.value[1].nativeResults[0], {
                exitCode: 0,
                [flag]: true,
              });
            }),
            (s) => {
              s.workflow.value[1].nativeResults[0].processSignal = "SIGTERM";
            },
            (s) => {
              s.workflow.value[1].nativeResults[0].timedOut = true;
            },
            (s) => {
              s.steps[1].exitCode = null;
              s.workflow.value[1].nativeResults[0].exitCode = null;
            },
          ]) {
            const altered = JSON.parse(oldBytes);
            change(altered);
            fs.writeFileSync(oldStatusFile, JSON.stringify(altered));
            await assert.rejects(
              control.control(repair),
              /effects need reconciliation/,
            );
            fs.writeFileSync(oldStatusFile, oldBytes);
            assert.equal(
              control.snapshot().launches.length,
              1,
              "no replacement admitted for unknown effects",
            );
          }
          const reportOnly = JSON.parse(oldBytes);
          const reportAcceptance = {
            ...reportOnly.steps[1].acceptance,
            childReportParseError:
              "Invalid report shape; preserve existing implementation.",
          };
          reportOnly.steps[1].acceptance = reportAcceptance;
          reportOnly.workflow.value[1].nativeResults[0].acceptance =
            reportAcceptance;
          fs.writeFileSync(oldStatusFile, JSON.stringify(reportOnly));
          await assert.rejects(control.control(repair), /report-only.*replay/);
          assert.equal(
            control.snapshot().launches.length,
            1,
            "report parsing cannot authorize a replacement",
          );
          fs.writeFileSync(oldStatusFile, oldBytes);
          if (publicSeam) {
            const event = await x.publicWorker.call("team_role_control", {
              action: repair.action,
              run_id: repair.runId,
              key: repair.key,
              reason: repair.reason,
              task: repair.task,
              max_tokens: repair.maxTokens,
            });
            assert.equal(event.isError, false, JSON.stringify(event.result));
            replacement = event.result.details;
            assert.equal(event.result.terminate, true);
          } else replacement = await control.control(repair);
          control.refreshTerminals();
          assert.equal(control.snapshot().unresolvedRunCount, 0);
          await assert.rejects(control.control(repair), /already replaced/);
          await assert.rejects(
            control.control({
              ...repair,
              runId: replacement.runId,
              key: "replacement",
            }),
            /allowance exhausted/,
          );
          assert.equal(
            bytesDigest(fs.readFileSync(x.manifests[0].patchPath)),
            healthySha,
          );
          assert.equal(
            bytesDigest(fs.readFileSync(path.join(x.native, "status.json"))),
            failedSha,
          );
          assert.equal(
            orchestrator.ledger.getExecution(b.executionId).state,
            "ACCEPTED",
          );
        },
      },
    );
    const id = f.prepared.executionId;
    const budgetContext = {
      mailbox: f.worker.mailbox,
      contract: f.prepared.contract,
    };
    if (tokenBudgetMode === "shared" && !publicSeam) {
      const boot = f.worker.mailbox.readJson("receipts/boot.json");
      changeTaskBudget(taskBudgetBinding(budgetContext, "worker"), {
        type: "finish",
        sessionId: boot.workerSessionId,
        sessionFile: boot.workerSessionFile,
        used: 10,
      });
    }
    const reviewed = await reviewWaveFixture(t, 1, {
      existing: f,
      reviewRunPrefix: "recovered",
      tokenBudgetMode,
    });
    assert.ok(reviewed.request.subject.branchRecovery);
    const staged = f.worker.mailbox.readJson("integration/receipt.json");
    assert.deepEqual(
      staged.lanes.map((row) => row.key),
      ["lane-0", "replacement"],
    );
    assert.equal(f.status.steps[1].status, "failed");
    const plan = await f.host.planIntegrationReview(
      id,
      reviewed.wave,
      reviewed.adapter,
    );
    await f.host.startIntegrationReview(
      id,
      plan.key,
      plan.planDigest,
      reviewed.adapter,
    );
    const finalReview = reviewed.publish();
    if (tokenBudgetMode === "shared")
      meterMember(
        budgetContext,
        `review.${reviewed.wave.key}.view-0`,
        finalReview.steps[0].sessionFile,
        100,
        false,
      );
    await f.host.collectIntegrationReview(
      id,
      plan.key,
      plan.planDigest,
      reviewed.adapter,
    );
    await f.host.sealIntegrationReview(id);
    await f.host.runChecks(id);
    let receipt;
    if (publicSeam) {
      const checked = await f.publicApi.call("team_task_run_checks", {
        execution_id: id,
      });
      assert.equal(checked.isError, false, JSON.stringify(checked.result));
      const accepted = await f.publicApi.call("team_task_accept", {
        execution_id: id,
      });
      assert.equal(accepted.isError, false, JSON.stringify(accepted.result));
      receipt = accepted.result.details.receipt;
    } else ({ receipt } = await f.host.accept(id));
    assert.equal(receipt.schemaVersion, "teams-task-acceptance/3");
    assert.notEqual(receipt.acceptanceId, siblingReceipt.acceptanceId);
    const usage = receipt.finalEvidence.usage;
    assert.equal(usage.spawnCount, 4); // BOTH original children + replacement + final reviewer.
    assert.equal(usage.sources.filter((row) => row.kind === "leaf").length, 3);
    assert.equal(usage.totals.total, 50); // failed child's 10 tokens remain charged.
    const goalId = f.prepared.contract.identity.goalId;
    if (publicSeam) {
      const completed = await f.publicApi.call("update_goal_task", {
        task_id: "task",
        status: "complete",
      });
      assert.equal(completed.isError, false, JSON.stringify(completed.result));
      assert.equal(
        f.orchestrator.ledger.getExecution(id).goalCommitState,
        "committed",
      );
      assert.equal(
        f.orchestrator.ledger.getExecution(id).reservationOpen,
        false,
      );
      const readback = await f.publicApi.call("get_goal", { verbose: true });
      assert.ok(
        readback.result.details.goal.taskList.tasks.every(
          (task) =>
            task.status === "complete" &&
            task.evidence.startsWith("task-runtime:"),
        ),
      );
      const goal = await f.publicApi.call("update_goal", {
        status: "complete",
      });
      assert.equal(goal.isError, false, JSON.stringify(goal.result));
      assert.equal(goal.result.details.goal.status, "complete");
      assert.equal(f.publicApi.goalFixture.readDisk().status, "complete");
      assert.equal(
        f.publicApi.goalFixture.auditCalls,
        1,
        "controlled auditor ran, not audit-skip",
      );
    } else {
      const ready = await gate.beforeTaskCompletion({ goalId, taskId: "task" });
      await gate.afterTaskCompletion({
        goalId,
        taskId: "task",
        evidence: ready.evidence,
      });
    }
    assert.equal(gate.beforeGoalCompletion({ goalId }).ok, true);
    assert.equal(git(f.source, "status", "--porcelain"), "");
  });

test("L0 readback rejects Worker role evidence outside its restricted subset", async (t) => {
  // Deliberately inject a native-format writer in the fixture, bypassing admission.
  // Total Task/L0 roles still include this writer; only the Worker restriction rejects it.
  const f = await reviewWaveFixture(t, 1, {
    workerAllowedRoles: ["team.reviewer"],
    stoppedWorker: true,
    hostedWorkflow: true,
    writerEvidence: true,
    nativeReviewRequired: false,
  });
  await f.host.startIntegrationReview(
    f.id,
    f.wave.key,
    f.plan.planDigest,
    f.adapter,
  );
  f.publish();
  await f.host.collectIntegrationReview(f.id, f.wave.key, f.plan.planDigest);
  await f.host.sealIntegrationReview(f.id);
  await f.host.runChecks(f.id);
  await assert.rejects(
    async () => f.host.accept(f.id),
    /native Worker role outside approved policy/,
  );
});

test("public execution selector preserves known-row loss and lookup IO as hard failures", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    publicEntry: true,
    stoppedWorker: true,
    review: reviewPolicy,
  });
  for (const known of [true, false]) {
    const selected = known
      ? f.prepared.executionId
      : "486ecc9d-1305-4e67-aa07-c3ee5b1b443e";
    // Controlled read faults only: do not delete a real row or change SQL safety.
    const exists = t.mock.method(f.orchestrator.ledger, "hasExecution", () => {
      if (!known) throw new Error("fixture ledger read EIO");
      return false;
    });
    const get = t.mock.method(f.orchestrator.ledger, "getExecution", () => {
      throw new Error(`execution not found: ${selected}`);
    });
    let event;
    try {
      event = await f.publicApi.call("team_task_status", {
        execution_id: selected,
      });
    } finally {
      exists.mock.restore();
      get.mock.restore();
    }
    assert.equal(event.isError, true);
    assert.equal(
      event.result.details?.rejection,
      undefined,
      "known dispatch loss or failed lookup is not a spelling correction",
    );
    assert.match(
      JSON.stringify(event.result),
      known ? /execution not found/ : /fixture ledger read EIO/,
    );
  }
});

test("public Goal hooks block closed failed Tasks and bind the native session Goal, not foreign reservations", async (t) => {
  const f = await fixture(t, ["alpha"], undefined, {
    publicEntry: true,
    stoppedWorker: true,
    review: reviewPolicy,
  });
  const cancelled = await f.publicApi.call("team_task_cancel", {
    execution_id: f.prepared.executionId,
    reason: "Fixture completed failure; no blind retry.",
  });
  assert.equal(cancelled.isError, false);
  assert.equal(
    f.orchestrator.ledger.getExecution(f.prepared.executionId).reservationOpen,
    false,
  );
  const invoke = (name, args) =>
    f.publicApi.agent.beforeToolCall({
      toolCall: { name, id: `goal-${name}` },
      args,
    });
  const complete = {
    task_id: "task",
    status: "complete",
    evidence: "not a receipt",
  };
  const blocked = await invoke("update_goal_task", complete);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /AcceptanceReceipt/);
  assert.equal(
    (await invoke("update_goal", { status: "complete" })).block,
    true,
  );
  assert.equal(
    (await invoke("update_goal_task", { updates: [complete] })).block,
    true,
  );
  f.publicApi.setGoalFocus("unrelated-goal");
  assert.equal(await invoke("update_goal_task", complete), undefined);
  assert.equal(await invoke("update_goal", { status: "complete" }), undefined);
  f.publicApi.setGoalFocus(null);
  assert.equal((await invoke("update_goal_task", complete)).block, true);
  // Only public before-tool hooks ran: no real Goal task was completed.
});
