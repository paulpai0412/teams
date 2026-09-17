import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { canonicalBytes, digest } from "./contracts.mjs";

function permits(schema, literal) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.const === literal || schema.enum?.includes?.(literal)) return true;
  return ["anyOf", "oneOf", "allOf"].some((key) =>
    schema[key]?.some?.((item) => permits(item, literal)),
  );
}

export function inspectGoalTools(pi) {
  const active = new Set(pi.getActiveTools());
  const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const task = tools.get("update_goal_task");
  const goal = tools.get("update_goal");
  const taskProperties = task?.parameters?.properties;
  const updateProperties = taskProperties?.updates?.items?.properties;
  const goalProperties = goal?.parameters?.properties;
  const checks = {
    toolsActive: active.has("update_goal_task") && active.has("update_goal"),
    singleComplete: Boolean(
      taskProperties?.task_id && permits(taskProperties.status, "complete"),
    ),
    batchComplete: Boolean(
      updateProperties?.task_id && permits(updateProperties.status, "complete"),
    ),
    goalComplete: Boolean(permits(goalProperties?.status, "complete")),
  };
  return {
    compatible:
      checks.singleComplete && checks.batchComplete && checks.goalComplete,
    checks,
    tools: [task, goal].filter(Boolean).map((tool) => ({
      name: tool.name,
      schemaDigest: digest(JSON.stringify(tool.parameters)),
      sourcePath: tool.sourceInfo?.path ?? null,
    })),
  };
}

export class SubagentsRpcClient {
  constructor(events) {
    assert.ok(events?.on && events?.emit, "Pi event bus required");
    this.events = events;
  }

  request(method, params = {}, timeoutMs = 2_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
      let settled = false;
      const unsubscribe = this.events.on(replyEvent, (reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (reply?.version !== 1 || reply.requestId !== requestId)
          return reject(new Error("pi-subagents RPC reply identity mismatch"));
        if (!reply.success)
          return reject(
            Object.assign(
              new Error(reply.error?.message ?? "pi-subagents RPC failed"),
              {
                code: reply.error?.code,
                details: reply.error?.details,
                requestId,
              },
            ),
          );
        resolve(reply.data);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        reject(new Error(`pi-subagents RPC ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params,
      });
    });
  }

  ping(timeoutMs) {
    return this.request("ping", {}, timeoutMs);
  }
}

export function inspectSubagentsPing(ping) {
  const methods = new Set(Array.isArray(ping?.methods) ? ping.methods : []);
  const checks = {
    protocolV1: ping?.version === 1,
    status: methods.has("status") && ping?.capabilities?.status === true,
    spawn: methods.has("spawn") && ping?.capabilities?.asyncSpawn === true,
    stop: methods.has("stop") && ping?.capabilities?.stop === true,
    runtimeAcknowledgement:
      ping?.capabilities?.runtimeAcknowledgedExtensions?.version === 1,
    asyncCompleteEvent:
      typeof ping?.events?.asyncComplete === "string" &&
      ping.events.asyncComplete.length > 0,
    processTerminalProof:
      ping?.capabilities?.processTerminalProof?.version === 1 &&
      typeof ping?.events?.processTerminal === "string" &&
      ping.events.processTerminal.length > 0,
  };
  return { compatible: Object.values(checks).every(Boolean), checks, ping };
}

// Public manifests and this project's source identify a tested runtime. No version
// allowlist or dependency-name heuristic may turn an untested host into a pass.
export function publicPackage(entry) {
  let directory = path.dirname(fs.realpathSync(entry));
  while (true) {
    const file = path.join(directory, "package.json");
    if (fs.existsSync(file)) {
      try {
        return { file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch (cause) {
        throw new Error(`Invalid public package manifest: ${file}`, { cause });
      }
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, "npm package root not found");
    directory = parent;
  }
}

// Host-owned launch settings, separate from Pi's provider/auth configuration.
export function modelId(value) {
  assert.ok(
    typeof value === "string" &&
      /^(?:openai-codex|antigravity)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
        value,
      ),
    "explicit provider/model required",
  );
  return value;
}

export function readTaskModels(
  file = fileURLToPath(new URL("./models.json", import.meta.url)),
) {
  assert.equal(
    fs.realpathSync(file),
    path.resolve(file),
    "canonical model settings required",
  );
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let settings;
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= 16 * 1024,
      "bounded regular model settings required",
    );
    settings = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(
    Object.keys(settings).sort(),
    ["l0", "roles", "taskPi", "version"],
    "model settings fields changed",
  );
  assert.equal(settings.version, 1, "unsupported model settings version");
  modelId(settings.l0);
  modelId(settings.taskPi);
  assert.ok(
    settings.roles &&
      typeof settings.roles === "object" &&
      !Array.isArray(settings.roles),
    "role model map required",
  );
  assert.ok(
    Object.keys(settings.roles).length > 0 &&
      Object.keys(settings.roles).length <= 64,
    "bounded role model map required",
  );
  for (const [role, model] of Object.entries(settings.roles)) {
    assert.match(
      role,
      /^team\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
      "canonical role name required",
    );
    modelId(model);
  }
  return settings;
}

export function taskRoleModel(role, settings) {
  assert.ok(
    Object.hasOwn(settings.roles, role),
    `no configured Task Pi model for ${role}; do not inherit or guess`,
  );
  return modelId(settings.roles[role]);
}

export function inspectBackgroundHost(
  piExecutable,
  { subagentsExtension, goalExtension, readinessReceipt } = {},
) {
  const pi = publicPackage(piExecutable);
  const subagents = subagentsExtension
    ? publicPackage(subagentsExtension)
    : null;
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = [];
  for (const dir of ["task-runtime", "extensions"]) {
    const root = path.join(repo, dir);
    for (const name of fs.readdirSync(root, { recursive: true }).sort())
      if (name.endsWith(".mjs"))
        source.push([
          `${dir}/${name}`,
          digest(fs.readFileSync(path.join(root, name), "utf8")),
        ]);
  }
  source.push([
    "task-runtime/models.json",
    digest(
      fs.readFileSync(path.join(repo, "task-runtime/models.json"), "utf8"),
    ),
  ]);
  source.push([
    "handoff-schema.mjs",
    digest(fs.readFileSync(path.join(repo, "handoff-schema.mjs"), "utf8")),
  ]);
  const runtimeDigest = digest({
    pi: pi.manifest,
    subagents: subagents?.manifest ?? null,
    goal: goalExtension ? publicPackage(goalExtension).manifest : null,
    source,
  });
  const base = {
    piVersion: pi.manifest.version,
    packageRoot: path.dirname(pi.file),
    runtimeDigest,
    compatible: false,
    liveVerified: false,
  };
  if (!readinessReceipt)
    return {
      ...base,
      reason:
        "Full live compatibility evidence is required; use an explicitly authorized canary, not a version exception",
    };
  try {
    assert.ok(subagents, "subagents public manifest required");
    assert.ok(
      fs.statSync(readinessReceipt).size <= 64 * 1024,
      "readiness receipt too large",
    );
    const receipt = JSON.parse(fs.readFileSync(readinessReceipt, "utf8"));
    assert.equal(receipt.schemaVersion, "teams-runtime-readiness/1");
    assert.equal(
      receipt.runtimeDigest,
      runtimeDigest,
      "runtime changed after canary",
    );
    assert.equal(receipt.decision, "accepted");
    assert.equal(receipt.goalReadback, "live");
    assert.ok(receipt.evidence?.length > 0, "canary evidence missing");
    for (const evidence of receipt.evidence)
      assert.equal(
        digest(fs.readFileSync(evidence.file, "utf8")),
        evidence.digest,
        "canary evidence changed",
      );
    return { ...base, compatible: true, liveVerified: true, readinessReceipt };
  } catch (error) {
    return { ...base, reason: error.message };
  }
}

export function writeCapabilityReceipt(file, receipt) {
  file = path.resolve(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = Buffer.concat([canonicalBytes(receipt), Buffer.from("\n")]);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { file, sha256: digest(receipt) };
}
