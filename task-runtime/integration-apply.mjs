// L0-only staged application. No commit, ref movement, force/reset or automatic retry.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bytesDigest, digest } from "./contracts.mjs";
import { readEvidenceBytes, saveEvidenceJson } from "../host-evidence.mjs";
import {
  integrationGit as git,
  integrationGitInvocation,
  integrationWorkspaceSnapshot as workspaceSnapshot,
  readIntegrationRehearsal,
} from "./integration.mjs";

function json(file) {
  try {
    return JSON.parse(readEvidenceBytes(file, 1024 * 1024).toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid target-apply evidence: ${file}`, { cause });
  }
}
const directory = (context) =>
  path.join(context.mailbox.root, "integration", "target-apply");

function targetState(context) {
  const source = context.contract.workspace.sourceRoot;
  const index = git(source, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]).trim();
  return {
    ref: git(source, ["symbolic-ref", "HEAD"]).trim(),
    head: git(source, ["rev-parse", "HEAD"]).trim(),
    tree: git(source, ["write-tree"]).trim(),
    workspaceDigest: workspaceSnapshot(
      source,
      context.contract.schemaVersion === "teams-task-runtime/3",
    ).digest,
    indexDigest: bytesDigest(readEvidenceBytes(index)),
  };
}

function logical(state) {
  const { indexDigest: _index, ...rest } = state;
  return rest;
}

function mergedPatch(staged, base) {
  // A text diff can contain arbitrary bytes even without NUL; never decode it.
  return git(
    staged.cwd,
    [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      base,
      "--",
    ],
    { encoding: "buffer" },
  );
}

function load(context, expectedDigest) {
  context.assertOwner();
  assert.equal(
    context.contract.policy.integrationMode,
    "approved-integration",
    "verify-only is not target-write authority",
  );
  const staged = readIntegrationRehearsal(context);
  const dir = directory(context);
  assert.equal(fs.realpathSync(dir), dir, "canonical apply directory required");
  const plan = json(path.join(dir, "plan.json"));
  const { planDigest, ...body } = plan;
  assert.equal(digest(body), planDigest, "apply plan changed");
  if (expectedDigest !== undefined)
    assert.equal(planDigest, expectedDigest, "apply plan digest mismatch");
  assert.equal(
    plan.schemaVersion,
    "teams-integration-apply-plan/1",
    "unsupported apply plan",
  );
  assert.equal(
    plan.contractDigest,
    digest(context.contract),
    "apply contract changed",
  );
  assert.equal(
    plan.resultDigest,
    digest(context.result),
    "apply candidate changed",
  );
  assert.equal(
    plan.ownerSessionId,
    context.ownerSessionId,
    "apply owner changed",
  );
  assert.equal(plan.rehearsalDigest, digest(staged), "apply rehearsal changed");
  assert.equal(
    plan.targetRoot,
    context.contract.workspace.sourceRoot,
    "apply target changed",
  );
  assert.equal(
    plan.baseCommit,
    context.contract.workspace.baseCommit,
    "apply base changed",
  );
  assert.equal(plan.mergedTree, staged.tree, "apply tree changed");
  assert.deepEqual(
    plan.after,
    {
      ref: plan.before.ref,
      head: plan.baseCommit,
      tree: staged.tree,
      workspaceDigest: staged.workspaceDigest,
    },
    "apply expected state changed",
  );
  assert.equal(plan.before.head, plan.baseCommit, "apply baseline changed");
  assert.equal(
    plan.before.tree,
    git(staged.cwd, ["rev-parse", `${plan.baseCommit}^{tree}`]).trim(),
    "apply base tree changed",
  );
  git(staged.cwd, ["check-ref-format", plan.before.ref]);
  assert.ok(
    plan.before.ref.startsWith("refs/heads/"),
    "named local target branch required",
  );
  const patch = readEvidenceBytes(path.join(dir, "merged.patch"));
  assert.equal(bytesDigest(patch), plan.patchDigest, "apply patch changed");
  assert.equal(
    bytesDigest(mergedPatch(staged, plan.baseCommit)),
    plan.patchDigest,
    "patch is not the verified integration delta",
  );
  return { dir, plan, patch, staged };
}

export function prepareIntegrationApply(context) {
  context.assertOwner();
  assert.equal(
    context.contract.policy.integrationMode,
    "approved-integration",
    "verify-only is not target-write authority",
  );
  const dir = directory(context);
  if (fs.existsSync(dir)) {
    assert.ok(
      fs.existsSync(path.join(dir, "plan.json")),
      "incomplete apply preparation; reconcile before retry",
    );
    return load(context).plan;
  }
  const staged = readIntegrationRehearsal(context);
  const source = context.contract.workspace.sourceRoot;
  const base = context.contract.workspace.baseCommit;
  const before = targetState(context);
  assert.equal(before.head, base, "target base changed");
  const baseTree = git(staged.cwd, ["rev-parse", `${base}^{tree}`]).trim();
  assert.equal(before.tree, baseTree, "target index is not clean");
  git(source, ["check-ref-format", before.ref]);
  assert.ok(
    before.ref.startsWith("refs/heads/"),
    "named local target branch required",
  );
  const patch = mergedPatch(staged, base);
  assert.ok(patch.length, "no integration delta to apply");
  // Materialize the actual Git base, not a possibly hidden/ignored target edit.
  // This scratch index/checkout is not a native leaf worktree allocator.
  fs.mkdirSync(dir, { mode: 0o700 });
  const baseline = path.join(dir, "baseline");
  fs.mkdirSync(baseline);
  const index = path.join(dir, "base.index");
  git(staged.cwd, ["read-tree", base], { index });
  git(staged.cwd, ["checkout-index", "--all", `--prefix=${baseline}/`], {
    index,
  });
  assert.equal(
    workspaceSnapshot(baseline).digest,
    before.workspaceDigest,
    "target differs from complete Git baseline (including hidden/ignored files)",
  );
  const patchFd = fs.openSync(path.join(dir, "merged.patch"), "wx", 0o600);
  try {
    fs.writeFileSync(patchFd, patch);
    fs.fsyncSync(patchFd);
  } finally {
    fs.closeSync(patchFd);
  }
  const body = {
    schemaVersion: "teams-integration-apply-plan/1",
    contractDigest: digest(context.contract),
    resultDigest: digest(context.result),
    ownerSessionId: context.ownerSessionId,
    rehearsalDigest: digest(staged),
    targetRoot: source,
    baseCommit: base,
    mergedTree: staged.tree,
    before,
    after: {
      ref: before.ref,
      head: base,
      tree: staged.tree,
      workspaceDigest: staged.workspaceDigest,
    },
    patchDigest: bytesDigest(patch),
    mode: "staged-diff",
    refModified: false,
  };
  context.assertOwner();
  assert.deepEqual(
    targetState(context),
    before,
    "target changed during apply preparation",
  );
  saveEvidenceJson(path.join(dir, "plan.json"), {
    ...body,
    planDigest: digest(body),
  });
  return load(context).plan;
}

function verifyJournal(file, plan, action) {
  const value = json(file);
  const phase = path.basename(file, ".json").split("-").at(-1);
  assert.equal(
    value.schemaVersion,
    `teams-integration-apply-${phase}/1`,
    "unsupported operation evidence",
  );
  assert.equal(value.planDigest, plan.planDigest, "operation plan changed");
  assert.equal(value.action, action, "operation action changed");
  assert.equal(
    value.ownerSessionId,
    plan.ownerSessionId,
    "operation owner changed",
  );
  return value;
}

function observation(context, dir, plan) {
  const current = targetState(context);
  let disposition = "diverged";
  if (digest(logical(current)) === digest(logical(plan.before)))
    disposition = "baseline";
  if (digest(logical(current)) === digest(plan.after)) disposition = "applied";
  return {
    disposition,
    current,
    locked: fs.existsSync(path.join(dir, "operation.lock")),
  };
}

export function inspectIntegrationApply(context, planDigest) {
  const { dir, plan } = load(context, planDigest);
  const observed = observation(context, dir, plan);
  let commandClosed = false,
    mutationClosed = false;
  for (const action of ["apply", "rollback"]) {
    for (const phase of ["intent", "command", "receipt"]) {
      const file = path.join(dir, `${action}-${phase}.json`);
      if (!fs.existsSync(file)) continue;
      const evidence = verifyJournal(file, plan, action);
      if (action === "apply" && phase === "command") {
        commandClosed = evidence.terminal?.observed === true;
        mutationClosed = evidence.mutationTerminal?.observed === true;
      }
    }
  }
  return {
    ...observed,
    planDigest: plan.planDigest,
    acceptance: "not-assessed",
    applyIntent: fs.existsSync(path.join(dir, "apply-intent.json")),
    applyReceipt: fs.existsSync(path.join(dir, "apply-receipt.json")),
    rollbackIntent: fs.existsSync(path.join(dir, "rollback-intent.json")),
    rollbackReceipt: fs.existsSync(path.join(dir, "rollback-receipt.json")),
    // Missing command-close proof or a retained lock is not permission to replay.
    commandClosed,
    mutationClosed,
  };
}

// Git holds HEAD's symbolic identity and the expected branch OID while the
// index/worktree operation runs. No ref is updated. Git's index/ref locks are NOT
// a filesystem transaction or an OS sandbox: cooperating writers must be exclusive.
async function withTargetFence(plan, mutate) {
  const invocation = integrationGitInvocation(plan.targetRoot, [
    "update-ref",
    "--stdin",
  ]);
  const child = spawn("git", invocation.args, {
    env: invocation.options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    stdout = "",
    prepared = false,
    failure = null;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", (error) => {
    failure ??= error;
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-4096);
  });
  const timer = setTimeout(() => {
    failure ??= new Error("Git ref fence timed out; reconcile required");
    child.kill("SIGTERM");
  }, 30000);
  try {
    // A dereferenced HEAD verification locks HEAD and its referent together.
    // Verify the named branch identity inside those locks in mutate().
    child.stdin.write(`start\nverify HEAD ${plan.baseCommit}\nprepare\n`);
    for await (const bytes of child.stdout) {
      stdout += bytes.toString();
      assert.ok(stdout.length <= 16384, "Git fence output exceeds bound");
      if (!prepared && stdout.includes("prepare: ok\n")) {
        prepared = true;
        mutate();
        child.stdin.end("commit\n");
      }
    }
  } catch (error) {
    failure = error;
    child.stdin.end(); // EOF aborts a prepared transaction; never force a ref.
  }
  const terminal = await closed;
  clearTimeout(timer);
  if (
    !prepared ||
    terminal.code !== 0 ||
    terminal.signal ||
    !stdout.includes("commit: ok\n")
  )
    failure ??= new Error(
      `Git target fence did not commit its verification: ${stderr}`,
    );
  return {
    terminal: { ...terminal, observed: true },
    stdout,
    stderr,
    error: failure ? String(failure.message).slice(0, 2000) : null,
  };
}

function validateReviewBinding(binding) {
  assert.equal(
    binding?.schemaVersion,
    "teams-integration-review-binding/1",
    "review authority binding missing",
  );
  assert.deepEqual(
    Object.keys(binding).sort(),
    [
      "schemaVersion",
      "requestDigest",
      "candidateDigest",
      "writerEvidenceDigest",
    ].sort(),
    "review authority fields changed",
  );
  for (const key of [
    "requestDigest",
    "candidateDigest",
    "writerEvidenceDigest",
  ])
    assert.match(
      typeof binding[key] === "string" ? binding[key] : "",
      /^[a-f0-9]{64}$/,
      "review authority digest missing",
    );
}

function readOperationReceipt(context, { dir, plan }, action) {
  const entries = fs.readdirSync(dir);
  assert.ok(
    !entries.includes("operation.lock"),
    "operation lock retained; reconcile before verification",
  );
  if (action === "apply")
    assert.ok(
      ![
        "rollback-intent.json",
        "rollback-command.json",
        "rollback-receipt.json",
      ].some((name) => entries.includes(name)),
      "apply plan was rolled back or consumed",
    );
  const receipt = verifyJournal(
    path.join(dir, `${action}-receipt.json`),
    plan,
    action,
  );
  const intent = verifyJournal(
    path.join(dir, `${action}-intent.json`),
    plan,
    action,
  );
  const command = verifyJournal(
    path.join(dir, `${action}-command.json`),
    plan,
    action,
  );
  assert.equal(
    intent.authority,
    "interactive-confirmation",
    "operation authority missing",
  );
  if (
    action === "apply" &&
    context.contract.schemaVersion === "teams-task-runtime/3"
  ) {
    validateReviewBinding(intent.reviewBinding);
    assert.deepEqual(
      command.reviewBinding,
      intent.reviewBinding,
      "command review authority changed",
    );
    assert.deepEqual(
      receipt.reviewBinding,
      intent.reviewBinding,
      "receipt review authority changed",
    );
  }
  assert.equal(
    receipt.commandDigest,
    digest(command),
    "operation command receipt changed",
  );
  assert.equal(
    receipt.status,
    action === "apply" ? "applied" : "rolled-back",
    "operation status changed",
  );
  assert.equal(
    receipt.acceptance,
    "not-assessed",
    "application is not acceptance",
  );
  assert.equal(receipt.refModified, false, "staged apply must not move refs");
  assert.equal(
    command.terminal?.observed,
    true,
    "operation terminal proof missing",
  );
  assert.equal(command.terminal.code, 0, "operation did not exit successfully");
  assert.equal(command.terminal.signal, null, "operation was interrupted");
  assert.equal(
    command.mutationTerminal?.observed,
    true,
    "mutation command terminal proof missing",
  );
  assert.equal(command.mutationTerminal.code, 0, "mutation command failed");
  assert.equal(
    command.mutationTerminal.signal,
    null,
    "mutation command was interrupted",
  );
  assert.equal(command.mutationTerminal.error, null, "mutation command error");
  assert.equal(command.error, null, "operation command failed");
  assert.equal(command.observationError, null, "operation observation failed");
  assert.deepEqual(receipt.before, intent.before, "operation baseline changed");
  const expectedBefore =
    action === "apply"
      ? plan.before
      : verifyJournal(path.join(dir, "apply-command.json"), plan, "apply")
          .after;
  assert.ok(expectedBefore, "operation baseline missing");
  if (action === "rollback")
    assert.deepEqual(
      logical(expectedBefore),
      plan.after,
      "rollback baseline is not the applied state",
    );
  assert.deepEqual(
    intent.before,
    expectedBefore,
    "operation baseline is not the planned state",
  );
  assert.deepEqual(receipt.after, command.after, "operation result changed");
  assert.deepEqual(
    logical(receipt.after),
    action === "apply" ? plan.after : logical(plan.before),
    "operation source changed",
  );
  assert.deepEqual(
    targetState(context),
    receipt.after,
    "target changed since operation receipt",
  );
  context.assertOwner();
  return receipt;
}

// Read existing success proof only. Never confirms, executes, repairs a journal,
// or treats an observed filesystem effect without command-close proof as success.
export function verifyIntegrationApply(context, planDigest) {
  assert.match(
    typeof planDigest === "string" ? planDigest : "",
    /^[a-f0-9]{64}$/,
    "explicit apply plan digest required",
  );
  return readOperationReceipt(context, load(context, planDigest), "apply");
}

export async function executeIntegrationApply(
  context,
  { action, planDigest, confirm },
) {
  assert.ok(
    ["apply", "rollback"].includes(action),
    "unsupported integration operation",
  );
  assert.match(
    typeof planDigest === "string" ? planDigest : "",
    /^[a-f0-9]{64}$/,
    "explicit apply plan digest required",
  );
  const { dir, plan, patch, staged } = load(context, planDigest);
  const receiptFile = path.join(dir, `${action}-receipt.json`);
  const intentFile = path.join(dir, `${action}-intent.json`);
  if (action === "apply")
    assert.ok(
      !fs.existsSync(path.join(dir, "rollback-intent.json")),
      "apply plan was rolled back or consumed",
    );
  if (fs.existsSync(receiptFile))
    return readOperationReceipt(context, { dir, plan }, action);
  assert.ok(
    !fs.existsSync(intentFile),
    "operation intent exists; reconcile instead of retrying",
  );
  let expected, reviewBinding;
  if (action === "apply") {
    reviewBinding = structuredClone(await context.assertApplyGates(staged));
    if (context.contract.schemaVersion === "teams-task-runtime/3")
      validateReviewBinding(reviewBinding);
    expected = plan.before;
  } else {
    verifyJournal(path.join(dir, "apply-intent.json"), plan, "apply");
    const command = verifyJournal(
      path.join(dir, "apply-command.json"),
      plan,
      "apply",
    );
    assert.equal(
      command.terminal?.observed,
      true,
      "apply command terminal proof required before rollback",
    );
    assert.equal(
      command.mutationTerminal?.observed,
      true,
      "mutation command terminal proof required before rollback",
    );
    assert.ok(
      command.after,
      "no complete applied state to roll back; preserve and reconcile",
    );
    assert.deepEqual(
      logical(command.after),
      plan.after,
      "no complete applied state to roll back; preserve and reconcile",
    );
    expected = command.after;
  }
  assert.deepEqual(
    targetState(context),
    expected,
    "target changed; refusing to overwrite later edits",
  );
  assert.equal(
    typeof confirm,
    "function",
    "interactive host confirmation required",
  );
  const approved = await confirm({ action, plan });
  if (approved !== true) return { status: "declined", targetModified: false };
  // Revalidate after the UI wait. Model tool arguments are not approval receipts.
  load(context, planDigest);
  if (action === "apply")
    assert.deepEqual(
      await context.assertApplyGates(staged),
      reviewBinding,
      "review authority changed during confirmation",
    );
  const lockFile = path.join(dir, "operation.lock");
  const lock = fs.openSync(lockFile, "wx", 0o600);
  const ownedLock = fs.fstatSync(lock);
  try {
    fs.writeFileSync(
      lock,
      JSON.stringify({
        action,
        planDigest,
        ownerSessionId: context.ownerSessionId,
        processId: process.pid,
      }),
    );
    fs.fsyncSync(lock);
    assert.ok(
      !fs.existsSync(intentFile),
      "operation intent exists; reconcile instead of retrying",
    );
    context.assertOwner();
    assert.deepEqual(
      targetState(context),
      expected,
      "target changed during confirmation",
    );
    const identity = {
      action,
      planDigest: plan.planDigest,
      ownerSessionId: context.ownerSessionId,
      ...(reviewBinding === undefined ? {} : { reviewBinding }),
    };
    saveEvidenceJson(intentFile, {
      ...identity,
      schemaVersion: "teams-integration-apply-intent/1",
      before: expected,
      authority: "interactive-confirmation",
      confirmedAt: new Date().toISOString(),
    });
    let mutationTerminal = null;
    const command = await withTargetFence(plan, () => {
      context.assertOwner();
      assert.deepEqual(
        targetState(context),
        expected,
        "target changed before fenced apply",
      );
      const invocation = integrationGitInvocation(
        plan.targetRoot,
        [
          "apply",
          "--index",
          "--binary",
          "--whitespace=nowarn",
          ...(action === "rollback" ? ["--reverse"] : []),
          "-",
        ],
        { input: patch },
      );
      const mutation = spawnSync("git", invocation.args, invocation.options);
      mutationTerminal = {
        observed:
          !mutation.error && mutation.status !== null && !mutation.signal,
        code: mutation.status,
        signal: mutation.signal,
        error: mutation.error?.code ?? null,
      };
      assert.ok(
        mutationTerminal.observed && mutation.status === 0,
        `Git mutation failed; reconcile required: ${String(mutation.error?.code ?? mutation.stderr).slice(0, 1500)}`,
      );
      context.assertOwner();
      assert.deepEqual(
        logical(targetState(context)),
        action === "apply" ? plan.after : logical(plan.before),
        "target changed during fenced apply",
      );
    });
    // Preserve close evidence even if observing a partial/invalid working tree fails.
    let after = null,
      observationError = null;
    try {
      after = targetState(context);
    } catch (error) {
      observationError = String(error.message).slice(0, 2000);
    }
    const commandReceipt = {
      ...identity,
      schemaVersion: "teams-integration-apply-command/1",
      ...command,
      mutationTerminal,
      after,
      observationError,
    };
    saveEvidenceJson(path.join(dir, `${action}-command.json`), commandReceipt);
    assert.equal(
      command.error,
      null,
      `integration operation failed; preserve and reconcile: ${command.error}`,
    );
    assert.equal(
      observationError,
      null,
      "cannot observe target; preserve and reconcile",
    );
    context.assertOwner();
    assert.deepEqual(
      logical(after),
      action === "apply" ? plan.after : logical(plan.before),
      "target changed after fenced apply",
    );
    const receipt = {
      ...identity,
      schemaVersion: "teams-integration-apply-receipt/1",
      status: action === "apply" ? "applied" : "rolled-back",
      acceptance: "not-assessed",
      refModified: false,
      before: expected,
      after,
      commandDigest: digest(commandReceipt),
      completedAt: new Date().toISOString(),
    };
    saveEvidenceJson(receiptFile, receipt);
    return receipt;
  } finally {
    fs.closeSync(lock);
    const currentLock = fs.lstatSync(lockFile);
    assert.ok(
      currentLock.ino === ownedLock.ino && currentLock.dev === ownedLock.dev,
      "operation lock changed; preserve and reconcile",
    );
    fs.unlinkSync(lockFile); // Only our exclusive lock; a process crash retains it.
  }
}
