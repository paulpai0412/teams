import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalBytes,
  digest,
  validateEvent,
  validateTaskContract,
  validateTaskResult,
} from "./contracts.mjs";
import { RuntimeLedger } from "./ledger.mjs";
import { Mailbox } from "./mailbox.mjs";
import { measureClosedExecutionUsage } from "./task-usage.mjs";
import { captureWorkspace, verifyWorkspaceResult } from "./workspace-scope.mjs";
import {
  readRoleLifecycle,
  readReviewLifecycle,
  captureNativeTerminal,
  processStartTicks,
} from "./role-lifecycle.mjs";

export function deriveProjectId(sourceRoot) {
  const canonical = fs.realpathSync(path.resolve(sourceRoot));
  return `p-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `timed out waiting for ${path.basename(file)}; execution requires reconciliation`,
  );
}

export function processTerminalProof(boot) {
  if (
    !Number.isSafeInteger(boot?.processId) ||
    boot.processId <= 0 ||
    typeof boot.processStartedAtTicks !== "string" ||
    !/^\d+$/.test(boot.processStartedAtTicks)
  )
    return { terminal: false, reason: "missing-process-identity" };
  try {
    const stat = fs.readFileSync(`/proc/${boot.processId}/stat`, "utf8");
    const current = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    return current === boot.processStartedAtTicks
      ? { terminal: false, reason: "worker-process-alive" }
      : { terminal: true, reason: "pid-reused" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return { terminal: true, reason: "process-exited" };
    return {
      terminal: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
      "bounded regular JSON required",
    );
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`invalid runtime JSON: ${file}`, { cause });
  }
}

function readWorkerBoot(mailbox, execution, contract) {
  const boot = mailbox.readJson("receipts/boot.json", 16 * 1024);
  const bootstrap = mailbox.readJson("bootstrap.json", 16 * 1024);
  assert.equal(boot.schemaVersion, "teams-task-boot/1");
  assert.equal(
    boot.executionId,
    execution.executionId,
    "boot execution mismatch",
  );
  assert.equal(boot.ownerEpoch, execution.ownerEpoch, "boot epoch mismatch");
  assert.equal(
    boot.requestDigest,
    execution.requestDigest,
    "boot request mismatch",
  );
  assert.equal(
    boot.launchNonce,
    bootstrap.launchNonce,
    "boot launch nonce mismatch",
  );
  assert.equal(
    boot.cwd,
    contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
    "boot cwd mismatch",
  );
  assert.ok(
    typeof boot.workerSessionId === "string" && boot.workerSessionId,
    "boot Worker identity missing",
  );
  if (execution.workerSessionId)
    assert.equal(
      boot.workerSessionId,
      execution.workerSessionId,
      "boot Worker mismatch",
    );
  return boot;
}

export class TaskOrchestrator {
  constructor({ runtimeRoot, ownerSessionId, herdr = null }) {
    assert.ok(path.isAbsolute(runtimeRoot), "absolute runtimeRoot required");
    assert.ok(
      typeof ownerSessionId === "string" && ownerSessionId.trim(),
      "ownerSessionId required",
    );
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.ownerSessionId = ownerSessionId;
    this.instanceId = randomUUID();
    this.admittedExecutions = new Set();
    this.closed = false;
    this.herdr = herdr;
    fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    this.ledger = new RuntimeLedger(
      path.join(this.runtimeRoot, "ledger.sqlite"),
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const executionId of this.admittedExecutions) {
        const execution = this.ledger.getExecution(executionId);
        if (!execution.reservationOpen) continue;
        const mailbox = Mailbox.open(
          path.join(
            this.runtimeRoot,
            "projects",
            execution.projectId,
            "executions",
            executionId,
          ),
          executionId,
        );
        mailbox.writeReceipt("controller-ended", {
          executionId,
          instanceId: this.instanceId,
          ownerSessionId: this.ownerSessionId,
        });
      }
      this.ledger.releaseOwnedControllers(this.ownerSessionId);
    } finally {
      this.ledger.close();
    }
  }

  assertController(projectId) {
    const controller = this.ledger.getController(projectId);
    assert.equal(
      controller?.ownerSessionId,
      this.ownerSessionId,
      "controller ownership changed; reconcile before acting",
    );
    return controller;
  }

  prepareTakeover(executionId) {
    const execution = this.ledger.getExecution(executionId);
    const controller = this.ledger.getController(execution.projectId);
    assert.ok(
      controller,
      `project controller not found: ${execution.projectId}`,
    );
    const openExecutions = this.ledger
      .listOpen(execution.projectId)
      .map((item) => {
        let pane = null;
        if (this.herdr && item.paneId) {
          try {
            pane = this.herdr.status(item.paneId);
          } catch (error) {
            pane = {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        return {
          executionId: item.executionId,
          goalId: item.goalId,
          taskId: item.taskId,
          state: item.state,
          revision: item.revision,
          paneId: item.paneId,
          workerSessionId: item.workerSessionId,
          pane,
        };
      });
    const proof = {
      schemaVersion: "teams-controller-takeover/1",
      projectId: execution.projectId,
      previousOwnerSessionId: controller.ownerSessionId,
      previousOwnerEpoch: controller.ownerEpoch,
      nextOwnerSessionId: this.ownerSessionId,
      openExecutions,
      createdAt: new Date().toISOString(),
      requiresUserConfirmation: true,
    };
    const directory = path.join(this.runtimeRoot, "recovery");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const proofRef = path.join(directory, `takeover-${randomUUID()}.json`);
    fs.writeFileSync(
      proofRef,
      Buffer.concat([canonicalBytes(proof), Buffer.from("\n")]),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return { proofRef, proof, proofDigest: digest(proof) };
  }

  takeover(projectId, expectedOwnerSessionId, expectedOwnerEpoch, proofRef) {
    const recoveryRoot = path.join(this.runtimeRoot, "recovery");
    const canonicalProof = fs.realpathSync(proofRef);
    assert.ok(
      canonicalProof.startsWith(`${fs.realpathSync(recoveryRoot)}${path.sep}`),
      "takeover proof escapes recovery root",
    );
    const proof = readJson(canonicalProof);
    assert.equal(
      proof.schemaVersion,
      "teams-controller-takeover/1",
      "invalid takeover proof",
    );
    assert.equal(proof.projectId, projectId, "takeover project mismatch");
    assert.equal(
      proof.previousOwnerSessionId,
      expectedOwnerSessionId,
      "takeover owner mismatch",
    );
    assert.equal(
      proof.previousOwnerEpoch,
      expectedOwnerEpoch,
      "takeover epoch mismatch",
    );
    assert.equal(
      proof.nextOwnerSessionId,
      this.ownerSessionId,
      "takeover successor mismatch",
    );
    assert.equal(
      proof.requiresUserConfirmation,
      true,
      "takeover proof lacks confirmation gate",
    );
    return this.ledger.takeoverController(
      projectId,
      this.ownerSessionId,
      expectedOwnerSessionId,
      expectedOwnerEpoch,
      canonicalProof,
    );
  }

  commitTakeover(proofRef) {
    const proof = readJson(proofRef);
    return this.takeover(
      proof.projectId,
      proof.previousOwnerSessionId,
      proof.previousOwnerEpoch,
      proofRef,
    );
  }

  prepare(spec) {
    assert.ok(
      spec && typeof spec === "object" && !Array.isArray(spec),
      "task specification required",
    );
    const id = deriveProjectId(spec.workspace?.sourceRoot);
    const owner = this.ledger.claimController(id, this.ownerSessionId);
    const executionId = randomUUID();
    const contract = validateTaskContract({
      schemaVersion: spec.schemaVersion ?? "teams-task-runtime/2",
      identity: {
        projectId: id,
        goalId: spec.goalId,
        taskId: spec.taskId,
        taskRevision: spec.taskRevision,
        executionId,
        ownerEpoch: owner.ownerEpoch,
      },
      objective: spec.objective,
      nonGoals: spec.nonGoals,
      workspace: spec.workspace,
      criteria: spec.criteria,
      checks: spec.checks,
      policy:
        spec.schemaVersion === "teams-task-runtime/3"
          ? {
              ...spec.policy,
              tokenBudgetMode: spec.policy.tokenBudgetMode ?? "shared",
            }
          : spec.policy,
      contextRefs: spec.contextRefs,
    });
    const requestDigest = digest(contract);
    const workspaceBaseline =
      contract.schemaVersion === "teams-task-runtime/3"
        ? captureWorkspace(contract, this.runtimeRoot)
        : null;
    const controller = workspaceBaseline
      ? {
          ownerSessionId: this.ownerSessionId,
          instanceId: this.instanceId,
          processId: process.pid,
          processStartedAtTicks: processStartTicks(process.pid),
        }
      : null;
    if (controller)
      assert.match(
        controller.processStartedAtTicks ?? "",
        /^\d+$/,
        "L0 process identity unavailable",
      );
    const prior = this.ledger.findLatestTask(id, spec.goalId, spec.taskId);
    let priorUsage = null;
    if (workspaceBaseline) {
      const history = this.ledger.listTaskExecutions(
        id,
        spec.goalId,
        spec.taskId,
      );
      assert.ok(
        history.length <= contract.policy.maxProcessRestarts,
        "task process restart budget exhausted",
      );
      if (prior) {
        const oldContract = this.ledger.getContract(prior.executionId);
        assert.equal(
          oldContract.schemaVersion,
          "teams-task-runtime/3",
          "previous execution usage schema unavailable",
        );
        const previousMailbox = Mailbox.open(
          path.join(
            this.runtimeRoot,
            "projects",
            id,
            "executions",
            prior.executionId,
          ),
          prior.executionId,
        );
        priorUsage = measureClosedExecutionUsage({
          mailbox: previousMailbox,
          contract: oldContract,
          execution: prior,
          ownerSessionId: prior.ownerSessionId,
          assertOwner: () => {
            this.assertController(id);
            const current = this.ledger.getExecution(prior.executionId);
            assert.ok(
              !current.reservationOpen &&
                ["ACCEPTED", "CANCELLED", "FAILED", "REJECTED"].includes(
                  current.state,
                ),
              "previous execution still has an open reservation or unknown usage",
            );
            assert.equal(
              current.requestDigest,
              digest(oldContract),
              "previous usage contract changed",
            );
            assert.equal(
              current.revision,
              prior.revision,
              "previous execution changed during usage capture",
            );
          },
          assertStopped: (boot) =>
            assert.equal(
              processTerminalProof(boot).terminal,
              true,
              "previous Worker usage is not terminal",
            ),
        });
        assert.ok(
          priorUsage.totals.total < contract.policy.maxTaskTokens,
          "cumulative task token budget exhausted",
        );
      }
    }
    this.ledger.reserve(contract, requestDigest, this.ownerSessionId);
    const mailbox = Mailbox.create(this.runtimeRoot, id, executionId);
    mailbox.sealContract(contract);
    if (priorUsage)
      mailbox.writeJson("receipts/prior-usage.json", priorUsage, 1024 * 1024);
    if (workspaceBaseline)
      mailbox.writeReceipt("workspace-baseline", workspaceBaseline);
    const launchNonce = randomUUID();
    if (workspaceBaseline) this.admittedExecutions.add(executionId);
    mailbox.writeBootstrap({
      schemaVersion: "teams-task-bootstrap/1",
      executionId,
      ownerEpoch: owner.ownerEpoch,
      requestDigest,
      launchNonce,
      priorExecutionId: prior?.executionId ?? null,
      ...(priorUsage ? { priorUsageDigest: digest(priorUsage) } : {}),
      ...(controller ? { controller } : {}),
      ...(workspaceBaseline
        ? { workspaceBaselineDigest: digest(workspaceBaseline) }
        : {}),
      contractRef: "task-request.json",
    });
    if (contract.policy.tokenBudgetMode === "shared")
      this.ledger.createTaskPool(
        executionId,
        requestDigest,
        priorUsage?.totals.total ?? 0,
        path.join(mailbox.root, "worker-sessions"),
      );
    return {
      executionId,
      projectId: id,
      ownerEpoch: owner.ownerEpoch,
      requestDigest,
      launchNonce,
      executionRoot: mailbox.root,
      contract,
    };
  }

  async launch(executionId, { timeoutMs = 30_000 } = {}) {
    let execution = this.ledger.getExecution(executionId);
    const { contract, mailbox } = this.assertControllerAdmission(execution);
    if (execution.state === "RUNNING")
      return { ...execution, disposition: "already-running" };
    assert.equal(
      execution.state,
      "RESERVED",
      "only a reserved execution can launch",
    );
    assert.ok(
      this.herdr && typeof this.herdr.start === "function",
      "Herdr adapter required",
    );
    execution = this.ledger.transition(
      executionId,
      "RESERVED",
      execution.revision,
      "SPAWNING",
    );
    const rememberPane = (paneId) => {
      const current = this.ledger.getExecution(executionId);
      this.assertExecutionOwner(current);
      if (current.paneId === paneId) return current;
      assert.ok(
        ["SPAWNING", "CANCEL_REQUESTED", "UNKNOWN"].includes(current.state),
        "launch state changed before pane binding",
      );
      return this.ledger.attachPane(executionId, current.revision, paneId);
    };
    try {
      const started = await this.herdr.start({
        onPane: rememberPane,
        executionId,
        executionRoot: mailbox.root,
        cwd: contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
        deadlineMs: contract.policy.deadlineMs,
      });
      execution = rememberPane(started.paneId);
      if (execution.state !== "SPAWNING")
        return { ...execution, disposition: "launch-not-granted" };
      const bootPath = path.join(mailbox.root, "receipts", "boot.json");
      await waitForFile(bootPath, timeoutMs);
      execution = this.ledger.getExecution(executionId);
      this.assertExecutionOwner(execution);
      if (execution.state !== "SPAWNING")
        return { ...execution, disposition: "launch-not-granted" };
      this.assertControllerAdmission(execution);
      const boot = readWorkerBoot(mailbox, execution, contract);
      execution = this.ledger.bindWorker(
        executionId,
        execution.revision,
        boot.workerSessionId,
      );
      mailbox.writeCommand({
        schemaVersion: "teams-task-control/1",
        commandId: `grant-${executionId}`,
        executionId,
        ownerEpoch: execution.ownerEpoch,
        requestDigest: execution.requestDigest,
        type: "grant",
        payload: {},
      });
      const boundPath = path.join(mailbox.root, "receipts", "bound.json");
      await waitForFile(boundPath, timeoutMs);
      const bound = readJson(boundPath);
      assert.equal(
        bound.workerSessionId,
        execution.workerSessionId,
        "bound worker mismatch",
      );
      assert.equal(
        bound.requestDigest,
        execution.requestDigest,
        "bound request mismatch",
      );
      this.ingestEvents(mailbox);
      execution = this.ledger.getExecution(executionId);
      this.assertExecutionOwner(execution);
      if (execution.state !== "SPAWNING")
        return { ...execution, disposition: "launch-not-granted" };
      execution = this.ledger.transition(
        executionId,
        "SPAWNING",
        execution.revision,
        "RUNNING",
      );
      return { ...execution, disposition: "launched" };
    } catch (error) {
      const current = this.ledger.getExecution(executionId);
      if (current.state === "SPAWNING")
        this.ledger.transition(
          executionId,
          "SPAWNING",
          current.revision,
          "UNKNOWN",
        );
      throw error;
    }
  }

  assertControllerAdmission(execution) {
    this.assertExecutionOwner(execution);
    const contract = this.ledger.getContract(execution.executionId);
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        execution.executionId,
      ),
      execution.executionId,
    );
    if (contract.schemaVersion === "teams-task-runtime/3") {
      const bootstrap = mailbox.readJson("bootstrap.json");
      assert.ok(
        !this.closed &&
          !fs.existsSync(
            path.join(mailbox.root, "receipts/controller-ended.json"),
          ),
        "L0 session admission ended",
      );
      assert.equal(
        bootstrap.controller?.instanceId,
        this.instanceId,
        "fresh L0 instance admission unavailable; reconcile without resuming dispatch",
      );
      assert.ok(
        Date.now() <
          Date.parse(execution.createdAt) + contract.policy.deadlineMs,
        "execution deadline exhausted",
      );
    }
    return { contract, mailbox };
  }

  closeAcceptedPane(receipt) {
    const execution = this.ledger.getExecution(receipt.executionId);
    this.assertExecutionOwner(execution);
    assert.equal(
      execution.state,
      "ACCEPTED",
      "pane cleanup requires acceptance",
    );
    assert.equal(
      execution.goalCommitState,
      "committed",
      "pane cleanup requires Goal readback",
    );
    assert.equal(
      execution.paneId,
      receipt.paneId,
      "accepted pane identity changed",
    );
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        execution.executionId,
      ),
      execution.executionId,
    );
    const binding = {
      executionId: execution.executionId,
      ownerEpoch: execution.ownerEpoch,
      acceptanceId: receipt.acceptanceId,
      paneId: receipt.paneId,
    };
    const intent = "receipts/accepted-pane-intent.json",
      reply = "receipts/accepted-pane.json";
    if (fs.existsSync(path.join(mailbox.root, reply))) {
      assert.deepEqual(
        mailbox.readJson(intent),
        binding,
        "accepted pane intent changed",
      );
      assert.deepEqual(
        mailbox.readJson(reply),
        { ...binding, disposition: "closed" },
        "accepted pane reply changed",
      );
      return;
    }
    assert.ok(
      !fs.existsSync(path.join(mailbox.root, intent)),
      "accepted pane closure outcome unknown; reconcile without replay",
    );
    assert.ok(
      this.herdr?.closeIdle,
      "Herdr cleanup unavailable; reservation retained",
    );
    const workspace = this.ledger.getContract(execution.executionId).workspace;
    const cwd = workspace.worktreePath ?? workspace.sourceRoot;
    if (this.herdr.isIdle)
      assert.equal(
        this.herdr.isIdle(receipt.paneId, cwd),
        true,
        "accepted pane is not idle; reservation retained",
      );
    this.assertExecutionOwner(this.ledger.getExecution(execution.executionId));
    mailbox.writeJson(intent, binding);
    const closed = this.herdr.closeIdle(receipt.paneId, cwd);
    assert.deepEqual(
      closed,
      { paneId: receipt.paneId, disposition: "closed" },
      "accepted pane close reply unknown",
    );
    mailbox.writeJson(reply, { ...binding, disposition: "closed" });
    this.assertExecutionOwner(this.ledger.getExecution(execution.executionId));
  }

  assertReviewAdmission(executionId) {
    const execution = this.ledger.getExecution(executionId);
    const { contract, mailbox } = this.assertControllerAdmission(execution);
    assert.ok(
      execution.reservationOpen && execution.state === "RESULT_READY",
      "review requires an owned ready reservation",
    );
    const boot = readWorkerBoot(mailbox, execution, contract);
    assert.equal(
      processTerminalProof(boot).terminal,
      true,
      "Worker must exit before L0 review admission",
    );
    const roles = readRoleLifecycle(mailbox, contract, boot.workerSessionId);
    assert.ok(
      roles.every((role) => role.terminal),
      "unresolved Worker roles block review admission",
    );
    this.assertControllerAdmission(this.ledger.getExecution(executionId));
  }

  ingestEvents(mailbox) {
    for (const event of mailbox.listEvents()) {
      validateEvent(event);
      assert.equal(
        mailbox.digestRelative(event.payloadRef),
        event.payloadDigest,
        `event payload changed: ${event.eventId}`,
      );
      this.ledger.recordEvent(event);
      if (event.type === "progress") {
        const payload = mailbox.readJson(event.payloadRef, 16 * 1024);
        if (payload.kind === "role-launch-intent")
          this.ledger.recordRoleIntent(
            event.executionId,
            event.eventId,
            payload.role,
            payload.maxTokens,
          );
      }
    }
  }

  collect(executionId, { includeCandidate = false } = {}) {
    let execution = this.ledger.getExecution(executionId);
    this.assertController(execution.projectId);
    assert.ok(
      ["RUNNING", "RESULT_READY", "UNKNOWN"].includes(execution.state),
      "execution is not collecting results",
    );
    const contract = this.ledger.getContract(executionId);
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        executionId,
      ),
      executionId,
    );
    this.ingestEvents(mailbox);
    const results = mailbox.listResults();
    assert.ok(results.length > 0, "Task Pi has not submitted a result");
    const latest = results.at(-1);
    validateTaskResult(latest, contract, execution.requestDigest);
    verifyWorkspaceResult(contract, mailbox, latest);
    this.ledger.recordResult(
      executionId,
      latest.resultRevision,
      digest(latest),
      latest.source.sourceDigest,
      path.join(
        mailbox.root,
        "results",
        `r${String(latest.resultRevision).padStart(4, "0")}.json`,
      ),
      latest.unresolvedRunCount,
    );
    execution = this.ledger.getExecution(executionId);
    if (execution.state === "RUNNING" || execution.state === "UNKNOWN")
      execution = this.ledger.transition(
        executionId,
        execution.state,
        execution.revision,
        "RESULT_READY",
      );
    return includeCandidate ? { execution, candidate: latest } : execution;
  }

  requestCancel(executionId, reason) {
    assert.ok(
      typeof reason === "string" &&
        reason.trim() &&
        Buffer.byteLength(reason) <= 500,
      "bounded cancellation reason required",
    );
    let execution = this.ledger.getExecution(executionId);
    this.assertExecutionOwner(execution);
    if (
      ["ACCEPTED", "REJECTED", "FAILED", "CANCELLED"].includes(execution.state)
    )
      return { ...execution, disposition: "already-terminal" };
    if (execution.state === "RESERVED") {
      return {
        ...this.ledger.finishCancellation(
          executionId,
          execution.revision,
          this.ownerSessionId,
        ),
        disposition: "cancelled-before-launch",
      };
    }
    if (execution.state !== "CANCEL_REQUESTED")
      execution = this.ledger.transition(
        executionId,
        execution.state,
        execution.revision,
        "CANCEL_REQUESTED",
      );
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        executionId,
      ),
      executionId,
    );
    const existing = mailbox
      .listCommands()
      .find((command) => command.commandId === `cancel-${executionId}`);
    if (existing) {
      assert.equal(
        existing.executionId,
        executionId,
        "cancel execution changed",
      );
      assert.equal(
        existing.ownerEpoch,
        execution.ownerEpoch,
        "cancel epoch changed",
      );
      assert.equal(
        existing.requestDigest,
        execution.requestDigest,
        "cancel request changed",
      );
      assert.equal(existing.type, "cancel", "cancel command changed");
      return { ...execution, disposition: "cancel-requested" };
    }
    mailbox.writeCommand({
      schemaVersion: "teams-task-control/1",
      commandId: `cancel-${executionId}`,
      executionId,
      ownerEpoch: execution.ownerEpoch,
      requestDigest: execution.requestDigest,
      type: "cancel",
      payload: { reason: reason.trim() },
    });
    return { ...execution, disposition: "cancel-requested" };
  }

  assertExecutionOwner(execution) {
    const owner = this.assertController(execution.projectId);
    assert.equal(
      execution.ownerSessionId,
      this.ownerSessionId,
      "execution belongs to another controller",
    );
    assert.equal(
      execution.ownerEpoch,
      owner.ownerEpoch,
      "execution owner epoch changed",
    );
  }

  async cancel(
    executionId,
    reason,
    { timeoutMs = 30_000, signal, reviewAdapter } = {},
  ) {
    assert.ok(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 300_000,
      "bounded cancellation wait required",
    );
    const requested = this.requestCancel(executionId, reason);
    if (requested.state !== "CANCEL_REQUESTED")
      return { execution: requested, disposition: requested.disposition };
    const deadline = Date.now() + timeoutMs;
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        requested.projectId,
        "executions",
        executionId,
      ),
      executionId,
    );
    for (;;) {
      const reconciled = this.reconcile(executionId);
      if (!reconciled.execution.reservationOpen) return reconciled;
      for (const review of reconciled.reviews ?? []) {
        if (review.terminal || review.error || !review.runId || signal?.aborted)
          continue;
        this.assertExecutionOwner(this.ledger.getExecution(executionId));
        assert.equal(
          reviewAdapter?.nativeOwner,
          review.nativeOwner,
          "review cancellation RPC owner required",
        );
        assert.equal(
          typeof reviewAdapter?.rpc?.request,
          "function",
          "review cancellation public RPC required",
        );
        const intentRef = `${review.dir}/cancel-stop.json`;
        const binding = {
          executionId,
          ownerEpoch: requested.ownerEpoch,
          ownerSessionId: this.ownerSessionId,
          planDigest: review.planDigest,
          nativeOwner: review.nativeOwner,
          runId: review.runId,
        };
        if (fs.existsSync(path.join(mailbox.root, intentRef))) {
          assert.deepEqual(
            mailbox.readJson(intentRef),
            binding,
            "review cancellation stop intent changed",
          );
          continue; // A timed-out stop is not permission to repeat it.
        }
        mailbox.writeJson(intentRef, binding);
        let outcome;
        try {
          await reviewAdapter.rpc.request(
            "stop",
            { id: review.runId },
            Math.min(2000, Math.max(1, deadline - Date.now())),
          );
          outcome = { disposition: "requested" };
        } catch (error) {
          outcome = {
            disposition: "unknown",
            error: String(error.message ?? error).slice(0, 1000),
          };
        }
        mailbox.writeJson(`${review.dir}/cancel-stop-result.json`, {
          ...binding,
          ...outcome,
        });
        this.assertExecutionOwner(this.ledger.getExecution(executionId));
      }
      if (signal?.aborted || Date.now() >= deadline)
        return { ...reconciled, disposition: "draining" };
      await delay(Math.min(100, deadline - Date.now()));
    }
  }

  reconcile(executionId) {
    let execution = this.ledger.getExecution(executionId);
    this.assertExecutionOwner(execution);
    if (execution.state === "CANCELLED" && !execution.reservationOpen)
      return { execution, disposition: "already-cancelled" };
    const mailbox = Mailbox.open(
      path.join(
        this.runtimeRoot,
        "projects",
        execution.projectId,
        "executions",
        executionId,
      ),
      executionId,
    );
    if (
      execution.state === "CANCEL_REQUESTED" &&
      !mailbox.listCommands().some((command) => command.type === "cancel")
    )
      this.requestCancel(
        executionId,
        "reconcile persisted cancellation intent",
      );
    this.ingestEvents(mailbox);
    execution = this.ledger.getExecution(executionId);
    let processProof = null;
    let paneClosure = null;
    let reviews = [];
    if (["CANCEL_REQUESTED", "CANCELLED"].includes(execution.state)) {
      if (!fs.existsSync(path.join(mailbox.root, "receipts/boot.json")))
        return {
          execution,
          disposition: "draining",
          processProof: {
            terminal: false,
            reason: "boot identity unavailable",
          },
        };
      const contract = this.ledger.getContract(executionId);
      const boot = readWorkerBoot(mailbox, execution, contract);
      let roles = readRoleLifecycle(mailbox, contract, boot.workerSessionId);
      processProof = processTerminalProof(boot);
      if (processProof.terminal)
        roles = roles.map((role) => {
          if (role.terminal || !role.runId || !role.asyncDir) return role;
          try {
            const proof = captureNativeTerminal(
              mailbox,
              role,
              [boot.workerSessionId, boot.workerSessionFile],
              `role-${role.launchId}`,
            );
            return { ...role, terminal: Boolean(proof), hostTerminal: proof };
          } catch (error) {
            return {
              ...role,
              terminal: false,
              error: String(error.message ?? error).slice(0, 1000),
            };
          }
        });
      reviews = readReviewLifecycle(
        mailbox,
        contract,
        this.ownerSessionId,
        (launch, owners, read) =>
          captureNativeTerminal(
            mailbox,
            launch,
            owners,
            `review-${launch.key}`,
            read,
          ),
      );
      const runIds = [...roles, ...reviews]
        .map((run) => run.runId)
        .filter(Boolean);
      assert.equal(
        new Set(runIds).size,
        runIds.length,
        "cancellation native run identity reused",
      );
      if (
        processProof.terminal &&
        [...roles, ...reviews].every((run) => run.terminal)
      ) {
        const binding = {
          executionId,
          ownerSessionId: this.ownerSessionId,
          ownerEpoch: execution.ownerEpoch,
          requestDigest: execution.requestDigest,
          workerSessionId: boot.workerSessionId,
          paneId: execution.paneId,
          workerProcess: {
            processId: boot.processId,
            processStartedAtTicks: boot.processStartedAtTicks,
          },
          roleDigest: digest(roles),
          reviewDigest: digest(reviews),
          cwd: contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
        };
        const receiptPath = "receipts/cancel-pane.json";
        if (fs.existsSync(path.join(mailbox.root, receiptPath))) {
          const receipt = mailbox.readJson(receiptPath);
          assert.deepEqual(
            receipt.binding,
            binding,
            "pane closure binding changed",
          );
          assert.deepEqual(
            mailbox.readJson("receipts/cancel-pane-intent.json"),
            binding,
            "pane closure intent changed",
          );
          assert.equal(
            receipt.processProof?.terminal,
            true,
            "pane closure terminal proof missing",
          );
          paneClosure = receipt.result;
        } else {
          assert.ok(
            this.herdr &&
              execution.paneId &&
              typeof this.herdr.closeIdle === "function",
            "pane closure adapter and identity required",
          );
          assert.ok(
            !fs.existsSync(
              path.join(mailbox.root, "receipts/cancel-pane-intent.json"),
            ),
            "pane closure outcome unknown; reconcile without replay",
          );
          this.assertExecutionOwner(this.ledger.getExecution(executionId));
          if (typeof this.herdr.isIdle === "function") {
            const idle = this.herdr.isIdle(execution.paneId, binding.cwd);
            assert.equal(
              typeof idle,
              "boolean",
              "pane idle observation missing",
            );
            if (!idle)
              return {
                execution,
                processProof,
                reviews,
                disposition: "draining",
                paneClosure: {
                  paneId: execution.paneId,
                  disposition: "waiting-for-idle",
                },
              };
          }
          this.assertExecutionOwner(this.ledger.getExecution(executionId));
          mailbox.writeReceipt("cancel-pane-intent", binding);
          paneClosure = this.herdr.closeIdle(execution.paneId, binding.cwd);
          assert.equal(
            paneClosure?.paneId,
            execution.paneId,
            "pane closure identity mismatch",
          );
          assert.equal(
            paneClosure?.disposition,
            "closed",
            "pane closure not confirmed",
          );
          mailbox.writeReceipt("cancel-pane", {
            binding,
            processProof,
            result: paneClosure,
          });
          this.assertExecutionOwner(this.ledger.getExecution(executionId));
        }
        assert.equal(
          paneClosure?.paneId,
          execution.paneId,
          "pane closure identity mismatch",
        );
        assert.equal(
          paneClosure?.disposition,
          "closed",
          "pane closure not confirmed",
        );
        execution = this.ledger.finishCancellation(
          executionId,
          execution.revision,
          this.ownerSessionId,
        );
      }
    } else if (
      mailbox.listResults().length > 0 &&
      ["RUNNING", "RESULT_READY", "UNKNOWN"].includes(execution.state)
    ) {
      execution = this.collect(executionId);
    }
    if (
      !processProof &&
      fs.existsSync(path.join(mailbox.root, "receipts/boot.json"))
    ) {
      processProof = processTerminalProof(
        readWorkerBoot(
          mailbox,
          execution,
          this.ledger.getContract(executionId),
        ),
      );
    }
    let pane = null;
    if (this.herdr && execution.paneId && !paneClosure) {
      try {
        pane = this.herdr.status(execution.paneId);
      } catch (error) {
        pane = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      execution,
      pane,
      processProof,
      paneClosure,
      reviews,
      disposition: "reconciled",
    };
  }
}
