#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectBackgroundHost,
  writeCapabilityReceipt,
} from "./capabilities.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const packageRoot = path.join(agentDir, "npm", "node_modules");
const piExecutable = path.join(path.dirname(process.execPath), "pi");

function run(
  executable,
  argv,
  cwd,
  timeoutMs = 120_000,
  environment = process.env,
  input,
) {
  const result = spawnSync(executable, argv, {
    cwd,
    env: environment,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable} ${argv.join(" ")} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
    );
  return result.stdout;
}

function versionParts(value) {
  const match = String(value)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `unsupported version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function satisfies(version, range) {
  if (!range || range === "*") return true;
  const comparators = range.trim().split(/\s+/);
  return comparators.every((item) => {
    const match = item.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
    if (!match) return false;
    const comparison = compareVersions(version, match[2]);
    return match[1] === ">="
      ? comparison >= 0
      : match[1] === "<="
        ? comparison <= 0
        : match[1] === ">"
          ? comparison > 0
          : match[1] === "<"
            ? comparison < 0
            : comparison === 0;
  });
}

function sha(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function files(root, directory = root, output = new Map()) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file);
    if (entry.isDirectory()) files(root, file, output);
    else if (entry.isFile()) output.set(relative, sha(file));
    else throw new Error(`unsupported package entry: ${file}`);
  }
  return output;
}

function verifyPristine(packageName) {
  const installed = path.join(packageRoot, packageName);
  let manifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(installed, "package.json"), "utf8"),
    );
  } catch (cause) {
    throw new Error(`invalid installed package: ${packageName}`, { cause });
  }
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), `teams-${packageName}-`),
  );
  try {
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", `${packageName}@${manifest.version}`, "--offline", "--json"],
        temporary,
      ),
    );
    assert.equal(
      packed.length,
      1,
      `unexpected npm pack result for ${packageName}`,
    );
    run("tar", ["-xzf", path.join(temporary, packed[0].filename)], temporary);
    const expected = files(path.join(temporary, "package"));
    const actual = files(installed);
    assert.deepEqual(
      actual,
      expected,
      `${packageName}@${manifest.version} differs from its official package tarball`,
    );
    return {
      packageName,
      version: manifest.version,
      integrity: packed[0].integrity,
      fileCount: actual.size,
      pristine: true,
      piExtensions: manifest.pi?.extensions ?? [],
      peerDependencies: manifest.peerDependencies ?? {},
      engines: manifest.engines ?? {},
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function extensionLoad(packages) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "teams-extension-load-"),
  );
  try {
    const nodeModules = path.join(temporary, "npm", "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });
    for (const item of packages)
      fs.symlinkSync(
        path.join(packageRoot, item.packageName),
        path.join(nodeModules, item.packageName),
      );
    const goalEntry = path.join(
      packageRoot,
      "pi-goal-x",
      packages.find((item) => item.packageName === "pi-goal-x").piExtensions[0],
    );
    const probeFile = path.join(temporary, "goal-tool-probe.json");
    const output = run(
      piExecutable,
      [
        "--offline",
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--extension",
        goalEntry,
        "--extension",
        path.join(repoRoot, "task-runtime", "compat-probe.mjs"),
        "--extension",
        path.join(repoRoot, "extensions", "teams-orchestrator", "index.mjs"),
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
      ],
      repoRoot,
      120_000,
      {
        ...process.env,
        PI_CODING_AGENT_DIR: temporary,
        TEAMS_COMPAT_PROBE_OUTPUT: probeFile,
      },
      '{"type":"get_state"}\n',
    );
    let probe;
    try {
      probe = JSON.parse(fs.readFileSync(probeFile, "utf8"));
    } catch (cause) {
      throw new Error("static Goal-X capability probe was not produced", {
        cause,
      });
    }
    assert.equal(
      probe.goalX?.compatible,
      true,
      "Goal-X public schemas failed static probe",
    );
    return {
      passed: true,
      output: output.trim().slice(0, 1000),
      goalToolProbe: probe,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const startedAt = new Date().toISOString();
const packages = [verifyPristine("pi-goal-x"), verifyPristine("pi-subagents")];
const piVersion = run(piExecutable, ["--version"], repoRoot).trim();
const nodeVersion = process.version.slice(1);
const peerCompatibility = packages.every((item) =>
  satisfies(
    piVersion,
    item.peerDependencies["@earendil-works/pi-coding-agent"] ?? "*",
  ),
);
const engineCompatibility = packages.every((item) =>
  satisfies(nodeVersion, item.engines?.node ?? "*"),
);
assert.ok(peerCompatibility, `Pi ${piVersion} is outside a package peer range`);
assert.ok(
  engineCompatibility,
  `Node ${nodeVersion} is outside a package engine range`,
);
const testFiles = fs
  .readdirSync(path.join(repoRoot, "task-runtime", "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join("task-runtime", "test", name));
const tests = run(process.execPath, ["--test", ...testFiles], repoRoot);
const load = extensionLoad(packages);
const backgroundHost = inspectBackgroundHost(piExecutable, {
  subagentsExtension: path.join(
    packageRoot,
    "pi-subagents",
    packages.find((item) => item.packageName === "pi-subagents")
      .piExtensions[0],
  ),
  goalExtension: path.join(
    packageRoot,
    "pi-goal-x",
    packages.find((item) => item.packageName === "pi-goal-x").piExtensions[0],
  ),
});
const receipt = {
  schemaVersion: "teams-upgrade-verification/1",
  startedAt,
  finishedAt: new Date().toISOString(),
  mode: "offline-contract",
  runtime: { node: process.version, pi: piVersion },
  packages,
  gates: {
    pristinePackages: true,
    peerRangesCaptured: true,
    peerCompatibility,
    engineCompatibility,
    contractTests: {
      passed: true,
      summary: tests.trim().split("\n").slice(-10),
    },
    extensionLoad: load,
    backgroundHost,
    disposableGoalReadback: "contract-simulation-only",
    liveTaskPi: "pending-new-session-canary",
  },
  decision: {
    offlineCompatible: backgroundHost.compatible,
    liveTaskPiApproved: false,
    fallback: "direct-only-until-live-readiness",
    reason: backgroundHost.reason ?? null,
  },
};
const outputFile = path.join(
  repoRoot,
  "goal-team-evidence",
  "task-runtime-20260910",
  "compatibility-harness.json",
);
const saved = writeCapabilityReceipt(outputFile, receipt);
console.log(JSON.stringify({ ...receipt.decision, receipt: saved }, null, 2));
