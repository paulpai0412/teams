import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readNativeTerminal,
  nativeWorkflowResult,
} from "../role-lifecycle.mjs";
import { compileRoleWave } from "../role-wave.mjs";
import { runInNewContext } from "node:vm";

// Public hosted-workflow shape observed in d941a0c9. Identities/paths are
// synthetic; no detached process proof is added to the recorded run.
function fixture() {
  const launch = {
    runId: "wave",
    asyncDir: "/native/wave",
    mode: "wave",
    hostedWorkflow: { version: 1, pid: 12345 },
    members: [{ key: "app", role: "team.implementer" }],
  };
  const status = {
    runId: "wave",
    sessionId: "owner",
    cwd: "/source",
    pid: 12345,
    mode: "workflow",
    state: "complete",
    workflowChildren: {
      version: 1,
      workflowRunId: "wave",
      inventoryComplete: true,
      workflowState: "completed",
      children: [
        {
          childId: "app",
          runId: "child",
          agent: "team.implementer",
          state: "completed",
        },
      ],
    },
    steps: [
      {
        workflowKey: "app",
        runId: "child",
        agent: "team.implementer",
        async: false,
        status: "completed",
        sessionFile: "/sessions/child.jsonl",
      },
    ],
  };
  return {
    launch,
    status,
    read: () =>
      readNativeTerminal(launch, ["owner"], () =>
        Buffer.from(JSON.stringify(status)),
      ),
  };
}

test("parallel native launches receive distinct session roots before exclusive session creation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-session-roots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const children = ["review", "browser"].map((key) => ({
    key,
    agent: "team.reviewer",
    task: "fixture",
    async: false,
  }));
  const script = compileRoleWave(children, root);
  const run = runInNewContext(`(async function(runs) { ${script} })`);
  const files = [];
  await run({
    all: async (items) =>
      Promise.all(
        items.map(async (child) => {
          const file = path.join(
            child.sessionDir ?? root,
            "run-0/session.jsonl",
          );
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, child.key, { flag: "wx" });
          files.push(file);
          return { ok: true };
        }),
      ),
  });
  assert.equal(new Set(files).size, 2);
  for (const child of children)
    assert.equal(
      fs.readFileSync(
        path.join(root, child.key, "run-0/session.jsonl"),
        "utf8",
      ),
      child.key,
    );
  assert.throws(() =>
    compileRoleWave([{ ...children[0], key: "../escape" }], root),
  );
});

test("hosted workflow settles its sessions without inventing process-terminal evidence", () => {
  const f = fixture();
  const proof = f.read();
  assert.equal(proof.completion, "completed");
  assert.equal(proof.processTerminal, undefined);
  assert.equal(proof.hostedTerminal.state, "settled");
  assert.equal(proof.hostedTerminal.pid, 12345);
  assert.equal(proof.hostedTerminal.runId, "wave");
  assert.match(proof.hostedTerminal.inventoryDigest, /^[a-f0-9]{64}$/);
  f.status.lastUpdate = 123;
  assert.deepEqual(
    f.read(),
    proof,
    "display timestamps do not change settled identity",
  );
  delete f.launch.hostedWorkflow;
  assert.throws(
    f.read,
    /native cancellation proof missing/,
    "old launches cannot be retroactively accepted",
  );
});

test("hosted completion requires exact host, owner, inventory and settled in-process children", () => {
  for (const mutate of [
    (f) => {
      f.status.pid++;
    },
    (f) => {
      f.status.sessionId = "foreign";
    },
    (f) => {
      f.status.mode = "single";
    },
    (f) => {
      f.status.workflowChildren.inventoryComplete = false;
    },
    (f) => {
      f.status.workflowChildren.workflowRunId = "foreign";
    },
    (f) => {
      f.status.workflowChildren.workflowState = "running";
    },
    (f) => {
      f.status.workflowChildren.children = [];
    },
    (f) => {
      f.status.workflowChildren.children[0].runId = "foreign";
    },
    (f) => {
      f.status.steps[0].async = true;
    },
    (f) => {
      delete f.status.steps[0].async;
    },
    (f) => {
      f.status.steps[0].status = "running";
    },
    (f) => {
      f.status.steps[0].children = [{ runId: "nested" }];
    },
    (f) => {
      f.status.processTerminal = {
        version: 1,
        state: "unknown",
        runId: "wave",
      };
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.read);
  }
  const f = fixture();
  f.status.state = "running";
  assert.equal(f.read(), null);
});

test("compiler retains bounded public result fields instead of transcripts or guessed metadata paths", async () => {
  const script = compileRoleWave([
    { key: "app", agent: "team.implementer", task: "fixture" },
  ]);
  // Execute only this repository's trusted compiler output against a fake API.
  const run = runInNewContext(`(async function(runs) { ${script} })`);
  const rows = JSON.parse(
    JSON.stringify(
      await run({
        all: async () => [
          {
            ok: true,
            runId: "child",
            results: [
              {
                index: 0,
                agent: "team.implementer",
                context: "fresh",
                exitCode: 0,
                sessionFile: "/sessions/child.jsonl",
                launchContractDigest: "digest",
                acceptance: { status: "checked" },
                messages: ["not forwarded"],
                error: undefined,
              },
            ],
          },
        ],
      }),
    ),
  );
  const f = fixture();
  f.status.workflow = { value: rows };
  const result = nativeWorkflowResult(f.status, f.status.steps[0]);
  assert.equal(result.launchContractDigest, "digest");
  assert.equal(result.acceptance.status, "checked");
  assert.equal(Object.hasOwn(result, "messages"), false);
  assert.equal(Object.hasOwn(rows[0].nativeResults[0], "error"), false);
  rows[0].nativeResults[0].sessionFile = "/foreign/session.jsonl";
  assert.throws(
    () => nativeWorkflowResult(f.status, f.status.steps[0]),
    /session changed/,
  );
});

test("failed hosted sessions can drain but cannot be represented as successful work", () => {
  const f = fixture();
  f.status.state = "failed";
  f.status.workflowChildren.workflowState = "failed";
  f.status.workflowChildren.children[0].state = "failed";
  f.status.steps[0].status = "failed";
  assert.equal(f.read().completion, "failed");
});
