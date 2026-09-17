import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./contracts.mjs";
import { usesSharedTaskBudget } from "./budget-pool.mjs";
import {
  budgetedChildren,
  assertBudgetHook,
  registerTaskBudgetMembers,
} from "./task-budget.mjs";
import {
  measureExecutionUsage,
  reviewUsageAdmission,
  readWorkerUsageCheckpoint,
} from "./task-usage.mjs";
import { prepareRoleWave, compileRoleWave } from "./role-wave.mjs";
import { verifyWorkspaceScope } from "./workspace-scope.mjs";
import {
  readNativeTerminal,
  readNativeStartFailure,
  readRoleLifecycle,
  captureNativeTerminal,
} from "./role-lifecycle.mjs";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class RoleController {
  constructor({ runtime, rpc, cwd, readWorker = null, resolve = null }) {
    assert.ok(
      runtime?.contract && rpc?.request,
      "worker runtime and RPC client required",
    );
    this.runtime = runtime;
    this.rpc = rpc;
    this.cwd = cwd;
    this.launches = new Map();
    this.reservedTokens = 0;
    this.memberCount = 0;
    this.draining = false;
    this.readWorker = readWorker;
    this.resolve = resolve;
    this.turnCount = 0;
    this.turnUsage = null;
  }

  async spawn({ role, task, mode, maxTokens }) {
    const managed =
      this.runtime.contract.schemaVersion === "teams-task-runtime/3" &&
      ["mutation", "check"].includes(mode);
    return this.#dispatch(
      {
        key: `single-${randomUUID()}`,
        reason: "One bounded role requested; no parallelism needed.",
        runs: [
          {
            key: "role",
            role,
            task,
            mode,
            maxTokens,
            isolation: managed ? "worktree" : "shared",
          },
        ],
      },
      !managed,
    );
  }

  async spawnWave(wave) {
    return this.#dispatch(wave, false);
  }

  #measureAdmission(plan, checkpointOnly = false, reserveActive = false) {
    if (this.runtime.contract.schemaVersion !== "teams-task-runtime/3")
      return null;
    const { mailbox, contract } = this.runtime;
    const launches = [...this.launches.values()];
    const checkpoint = readWorkerUsageCheckpoint(mailbox);
    assert.equal(
      checkpoint.count,
      this.turnCount,
      "Worker usage controller changed; reconcile before admission",
    );
    assert.deepEqual(
      checkpoint.latest,
      this.turnUsage,
      "Worker usage checkpoint changed",
    );
    // Do not reconstruct grants or reset budgets when a controller is recreated.
    assert.deepEqual(
      fs
        .readdirSync(path.join(mailbox.root, "receipts"))
        .filter((name) => name.startsWith("wave-plan-"))
        .sort(),
      launches.map((launch) => `wave-plan-${launch.launchId}.json`).sort(),
      "role history differs from this controller; reconcile before dispatch",
    );
    let previous = null;
    for (const launch of launches) {
      const receipt = mailbox.readJson(launch.usageAdmissionRef);
      assert.equal(
        digest(receipt),
        launch.usageAdmissionDigest,
        "role usage checkpoint changed",
      );
      previous = receipt;
    }
    const context = {
      mailbox,
      contract,
      result: { childRunRefs: this.snapshot().childRunRefs },
      assertOwner: () => {
        this.runtime.assertAdmission();
        assert.deepEqual(
          mailbox.readJson("bootstrap.json"),
          this.runtime.bootstrap,
          "worker bootstrap changed; reconcile admission",
        );
        assert.equal(
          mailbox.readJson("receipts/boot.json").workerSessionId,
          this.runtime.workerSessionId,
          "worker usage identity changed",
        );
        verifyWorkspaceScope(contract, mailbox);
      },
    };
    return reviewUsageAdmission(
      context,
      plan,
      measureExecutionUsage(context, {
        previous,
        expectedRuns: launches,
        readWorker: this.readWorker,
        reserveActive,
      }),
      { checkpointOnly },
    );
  }

  admitTurn() {
    this.runtime.assertAdmission();
    assert.ok(!this.draining, "role controller is draining");
    this.refreshTerminals();
    const active = [...this.launches.values()].filter(
      (launch) => !launch.terminal,
    );
    const members = active.flatMap((launch) => launch.members);
    // Coordination is a real Worker turn. Charge its history and retain the
    // full allocation of in-flight roles; do not pretend they have zero usage
    // or require terminal proof before the Worker can answer their questions.
    const usage = this.#measureAdmission(
      {
        members,
        reservedTokens: members.reduce(
          (total, member) => total + member.maxTokens,
          0,
        ),
      },
      active.length === 0,
      true,
    );
    if (usage) {
      assert.ok(
        usage.taskTotals.total +
          (usesSharedTaskBudget(this.runtime.contract)
            ? 0
            : usage.nextReservation) <
          usage.maxTaskTokens,
        "task budget exhausted before Worker model request",
      );
      const next = this.turnCount + 1;
      assert.ok(next <= 1024, "Worker usage checkpoint inventory too large");
      this.runtime.mailbox.writeReceipt(
        `worker-usage-${String(next).padStart(6, "0")}`,
        usage,
      );
      this.turnCount = next;
      this.turnUsage = usage;
    }
    return { waiting: active.length > 0, usage };
  }

  async #dispatch(wave, single) {
    this.runtime.assertAdmission();
    assert.ok(!this.draining, "role controller is draining; no new dispatch");
    assert.ok(
      ![...this.launches.values()].some((launch) => !launch.terminal),
      "one active native wave; consume completion and process proof before dependent work",
    );
    assert.ok(
      ![...this.launches.values()].some(
        (launch) => launch.waveKey === wave?.key,
      ),
      "wave key already consumed; reconcile instead of replaying",
    );
    const plan = prepareRoleWave(this.runtime.contract, this.cwd, wave);
    assert.ok(
      this.memberCount + plan.members.length <=
        this.runtime.contract.policy.maxRoleSpawnsPerTask,
      "role spawn budget exhausted",
    );
    assert.ok(
      usesSharedTaskBudget(this.runtime.contract) ||
        this.reservedTokens + plan.reservedTokens <=
          this.runtime.contract.policy.maxTaskTokens,
      "task token budget exhausted",
    );
    const usageAdmission = this.#measureAdmission(plan);
    const launchId = randomUUID();
    const launch = {
      launchId,
      waveKey: plan.key,
      sessionDir: path.join(
        this.runtime.executionRoot,
        "role-sessions",
        launchId,
      ),
      members: plan.members,
      role: plan.members.length === 1 ? plan.members[0].role : null,
      mode: plan.members.length === 1 ? plan.members[0].mode : "wave",
      maxTokens: plan.reservedTokens,
      runId: null,
      completion: null,
      processTerminal: null,
      hostedTerminal: null,
      ...(!single &&
      this.runtime.contract.schemaVersion === "teams-task-runtime/3"
        ? {
            hostedWorkflow: {
              version: 1,
              pid: this.runtime.mailbox.readJson("receipts/boot.json")
                .processId,
            },
          }
        : {}),
      terminal: false,
      ...(usageAdmission
        ? {
            usageAdmissionRef: `receipts/role-usage-${launchId}.json`,
            usageAdmissionDigest: digest(usageAdmission),
          }
        : {}),
    };
    const sharedBudget = usesSharedTaskBudget(this.runtime.contract);
    const children = budgetedChildren(
      this.runtime,
      plan.children,
      `role.${launchId}`,
    );
    if (sharedBudget) {
      assert.equal(
        typeof this.resolve,
        "function",
        "shared budget native preflight required",
      );
      for (const child of children)
        assertBudgetHook(
          await this.resolve({
            ...child,
            sessionDir: single
              ? launch.sessionDir
              : path.join(launch.sessionDir, child.key),
          }),
        );
      this.runtime.assertAdmission();
      registerTaskBudgetMembers(
        this.runtime,
        plan.members.map((member) => ({
          key: `role.${launchId}.${member.key}`,
          estimate: member.maxTokens,
          sessionRoot: single
            ? launch.sessionDir
            : path.join(launch.sessionDir, member.key),
        })),
      );
    }
    this.launches.set(launchId, launch);
    this.memberCount += plan.members.length;
    this.reservedTokens += plan.reservedTokens;
    this.runtime.mailbox.writeReceipt(`wave-plan-${launchId}`, {
      ...wave,
      ...(launch.hostedWorkflow
        ? { hostedWorkflow: launch.hostedWorkflow }
        : {}),
    });
    if (usageAdmission)
      this.runtime.mailbox.writeJson(launch.usageAdmissionRef, usageAdmission);
    this.runtime.recordProgress(launchId, {
      kind: "role-wave-launch-intent",
      ...(usageAdmission
        ? {
            usageAdmissionRef: launch.usageAdmissionRef,
            usageAdmissionDigest: launch.usageAdmissionDigest,
          }
        : {}),
      role: launch.role,
      mode: launch.mode,
      maxTokens: launch.maxTokens,
      members: plan.members,
      waveKey: plan.key,
      reason: plan.reason,
      baseCommit: plan.baseCommit,
    });
    for (const member of plan.members)
      this.runtime.recordProgress(`${launchId}.${member.key}`, {
        kind: "role-launch-intent",
        rootLaunchId: launchId,
        role: member.role,
        mode: member.mode,
        maxTokens: member.maxTokens,
      });
    let execution;
    if (single) {
      assert.equal(plan.children.length, 1);
      const { key: _key, worktree: _worktree, ...child } = children[0];
      execution = child;
    } else {
      execution = {
        workflowScript: compileRoleWave(children, launch.sessionDir),
        mission: { title: `Task ${this.runtime.executionId} wave ${plan.key}` },
      };
    }
    let response, startFailure;
    try {
      try {
        response = await this.rpc.request("spawn", {
          ...execution,
          cwd: this.cwd,
          async: true,
          context: "fresh",
          sessionDir: launch.sessionDir,
          timeoutMs: this.runtime.contract.policy.deadlineMs,
          usageBudget: {
            tokens: {
              hard: sharedBudget
                ? this.runtime.contract.policy.maxTaskTokens
                : plan.reservedTokens,
            },
          },
        });
      } catch (cause) {
        const boot = this.runtime.mailbox.readJson("receipts/boot.json");
        response = readNativeStartFailure(cause, launch, [
          boot.workerSessionId,
          boot.workerSessionFile,
        ]);
        if (!response) throw cause;
        startFailure = cause;
      }
      launch.runId =
        response?.runId ??
        response?.asyncId ??
        response?.details?.runId ??
        response?.details?.asyncId;
      assert.match(
        launch.runId,
        safeId,
        "pi-subagents spawn returned no safe run id",
      );
      launch.asyncDir =
        response?.asyncDir ?? response?.details?.asyncDir ?? null;
      assert.ok(
        (launch.asyncDir === null &&
          this.runtime.contract.schemaVersion !== "teams-task-runtime/3") ||
          (typeof launch.asyncDir === "string" &&
            path.isAbsolute(launch.asyncDir) &&
            (this.runtime.contract.schemaVersion !== "teams-task-runtime/3" ||
              path.resolve(launch.asyncDir) === launch.asyncDir)),
        "pi-subagents returned invalid async directory",
      );
      if (usageAdmission)
        assert.ok(
          ![...this.launches.values()].some(
            (other) => other !== launch && other.runId === launch.runId,
          ),
          "native usage run identity reused",
        );
      this.runtime.recordProgress(`${launchId}-started`, {
        kind: "role-started",
        launchId,
        runId: launch.runId,
        asyncDir: launch.asyncDir,
        sessionDir: launch.sessionDir,
        ...(launch.hostedWorkflow
          ? { hostedWorkflow: launch.hostedWorkflow }
          : {}),
        role: launch.role,
        mode: launch.mode,
        maxTokens: launch.maxTokens,
        members: plan.members,
        waveKey: plan.key,
        baseCommit: plan.baseCommit,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.runtime.recordProgress(`${launchId}-unknown`, {
        kind: "role-launch-unknown",
        launchId,
        role: launch.role,
        error: error.slice(0, 1000),
      });
      throw new Error(
        `role launch ${launchId} is unknown; reconcile before retry: ${error}`,
        { cause },
      );
    }
    if (startFailure) {
      this.finish(launch.runId, "failed");
      this.observeProcessTerminal(response.processTerminal);
      // No model retry/redispatch: keep the original failure while allowing
      // the existing owner cancellation to observe a terminal role.
      this.runtime.failAdmission(startFailure);
      throw new Error(
        `role launch ${launch.launchId} failed before runner spawn; cancel without retry: ${startFailure.message}`,
        { cause: startFailure },
      );
    }
    return { ...launch, response };
  }

  async stopAll() {
    this.draining = true;
    const durable = readRoleLifecycle(
      this.runtime.mailbox,
      this.runtime.contract,
      this.runtime.workerSessionId,
    );
    this.launches = new Map(
      durable.map((row) => [
        row.launchId,
        Object.assign(this.launches.get(row.launchId) ?? {}, row),
      ]),
    );
    this.memberCount = durable.reduce(
      (sum, row) => sum + row.members.length,
      0,
    );
    this.reservedTokens = durable.reduce((sum, row) => sum + row.maxTokens, 0);
    const observations = this.refreshTerminals();
    const active = [...this.launches.values()].filter(
      (launch) =>
        !launch.terminal &&
        launch.runId &&
        !launch.stopRequested &&
        !launch.stopBlocked,
    );
    const outcomes = [];
    for (const launch of active) {
      launch.stopRequested = true;
      this.runtime.recordProgress(`${launch.launchId}-stop-intent`, {
        kind: "role-stop-intent",
        launchId: launch.launchId,
        runId: launch.runId,
      });
      try {
        const response = await this.rpc.request("stop", { id: launch.runId });
        outcomes.push({
          runId: launch.runId,
          disposition: "requested",
          response,
        });
      } catch (error) {
        outcomes.push({
          runId: launch.runId,
          disposition: "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { outcomes, observations, ...this.snapshot() };
  }

  refreshTerminals() {
    const observations = [];
    for (const launch of this.launches.values()) {
      if (launch.terminal || !launch.runId || !launch.asyncDir) continue;
      try {
        const boot = this.runtime.mailbox.readJson("receipts/boot.json");
        const proof = readNativeTerminal(launch, [
          boot.workerSessionId,
          boot.workerSessionFile,
        ]);
        launch.stopBlocked = false;
        if (!proof) continue;
        this.finish(launch.runId, proof.completion);
        if (proof.hostedTerminal) {
          launch.hostedTerminal = proof.hostedTerminal;
          this.#settle(launch);
        } else this.observeProcessTerminal(proof.processTerminal);
      } catch (error) {
        launch.stopBlocked = true;
        observations.push({
          runId: launch.runId,
          error: String(error.message ?? error).slice(0, 1000),
        });
      }
    }
    return observations;
  }

  finish(runId, completion = "completed") {
    assert.ok(
      ["completed", "failed", "stopped"].includes(completion),
      "invalid role completion state",
    );
    const launch = [...this.launches.values()].find(
      (candidate) => candidate.runId === runId,
    );
    assert.ok(launch, `unknown role run: ${runId}`);
    if (!launch.completion) {
      launch.completion = completion;
      this.runtime.recordProgress(`${launch.launchId}-completion`, {
        kind: "role-completion",
        launchId: launch.launchId,
        runId,
        completion,
      });
    }
    return this.#settle(launch);
  }

  observeProcessTerminal(proof) {
    const runId = proof?.runId;
    assert.match(runId, safeId, "invalid process-terminal run id");
    assert.equal(proof.version, 1, "unsupported process-terminal proof");
    assert.match(
      proof.runnerProcessInstanceId,
      safeId,
      "invalid runner process identity",
    );
    const launch = [...this.launches.values()].find(
      (candidate) => candidate.runId === runId,
    );
    assert.ok(launch, `unknown role run: ${runId}`);
    if (proof.state === "not-started") {
      const boot = this.runtime.mailbox.readJson("receipts/boot.json");
      const verified = captureNativeTerminal(
        this.runtime.mailbox,
        launch,
        [boot.workerSessionId, boot.workerSessionFile],
        `role-${launch.launchId}`,
      );
      assert.deepEqual(
        verified?.processTerminal,
        proof,
        "no-start event lacks durable proof",
      );
      assert.equal(
        launch.completion,
        "failed",
        "no-start completion must be failed",
      );
      launch.processTerminal = { ...proof };
    } else if (proof.state === "observed")
      launch.processTerminal = {
        version: 1,
        state: "observed",
        runId,
        runnerProcessInstanceId: proof.runnerProcessInstanceId,
      };
    return this.#settle(launch);
  }

  #settle(launch) {
    if (
      !launch.terminal &&
      launch.completion &&
      (launch.processTerminal?.state === "observed" ||
        (launch.completion === "failed" &&
          launch.processTerminal?.state === "not-started") ||
        launch.hostedTerminal?.state === "settled")
    ) {
      launch.terminal = true;
      this.runtime.recordProgress(`${launch.launchId}-terminal`, {
        kind: "role-terminal",
        launchId: launch.launchId,
        runId: launch.runId,
        completion: launch.completion,
        processTerminal: launch.processTerminal,
        ...(launch.hostedTerminal
          ? { hostedTerminal: launch.hostedTerminal }
          : {}),
      });
    }
    return { ...launch };
  }

  snapshot() {
    const launches = [...this.launches.values()].map((launch) => ({
      ...launch,
    }));
    return {
      launches,
      childRunRefs: launches.flatMap((launch) =>
        launch.runId ? [launch.runId] : [],
      ),
      unresolvedRunCount: launches.filter((launch) => !launch.terminal).length,
      reservedTokens: this.reservedTokens,
    };
  }
}
