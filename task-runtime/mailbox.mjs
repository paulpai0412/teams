import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  bytesDigest,
  canonicalBytes,
  validateControl,
  validateEvent,
} from "./contracts.mjs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function inside(root, file) {
  return file === root || file.startsWith(root + path.sep);
}

function relativePath(root, relative) {
  assert.ok(
    typeof relative === "string" && relative && !path.isAbsolute(relative),
    "scoped relative path required",
  );
  assert.ok(
    !relative
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === ".."),
    "scoped relative path required",
  );
  const file = path.resolve(root, relative);
  assert.ok(inside(root, file), "path escapes mailbox");
  return file;
}

function readRegular(file, max = 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    assert.ok(
      before.isFile() && before.size <= max,
      "bounded regular mailbox file required",
    );
    const bytes = Buffer.alloc(before.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    assert.equal(count, before.size, "mailbox file changed while reading");
    const after = fs.fstatSync(fd);
    assert.equal(after.size, before.size, "mailbox file changed while reading");
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

function immutableWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, file);
      syncDirectory(path.dirname(file));
      return { disposition: "written" };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.deepEqual(
        readRegular(file, Math.max(bytes.length, 1)),
        bytes,
        "conflicting immutable message",
      );
      return { disposition: "duplicate" };
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

function parseJson(bytes, file) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`invalid mailbox JSON: ${file}`, { cause });
  }
}

export class Mailbox {
  static create(runtimeRoot, projectId, executionId) {
    assert.ok(path.isAbsolute(runtimeRoot), "absolute runtime root required");
    assert.match(projectId, NAME, "invalid projectId");
    assert.match(executionId, /^[0-9a-f-]{36}$/i, "invalid executionId");
    const root = path.resolve(
      runtimeRoot,
      "projects",
      projectId,
      "executions",
      executionId,
    );
    for (const directory of [
      root,
      "commands",
      "events",
      "receipts",
      "results",
      "evidence",
    ].map((name) => (name === root ? root : path.join(root, name)))) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      assert.equal(
        fs.realpathSync(directory),
        directory,
        "mailbox directories cannot be symlinks",
      );
    }
    immutableWrite(
      path.join(root, "mailbox.json"),
      canonicalBytes({
        schemaVersion: "teams-mailbox/1",
        executionId,
        writerVersion: 1,
      }),
    );
    return new Mailbox(root, executionId, 1);
  }

  static open(root, executionId) {
    assert.ok(path.isAbsolute(root), "absolute mailbox root required");
    assert.equal(
      fs.realpathSync(root),
      path.resolve(root),
      "canonical mailbox root required",
    );
    const canonical = path.resolve(root);
    const metadataFile = path.join(canonical, "mailbox.json");
    let readerVersion = 0;
    if (fs.existsSync(metadataFile)) {
      const metadata = parseJson(
        readRegular(metadataFile, 16 * 1024),
        metadataFile,
      );
      assert.equal(
        metadata.schemaVersion,
        "teams-mailbox/1",
        `unsupported mailbox schema: ${metadata.schemaVersion}`,
      );
      assert.equal(
        metadata.executionId,
        executionId,
        "mailbox execution mismatch",
      );
      assert.equal(
        metadata.writerVersion,
        1,
        "unsupported mailbox writer version",
      );
      readerVersion = 1;
    }
    return new Mailbox(canonical, executionId, readerVersion);
  }

  constructor(root, executionId, readerVersion = 0) {
    this.root = root;
    this.executionId = executionId;
    this.readerVersion = readerVersion;
  }

  readRelative(relative, max) {
    const file = relativePath(this.root, relative);
    return readRegular(file, max);
  }

  readJson(relative, max) {
    return parseJson(this.readRelative(relative, max), relative);
  }

  writeJson(relative, value, max = 1024 * 1024) {
    const bytes = Buffer.concat([canonicalBytes(value), Buffer.from("\n")]);
    assert.ok(bytes.length <= max, "mailbox message too large");
    return immutableWrite(relativePath(this.root, relative), bytes);
  }

  sealContract(contract) {
    return this.writeJson("task-request.json", contract, 64 * 1024);
  }

  writeBootstrap(bootstrap) {
    return this.writeJson("bootstrap.json", bootstrap, 16 * 1024);
  }

  writeCommand(command) {
    validateControl(command);
    assert.equal(
      command.executionId,
      this.executionId,
      "command execution mismatch",
    );
    return this.writeJson(
      `commands/${command.commandId}.json`,
      command,
      16 * 1024,
    );
  }

  writeEvent(event) {
    validateEvent(event);
    assert.equal(
      event.executionId,
      this.executionId,
      "event execution mismatch",
    );
    // ponytail: linear scan is bounded by one task's small event mailbox; index it if event volume exceeds 1,000.
    for (const name of fs.readdirSync(path.join(this.root, "events"))) {
      if (!name.endsWith(".json")) continue;
      const existing = this.readJson(`events/${name}`, 16 * 1024);
      if (
        existing.sequence === event.sequence &&
        existing.eventId !== event.eventId
      )
        throw new Error("event sequence conflict");
    }
    return this.writeJson(
      `events/${String(event.sequence).padStart(6, "0")}-${event.eventId}.json`,
      event,
      16 * 1024,
    );
  }

  writeReceipt(name, value) {
    assert.match(name, NAME, "invalid receipt name");
    return this.writeJson(`receipts/${name}.json`, value);
  }

  writeResult(revision, result) {
    assert.ok(
      Number.isSafeInteger(revision) && revision > 0,
      "invalid result revision",
    );
    return this.writeJson(
      `results/r${String(revision).padStart(4, "0")}.json`,
      result,
      64 * 1024,
    );
  }

  listCommands() {
    return fs
      .readdirSync(path.join(this.root, "commands"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.readJson(`commands/${name}`, 16 * 1024));
  }

  listEvents() {
    return fs
      .readdirSync(path.join(this.root, "events"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.readJson(`events/${name}`, 16 * 1024));
  }

  listResults() {
    return fs
      .readdirSync(path.join(this.root, "results"))
      .filter((name) => /^r[0-9]{4}\.json$/.test(name))
      .sort()
      .map((name) => this.readJson(`results/${name}`, 64 * 1024));
  }

  digestRelative(relative) {
    return bytesDigest(this.readRelative(relative));
  }
}
