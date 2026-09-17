import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createPool,
  changePool,
  usesSharedTaskBudget,
} from "./budget-pool.mjs";
import {
  canonicalBytes,
  digest,
  validateEvent,
  validateTaskContract,
} from "./contracts.mjs";

const transitions = {
  RESERVED: new Set(["SPAWNING", "CANCELLED"]),
  SPAWNING: new Set(["RUNNING", "UNKNOWN", "CANCEL_REQUESTED", "FAILED"]),
  RUNNING: new Set([
    "WAITING_DECISION",
    "RESULT_READY",
    "CANCEL_REQUESTED",
    "FAILED",
    "UNKNOWN",
  ]),
  WAITING_DECISION: new Set([
    "RUNNING",
    "CANCEL_REQUESTED",
    "FAILED",
    "UNKNOWN",
  ]),
  RESULT_READY: new Set([
    "VALIDATING",
    "REJECTED",
    "CANCEL_REQUESTED",
    "UNKNOWN",
  ]),
  VALIDATING: new Set(["ACCEPTED", "REJECTED", "UNKNOWN"]),
  CANCEL_REQUESTED: new Set(["CANCELLED", "UNKNOWN"]),
  UNKNOWN: new Set([
    "SPAWNING",
    "RUNNING",
    "RESULT_READY",
    "CANCEL_REQUESTED",
    "CANCELLED",
    "FAILED",
    "REJECTED",
  ]),
  ACCEPTED: new Set(),
  REJECTED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};
const terminal = new Set(["ACCEPTED", "REJECTED", "FAILED", "CANCELLED"]);

function now() {
  return new Date().toISOString();
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowObject(row) {
  if (!row) return null;
  return {
    executionId: row.execution_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    ownerEpoch: row.owner_epoch,
    ownerSessionId: row.owner_session_id,
    requestDigest: row.request_digest,
    state: row.state,
    revision: row.revision,
    reservationOpen: row.reservation_open === 1,
    goalCommitState: row.goal_commit_state,
    workspaceIntegration: row.workspace_integration,
    paneId: row.pane_id,
    workerSessionId: row.worker_session_id,
    sourceDigest: row.source_digest,
    resultDigest: row.result_digest,
    unresolvedRunCount: row.unresolved_run_count,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RuntimeLedger {
  constructor(file, { readOnly = false } = {}) {
    assert.ok(path.isAbsolute(file), "absolute ledger path required");
    if (!readOnly)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.file = path.resolve(file);
    if (readOnly)
      assert.equal(
        fs.realpathSync(this.file),
        this.file,
        "canonical ledger path required",
      );
    this.db = new DatabaseSync(this.file, { timeout: 5_000, readOnly });
    const storedVersion = Number(
      this.db.prepare("PRAGMA user_version").get().user_version,
    );
    if (
      ![0, 1, 2, 3].includes(storedVersion) ||
      (readOnly && ![2, 3].includes(storedVersion))
    ) {
      this.db.close();
      throw new Error(
        `unsupported ledger schema version: ${storedVersion}; admission reader does not migrate`,
      );
    }
    if (readOnly || storedVersion === 3) {
      this.schemaVersion = storedVersion;
      if (!readOnly) this.db.exec("PRAGMA foreign_keys = ON");
      return;
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS controllers (
        project_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
        claimed_at TEXT NOT NULL,
        takeover_proof_ref TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision > 0),
        owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
        owner_session_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        reservation_open INTEGER NOT NULL DEFAULT 1 CHECK(reservation_open IN (0,1)),
        goal_commit_state TEXT NOT NULL DEFAULT 'not_requested',
        workspace_integration TEXT NOT NULL DEFAULT 'not_requested',
        pane_id TEXT,
        worker_session_id TEXT,
        source_digest TEXT,
        result_digest TEXT,
        unresolved_run_count INTEGER NOT NULL DEFAULT 0,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES controllers(project_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_task_execution
        ON executions(project_id, goal_id, task_id) WHERE reservation_open = 1;
      CREATE TABLE IF NOT EXISTS execution_events (
        execution_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_digest TEXT NOT NULL,
        event_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, event_id),
        UNIQUE(execution_id, sequence),
        FOREIGN KEY(execution_id) REFERENCES executions(execution_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS results (
        execution_id TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        result_digest TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        result_ref TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, result_revision),
        UNIQUE(execution_id, result_digest),
        FOREIGN KEY(execution_id) REFERENCES executions(execution_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS acceptances (
        acceptance_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        result_digest TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        decision TEXT NOT NULL,
        receipt_ref TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        FOREIGN KEY(execution_id) REFERENCES executions(execution_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_budgets (
        project_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        spawns INTEGER NOT NULL DEFAULT 0,
        product_repairs INTEGER NOT NULL DEFAULT 0,
        report_repairs INTEGER NOT NULL DEFAULT 0,
        process_restarts INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER,
        PRIMARY KEY(project_id, goal_id, task_id, role)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_budget_events (
        execution_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        role TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, event_id),
        FOREIGN KEY(execution_id, event_id)
          REFERENCES execution_events(execution_id, event_id)
      ) STRICT;
    `);
    try {
      const columns = this.db.prepare("PRAGMA table_info(executions)").all();
      if (!columns.some((column) => column.name === "budget_pool_json"))
        this.db.exec("ALTER TABLE executions ADD COLUMN budget_pool_json TEXT");
      this.db.exec("PRAGMA user_version = 3; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
    this.schemaVersion = 3;
  }

  // Admission state lives in the same durable ledger as the execution. No new
  // controller or side database. The transaction fences concurrent leaf requests.
  createTaskPool(executionId, requestDigest, priorTokens, sessionRoot) {
    return transaction(this.db, () => {
      const execution = this.getExecution(executionId);
      const contract = this.getContract(executionId);
      const controller = this.getController(execution.projectId);
      assert.equal(
        controller.ownerEpoch,
        execution.ownerEpoch,
        "budget owner fenced",
      );
      assert.equal(
        controller.ownerSessionId,
        execution.ownerSessionId,
        "budget owner changed",
      );
      assert.equal(
        execution.ownerEpoch,
        contract.identity.ownerEpoch,
        "budget owner fenced",
      );
      assert.equal(execution.state, "RESERVED", "pool must precede launch");
      assert.equal(execution.requestDigest, requestDigest);
      assert.ok(usesSharedTaskBudget(contract), "shared budget not authorized");
      assert.equal(
        this.readTaskPool(executionId),
        null,
        "pool already initialized; never reset usage",
      );
      const pool = createPool(
        requestDigest,
        contract.policy.maxTaskTokens,
        priorTokens,
      );
      changePool(pool, {
        type: "register",
        members: [{ key: "worker", estimate: 0, sessionRoot }],
      });
      this.db
        .prepare(
          "UPDATE executions SET budget_pool_json = ? WHERE execution_id = ?",
        )
        .run(JSON.stringify(pool), executionId);
      return pool;
    });
  }

  readTaskPool(executionId) {
    if (this.schemaVersion < 3) return null;
    const row = this.db
      .prepare("SELECT budget_pool_json FROM executions WHERE execution_id = ?")
      .get(executionId);
    assert.ok(row, "budget execution missing");
    try {
      return row.budget_pool_json === null
        ? null
        : JSON.parse(row.budget_pool_json);
    } catch (cause) {
      throw new Error("invalid persisted task budget", { cause });
    }
  }

  changeTaskPool(executionId, requestDigest, operation) {
    return transaction(this.db, () => {
      const execution = this.getExecution(executionId);
      const controller = this.getController(execution.projectId);
      assert.equal(
        execution.requestDigest,
        requestDigest,
        "budget contract changed",
      );
      assert.equal(
        controller.ownerEpoch,
        execution.ownerEpoch,
        "budget owner fenced",
      );
      assert.equal(
        controller.ownerSessionId,
        execution.ownerSessionId,
        "budget owner changed",
      );
      assert.equal(
        execution.ownerEpoch,
        this.getContract(executionId).identity.ownerEpoch,
        "budget owner fenced",
      );
      assert.ok(execution.reservationOpen, "budget execution is closed");
      if (["register", "bind", "request"].includes(operation.type)) {
        assert.ok(
          ["SPAWNING", "RUNNING", "RESULT_READY"].includes(execution.state),
          "budget execution not admitting requests",
        );
        assert.ok(
          Date.now() <
            Date.parse(execution.createdAt) +
              this.getContract(executionId).policy.deadlineMs,
          "execution deadline exhausted",
        );
      }
      const pool = this.readTaskPool(executionId);
      assert.ok(pool, "shared budget missing; no fallback");
      assert.equal(pool.contractDigest, requestDigest, "pool contract changed");
      assert.equal(
        pool.ceiling,
        this.getContract(executionId).policy.maxTaskTokens,
        "task ceiling changed",
      );
      changePool(pool, operation);
      this.db
        .prepare(
          "UPDATE executions SET budget_pool_json = ? WHERE execution_id = ?",
        )
        .run(JSON.stringify(pool), executionId);
      return pool;
    });
  }

  close() {
    this.db.close();
  }

  claimController(projectId, ownerSessionId) {
    assert.ok(
      projectId && ownerSessionId,
      "project and owner session required",
    );
    return transaction(this.db, () => {
      const current = this.db
        .prepare("SELECT * FROM controllers WHERE project_id = ?")
        .get(projectId);
      if (!current) {
        this.db
          .prepare(
            "INSERT INTO controllers(project_id, owner_session_id, owner_epoch, claimed_at) VALUES (?, ?, 1, ?)",
          )
          .run(projectId, ownerSessionId, now());
        return { ownerEpoch: 1, disposition: "claimed" };
      }
      if (current.owner_session_id === ownerSessionId)
        return {
          ownerEpoch: current.owner_epoch,
          disposition: "already-owned",
        };
      assert.ok(
        current.owner_session_id.startsWith("released:"),
        `project ${projectId} is owned by another session`,
      );
      const ownerEpoch = current.owner_epoch + 1;
      this.db
        .prepare(
          "UPDATE controllers SET owner_session_id = ?, owner_epoch = ?, claimed_at = ?, takeover_proof_ref = NULL WHERE project_id = ? AND owner_session_id = ? AND owner_epoch = ?",
        )
        .run(
          ownerSessionId,
          ownerEpoch,
          now(),
          projectId,
          current.owner_session_id,
          current.owner_epoch,
        );
      return { ownerEpoch, disposition: "claimed-released" };
    });
  }

  adoptController(
    projectId,
    previousOwnerSessionId,
    nextOwnerSessionId,
    proofRef,
  ) {
    assert.ok(path.isAbsolute(proofRef), "absolute takeover proof required");
    return transaction(this.db, () => {
      const current = this.db
        .prepare("SELECT * FROM controllers WHERE project_id = ?")
        .get(projectId);
      assert.ok(current, "controller does not exist");
      assert.equal(
        current.owner_session_id,
        previousOwnerSessionId,
        "previous owner changed",
      );
      const ownerEpoch = current.owner_epoch + 1;
      this.db
        .prepare(
          "UPDATE controllers SET owner_session_id = ?, owner_epoch = ?, claimed_at = ?, takeover_proof_ref = ? WHERE project_id = ?",
        )
        .run(nextOwnerSessionId, ownerEpoch, now(), proofRef, projectId);
      return { ownerEpoch, disposition: "adopted" };
    });
  }

  reserve(contract, requestDigest, ownerSessionId) {
    validateTaskContract(contract);
    assert.equal(digest(contract), requestDigest, "request digest mismatch");
    return transaction(this.db, () => {
      const {
        projectId,
        goalId,
        taskId,
        taskRevision,
        executionId,
        ownerEpoch,
      } = contract.identity;
      const owner = this.db
        .prepare("SELECT * FROM controllers WHERE project_id = ?")
        .get(projectId);
      assert.ok(owner, "controller must be claimed first");
      assert.equal(
        owner.owner_session_id,
        ownerSessionId,
        "controller session mismatch",
      );
      assert.equal(owner.owner_epoch, ownerEpoch, "controller epoch mismatch");
      const existing = this.db
        .prepare("SELECT * FROM executions WHERE execution_id = ?")
        .get(executionId);
      if (existing) {
        assert.equal(
          existing.request_digest,
          requestDigest,
          "execution id reused with another request",
        );
        return { ...rowObject(existing), disposition: "duplicate" };
      }
      const open = this.db
        .prepare(
          "SELECT execution_id FROM executions WHERE project_id = ? AND goal_id = ? AND task_id = ? AND reservation_open = 1",
        )
        .get(projectId, goalId, taskId);
      assert.ok(
        !open,
        `task has an open reservation: ${open?.execution_id ?? "unknown"}`,
      );
      const timestamp = now();
      this.db
        .prepare(`INSERT INTO executions(
        execution_id, project_id, goal_id, task_id, task_revision, owner_epoch,
        owner_session_id, request_digest, contract_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)`)
        .run(
          executionId,
          projectId,
          goalId,
          taskId,
          taskRevision,
          ownerEpoch,
          ownerSessionId,
          requestDigest,
          canonicalBytes(contract).toString("utf8"),
          timestamp,
          timestamp,
        );
      return { ...this.getExecution(executionId), disposition: "reserved" };
    });
  }

  getController(projectId) {
    const row = this.db
      .prepare("SELECT * FROM controllers WHERE project_id = ?")
      .get(projectId);
    if (!row) return null;
    return {
      projectId: row.project_id,
      ownerSessionId: row.owner_session_id,
      ownerEpoch: row.owner_epoch,
      claimedAt: row.claimed_at,
      takeoverProofRef: row.takeover_proof_ref,
    };
  }

  takeoverController(
    projectId,
    ownerSessionId,
    expectedOwnerSessionId,
    expectedOwnerEpoch,
    proofRef,
  ) {
    assert.ok(
      ownerSessionId && expectedOwnerSessionId,
      "controller identities required",
    );
    assert.ok(path.isAbsolute(proofRef), "absolute takeover proof required");
    return transaction(this.db, () => {
      const current = this.getController(projectId);
      assert.ok(current, `project controller not found: ${projectId}`);
      assert.equal(
        current.ownerSessionId,
        expectedOwnerSessionId,
        "controller owner changed; reconcile again",
      );
      assert.equal(
        current.ownerEpoch,
        expectedOwnerEpoch,
        "controller epoch changed; reconcile again",
      );
      const nextEpoch = current.ownerEpoch + 1;
      const result = this.db
        .prepare(
          "UPDATE controllers SET owner_session_id = ?, owner_epoch = ?, claimed_at = ?, takeover_proof_ref = ? WHERE project_id = ? AND owner_session_id = ? AND owner_epoch = ?",
        )
        .run(
          ownerSessionId,
          nextEpoch,
          now(),
          proofRef,
          projectId,
          expectedOwnerSessionId,
          expectedOwnerEpoch,
        );
      assert.equal(result.changes, 1, "controller changed; reconcile again");
      return this.getController(projectId);
    });
  }

  releaseOwnedControllers(ownerSessionId) {
    return transaction(this.db, () => {
      const projects = this.db
        .prepare(
          "SELECT project_id FROM controllers WHERE owner_session_id = ? AND NOT EXISTS (SELECT 1 FROM executions WHERE executions.project_id = controllers.project_id AND reservation_open = 1)",
        )
        .all(ownerSessionId)
        .map((row) => row.project_id);
      for (const projectId of projects)
        this.db
          .prepare(
            "UPDATE controllers SET owner_session_id = ? WHERE project_id = ? AND owner_session_id = ?",
          )
          .run(`released:${ownerSessionId}`, projectId, ownerSessionId);
      return projects;
    });
  }

  getExecution(executionId) {
    const row = this.db
      .prepare("SELECT * FROM executions WHERE execution_id = ?")
      .get(executionId);
    assert.ok(row, `execution not found: ${executionId}`);
    return rowObject(row);
  }

  getContract(executionId) {
    const row = this.db
      .prepare("SELECT contract_json FROM executions WHERE execution_id = ?")
      .get(executionId);
    assert.ok(row, `execution not found: ${executionId}`);
    try {
      return JSON.parse(row.contract_json);
    } catch (cause) {
      throw new Error(`stored contract is invalid for ${executionId}`, {
        cause,
      });
    }
  }

  listOpen(projectId) {
    return this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND reservation_open = 1 ORDER BY created_at",
      )
      .all(projectId)
      .map(rowObject);
  }

  transition(executionId, expectedState, expectedRevision, nextState) {
    assert.ok(
      transitions[expectedState]?.has(nextState),
      `illegal transition ${expectedState} -> ${nextState}`,
    );
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE executions SET state = ?, revision = revision + 1, updated_at = ? WHERE execution_id = ? AND state = ? AND revision = ?",
        )
        .run(nextState, now(), executionId, expectedState, expectedRevision);
      assert.equal(
        result.changes,
        1,
        "execution state changed; reconcile before retry",
      );
      return this.getExecution(executionId);
    });
  }

  attachPane(executionId, expectedRevision, paneId) {
    assert.ok(paneId, "paneId required");
    return this.#updateBound(executionId, expectedRevision, "pane_id", paneId);
  }

  bindWorker(executionId, expectedRevision, workerSessionId) {
    assert.ok(workerSessionId, "workerSessionId required");
    return this.#updateBound(
      executionId,
      expectedRevision,
      "worker_session_id",
      workerSessionId,
    );
  }

  #updateBound(executionId, expectedRevision, column, value) {
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE executions SET ${column} = ?, revision = revision + 1, updated_at = ? WHERE execution_id = ? AND revision = ? AND (${column} IS NULL OR ${column} = ?)`,
        )
        .run(value, now(), executionId, expectedRevision, value);
      assert.equal(
        result.changes,
        1,
        "execution binding changed; reconcile before retry",
      );
      return this.getExecution(executionId);
    });
  }

  recordEvent(event) {
    validateEvent(event);
    const eventDigest = digest(event);
    return transaction(this.db, () => {
      const execution = this.getExecution(event.executionId);
      assert.equal(
        event.ownerEpoch,
        execution.ownerEpoch,
        "event owner epoch mismatch",
      );
      if (execution.workerSessionId)
        assert.equal(
          event.workerSessionId,
          execution.workerSessionId,
          "event worker session mismatch",
        );
      const existing = this.db
        .prepare(
          "SELECT event_digest FROM execution_events WHERE execution_id = ? AND event_id = ?",
        )
        .get(event.executionId, event.eventId);
      if (existing) {
        assert.equal(
          existing.event_digest,
          eventDigest,
          "event id reused with different content",
        );
        return { disposition: "duplicate", eventDigest };
      }
      const sequence = this.db
        .prepare(
          "SELECT event_digest FROM execution_events WHERE execution_id = ? AND sequence = ?",
        )
        .get(event.executionId, event.sequence);
      assert.ok(!sequence, "event sequence conflict");
      this.db
        .prepare("INSERT INTO execution_events VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          event.executionId,
          event.eventId,
          event.sequence,
          eventDigest,
          canonicalBytes(event).toString("utf8"),
          now(),
        );
      if (event.type === "heartbeat")
        this.db
          .prepare(
            "UPDATE executions SET heartbeat_at = ?, updated_at = ? WHERE execution_id = ?",
          )
          .run(event.occurredAt, now(), event.executionId);
      return { disposition: "recorded", eventDigest };
    });
  }

  recordResult(
    executionId,
    resultRevision,
    resultDigest,
    sourceDigest,
    resultRef,
    unresolvedRunCount,
  ) {
    assert.ok(path.isAbsolute(resultRef), "absolute result reference required");
    return transaction(this.db, () => {
      const execution = this.getExecution(executionId);
      assert.ok(
        ["RUNNING", "RESULT_READY", "UNKNOWN"].includes(execution.state),
        "execution is not accepting results",
      );
      const existing = this.db
        .prepare(
          "SELECT * FROM results WHERE execution_id = ? AND result_revision = ?",
        )
        .get(executionId, resultRevision);
      if (existing) {
        assert.equal(
          existing.result_digest,
          resultDigest,
          "result revision changed",
        );
        return { disposition: "duplicate", resultDigest };
      }
      this.db
        .prepare("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          executionId,
          resultRevision,
          resultDigest,
          sourceDigest,
          resultRef,
          now(),
        );
      this.db
        .prepare(
          "UPDATE executions SET result_digest = ?, source_digest = ?, unresolved_run_count = ?, updated_at = ? WHERE execution_id = ?",
        )
        .run(
          resultDigest,
          sourceDigest,
          unresolvedRunCount,
          now(),
          executionId,
        );
      return { disposition: "recorded", resultDigest };
    });
  }

  listTaskExecutions(projectId, goalId, taskId) {
    // Contracts permit at most one process restart; a third row is enough to reject.
    return this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND goal_id = ? AND task_id = ? ORDER BY created_at, rowid LIMIT 3",
      )
      .all(projectId, goalId, taskId)
      .map(rowObject);
  }

  findLatestTask(projectId, goalId, taskId) {
    const row = this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND goal_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId, goalId, taskId);
    return rowObject(row);
  }

  listProjectOpen(projectId) {
    return this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND reservation_open = 1 ORDER BY created_at",
      )
      .all(projectId)
      .map(rowObject);
  }

  listTaskOpen(projectId, taskId) {
    return this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND task_id = ? AND reservation_open = 1 ORDER BY created_at",
      )
      .all(projectId, taskId)
      .map(rowObject);
  }

  listGoalOpen(projectId, goalId) {
    return this.db
      .prepare(
        "SELECT * FROM executions WHERE project_id = ? AND goal_id = ? AND reservation_open = 1 ORDER BY created_at",
      )
      .all(projectId, goalId)
      .map(rowObject);
  }

  recordRoleIntent(executionId, eventId, role, reservedTokens) {
    assert.match(role, /^team\.[A-Za-z0-9._-]+$/, "invalid role budget key");
    assert.ok(
      Number.isSafeInteger(reservedTokens) && reservedTokens > 0,
      "positive reserved tokens required",
    );
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT 1 FROM task_budget_events WHERE execution_id = ? AND event_id = ?",
        )
        .get(executionId, eventId);
      if (existing) return { disposition: "duplicate" };
      const execution = this.getExecution(executionId);
      const contract = this.getContract(executionId);
      assert.ok(
        contract.policy.allowedRoles.includes(role),
        `role not allowed: ${role}`,
      );
      const totals = this.db
        .prepare(
          "SELECT COALESCE(SUM(spawns), 0) AS spawns, COALESCE(SUM(reserved_tokens), 0) AS tokens FROM task_budgets WHERE project_id = ? AND goal_id = ? AND task_id = ?",
        )
        .get(execution.projectId, execution.goalId, execution.taskId);
      assert.ok(
        totals.spawns + 1 <= contract.policy.maxRoleSpawnsPerTask,
        "role spawn budget exhausted",
      );
      assert.ok(
        usesSharedTaskBudget(contract) ||
          totals.tokens + reservedTokens <= contract.policy.maxTaskTokens,
        "task token budget exhausted",
      );
      this.db
        .prepare(
          `INSERT INTO task_budgets(project_id, goal_id, task_id, role, spawns, reserved_tokens)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(project_id, goal_id, task_id, role)
           DO UPDATE SET spawns = spawns + 1, reserved_tokens = reserved_tokens + excluded.reserved_tokens`,
        )
        .run(
          execution.projectId,
          execution.goalId,
          execution.taskId,
          role,
          reservedTokens,
        );
      this.db
        .prepare("INSERT INTO task_budget_events VALUES (?, ?, ?, ?, ?)")
        .run(executionId, eventId, role, reservedTokens, now());
      return { disposition: "recorded" };
    });
  }

  getTaskBudget(projectId, goalId, taskId) {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_budgets WHERE project_id = ? AND goal_id = ? AND task_id = ? ORDER BY role",
      )
      .all(projectId, goalId, taskId);
    return {
      roles: rows.map((row) => ({
        role: row.role,
        spawns: row.spawns,
        reservedTokens: row.reserved_tokens,
        usedTokens: row.used_tokens,
      })),
      spawns: rows.reduce((sum, row) => sum + row.spawns, 0),
      reservedTokens: rows.reduce((sum, row) => sum + row.reserved_tokens, 0),
    };
  }

  getAcceptance(executionId) {
    const row = this.db
      .prepare("SELECT * FROM acceptances WHERE execution_id = ?")
      .get(executionId);
    if (!row) return null;
    return {
      acceptanceId: row.acceptance_id,
      executionId: row.execution_id,
      requestDigest: row.request_digest,
      resultDigest: row.result_digest,
      sourceDigest: row.source_digest,
      decision: row.decision,
      receiptRef: row.receipt_ref,
      controllerEpoch: row.controller_epoch,
      acceptedAt: row.accepted_at,
    };
  }

  getLatestResult(executionId) {
    const row = this.db
      .prepare(
        "SELECT * FROM results WHERE execution_id = ? ORDER BY result_revision DESC LIMIT 1",
      )
      .get(executionId);
    assert.ok(row, `result not found: ${executionId}`);
    return {
      executionId: row.execution_id,
      resultRevision: row.result_revision,
      resultDigest: row.result_digest,
      sourceDigest: row.source_digest,
      resultRef: row.result_ref,
      createdAt: row.created_at,
    };
  }

  saveAcceptance(receipt) {
    return transaction(this.db, () => {
      const execution = this.getExecution(receipt.executionId);
      assert.equal(
        execution.state,
        "VALIDATING",
        "execution is not validating",
      );
      assert.equal(
        execution.requestDigest,
        receipt.requestDigest,
        "acceptance request mismatch",
      );
      assert.equal(
        execution.resultDigest,
        receipt.resultDigest,
        "acceptance result mismatch",
      );
      assert.equal(
        execution.sourceDigest,
        ["teams-task-acceptance/2", "teams-task-acceptance/3"].includes(
          receipt.schemaVersion,
        )
          ? receipt.candidateSourceDigest
          : receipt.sourceDigest,
        "acceptance source mismatch",
      );
      assert.equal(
        execution.unresolvedRunCount,
        0,
        "execution has unresolved runs",
      );
      const controller = this.getController(execution.projectId);
      assert.equal(
        controller.ownerSessionId,
        receipt.acceptedBySessionId,
        "acceptance controller changed",
      );
      assert.equal(
        controller.ownerEpoch,
        receipt.controllerEpoch,
        "acceptance controller epoch changed",
      );
      assert.equal(
        execution.ownerSessionId,
        receipt.acceptedBySessionId,
        "acceptance execution owner changed",
      );
      assert.equal(
        execution.ownerEpoch,
        receipt.controllerEpoch,
        "acceptance execution epoch changed",
      );
      if (
        this.getContract(execution.executionId).schemaVersion ===
        "teams-task-runtime/3"
      )
        assert.equal(
          receipt.schemaVersion,
          this.getContract(execution.executionId).policy.integrationMode ===
            "verify-only"
            ? "teams-task-acceptance/3"
            : "teams-task-acceptance/2",
          "integrated acceptance receipt required",
        );
      const existing = this.db
        .prepare("SELECT * FROM acceptances WHERE execution_id = ?")
        .get(receipt.executionId);
      if (existing) {
        assert.equal(
          existing.acceptance_id,
          receipt.acceptanceId,
          "execution already has another acceptance",
        );
        return { disposition: "duplicate" };
      }
      this.db
        .prepare("INSERT INTO acceptances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          receipt.acceptanceId,
          receipt.executionId,
          receipt.requestDigest,
          receipt.resultDigest,
          receipt.sourceDigest,
          receipt.decision,
          receipt.receiptRef,
          receipt.controllerEpoch,
          receipt.acceptedAt,
        );
      this.db
        .prepare(
          "UPDATE executions SET state = 'ACCEPTED', revision = revision + 1, goal_commit_state = 'prepared', updated_at = ? WHERE execution_id = ?",
        )
        .run(now(), receipt.executionId);
      return { disposition: "saved" };
    });
  }

  markGoalCommitted(executionId, acceptanceId) {
    return transaction(this.db, () => {
      const current = this.getExecution(executionId);
      if (current.goalCommitState === "committed") return current;
      const acceptance = this.db
        .prepare("SELECT acceptance_id FROM acceptances WHERE execution_id = ?")
        .get(executionId);
      assert.equal(
        acceptance?.acceptance_id,
        acceptanceId,
        "acceptance identity mismatch",
      );
      const result = this.db
        .prepare(
          "UPDATE executions SET goal_commit_state = 'committed', revision = revision + 1, updated_at = ? WHERE execution_id = ? AND state = 'ACCEPTED'",
        )
        .run(now(), executionId);
      assert.equal(result.changes, 1, "accepted execution changed");
      return this.getExecution(executionId);
    });
  }

  // The host must verify drain and pane closure before calling this for a
  // launched execution. One CAS avoids CANCELLED-with-an-open-reservation crashes.
  finishCancellation(executionId, expectedRevision, ownerSessionId) {
    const result = this.db
      .prepare(`UPDATE executions
      SET state = 'CANCELLED', reservation_open = 0, unresolved_run_count = 0,
          revision = revision + 1, updated_at = ?
      WHERE execution_id = ? AND revision = ? AND owner_session_id = ?
        AND state IN ('RESERVED', 'CANCEL_REQUESTED', 'CANCELLED')
        AND EXISTS (SELECT 1 FROM controllers c WHERE c.project_id = executions.project_id
          AND c.owner_session_id = executions.owner_session_id AND c.owner_epoch = executions.owner_epoch)`)
      .run(now(), executionId, expectedRevision, ownerSessionId);
    assert.equal(
      result.changes,
      1,
      "cancellation owner or execution changed; reconcile before retry",
    );
    return this.getExecution(executionId);
  }

  releaseReservation(executionId) {
    return transaction(this.db, () => {
      const execution = this.getExecution(executionId);
      if (!execution.reservationOpen) return execution;
      assert.ok(
        terminal.has(execution.state),
        "only terminal executions release reservations",
      );
      assert.equal(
        execution.unresolvedRunCount,
        0,
        "unresolved runs block reservation release",
      );
      if (execution.state === "ACCEPTED")
        assert.equal(
          execution.goalCommitState,
          "committed",
          "Goal commit must be confirmed before release",
        );
      this.db
        .prepare(
          "UPDATE executions SET reservation_open = 0, revision = revision + 1, updated_at = ? WHERE execution_id = ?",
        )
        .run(now(), executionId);
      return this.getExecution(executionId);
    });
  }
}
