import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  inspectBackgroundHost,
  modelId,
  readTaskModels,
} from "./capabilities.mjs";

function shellArg(value) {
  assert.ok(
    typeof value === "string" && !value.includes("\0"),
    "safe command argument required",
  );
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function workerCommand({
  piExecutable,
  workerExtension,
  subagentsExtension,
  executionRoot,
  model = readTaskModels().taskPi,
}) {
  modelId(model);
  assert.ok(fs.statSync(piExecutable).isFile(), "Pi launcher file required");
  for (const file of [workerExtension, subagentsExtension])
    assert.equal(
      fs.realpathSync(file),
      path.resolve(file),
      `canonical runtime file required: ${file}`,
    );
  assert.equal(
    fs.realpathSync(executionRoot),
    path.resolve(executionRoot),
    "canonical executionRoot required",
  );
  const providerExtensions = [];
  if (model.startsWith("antigravity/")) {
    const antigravityDir = path.resolve(
      path.dirname(fs.realpathSync(subagentsExtension)),
      "../pi-antigravity",
    );
    const antigravityEntry = path.join(antigravityDir, "src", "index.ts");
    if (fs.existsSync(antigravityEntry)) {
      providerExtensions.push("--extension", fs.realpathSync(antigravityEntry));
    }
  }
  const environment = [`TEAMS_TASK_EXECUTION_DIR=${executionRoot}`];
  const argv = [
    piExecutable,
    "--model",
    model,
    "--no-extensions",
    "--extension",
    workerExtension,
    "--extension",
    subagentsExtension,
    ...providerExtensions,
    "--no-context-files",
    "--no-prompt-templates",
    "--session-dir",
    path.join(executionRoot, "worker-sessions"),
    "--tools",
    "read,team_role_spawn,team_task_result,subagent_supervisor",
    "--name",
    `task-${path.basename(executionRoot).slice(0, 8)}`,
  ];
  return `env ${environment.map(shellArg).join(" ")} ${argv.map(shellArg).join(" ")}`;
}

function nativeRunner(executable, args, timeoutMs) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Herdr command failed (${args.join(" ")}): ${result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
    );
  }
  if (!result.stdout.trim()) return { ok: true };
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`Herdr returned invalid JSON for ${args.join(" ")}`, {
      cause,
    });
  }
}

function paneId(value) {
  const id =
    value?.result?.pane?.pane_id ?? value?.result?.pane_id ?? value?.pane_id;
  assert.ok(
    typeof id === "string" && /^w[^:]+:p[^:]+$/.test(id),
    "Herdr response has no pane id",
  );
  return id;
}

export class HerdrPort {
  constructor({
    executable = process.env.HERDR_BIN ??
      path.join(os.homedir(), ".local", "bin", "herdr"),
    piExecutable = process.execPath.replace(/\/node$/, "/pi"),
    workerExtension,
    subagentsExtension,
    run = nativeRunner,
    inspectHost = inspectBackgroundHost,
    readinessReceipt,
    goalExtension,
    allowUnverifiedCanary = false,
    environment = process.env,
    model = readTaskModels().taskPi,
  }) {
    this.model = modelId(model);
    assert.ok(
      environment.HERDR_ENV === "1" && environment.HERDR_PANE_ID,
      "Task Pi dispatch requires a Herdr-managed parent pane",
    );
    this.executable = fs.realpathSync(executable);
    assert.ok(fs.statSync(piExecutable).isFile(), "Pi launcher file required");
    this.piExecutable = path.resolve(piExecutable);
    this.inspectHost = () =>
      inspectHost(this.piExecutable, {
        subagentsExtension: this.subagentsExtension,
        goalExtension,
        readinessReceipt,
      });
    this.allowUnverifiedCanary = allowUnverifiedCanary === true;
    this.workerExtension = fs.realpathSync(workerExtension);
    assert.ok(
      subagentsExtension,
      "pi-subagents public extension entry required",
    );
    this.subagentsExtension = fs.realpathSync(subagentsExtension);
    this.run = (args, timeoutMs) => run(this.executable, args, timeoutMs);
  }

  async start({ executionRoot, cwd, deadlineMs, onPane }) {
    const host = this.inspectHost();
    assert.ok(
      host.compatible || this.allowUnverifiedCanary,
      `Task Pi background host incompatible: ${JSON.stringify(host)}`,
    );
    assert.equal(
      fs.realpathSync(cwd),
      path.resolve(cwd),
      "canonical worker cwd required",
    );
    const split = this.run(
      [
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        cwd,
        "--no-focus",
      ],
      15_000,
    );
    const id = paneId(split);
    onPane?.(id);
    const command = workerCommand({
      piExecutable: this.piExecutable,
      workerExtension: this.workerExtension,
      subagentsExtension: this.subagentsExtension,
      executionRoot,
      model: this.model,
    });
    this.run(["pane", "run", id, command], 15_000);
    const boot = path.join(executionRoot, "receipts", "boot.json");
    const bootDeadline = Date.now() + Math.min(deadlineMs, 30_000);
    while (!fs.existsSync(boot) && Date.now() < bootDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(boot), "Task Pi did not produce a boot receipt");
    const agentName = `task-${path.basename(executionRoot).slice(0, 8)}`;
    this.run(["pane", "rename", id, agentName], 5_000);
    return { paneId: id, agentName };
  }

  capabilities() {
    const status = this.run(["status", "--json"], 5_000);
    const backgroundHost = this.inspectHost();
    return {
      backgroundHost,
      canaryAllowed:
        this.allowUnverifiedCanary &&
        status?.server?.running === true &&
        status?.server?.compatible === true &&
        status.server.endpoint_compatible === true,
      compatible:
        backgroundHost.compatible &&
        status?.server?.running === true &&
        status.server.compatible === true &&
        status.server.endpoint_compatible === true,
      client: status?.client ?? null,
      server: status?.server ?? null,
    };
  }

  status(id) {
    return this.run(["pane", "get", id], 5_000);
  }

  isIdle(id, expectedCwd) {
    const status = this.status(id);
    const pane = status?.result?.pane ?? status?.pane;
    assert.ok(pane, "Herdr pane status missing");
    assert.equal(
      fs.realpathSync(pane.cwd),
      fs.realpathSync(expectedCwd),
      "Task Pi pane cwd mismatch",
    );
    const state = pane.agent_status ?? pane.agentStatus;
    if (state === "idle") return true;
    // A cleanly exited Pi releases agent metadata: Herdr then reports unknown,
    // not idle. Accept only its sole foreground shell, never an unknown agent.
    if (pane.agent || state !== "unknown") return false;
    const info = this.run(["pane", "process-info", "--pane", id], 5_000)?.result
      ?.process_info;
    const processes = info?.foreground_processes;
    return (
      Number.isSafeInteger(info?.shell_pid) &&
      info.shell_pid > 0 &&
      info.foreground_process_group_id === info.shell_pid &&
      Array.isArray(processes) &&
      processes.length === 1 &&
      processes[0].pid === info.shell_pid &&
      typeof processes[0].cwd === "string" &&
      fs.realpathSync(processes[0].cwd) === fs.realpathSync(expectedCwd)
    );
  }

  closeIdle(id, expectedCwd) {
    assert.equal(
      this.isIdle(id, expectedCwd),
      true,
      "Task Pi pane is not idle",
    );
    this.run(["pane", "close", id], 10_000);
    return { paneId: id, disposition: "closed" };
  }
}
