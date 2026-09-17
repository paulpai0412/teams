import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as runner from "../e2e/run-todo-flow.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g1-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "source");
  fs.mkdirSync(cwd);
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const session = (file, id, amount) =>
    fs.writeFileSync(
      file,
      [
        { type: "session", id, cwd, version: 3 },
        {
          type: "message",
          id: "original-approval",
          message: { role: "user", content: [] },
        },
        {
          type: "message",
          id: "usage",
          message: {
            role: "assistant",
            usage: {
              input: amount,
              output: 0,
              cacheRead: amount,
              cacheWrite: 0,
              totalTokens: amount * 2,
            },
          },
        },
        {
          type: "message",
          id: "new-group",
          message: { role: "user", content: [] },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
  const parent = path.join(root, "parent.jsonl");
  const old = path.join(root, "old.jsonl");
  session(parent, "parent", 100);
  session(old, "old-worker", 200);
  const specs = ["a", "b"].map((taskId) => {
    const file = path.join(root, `${taskId}.json`);
    save(file, {
      goalId: "pending",
      taskId,
      taskRevision: 1,
      workspace: { sourceRoot: cwd },
      policy: { maxTaskTokens: 5000000 },
    });
    return file;
  });
  const config = {
    specPaths: specs,
    budget: {
      maxTokens: 10001000,
      parent: { file: parent, authorizationEntryId: "original-approval" },
      history: [{ file: old, sha256: sha(fs.readFileSync(old)) }],
    },
  };
  const file = path.join(root, "attempt.json");
  const load = () => {
    save(file, config);
    return runner.loadAttemptInputs(file, cwd, parent);
  };
  return { root, cwd, parent, old, config, file, load, save };
}

test("single and multi-Task admission derives reservations from specs, not a policy scalar", (t) => {
  const f = fixture(t);
  const inputs = f.load();
  assert.equal(inputs.taskTokenReservation, 10000000);
  assert.equal(inputs.authorizationEntryId, "original-approval");
  assert.equal(inputs.maxTokens, 10001000);
  assert.equal(inputs.preparation.specs.length, 2);
  f.config.specPaths.pop();
  assert.equal(f.load().taskTokenReservation, 5000000);
});

test("history includes cache and original parent anchor; no reservation counted as actual usage", (t) => {
  const f = fixture(t),
    inputs = f.load();
  const parent = runner.parentUsage(f.parent, inputs.authorizationEntryId);
  const history = runner.historicalUsage(
    inputs.historicalSessions,
    parent.sessionId,
  );
  assert.equal(parent.usage.total, 200);
  assert.equal(history.totals.total, 400);
  assert.equal(
    runner.assertBudget(
      parent,
      10,
      inputs.taskTokenReservation,
      inputs.maxTokens,
      history.totals.total,
    ),
    10000610,
  );
  assert.throws(
    () =>
      runner.assertBudget(
        parent,
        401,
        inputs.taskTokenReservation,
        inputs.maxTokens,
        history.totals.total,
      ),
    /aggregate budget exhausted/,
  );
});

test("missing, duplicate, foreign and unsafe admission inputs fail before any Pi spawn", (t) => {
  for (const mutation of [
    (f) => {
      delete f.config.budget.history;
    },
    (f) => {
      f.config.specPaths = [];
    },
    (f) => {
      f.config.specPaths[1] = f.config.specPaths[0];
    },
    (f) => {
      f.save(
        f.config.specPaths[1],
        JSON.parse(fs.readFileSync(f.config.specPaths[0])),
      );
    },
    (f) => {
      f.config.budget.parent.file = f.old;
    },
    (f) => {
      f.config.budget.maxTokens = Number.MAX_SAFE_INTEGER + 1;
    },
    (f) => {
      const s = JSON.parse(fs.readFileSync(f.config.specPaths[0]));
      s.workspace.sourceRoot = f.root;
      f.save(f.config.specPaths[0], s);
    },
    (f) => {
      const s = JSON.parse(fs.readFileSync(f.config.specPaths[0]));
      delete s.policy.maxTaskTokens;
      f.save(f.config.specPaths[0], s);
    },
  ]) {
    const f = fixture(t);
    mutation(f);
    assert.throws(f.load);
  }
});

test("historical usage refuses tampering, missing sources and duplicate session identities", (t) => {
  for (const mutation of [
    (_f, rows) => {
      rows[0].sha256 = "0".repeat(64);
    },
    (_f, rows) => {
      rows[0].file += ".missing";
    },
    (_f, rows) => {
      rows.push(rows[0]);
    },
    (f, rows) => {
      rows[0] = { file: f.parent, sha256: sha(fs.readFileSync(f.parent)) };
    },
    (f, rows) => {
      const copy = path.join(f.root, "copy.jsonl");
      fs.copyFileSync(f.old, copy);
      rows.push({ ...rows[0], file: copy });
    },
  ]) {
    const f = fixture(t),
      inputs = f.load();
    mutation(f, inputs.historicalSessions);
    assert.throws(() =>
      runner.historicalUsage(inputs.historicalSessions, "parent"),
    );
  }
});

test("actual CLI rejects exhausted aggregate before launching public Pi", (t) => {
  const f = fixture(t);
  f.config.budget.maxTokens = 10000600;
  f.load();
  const output = path.join(f.root, "live");
  const run = spawnSync(
    process.execPath,
    [new URL("../e2e/run-todo-flow.mjs", import.meta.url).pathname, output],
    {
      env: {
        ...process.env,
        PI_SESSION_FILE: f.parent,
        TEAMS_E2E_WORKSPACE: f.cwd,
        TEAMS_E2E_INPUT_FILE: f.file,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /aggregate budget exhausted/);
  assert.equal(fs.existsSync(output), false);
});
