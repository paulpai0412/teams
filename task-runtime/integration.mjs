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
import {
  bytesDigest,
  digest,
  validateScopedPath,
  isRelocatableCheck,
} from "./contracts.mjs";
import { CompletedCheckFailure } from "./check-failure.mjs";
import {
  CompletedIntegrationConflict,
  completedIntegrationConflict,
  conflictIndex,
  verifyConflictRepairBinding,
  conflictRepairCommand,
} from "./integration-conflict.mjs";
import { inspectNativeHandoffs } from "./native-handoff.mjs";
import { inspectWorktreeBase } from "./role-wave.mjs";
import { verifyReportOrigin } from "./report-lineage.mjs";
import {
  verifyReviewProductOrigin,
  verifyReviewWriterReconstruction,
  verifyWriterReconstruction,
} from "./review-product-lineage.mjs";
import { taskDeadlineAt, hasOriginalTaskDeadline } from "./task-deadline.mjs";

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

function git(cwd, args, options, onFailure) {
  const command = integrationGitInvocation(cwd, args, options);
  const result = spawnSync("git", command.args, command.options);
  if (onFailure && (result.error || result.status !== 0 || result.signal))
    onFailure(result);
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

function treeEntries(cwd, tree, { allowEmpty = false } = {}) {
  const rows = git(cwd, ["ls-tree", "-r", "-z", tree])
    .split("\0")
    .filter(Boolean);
  assert.ok(
    (allowEmpty || rows.length > 0) && rows.length <= 10000,
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
    return { name, mode };
  });
}

function treeFiles(cwd, tree, options) {
  return treeEntries(cwd, tree, options).map((entry) => entry.name);
}

// Git records executable status, but checkout-index also obeys the process
// umask. Keep pre-existing base files/directories in a rehearsal or baseline
// at canonical Git checkout modes; leave newly added candidate files untouched.
// This writes only to host-owned scratch, never to the source target.
export function restoreGitBaseModes(
  cwd,
  base,
  scratch,
  { allowDeleted = false } = {},
) {
  const dirs = new Set();
  const files = [];
  for (const { name, mode } of treeEntries(cwd, base, { allowEmpty: true })) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(path.join(scratch, ...parts.slice(0, i)));
    files.push({
      file: path.join(scratch, name),
      mode: mode === "100755" ? 0o755 : 0o644,
    });
  }
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat && allowDeleted) continue;
    assert.ok(stat?.isDirectory(), "Git base checkout directory changed");
    fs.chmodSync(dir, 0o755);
  }
  for (const { file, mode } of files) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat && allowDeleted) continue;
    assert.ok(stat?.isFile(), "Git base checkout file changed");
    fs.chmodSync(file, mode);
  }
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
      isRelocatableCheck(check, contract.workspace.sourceRoot),
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

function verifyStored(dir, input, contract, context = null) {
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
  if (context?.mailbox.readJson("bootstrap.json").repairIntentDigest) {
    const intent = context.mailbox.readJson("receipts/repair-intent.json");
    if (
      [
        "teams-candidate-repair-intent/2",
        "teams-candidate-repair-intent/3",
      ].includes(intent.schemaVersion)
    ) {
      assert.equal(
        digest(intent),
        context.mailbox.readJson("bootstrap.json").repairIntentDigest,
        "repair intent changed",
      );
      assert.ok(
        context.runtimeRoot && context.ledger,
        "product revision requires host-owned lineage",
      );
      (intent.schemaVersion === "teams-candidate-repair-intent/3"
        ? verifyConflictRepairBinding
        : verifyReviewProductOrigin)({
        projectId: contract.identity.projectId,
        runtimeRoot: context.runtimeRoot,
        ledger: context.ledger,
        contract,
        intent,
        assertOwner: context.assertOwner,
        afterApply: fs.existsSync(
          path.join(dir, "target-apply/apply-receipt.json"),
        ),
      });
      const files = native.captures.map((file) => ({
        path: file.origin,
        sha256: file.sha256,
        bytes: readEvidenceBytes(path.join(dir, file.saved), 8 * 1024 * 1024),
      }));
      if (intent.schemaVersion === "teams-candidate-repair-intent/3")
        verifyWriterReconstruction(
          { lanes: native.lanes, files },
          conflictRepairCommand(intent, contract),
          `TASK_PI_CONFLICT_BASE_READY:${intent.conflictIndexSha256}\n`,
        );
      else {
        verifyReviewWriterReconstruction(intent, contract, {
          lanes: native.lanes,
          files,
        });
        assert.notEqual(
          receipt.tree,
          intent.oldTree,
          "review repair did not change the product",
        );
      }
    }
  }
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
  if (native.repairs && context) {
    const checked = inspectNativeHandoffs(
      context.mailbox,
      contract,
      context.result.childRunRefs,
      (origin, limit) => {
        const captured = native.captures.filter(
          (file) => file.origin === origin,
        );
        assert.equal(
          captured.length,
          1,
          "branch recovery capture missing or duplicated",
        );
        return readEvidenceBytes(path.join(dir, captured[0].saved), limit);
      },
    );
    assert.deepEqual(
      checked.lanes,
      native.lanes,
      "branch delivery selection changed",
    );
    assert.deepEqual(
      checked.repairs,
      native.repairs,
      "branch recovery lineage changed",
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
  if (receipt.inheritedFrom) {
    assert.ok(
      context?.runtimeRoot && context?.ledger,
      "report lineage requires a host-owned ledger",
    );
    const intent = context.mailbox.readJson(
      "receipts/report-revision-intent.json",
    );
    assert.equal(
      digest(intent),
      receipt.inheritedFrom.intentDigest,
      "report lineage intent changed",
    );
    const origin = verifyReportOrigin({
      runtimeRoot: context.runtimeRoot,
      ledger: context.ledger,
      contract,
      intent,
      assertOwner: context.assertOwner,
    });
    assert.equal(origin.staged.tree, receipt.tree);
    assert.equal(origin.staged.sourceDigest, receipt.sourceDigest);
    assert.equal(origin.staged.nativeDigest, receipt.nativeDigest);
    assert.deepEqual(origin.staged.lanes, receipt.lanes);
    assert.deepEqual(origin.staged.captures, receipt.captures);
    assert.equal(
      origin.mailbox.digestRelative("integration/receipt.json"),
      receipt.inheritedFrom.rehearsalSha256,
    );
    assert.equal(
      intent.writerEvidenceDigest,
      receipt.inheritedFrom.writerEvidenceDigest,
    );
    assert.equal(origin.complete.verdict, "blocked");
  } else {
    for (const check of checks)
      verifyCheck(check.input, path.join(dir, `check-${check.id}.json`));
  }
  assert.equal(
    receipt.status,
    checks.length ? "checks-passed" : "staged",
    "integration check status changed",
  );
  return receipt;
}

// Readback is also needed after target application, when target HEAD/index no
// longer describe a clean baseline. This never grants target-write authority.
export function readIntegrationRehearsal(context) {
  const { mailbox, contract, result, ownerSessionId } = context;
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
    context,
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
  runtimeRoot,
  ledger,
}) {
  assertOwner();
  if (mailbox.readJson("bootstrap.json").reportRevisionIntentDigest)
    return stageReportRevision({
      mailbox,
      contract,
      result,
      ownerSessionId,
      assertOwner,
      runtimeRoot,
      ledger,
    });
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
    const receipt = verifyStored(dir, input, contract, {
      mailbox,
      contract,
      result,
      ownerSessionId,
      assertOwner,
      runtimeRoot,
      ledger,
    });
    assertOwner();
    inspectWorktreeBase(source, base);
    return receipt;
  }
  const native = inspectNativeHandoffs(mailbox, contract, result.childRunRefs);
  let reviewIntent = null;
  const boot = mailbox.readJson("bootstrap.json");
  if (boot.repairIntentDigest) {
    const intent = mailbox.readJson("receipts/repair-intent.json");
    if (intent.schemaVersion === "teams-candidate-repair-intent/2") {
      assert.equal(
        digest(intent),
        boot.repairIntentDigest,
        "product revision intent changed",
      );
      assert.ok(runtimeRoot && ledger, "host-owned product lineage required");
      verifyReviewProductOrigin({
        runtimeRoot,
        ledger,
        contract,
        intent,
        assertOwner,
      });
      verifyReviewWriterReconstruction(intent, contract, native);
      reviewIntent = intent;
    } else if (intent.schemaVersion === "teams-candidate-repair-intent/3") {
      assert.equal(
        digest(intent),
        boot.repairIntentDigest,
        "conflict repair intent changed",
      );
      verifyConflictRepairBinding({
        runtimeRoot,
        projectId: contract.identity.projectId,
        intent,
        contract,
      });
      verifyWriterReconstruction(
        native,
        conflictRepairCommand(intent, contract),
        `TASK_PI_CONFLICT_BASE_READY:${intent.conflictIndexSha256}\n`,
      );
    }
  }
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
    const nativeMetadata = {
      lanes: native.lanes,
      captures,
      ...(native.repairs.length ? { repairs: native.repairs } : {}),
    };
    saveEvidenceJson(path.join(dir, "native.json"), nativeMetadata);
    treeFiles(source, base, { allowEmpty: true });
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
    treeFiles(cwd, base, { allowEmpty: true }); // Valid empty base; reject unsafe entries before checkout.
    git(cwd, ["read-tree", base]);
    const applied = [],
      validated = [];
    // Validate every input against B before combining any lane. A conflict may
    // occur early; later contributions must still be bound for a complete repair.
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
      validated.push({
        ...lane,
        tree: laneTree,
        changedPaths,
        indexSha256: conflictIndex(cwd, laneIndex).indexSha256,
      });
    }
    for (const [index, lane] of validated.entries()) {
      assertOwner();
      const bytes = native.files.find(
        (file) => file.path === lane.patchPath,
      ).bytes;
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
          contract.schemaVersion === "teams-task-runtime/3"
            ? (result) => {
                throw completedIntegrationConflict(
                  { mailbox, contract, runtimeRoot, assertOwner },
                  {
                    result,
                    native: nativeMetadata,
                    lanes: validated,
                    failedLaneIndex: index,
                  },
                );
              }
            : undefined,
        );
      const { indexSha256: _indexSha256, ...integrated } = lane;
      applied.push(integrated);
      saveEvidenceJson(path.join(dir, `applied-${index}.json`), applied.at(-1));
    }
    const tree = git(cwd, ["write-tree"]).trim();
    treeFiles(cwd, tree);
    if (reviewIntent)
      assert.notEqual(
        tree,
        reviewIntent.oldTree,
        "review repair did not change the product",
      );
    scope(cwd, base, undefined, contract.workspace.allowedWritePaths);
    git(cwd, ["checkout-index", "--all"]);
    restoreGitBaseModes(cwd, base, cwd, { allowDeleted: true });
    assertStagedTree(cwd, base, tree);
    const sourceDigest = snapshot(cwd, contract.workspace.sourcePaths).digest;
    const workspaceDigest = workspaceSnapshot(cwd).digest;
    for (const check of checks) {
      assertOwner();
      const receiptRef = path.join(dir, `check-${check.id}.json`);
      const receipt = runCheck(
        check.input,
        receiptRef,
        hasOriginalTaskDeadline(contract, mailbox)
          ? {
              hardDeadlineAt: taskDeadlineAt(
                ledger,
                ledger.getExecution(contract.identity.executionId),
                contract,
              ),
            }
          : {},
      );
      // A completed check failure may return to L0 for diagnosis only after all
      // effect/source/owner boundaries are known. Timeout/signal/spawn failures
      // and mutations must never acquire this disposition.
      assertOwner();
      assertStagedTree(cwd, base, tree);
      assert.equal(
        workspaceSnapshot(cwd).digest,
        workspaceDigest,
        "integration workspace changed during host check",
      );
      inspectWorktreeBase(source, base);
      assert.equal(
        snapshot(source, contract.workspace.sourcePaths).digest,
        result.source.sourceDigest,
        "target source changed during integration",
      );
      if (
        receipt.status === "failed" &&
        Number.isSafeInteger(receipt.exitCode) &&
        receipt.exitCode > 0 &&
        receipt.signal === null &&
        receipt.errorCode === null &&
        receipt.before.digest === receipt.after.digest
      ) {
        throw new CompletedCheckFailure(
          check.id,
          receiptRef,
          bytesDigest(readEvidenceBytes(receiptRef)),
          receipt.logSha256,
          receipt.exitCode,
        );
      }
      assert.equal(
        receipt.status,
        "verified",
        `integration host check failed: ${check.id}`,
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
    return verifyStored(dir, input, contract, {
      mailbox,
      contract,
      result,
      ownerSessionId,
      assertOwner,
      runtimeRoot,
      ledger,
    });
  } catch (error) {
    // Preserve unknown effects AND known conflicts. Neither permits stage replay.
    const failureFile = path.join(dir, "failure.json");
    saveEvidenceJson(failureFile, {
      schemaVersion: "teams-integration-failure/1",
      inputDigest: digest(input),
      disposition: "preserved-reconcile-required",
      error: String(error.message).slice(0, 2000),
      ...(error instanceof CompletedIntegrationConflict
        ? { conflict: error.proof }
        : {}),
      observedAt: new Date().toISOString(),
    });
    if (error instanceof CompletedIntegrationConflict) {
      error.receiptRef = failureFile;
      error.receiptSha256 = bytesDigest(readEvidenceBytes(failureFile));
    }
    throw error;
  }
}

// A report-only revision replays the verified ORIGINAL patch against a fresh
// isolated checkout. It does not launch a writer or re-run a host check. The
// old native/check receipts remain origin evidence, not new execution receipts.
function stageReportRevision(context) {
  const {
    mailbox,
    contract,
    result,
    ownerSessionId,
    assertOwner,
    runtimeRoot,
    ledger,
  } = context;
  assert.ok(runtimeRoot && ledger, "host-owned report lineage required");
  assert.deepEqual(
    result.childRunRefs,
    [],
    "report-only result cannot claim native roles",
  );
  assert.equal(result.unresolvedRunCount, 0);
  const boot = mailbox.readJson("bootstrap.json");
  const intent = mailbox.readJson("receipts/report-revision-intent.json");
  assert.equal(
    digest(intent),
    boot.reportRevisionIntentDigest,
    "report intent changed after Worker admission",
  );
  const origin = verifyReportOrigin({
    runtimeRoot,
    ledger,
    contract,
    intent,
    assertOwner,
  });
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
    "report revision source changed",
  );
  assert.equal(
    result.source.sourceDigest,
    origin.result.source.sourceDigest,
    "report revision changed original source",
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
      "failed report lineage requires reconciliation",
    );
    assert.ok(
      fs.existsSync(path.join(dir, "receipt.json")),
      "incomplete report lineage requires reconciliation",
    );
    return verifyStored(dir, input, contract, context);
  }
  const cwd = path.join(dir, "repo");
  const checks = inputs(contract, cwd);
  const patch = origin.mailbox.readRelative(
    "integration/review.patch",
    8 * 1024 * 1024,
  );
  assert.equal(bytesDigest(patch), origin.request.subject.patch.sha256);
  assertOwner();
  fs.mkdirSync(dir, { mode: 0o700 });
  assert.equal(
    fs.realpathSync(dir),
    dir,
    "canonical integration directory required",
  );
  saveEvidenceJson(path.join(dir, "intent.json"), input);
  try {
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
      "target changed during report-only clone",
    );
    treeFiles(cwd, base, { allowEmpty: true });
    git(cwd, ["read-tree", base]);
    if (patch.length) {
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
        { input: patch },
      );
      git(cwd, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], {
        input: patch,
      });
    }
    const tree = git(cwd, ["write-tree"]).trim();
    treeFiles(cwd, tree);
    scope(cwd, base, undefined, contract.workspace.allowedWritePaths);
    assert.equal(
      tree,
      origin.staged.tree,
      "report lineage tree differs from old candidate",
    );
    git(cwd, ["checkout-index", "--all"]);
    assertStagedTree(cwd, base, tree);
    const sourceDigest = snapshot(cwd, contract.workspace.sourcePaths).digest;
    assert.equal(
      sourceDigest,
      origin.staged.sourceDigest,
      "report lineage staged source differs from old candidate",
    );
    const workspaceDigest = workspaceSnapshot(cwd).digest;
    assert.equal(
      workspaceDigest,
      origin.staged.workspaceDigest,
      "report lineage workspace differs from old candidate",
    );
    const native = origin.mailbox.readJson("integration/native.json");
    fs.mkdirSync(path.join(dir, "captures"), { mode: 0o700 });
    for (const capture of origin.staged.captures) {
      validateScopedPath(capture.saved, "original captured artifact");
      assert.match(capture.saved, /^captures\/[0-9]+\.bin$/);
      const bytes = origin.mailbox.readRelative(
        `integration/${capture.saved}`,
        8 * 1024 * 1024,
      );
      assert.equal(bytesDigest(bytes), capture.sha256);
      fs.writeFileSync(path.join(dir, capture.saved), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    saveEvidenceJson(path.join(dir, "native.json"), native);
    for (const [index, lane] of origin.staged.lanes.entries())
      saveEvidenceJson(path.join(dir, `applied-${index}.json`), lane);
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
      nativeDigest: digest(native),
      lanes: origin.staged.lanes,
      captures: origin.staged.captures,
      checks: checks.map((check) => check.id),
      inheritedFrom: {
        previousExecutionId: intent.previousExecutionId,
        intentDigest: digest(intent),
        rehearsalSha256: intent.rehearsalSha256,
        writerEvidenceDigest: intent.writerEvidenceDigest,
      },
      completedAt: new Date().toISOString(),
    };
    assertOwner();
    assert.equal(
      verifyReportOrigin({ runtimeRoot, ledger, contract, intent, assertOwner })
        .staged.tree,
      tree,
      "original stage changed during report lineage",
    );
    saveEvidenceJson(path.join(dir, "receipt.json"), receipt);
    return verifyStored(dir, input, contract, context);
  } catch (error) {
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
