import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoleController } from "../role-controller.mjs";

// Control-port fixture only. No agent, model, network or process is launched.
function fixture(t, { single = false, unknown = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, "native");
  fs.mkdirSync(asyncDir);
  const receipts = path.join(root, "receipts");
  fs.mkdirSync(receipts);
  const members = (single ? ["role"] : ["alpha", "beta"]).map((key) => ({
    key,
    role: "team.implementer",
    mode: "read-only",
    isolation: "shared",
    maxTokens: 10,
  }));
  const status = {
    runId: "owned-run",
    cwd: root,
    sessionId: "worker",
    state: "running",
    steps: members.map((member) => ({
      agent: member.role,
      ...(single ? {} : { workflowKey: member.key }),
      status: "running",
    })),
  };
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
  const calls = [],
    events = [];
  const runtime = {
    contract: {
      schemaVersion: "teams-task-runtime/3",
      workspace: { sourceRoot: root },
    },
    mailbox: {
      root,
      readJson(ref) {
        assert.equal(ref, "receipts/boot.json");
        return { workerSessionId: "worker" };
      },
    },
    assertAdmission() {},
    recordProgress(id, value) {
      events.push(value);
      fs.writeFileSync(
        path.join(receipts, `progress-${id}.json`),
        JSON.stringify(value),
      );
    },
  };
  const roles = new RoleController({
    runtime,
    cwd: root,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        if (unknown) throw new Error("transport outcome unknown");
        return { requested: true };
      },
    },
  });
  roles.launches.set("launch", {
    launchId: "launch",
    runId: "owned-run",
    asyncDir,
    members,
    mode: single ? "read-only" : "wave",
    terminal: false,
  });
  return { roles, calls, events, status, asyncDir };
}

for (const single of [false, true])
  test(`targeted stop is owned, one-shot and not terminal proof (single=${single})`, async (t) => {
    const f = fixture(t, { single });
    const input = {
      action: "stop",
      runId: "owned-run",
      key: single ? "role" : "beta",
      reason: "Diagnose only this branch; preserve its sibling.",
    };
    await assert.rejects(
      f.roles.control({ ...input, runId: "foreign-task" }),
      /not owned/,
    );
    await assert.rejects(
      f.roles.control({ ...input, key: "foreign-member" }),
      /not owned/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.roles.control(input)).disposition, "stop-requested");
    assert.deepEqual(f.calls, [
      {
        method: "stop",
        params: { id: input.runId, ...(single ? {} : { childId: input.key }) },
      },
    ]);
    assert.equal(f.roles.snapshot().unresolvedRunCount, 1);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.asyncDir, "status.json"))),
      f.status,
      "ACK changes no native state or sibling",
    );
    await assert.rejects(f.roles.control(input), /never replay/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      f.events.map((row) => row.kind),
      ["branch-stop-intent", "branch-stop-reply"],
    );
  });

test("unknown branch stop preserves intent and cannot be replayed", async (t) => {
  const f = fixture(t, { unknown: true });
  const input = {
    action: "stop",
    runId: "owned-run",
    key: "beta",
    reason: "Stop one bounded branch.",
  };
  await assert.rejects(f.roles.control(input), /transport outcome unknown/);
  await assert.rejects(f.roles.control(input), /never replay/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.roles.snapshot().unresolvedRunCount, 1);
  assert.equal(f.events.at(-1).kind, "branch-stop-unknown");
});
