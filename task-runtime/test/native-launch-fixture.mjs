// Test-only: exact installed producer/RPC bodies with bounded IO doubles.
// Never import or start an extension, runner, model or provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
export const pkg = path.join(
  os.homedir(),
  ".pi/agent/npm/node_modules/pi-subagents",
);
export const host = path.dirname(
  path.dirname(
    path.dirname(fs.realpathSync(process.execPath.replace(/\/node$/, "/pi"))),
  ),
);
const { parse } = createRequire(path.join(pkg, "package.json"))("acorn");
export function nativeDefinitions(relative, names) {
  const file = path.join(pkg, relative);
  const js = stripTypeScriptTypes(fs.readFileSync(file, "utf8"));
  const ast = parse(js, { ecmaVersion: "latest", sourceType: "module" });
  return names
    .map((name) => {
      const node = ast.body
        .map((n) => n.declaration ?? n)
        .find((n) => n.id?.name === name);
      assert.ok(node, `missing native definition ${name}`);
      return js
        .slice(node.start, node.end)
        .replaceAll(
          "import.meta.url",
          JSON.stringify(pathToFileURL(file).href),
        );
    })
    .join("\n");
}
export function runnerProbe(overrides = {}) {
  const source = nativeDefinitions("src/runs/background/async-execution.ts", [
    "spawnRunner",
    "formatAsyncStartError",
  ]);
  let spawns = 0;
  const saved = new Map();
  const sandbox = {
    path,
    fileURLToPath: (url) => new URL(url).pathname,
    randomUUID,
    process: { env: {} },
    console,
    preflightLaunchCwd: () => null,
    jitiCliPath: "/fixture/jiti",
    piPackageRoot: host,
    PI_CODING_AGENT_PACKAGE: "@earendil-works/pi-coding-agent",
    resolveHostPeerAliases: () => ({
      aliases: {},
      missing: [],
      supplemental: [],
    }),
    TEMP_ROOT_DIR: "/fixture",
    getAsyncConfigPath: () => "/fixture/config.json",
    writePrivateAtomicJson: (file, value) =>
      saved.set(file, structuredClone(value)),
    fs: {
      mkdirSync() {},
      openSync() {
        return 1;
      },
      rmSync() {},
      existsSync() {
        return false;
      },
    },
    resolveNodeExecutable: () => process.execPath,
    resolveAsyncRunnerLogPaths: () => null,
    backgroundProcessOptions: () => ({}),
    omitExtensionBindingsEnv: (v) => v,
    PI_CODING_AGENT_PACKAGE_ROOT_ENV: "PI_HOST",
    JITI_ALIAS_ENV: "JITI_ALIAS",
    closeFd() {},
    initializeProcessTerminal() {},
    writeRunnerStartupControl() {},
    processTerminalPath: (dir) => path.join(dir, "process-terminal.json"),
    spawn() {
      spawns++;
      return { pid: 12345, on() {}, once() {}, unref() {} };
    },
    ...overrides,
  };
  const native = vm.runInNewContext(
    source + "\n({spawnRunner,formatAsyncStartError})",
    sandbox,
  );
  function run(options = {}) {
    const {
      runId = "test-run",
      cwd = "/fixture/cwd",
      sessionId = "worker-1",
      sessionDir = "/fixture/sessions",
      asyncDir = "/fixture/run",
      members = [{ role: "team.reviewer" }],
      revivalLease,
    } = options;
    const initial = {
      runId,
      sessionId,
      mode: "single",
      state: "running",
      steps: members.map((m) => ({
        agent: m.role,
        ...(m.key ? { workflowKey: m.key } : {}),
        status: "pending",
      })),
    };
    return native.spawnRunner(
      { id: runId, asyncDir, sessionDir, revivalLease },
      runId,
      cwd,
      initial,
      path.join(asyncDir, "status.json"),
    );
  }
  return { run, saved, native, spawns: () => spawns };
}

// Exercise native result -> native RPC error serialization, not a hand-crafted
// error message. Task's real SubagentsRpcClient consumes this correlated reply.
export function rpcErrorReply(result, request) {
  const source = nativeDefinitions("src/extension/rpc.ts", [
    "SubagentRpcError",
    "isRecord",
    "textFromToolResult",
    "failIfToolError",
    "safeReplyRequestId",
    "errorReply",
  ]);
  const native = vm.runInNewContext(
    source + "\n({failIfToolError,errorReply})",
    {
      SUBAGENT_RPC_PROTOCOL_VERSION: 1,
      SUBAGENT_RPC_METHODS: ["spawn"],
    },
  );
  try {
    native.failIfToolError(result);
  } catch (error) {
    return structuredClone(native.errorReply(request, error));
  }
  throw new Error("fixture expected a native failed result");
}

export function failingNativeBus(options = {}) {
  const listeners = new Map();
  let count = 0;
  return {
    count: () => count,
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    emit(event, request) {
      if (event !== "subagents:rpc:v1:request") return;
      count++;
      const probe = runnerProbe({ jitiCliPath: null });
      const asyncDir = path.join(
        request.params.sessionDir,
        "native-failed-start",
      );
      const run = probe.run({
        sessionDir: request.params.sessionDir,
        cwd: request.params.cwd,
        asyncDir,
        runId: `failed-${count}`,
        sessionId: options.owner ?? "worker-1",
        members: options.members ?? [{ role: request.params.agent }],
      });
      for (const [file, status] of probe.saved) {
        if (path.basename(file) === "status.json")
          options.mutateStatus?.(status);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(status));
      }
      const result = probe.native.formatAsyncStartError(
        "single",
        run.error,
        run.notStarted,
      );
      const reply = rpcErrorReply(result, request);
      options.mutateReply?.(reply);
      listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.(reply);
    },
  };
}
