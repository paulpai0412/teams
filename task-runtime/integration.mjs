// Parent-owned rehearsal only: never writes the source repository or its refs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  readEvidenceBytes,
  runCheck,
  saveEvidenceJson,
  snapshot,
  verifyCheck,
} from "../host-evidence.mjs";
import { bytesDigest, digest, validateScopedPath } from "./contracts.mjs";
import { inspectNativeHandoffs } from "./native-handoff.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";

function json(file) {
  try {
    return JSON.parse(readEvidenceBytes(file, 1024 * 1024).toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid integration receipt: ${file}`, { cause });
  }
}
const inside = (root, file) =>
  file === root || file.startsWith(root + path.sep);

// No inherited Git overrides, global filters, credential helpers or hooks. Checks
// remain trusted OS commands, not a sandbox; their declared cwd is relocated.
export function integrationGitInvocation(
  cwd,
  args,
  { input, index, encoding = "utf8" } = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
  if (index) env.GIT_INDEX_FILE = index;
  return {
    args: [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-C",
      cwd,
      ...args,
    ],
    options: {
      env,
      input,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      encoding,
    },
  };
}

function git(cwd, args, options) {
  const command = integrationGitInvocation(cwd, args, options);
  const result = spawnSync("git", command.args, command.options);
  assert.ok(
    !result.error && result.status === 0 && !result.signal,
    `integration git ${args[0]} failed; preserve and reconcile: ${(result.error?.code ?? result.stderr ?? "unknown").slice(0, 1500)}`,
  );
  return result.stdout;
}

function safePath(name) {
  validateScopedPath(name, "Git path");
  assert.ok(
    !/[\x00-\x1f\\]/.test(name) &&
      !path.win32.isAbsolute(name) &&
      !name.split("/").some((part) => part.toLowerCase() === ".git"),
    "unsafe Git path",
  );
}

function treeFiles(cwd, tree) {
  const rows = git(cwd, ["ls-tree", "-r", "-z", tree])
    .split("\0")
    .filter(Boolean);
  assert.ok(
    rows.length > 0 && rows.length <= 10000,
    "bounded nonempty Git tree required",
  );
  return rows.map((row) => {
    const tab = row.indexOf("\t");
    assert.ok(tab > 0, "invalid Git tree record");
    const [mode, type] = row.slice(0, tab).split(" ");
    const name = row.slice(tab + 1);
    safePath(name);
    assert.ok(
      type === "blob" && ["100644", "100755"].includes(mode),
      "only regular Git files supported; symlink/submodule refused",
    );
    return name;
  });
}

function scope(cwd, base, index, allowed) {
  const names = git(
    cwd,
    [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      base,
      "--",
    ],
    { index },
  )
    .split("\0")
    .filter(Boolean);
  assert.ok(names.length <= 512, "patch scope exceeds 512 files");
  for (const name of names) {
    safePath(name);
    assert.ok(
      allowed.some(
        (prefix) => name === prefix || name.startsWith(prefix + "/"),
      ),
      `patch outside allowed scope: ${name}`,
    );
  }
  return names;
}

function workspaceSnapshot(cwd, goalMetadata = false) {
  if (goalMetadata) {
    const pool = fs.lstatSync(path.join(cwd, ".pi/.goals-pool-snapshot.json"), {
      throwIfNoEntry: false,
    });
    assert.ok(
      !pool || pool.isFile(),
      "Goal pool snapshot must be a regular file",
    );
  }
  const captured = snapshot(
    cwd,
    fs.readdirSync(cwd).filter((name) => name !== ".git"),
    goalMetadata ? [".pi/goals", ".pi/.goals-pool-snapshot.json"] : [],
  );
  if (
    !goalMetadata ||
    captured.files.some((file) => file.path.startsWith(".pi/"))
  )
    return captured;
  // An otherwise empty .pi container is not present in a Git checkout. Its mode
  // remains guarded by workspace-scope; other .pi files are never omitted here.
  const files = captured.files.filter(
    (file) => file.path !== ".pi" || file.kind !== "directory",
  );
  return { ...captured, files, digest: digest(files) };
}

function assertStagedTree(cwd, base, mergedTree) {
  assert.equal(
    git(cwd, ["rev-parse", "HEAD"]).trim(),
    base,
    "integration HEAD changed",
  );
  assert.equal(
    git(cwd, ["write-tree"]).trim(),
    mergedTree,
    "integration index changed",
  );
  assert.equal(
    git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "--",
    ]),
    "",
    "integration working tree changed",
  );
  // Deliberately include ignored files: checks cannot hide writes behind .gitignore.
  assert.equal(
    git(cwd, ["ls-files", "--others", "-z"]),
    "",
    "integration has new untracked files",
  );
}

function inputs(contract, cwd) {
  return contract.checks.map((check) => {
    assert.ok(
      !inside(contract.workspace.sourceRoot, check.executable) &&
        !check.argv.some((arg) => arg.includes(contract.workspace.sourceRoot)),
      "check is not relocatable; approve integration-local argv first",
    );
    return {
      id: check.commandId,
      input: {
        cwd,
        sourcePaths: contract.workspace.sourcePaths,
        argv: [check.executable, ...check.argv],
        timeoutMs: check.timeoutMs,
      },
    };
  });
}

function verifyStored(dir, input, contract) {
  assert.equal(
    fs.realpathSync(dir),
    dir,
    "canonical integration directory required",
  );
  const receipt = json(path.join(dir, "receipt.json"));
  assert.equal(
    receipt.schemaVersion,
    "teams-integration-rehearsal/1",
    "unsupported integration receipt",
  );
  assert.equal(
    receipt.inputDigest,
    digest(input),
    "integration request changed",
  );
  assert.deepEqual(
    json(path.join(dir, "intent.json")),
    input,
    "integration intent changed",
  );
  assert.equal(receipt.cwd, path.join(dir, "repo"), "integration cwd changed");
  assert.equal(
    fs.realpathSync(receipt.cwd),
    receipt.cwd,
    "integration cwd changed",
  );
  assert.equal(receipt.targetModified, false, "not a verify-only receipt");
  assert.equal(
    receipt.acceptance,
    "not-assessed",
    "rehearsal is not acceptance",
  );
  assert.match(
    receipt.tree,
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
    "invalid integration tree",
  );
  const native = json(path.join(dir, "native.json"));
  assert.equal(
    digest(native),
    receipt.nativeDigest,
    "native capture inventory changed",
  );
  assert.deepEqual(
    receipt.captures,
    native.captures,
    "capture inventory changed",
  );
  assert.deepEqual(
    receipt.lanes.map(({ tree: _tree, changedPaths: _paths, ...lane }) => lane),
    native.lanes,
    "lane inventory changed",
  );
  for (const [index, lane] of receipt.lanes.entries())
    assert.deepEqual(
      json(path.join(dir, `applied-${index}.json`)),
      lane,
      "applied lane receipt changed",
    );
  assert.equal(
    workspaceSnapshot(receipt.cwd).digest,
    receipt.workspaceDigest,
    "integration workspace changed",
  );
  for (const file of receipt.captures) {
    validateScopedPath(file.saved, "captured artifact");
    assert.ok(
      file.saved.startsWith("captures/"),
      "capture escapes integration",
    );
    assert.equal(
      bytesDigest(readEvidenceBytes(path.join(dir, file.saved))),
      file.sha256,
      "captured native artifact changed",
    );
  }
  assertStagedTree(receipt.cwd, contract.workspace.baseCommit, receipt.tree);
  assert.equal(
    snapshot(receipt.cwd, contract.workspace.sourcePaths).digest,
    receipt.sourceDigest,
    "staged source changed",
  );
  const checks = inputs(contract, receipt.cwd);
  assert.deepEqual(
    receipt.checks,
    checks.map((check) => check.id),
    "integration check inventory changed",
  );
  for (const check of checks)
    verifyCheck(check.input, path.join(dir, `check-${check.id}.json`));
  assert.equal(
    receipt.status,
    checks.length ? "checks-passed" : "staged",
    "integration check status changed",
  );
  return receipt;
}

// Readback is also needed after target application, when target HEAD/index no
// longer describe a clean baseline. This never grants target-write authority.
export function readIntegrationRehearsal({
  mailbox,
  contract,
  result,
  ownerSessionId,
}) {
  return verifyStored(
    path.join(mailbox.root, "integration"),
    {
      schemaVersion: "teams-integration-intent/1",
      executionId: contract.identity.executionId,
      ownerSessionId,
      contractDigest: digest(contract),
      resultDigest: digest(result),
      mode: "verify-only",
      sourceRoot: contract.workspace.sourceRoot,
      baseCommit: contract.workspace.baseCommit,
    },
    contract,
  );
}

export {
  git as integrationGit,
  workspaceSnapshot as integrationWorkspaceSnapshot,
};

export function stageIntegration({
  mailbox,
  contract,
  result,
  ownerSessionId,
  assertOwner,
}) {
  assertOwner();
  const source = contract.workspace.sourceRoot;
  const base = contract.workspace.baseCommit;
  const dir = path.join(mailbox.root, "integration");
  assert.ok(
    !inside(source, dir) && !inside(dir, source),
    "integration must be outside target",
  );
  inspectWorktreeBase(source, base);
  assert.equal(
    snapshot(source, contract.workspace.sourcePaths).digest,
    result.source.sourceDigest,
    "candidate source changed before integration",
  );
  const input = {
    schemaVersion: "teams-integration-intent/1",
    executionId: contract.identity.executionId,
    ownerSessionId,
    contractDigest: digest(contract),
    resultDigest: digest(result),
    mode: "verify-only",
    sourceRoot: source,
    baseCommit: base,
  };
  if (fs.existsSync(dir)) {
    assert.ok(
      !fs.existsSync(path.join(dir, "failure.json")),
      "failed integration; reconcile before reuse",
    );
    assert.ok(
      fs.existsSync(path.join(dir, "receipt.json")),
      "integration intent exists without completion; reconcile instead of retrying",
    );
    const receipt = verifyStored(dir, input, contract);
    assertOwner();
    inspectWorktreeBase(source, base);
    return receipt;
  }
  const native = inspectNativeHandoffs(mailbox, contract, result.childRunRefs);
  const cwd = path.join(dir, "repo");
  const checks = inputs(contract, cwd); // Refuse non-relocatable commands before intent.
  assertOwner();
  fs.mkdirSync(dir, { mode: 0o700 });
  assert.equal(
    fs.realpathSync(dir),
    dir,
    "canonical integration directory required",
  );
  saveEvidenceJson(path.join(dir, "intent.json"), input);
  try {
    fs.mkdirSync(path.join(dir, "captures"), { mode: 0o700 });
    const captures = native.files.map((file, index) => {
      const saved = `captures/${index}.bin`;
      const fd = fs.openSync(path.join(dir, saved), "wx", 0o600);
      try {
        fs.writeFileSync(fd, file.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { origin: file.path, saved, sha256: file.sha256 };
    });
    const nativeMetadata = { lanes: native.lanes, captures };
    saveEvidenceJson(path.join(dir, "native.json"), nativeMetadata);
    treeFiles(source, base);
    git(dir, [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--depth=1",
      "--single-branch",
      "--no-tags",
      "--",
      source,
      cwd,
    ]);
    assert.equal(
      git(cwd, ["rev-parse", "HEAD"]).trim(),
      base,
      "target changed during clone",
    );
    treeFiles(cwd, base); // Before any checkout: no symlinks, gitlinks or secret paths.
    git(cwd, ["read-tree", base]);
    const applied = [];
    for (const [index, lane] of native.lanes.entries()) {
      assertOwner();
      const bytes = native.files.find(
        (file) => file.path === lane.patchPath,
      ).bytes;
      const laneIndex = path.join(dir, `lane-${index}.index`);
      git(cwd, ["read-tree", base], { index: laneIndex });
      if (bytes.length) {
        // Validate each lane against its declared base, not a previous lane's output.
        git(
          cwd,
          [
            "apply",
            "--cached",
            "--check",
            "--binary",
            "--whitespace=nowarn",
            "-",
          ],
          { input: bytes, index: laneIndex },
        );
        git(
          cwd,
          ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
          { input: bytes, index: laneIndex },
        );
      }
      const changedPaths = scope(
        cwd,
        base,
        laneIndex,
        contract.workspace.allowedWritePaths,
      );
      const laneTree = git(cwd, ["write-tree"], { index: laneIndex }).trim();
      treeFiles(cwd, laneTree);
      if (bytes.length)
        git(
          cwd,
          [
            "apply",
            "--cached",
            "--3way",
            "--binary",
            "--whitespace=nowarn",
            "-",
          ],
          { input: bytes },
        );
      applied.push({ ...lane, tree: laneTree, changedPaths });
      saveEvidenceJson(path.join(dir, `applied-${index}.json`), applied.at(-1));
    }
    const tree = git(cwd, ["write-tree"]).trim();
    treeFiles(cwd, tree);
    scope(cwd, base, undefined, contract.workspace.allowedWritePaths);
    git(cwd, ["checkout-index", "--all"]);
    assertStagedTree(cwd, base, tree);
    const sourceDigest = snapshot(cwd, contract.workspace.sourcePaths).digest;
    const workspaceDigest = workspaceSnapshot(cwd).digest;
    for (const check of checks) {
      assertOwner();
      const receipt = runCheck(
        check.input,
        path.join(dir, `check-${check.id}.json`),
      );
      assert.equal(
        receipt.status,
        "verified",
        `integration host check failed: ${check.id}`,
      );
      assertStagedTree(cwd, base, tree);
      assert.equal(
        workspaceSnapshot(cwd).digest,
        workspaceDigest,
        "integration workspace changed during host check",
      );
    }
    assertOwner();
    inspectWorktreeBase(source, base);
    assert.equal(
      snapshot(source, contract.workspace.sourcePaths).digest,
      result.source.sourceDigest,
      "target source changed during integration",
    );
    const receipt = {
      schemaVersion: "teams-integration-rehearsal/1",
      inputDigest: digest(input),
      status: checks.length ? "checks-passed" : "staged",
      acceptance: "not-assessed",
      targetModified: false,
      cwd,
      tree,
      sourceDigest,
      workspaceDigest,
      nativeDigest: digest(nativeMetadata),
      lanes: applied,
      captures,
      checks: checks.map((check) => check.id),
      completedAt: new Date().toISOString(),
    };
    saveEvidenceJson(path.join(dir, "receipt.json"), receipt);
    return verifyStored(dir, input, contract);
  } catch (error) {
    // Never retry, reset or delete a partially applied index/check after ambiguity.
    saveEvidenceJson(path.join(dir, "failure.json"), {
      schemaVersion: "teams-integration-failure/1",
      inputDigest: digest(input),
      disposition: "preserved-reconcile-required",
      error: String(error.message).slice(0, 2000),
      observedAt: new Date().toISOString(),
    });
    throw error;
  }
}
