import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  pkg,
  host,
  runnerProbe,
  rpcErrorReply,
} from "./native-launch-fixture.mjs";
import { SubagentsRpcClient } from "../capabilities.mjs";

test("installed Pi resolves all required background aliases without unused chord peers", async () => {
  const file = path.join(pkg, "src/runs/background/runner-aliases.ts");
  const js = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
  const { resolveHostPeerAliases } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  const result = resolveHostPeerAliases(host, pkg);
  assert.deepEqual(result.missing, []);
  assert.ok(Object.values(result.aliases).every((file) => fs.existsSync(file)));
  // Load actual host export targets, not just file existence. No session or
  // provider is created; detached runner/LLM execution is not claimed here.
  for (const file of new Set(Object.values(result.aliases)))
    await import(pathToFileURL(file).href);
});

test("runner pre-spawn failures carry terminal no-start proof, not only text", () => {
  for (const overrides of [
    {
      resolveHostPeerAliases: () => ({
        missing: ["required-peer"],
        aliases: {},
        supplemental: [],
      }),
    },
    { jitiCliPath: null },
    { piPackageRoot: null },
    { preflightLaunchCwd: () => "cwd unavailable" },
    {
      resolveNodeExecutable: () => {
        throw new Error("node unavailable");
      },
    },
    {
      getAsyncConfigPath: () => {
        throw new Error("config unavailable");
      },
    },
    {
      resolveAsyncRunnerLogPaths: () => {
        throw new Error("log setup unavailable");
      },
    },
    {
      backgroundProcessOptions: () => {
        throw new Error("process options unavailable");
      },
    },
    {
      omitExtensionBindingsEnv: () => {
        throw new Error("environment preparation failed");
      },
    },
  ]) {
    const p = runnerProbe(overrides),
      r = p.run();
    assert.equal(p.spawns(), 0);
    assert.equal(
      r.notStarted?.lifecycleStatus?.processTerminal?.state,
      "not-started",
    );
    assert.equal(
      r.notStarted.lifecycleStatus.processTerminal.reason,
      "spawn-not-attempted",
    );
    const status = p.saved.get("/fixture/run/status.json");
    assert.equal(status.state, "failed");
    assert.equal(status.sessionId, "worker-1");
    assert.equal(status.cwd, "/fixture/cwd");
    assert.equal(status.sessionRoot, "/fixture/sessions");
    assert.equal(status.pid, undefined);
    assert.equal(status.steps[0].status, "failed");
    assert.equal(
      p.native.formatAsyncStartError("single", r.error, r.notStarted).details
        .runId,
      "test-run",
    );
  }
});

test("same runner success path still spawns once; post-spawn uncertainty is never no-start", () => {
  const p = runnerProbe(),
    r = p.run();
  assert.equal(p.spawns(), 1);
  assert.equal(r.pid, 12345);
  assert.equal(r.notStarted, undefined);
  const ambiguous = runnerProbe({
    spawn() {
      throw new Error("ambiguous spawn failure");
    },
  }).run();
  assert.match(ambiguous.error, /ambiguous/);
  assert.equal(ambiguous.notStarted, undefined);
});

test("failure to persist no-start evidence must not certify zero execution", () => {
  const p = runnerProbe({
    jitiCliPath: null,
    writePrivateAtomicJson() {
      throw new Error("disk full");
    },
  });
  const r = p.run();
  assert.equal(p.spawns(), 0);
  assert.equal(r.notStarted, undefined);
  assert.ok(r.error);
});

test("revival and existing status are not rewritten as fresh zero-execution failures", () => {
  assert.equal(
    runnerProbe({ jitiCliPath: null }).run({ revivalLease: {} }).notStarted,
    undefined,
  );
  const p = runnerProbe({
    jitiCliPath: null,
    fs: {
      existsSync() {
        return true;
      },
    },
  });
  assert.equal(p.run().notStarted, undefined);
  assert.equal(p.saved.size, 0);
});

test("both native single and chain producers pass startup evidence to their error result", () => {
  const file = fs.readFileSync(
    path.join(pkg, "src/runs/background/async-execution.ts"),
    "utf8",
  );
  // Wiring assertion complements executable producer tests; does not certify E2E.
  assert.equal(
    (file.match(/spawnResult\.error\}`, spawnResult\.notStarted/g) ?? [])
      .length,
    2,
  );
});

test("actual native RPC preserves error details through the Task RPC client", async () => {
  const p = runnerProbe({ jitiCliPath: null }),
    r = p.run();
  const result = p.native.formatAsyncStartError(
    "single",
    r.error,
    r.notStarted,
  );
  const listeners = new Map();
  const client = new SubagentsRpcClient({
    on(event, fn) {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    emit(_event, request) {
      listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)(
        rpcErrorReply(result, request),
      );
    },
  });
  await assert.rejects(client.request("spawn", {}), (error) => {
    assert.equal(error.code, "execution_failed");
    assert.equal(error.details.runId, "test-run");
    assert.equal(
      error.details.lifecycleStatus.processTerminal.reason,
      "spawn-not-attempted",
    );
    assert.match(error.requestId, /^[a-f0-9-]+$/);
    return true;
  });
});
