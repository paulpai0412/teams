#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let manifest;
try {
  manifest = JSON.parse(
    fs.readFileSync(path.join(here, "manifest.json"), "utf8"),
  );
} catch (error) {
  console.error(
    `goal-team-hold-wake: Cannot read patch manifest: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const defaultTarget = path.resolve(
  here,
  "../../..",
  "npm/node_modules/pi-goal-x",
);

function fail(message) {
  throw new Error(message);
}
function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function hashFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(`Unsupported non-regular file: ${file}`);
    return hashBuffer(fs.readFileSync(file));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function safeRelative(value, label) {
  if (
    typeof value !== "string" ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")
  )
    fail(`Unsafe ${label}: ${String(value)}`);
  return value;
}
function atomicWrite(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
function packageVersion(target) {
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    fail(
      `Cannot inspect target root: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
    fail(`Target root must be a real directory: ${target}`);
  const file = path.join(target, "package.json");
  if (!fs.existsSync(file)) fail(`Target package.json not found: ${file}`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(
      `Cannot read target package metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value.name !== manifest.package || value.version !== manifest.version) {
    fail(
      `Unsupported target: expected ${manifest.package}@${manifest.version}, found ${String(value.name)}@${String(value.version)}`,
    );
  }
  return value.version;
}
function verifyBundle() {
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.patchId !== "string" ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    fail("Invalid patch manifest");
  for (const item of manifest.files) {
    safeRelative(item.path, "target path");
    safeRelative(item.postimage, "postimage path");
    const post = path.join(here, item.postimage);
    if (hashFile(post) !== item.postSha256)
      fail(`Patch postimage hash mismatch: ${item.path}`);
    if (item.preimage === null) {
      if (item.preSha256 !== null)
        fail(`Invalid absent preimage: ${item.path}`);
    } else {
      safeRelative(item.preimage, "preimage path");
      if (hashFile(path.join(here, item.preimage)) !== item.preSha256)
        fail(`Patch preimage hash mismatch: ${item.path}`);
    }
  }
}
function inspectRows(target) {
  packageVersion(target);
  const rows = manifest.files.map((item) => {
    const current = hashFile(path.join(target, item.path));
    if (current === item.preSha256) return { ...item, current, state: "pre" };
    if (current === item.postSha256) return { ...item, current, state: "post" };
    return { ...item, current, state: "unsupported" };
  });
  if (rows.some((row) => row.state === "unsupported")) {
    const bad = rows
      .filter((row) => row.state === "unsupported")
      .map((row) => `${row.path}=${row.current ?? "missing"}`)
      .join(", ");
    fail(`Unsupported source; no files changed: ${bad}`);
  }
  return rows;
}
function classify(target) {
  const rows = inspectRows(target);
  const states = new Set(rows.map((row) => row.state));
  if (states.size !== 1)
    fail(
      `Mixed pre/post source; no files changed: ${rows.map((row) => `${row.path}:${row.state}`).join(", ")}`,
    );
  return { state: rows[0].state, rows };
}
function validate(target) {
  if (process.env.PI_GOAL_HOLD_TEST_FAIL_VALIDATION === "1")
    fail("Forced validation failure (test hook)");
  const result = spawnSync(
    process.execPath,
    [
      path.join(here, "verify-runtime.mjs"),
      "--source-root",
      path.join(target, "extensions"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PI_MEMORY_EXIT_SUMMARY: "off" },
      timeout: 120000,
    },
  );
  if (result.status !== 0)
    fail(
      `Focused validation failed (exit ${String(result.status)}):\n${result.stdout || ""}${result.stderr || ""}`.trim(),
    );
  return result.stdout.trim();
}
function backupName() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}
function createBackup(target, rows) {
  const name = backupName();
  const dir = path.join(here, "backups", name);
  try {
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  } catch (error) {
    fail(
      `Cannot create backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = [];
  for (const row of rows) {
    const source = path.join(target, row.path);
    const existed = fs.existsSync(source);
    const backupPath = path.join("files", row.path);
    if (existed) {
      const content = fs.readFileSync(source);
      if (hashBuffer(content) !== row.preSha256)
        fail(`Source changed during backup: ${row.path}`);
      const destination = path.join(dir, backupPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, {
        mode: fs.statSync(source).mode,
      });
    }
    files.push({
      path: row.path,
      existed,
      beforeSha256: row.preSha256,
      postSha256: row.postSha256,
      backupPath: existed ? backupPath : null,
    });
  }
  const data = {
    schemaVersion: 1,
    patchId: manifest.patchId,
    targetRoot: path.resolve(target),
    packageVersion: manifest.version,
    createdAt: new Date().toISOString(),
    state: "prepared",
    files,
  };
  atomicWrite(
    path.join(dir, "backup-manifest.json"),
    Buffer.from(JSON.stringify(data, null, 2) + "\n"),
  );
  return { name, dir, data };
}
function writeBackupManifest(backup, state) {
  backup.data.state = state;
  backup.data.updatedAt = new Date().toISOString();
  atomicWrite(
    path.join(backup.dir, "backup-manifest.json"),
    Buffer.from(JSON.stringify(backup.data, null, 2) + "\n"),
  );
}
function snapshot(target, rows) {
  return rows.map((row) => {
    const file = path.join(target, row.path);
    return {
      file,
      existed: fs.existsSync(file),
      content: fs.existsSync(file) ? fs.readFileSync(file) : null,
      mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o644,
    };
  });
}
function restoreSnapshot(values) {
  for (const value of values.toReversed()) {
    if (value.existed) atomicWrite(value.file, value.content, value.mode);
    else fs.rmSync(value.file, { force: true });
  }
}
function apply(target) {
  const status = classify(target);
  if (status.state === "post")
    return { status: "ALREADY_APPLIED", validation: validate(target) };
  const backup = createBackup(target, status.rows);
  const before = snapshot(target, status.rows);
  try {
    for (const row of status.rows)
      atomicWrite(
        path.join(target, row.path),
        fs.readFileSync(path.join(here, row.postimage)),
        fs.existsSync(path.join(target, row.path))
          ? fs.statSync(path.join(target, row.path)).mode
          : 0o644,
      );
    const after = classify(target);
    if (after.state !== "post") fail("Postimage verification failed");
    const validation = validate(target);
    writeBackupManifest(backup, "applied");
    return { status: "APPLIED", backup: backup.name, validation };
  } catch (error) {
    try {
      restoreSnapshot(before);
      writeBackupManifest(backup, "rolled-back");
    } catch (rollbackError) {
      fail(
        `Apply failed (${error.message}); rollback also failed (${rollbackError.message})`,
      );
    }
    throw error;
  }
}
function validateBackup(backup, target) {
  if (
    backup.schemaVersion !== 1 ||
    backup.patchId !== manifest.patchId ||
    !["prepared", "applied"].includes(backup.state) ||
    path.resolve(target) !== backup.targetRoot ||
    backup.packageVersion !== manifest.version ||
    !Array.isArray(backup.files) ||
    backup.files.length !== manifest.files.length
  )
    fail("Backup is not recoverable for this exact patch and target");
  const files = new Map(backup.files.map((item) => [item.path, item]));
  if (files.size !== manifest.files.length)
    fail("Backup file inventory is duplicated or incomplete");
  for (const expected of manifest.files) {
    const item = files.get(expected.path);
    if (
      !item ||
      item.beforeSha256 !== expected.preSha256 ||
      item.postSha256 !== expected.postSha256 ||
      item.existed !== (expected.preSha256 !== null) ||
      (item.existed
        ? item.backupPath !== path.join("files", expected.path)
        : item.backupPath !== null)
    )
      fail(`Backup metadata mismatch: ${expected.path}`);
  }
}
function revert(target, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
    fail("Revert requires a backup name, not a path");
  const dir = path.join(here, "backups", name);
  const manifestPath = path.join(dir, "backup-manifest.json");
  if (!fs.existsSync(manifestPath)) fail(`Unknown backup: ${name}`);
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `Cannot read backup manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateBackup(backup, target);
  const rows = inspectRows(target);
  const before = snapshot(target, rows);
  try {
    for (const expected of manifest.files) {
      const item = backup.files.find((value) => value.path === expected.path);
      const targetFile = path.join(
        target,
        safeRelative(item.path, "backup target path"),
      );
      if (item.existed) {
        const source = path.join(
          dir,
          safeRelative(item.backupPath, "backup path"),
        );
        const content = fs.readFileSync(source);
        if (hashBuffer(content) !== item.beforeSha256)
          fail(`Backup hash mismatch: ${item.path}`);
        atomicWrite(targetFile, content);
      } else fs.rmSync(targetFile, { force: true });
    }
    const restored = classify(target);
    if (restored.state !== "pre") fail("Revert preimage verification failed");
    backup.state = "reverted";
    backup.updatedAt = new Date().toISOString();
    atomicWrite(
      manifestPath,
      Buffer.from(JSON.stringify(backup, null, 2) + "\n"),
    );
    return { status: "REVERTED", backup: name };
  } catch (error) {
    try {
      restoreSnapshot(before);
    } catch (rollbackError) {
      fail(
        `Revert failed (${error.message}); rollback also failed (${rollbackError.message})`,
      );
    }
    throw error;
  }
}

try {
  verifyBundle();
  let command = "apply";
  let revertName = null;
  let target = defaultTarget;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check" || arg === "--verify") {
      if (command !== "apply") fail("Choose exactly one command");
      command = arg.slice(2);
    } else if (arg === "--revert") {
      if (command !== "apply" || !args[index + 1])
        fail("--revert requires one backup name");
      command = "revert";
      revertName = args[++index];
    } else if (arg === "--target") {
      if (!args[index + 1]) fail("--target requires a package root");
      target = path.resolve(args[++index]);
    } else fail(`Unknown argument: ${arg}`);
  }
  let result;
  if (command === "check") {
    const state = classify(target).state;
    result = { status: "COMPATIBLE", state, target, version: manifest.version };
  } else if (command === "verify") {
    const state = classify(target).state;
    if (state !== "post") fail("Patch is not applied");
    result = { status: "VERIFIED", target, validation: validate(target) };
  } else if (command === "revert") result = revert(target, revertName);
  else result = apply(target);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(
    `goal-team-hold-wake: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
