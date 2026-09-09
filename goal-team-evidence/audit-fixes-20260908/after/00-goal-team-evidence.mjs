// Parent-only host evidence. Commands must already be trusted/authorized.
// No child controller, retries, installations, Goal writes or semantic approval.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const identity = (value) => sha(canonical(value));
const secretPath =
  /(^|[\\/])(auth\.json|credentials(?:\.json)?|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc)([\\/]|$)|\.(pem|key)$/i;
const runtime = () => ({
  node: process.version,
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
});
const inside = (root, file) =>
  file === root || file.startsWith(root + path.sep);

function readBytes(file, max = 8 * 1024 * 1024) {
  assert.ok(
    !secretPath.test(file),
    "credential paths cannot be evidence inputs",
  );
  assert.equal(fs.realpathSync(file), file, "symlink paths are not evidence");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    assert.ok(
      before.isFile() && before.size <= max,
      "bounded regular file required",
    );
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0,
      count;
    while (
      size < buffer.length &&
      (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0
    )
      size += count;
    const after = fs.lstatSync(file);
    assert.ok(
      size === before.size &&
        after.ino === before.ino &&
        after.dev === before.dev &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "file changed while reading",
    );
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}
export function evidenceDigest(file) {
  assert.ok(path.isAbsolute(file), 'absolute evidence path required');
  const bytes = readBytes(file);
  assert.ok(bytes.length > 0, 'empty evidence artifact');
  return sha(bytes);
}
function readJson(file) {
  try {
    return JSON.parse(
      readBytes(path.resolve(file), 1024 * 1024).toString("utf8"),
    );
  } catch (cause) {
    throw new Error("Invalid or unreadable evidence JSON: " + file, { cause });
  }
}
export function saveEvidenceJson(file, value) {
  const data = JSON.stringify(value, null, 2) + "\n";
  assert.ok(
    Buffer.byteLength(data) <= 1024 * 1024,
    "evidence metadata too large",
  );
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
const save = saveEvidenceJson;

function scopedPath(cwd, relative) {
  assert.ok(
    typeof relative === "string" &&
      relative &&
      !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/).includes(".."),
    "relative source path required",
  );
  // This is not a secret scanner or OS sandbox. Parent must approve the scope.
  assert.ok(
    !secretPath.test(relative),
    "credential paths cannot be evidence inputs",
  );
  const file = path.resolve(cwd, relative);
  assert.ok(inside(cwd, file), "path escapes cwd");
  assert.equal(fs.realpathSync(file), file, "symlink paths are not evidence");
  return file;
}

export function snapshot(cwd, sourcePaths) {
  cwd = path.resolve(cwd);
  assert.equal(fs.realpathSync(cwd), cwd, "canonical cwd required");
  assert.ok(
    Array.isArray(sourcePaths) &&
      sourcePaths.length > 0 &&
      sourcePaths.length <= 128,
    "1..128 explicit source paths required",
  );
  const files = new Map();
  let bytes = 0,
    visited = 0;
  function visit(file, depth = 0) {
    assert.ok(++visited <= 1024 && depth <= 16, "source scope too broad");
    const relative = path.relative(cwd, file);
    scopedPath(cwd, relative || ".");
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      files.set(relative, {
        path: relative,
        kind: "directory",
        mode: stat.mode & 0o777,
      });
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name), depth + 1);
    } else {
      const content = readBytes(file);
      bytes += content.length;
      assert.ok(
        bytes <= 64 * 1024 * 1024 && files.size < 512,
        "source scope too large",
      );
      files.set(relative, {
        path: relative,
        mode: stat.mode & 0o777,
        sha256: sha(content),
      });
    }
  }
  for (const name of sourcePaths) visit(scopedPath(cwd, name));
  assert.ok(files.size > 0, "empty source scope");
  const entries = [...files.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return { cwd, files: entries, digest: identity(entries) };
}

function checkInput(input) {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    "check input required",
  );
  assert.deepEqual(Object.keys(input).sort(), [
    "argv",
    "cwd",
    "sourcePaths",
    "timeoutMs",
  ]);
  assert.ok(
    typeof input.cwd === "string" && path.isAbsolute(input.cwd),
    "absolute cwd required",
  );
  assert.ok(
    Array.isArray(input.argv) &&
      input.argv.length > 0 &&
      input.argv.length <= 128 &&
      input.argv.every((x) => typeof x === "string" && !x.includes("\0")),
    "bounded argv required",
  );
  assert.ok(
    path.isAbsolute(input.argv[0]),
    "explicit executable path required; no PATH lookup",
  );
  assert.ok(
    Number.isSafeInteger(input.timeoutMs) &&
      input.timeoutMs > 0 &&
      input.timeoutMs <= 2147483647,
    "explicit native-compatible timeout required",
  );
  return {
    cwd: input.cwd,
    sourcePaths: input.sourcePaths,
    argv: input.argv,
    timeoutMs: input.timeoutMs,
  };
}

export function runCheck(input, receiptFile) {
  input = checkInput(input);
  receiptFile = path.resolve(receiptFile);
  assert.equal(
    fs.realpathSync(path.dirname(receiptFile)),
    path.dirname(receiptFile),
    "canonical output directory required",
  );
  for (const source of input.sourcePaths)
    assert.ok(
      !inside(path.resolve(input.cwd, source), receiptFile),
      "receipt must be outside source scope",
    );
  assert.ok(
    !fs.existsSync(receiptFile) && !fs.existsSync(receiptFile + ".log"),
    "receipt/log already exists; reconcile instead of replaying",
  );
  const before = snapshot(input.cwd, input.sourcePaths);
  // Permanent exclusive intent: a crash/timeout never grants permission to rerun.
  save(receiptFile + ".intent", {
    version: "host-check-intent/1",
    input,
    before,
    startedAt: new Date().toISOString(),
  });
  const fd = fs.openSync(receiptFile + ".log", "wx", 0o600);
  const started = Date.now();
  let result, log;
  try {
    result = spawnSync(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    log = Buffer.concat([
      Buffer.from("[stdout]\n"),
      result.stdout ?? Buffer.alloc(0),
      Buffer.from("\n[stderr]\n"),
      result.stderr ?? Buffer.alloc(0),
    ]);
    fs.writeFileSync(fd, log);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const after = snapshot(input.cwd, input.sourcePaths);
  const receipt = {
    version: "host-check/1",
    input,
    runtime: runtime(),
    before,
    after,
    status:
      !result.error &&
      result.status === 0 &&
      !result.signal &&
      before.digest === after.digest
        ? "verified"
        : "failed",
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    durationMs: Date.now() - started,
    logSha256: sha(log),
    finishedAt: new Date().toISOString(),
  };
  save(receiptFile, receipt);
  return receipt;
}

export function verifyCheck(input, receiptFile) {
  input = checkInput(input);
  receiptFile = path.resolve(receiptFile);
  const receipt = readJson(receiptFile);
  assert.equal(receipt.version, "host-check/1", "not a host-check receipt");
  assert.equal(
    identity(receipt.input),
    identity(input),
    "check contract changed",
  );
  assert.equal(
    identity(receipt.runtime),
    identity(runtime()),
    "host runtime changed",
  );
  assert.ok(
    receipt.status === "verified" &&
      receipt.exitCode === 0 &&
      receipt.signal === null &&
      receipt.errorCode === null,
    "check did not complete successfully",
  );
  const current = snapshot(input.cwd, input.sourcePaths);
  assert.deepEqual(receipt.before, current, "source changed since check");
  assert.deepEqual(receipt.after, current, "check changed its source");
  const intent = readJson(receiptFile + ".intent");
  assert.equal(intent.version, "host-check-intent/1");
  assert.equal(identity(intent.input), identity(input), "intent mismatch");
  assert.deepEqual(intent.before, current, "intent source mismatch");
  assert.equal(
    sha(readBytes(receiptFile + ".log", 32 * 1024 * 1024)),
    receipt.logSha256,
    "log changed",
  );
  return {
    status: "verified",
    receipt: receiptFile,
    sourceDigest: current.digest,
  };
}

function atomicSave(file, value) {
  assert.equal(
    fs.realpathSync(path.dirname(file)),
    path.dirname(file),
    "canonical evidence directory required",
  );
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    save(temp, value);
    const fd = fs.openSync(temp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function relativeArtifact(root, name) {
  assert.ok(
    typeof name === "string" &&
      name &&
      !path.isAbsolute(name) &&
      !name.split(/[\\/]/).some((x) => !x || x === "." || x === ".."),
    "relative artifact path required",
  );
  const file = path.resolve(root, name);
  assert.ok(
    inside(root, file) && !secretPath.test(file),
    "artifact escapes approved evidence directory",
  );
  return file;
}
function loadContract(file, digest) {
  file = path.resolve(file);
  const contract = readJson(file);
  assert.equal(contract.version, "team-evidence/1");
  for (const key of Object.keys(contract))
    assert.ok(
      [
        "version",
        "cwd",
        "goalId",
        "taskId",
        "criteria",
        "checks",
        "requiredEvidence",
        "decision",
        "mission",
      ].includes(key),
      "unknown contract field: " + key,
    );
  assert.ok(
    typeof contract.cwd === "string" &&
      path.isAbsolute(contract.cwd) &&
      inside(contract.cwd, file),
    "contract must live under its approved cwd",
  );
  assert.equal(fs.realpathSync(contract.cwd), contract.cwd);
  assert.ok(
    Array.isArray(contract.criteria) &&
      contract.criteria.length > 0 &&
      contract.criteria.length <= 30 &&
      contract.criteria.every((x) => typeof x === "string" && x.trim()) &&
      new Set(contract.criteria).size === contract.criteria.length,
    "unique observable criteria required",
  );
  assert.ok(
    Array.isArray(contract.checks) &&
      contract.checks.length <= 30 &&
      new Set(contract.checks.map((x) => x.id)).size === contract.checks.length,
    "unique checks required",
  );
  for (const check of contract.checks) {
    assert.ok(
      /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(check.id),
      "invalid check id",
    );
    checkInput(check.input);
    assert.equal(
      check.input.cwd,
      contract.cwd,
      "check cwd differs from contract",
    );
  }
  assert.ok(
    Array.isArray(contract.requiredEvidence) &&
      contract.requiredEvidence.length <= 30 &&
      new Set(contract.requiredEvidence).size ===
        contract.requiredEvidence.length,
    "explicit requiredEvidence array required",
  );
  assert.ok(
    contract.checks.length + contract.requiredEvidence.length > 0,
    "no evidence requirements",
  );
  const root = path.dirname(file);
  const decision = relativeArtifact(root, contract.decision);
  for (const name of contract.requiredEvidence)
    assert.notEqual(
      relativeArtifact(root, name),
      decision,
      "decision cannot attest itself",
    );
  const contractDigest = identity(contract);
  if (digest !== undefined)
    assert.equal(contractDigest, digest, "acceptance contract changed");
  return { contract, root, decision, contractDigest, file };
}
// A parent reconciliation settles execution, not product acceptance. Historical
// source may change after a repair; never rerun historical checks to settle it.
export function goalStepSettled(record) {
  const recovery = record?.recovery;
  return !!(record && ['reported', 'blocked', 'dispatching'].includes(record.status) &&
    recovery && ['continue', 'retry', 'report-only'].includes(recovery.action) &&
    recovery.requestDigest === record.requestDigest && /^[a-f0-9]{64}$/.test(record.requestDigest ?? '') &&
    ['nativeStatusRef', 'hostReceiptRef'].every(field => typeof recovery[field] === 'string' && recovery[field].startsWith('/')) &&
    ['nativeDigest', 'hostReceiptDigest'].every(field => typeof recovery[field] === 'string' && /^[a-f0-9]{64}$/.test(recovery[field])) &&
    typeof recovery.childRunId === 'string' && recovery.childRunId.trim() &&
    (record.runId == null || record.runId === recovery.childRunId) &&
    typeof recovery.sourceState === 'string' && recovery.sourceState.trim() &&
    (recovery.action !== 'retry' || record.outcomes?.product !== 'pass' ||
      (typeof recovery.rejectionRef === 'string' && recovery.rejectionRef.startsWith('/') && /^[a-f0-9]{64}$/.test(recovery.rejectionDigest ?? ''))) &&
    typeof recovery.reason === 'string' && recovery.reason.trim() && recovery.reason.length <= 1024);
}
function missionSettled(contract) {
  if (!contract.mission) return;
  const { id, statePath } = contract.mission;
  assert.ok(
    typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
    "invalid mission id",
  );
  assert.ok(
    typeof statePath === "string" &&
      path.isAbsolute(statePath) &&
      path.basename(statePath) === "state.json" &&
      path.basename(path.dirname(statePath)) === id,
    "exact native mission state path required",
  );
  const state = readJson(statePath);
  assert.deepEqual(
    state.teamGoalBinding,
    { goalId: contract.goalId, cwd: contract.cwd },
    "mission Goal binding mismatch",
  );
  assert.equal(
    state.teamGoalActiveStep,
    null,
    "mission has an unreconciled active intent",
  );
  for (const [key, value] of Object.entries(state))
    if (key.startsWith("goal-step.")) {
      assert.ok(
        goalStepSettled(value),
        "unresolved retained step: " + key,
      );
    }
}
function prove(context, summary) {
  const { contract, root } = context;
  missionSettled(contract);
  assert.ok(
    summary && Array.isArray(summary.criterionResults),
    "parent observations required",
  );
  const rows = summary.criterionResults;
  assert.equal(rows.length, contract.criteria.length, "missing criterion");
  assert.equal(
    new Set(rows.map((row) => row.criterion)).size,
    contract.criteria.length,
    "duplicate criterion",
  );
  const checks = {},
    evidence = {};
  assert.deepEqual(
    Object.keys(summary.checks ?? {}).sort(),
    contract.checks.map((check) => check.id).sort(),
    "exact receipt selection required",
  );
  for (const check of contract.checks) {
    const receipt = relativeArtifact(root, summary.checks[check.id]);
    verifyCheck(check.input, receipt);
    checks[check.id] = {
      path: summary.checks[check.id],
      digest: identity(readJson(receipt)),
    };
  }
  for (const name of contract.requiredEvidence)
    evidence[name] = sha(readBytes(relativeArtifact(root, name)));
  const refs = new Set([
    ...contract.checks.map((check) => "check:" + check.id),
    ...contract.requiredEvidence.map((name) => "file:" + name),
  ]);
  for (const row of rows) {
    assert.ok(
      contract.criteria.includes(row.criterion) && row.status === "met",
      "criterion not met",
    );
    assert.ok(
      typeof row.entrypoint === "string" &&
        row.entrypoint.trim() &&
        typeof row.observed === "string" &&
        row.observed.trim(),
      "actual entrypoint/observation required",
    );
    assert.ok(
      Array.isArray(row.evidence) &&
        row.evidence.length &&
        row.evidence.every((ref) => refs.has(ref)),
      "observation references undeclared evidence",
    );
  }
  return { checks, evidence };
}

export function acceptanceReference(file, expected = {}) {
  const context = loadContract(file);
  for (const key of ["cwd", "goalId", "taskId"])
    if (expected[key] !== undefined)
      assert.equal(
        context.contract[key],
        expected[key],
        "acceptance identity mismatch: " + key,
      );
  return (
    "team-evidence/1:" +
    context.contractDigest +
    ":" +
    path.relative(context.contract.cwd, context.file)
  );
}
export function sealAcceptance(file, summaryFile) {
  const context = loadContract(file);
  const summary = readJson(summaryFile);
  // Retain prior judgments, then invalidate the current decision BEFORE checking.
  // A failed attempt must never leave an older ready decision looking current.
  if (fs.existsSync(context.decision)) {
    const previous = readJson(context.decision);
    const archive = context.decision + "." + identity(previous) + ".json";
    if (fs.existsSync(archive))
      assert.equal(
        identity(readJson(archive)),
        identity(previous),
        "decision archive changed",
      );
    else save(archive, previous);
  }
  atomicSave(context.decision, {
    version: "team-decision/1",
    status: "pending",
    contractDigest: context.contractDigest,
  });
  const proof = prove(context, summary);
  const decision = {
    version: "team-decision/1",
    status: "ready",
    contractDigest: context.contractDigest,
    summary,
    proof,
    sealedAt: new Date().toISOString(),
  };
  atomicSave(context.decision, decision);
  return verifyAcceptance(file, context.contractDigest);
}
export function verifyAcceptance(file, digest, expected = {}) {
  const context = loadContract(file, digest);
  for (const key of ["cwd", "goalId", "taskId"])
    if (expected[key] !== undefined)
      assert.equal(
        context.contract[key],
        expected[key],
        "acceptance identity mismatch: " + key,
      );
  const decision = readJson(context.decision);
  assert.ok(
    decision.version === "team-decision/1" &&
      decision.status === "ready" &&
      decision.contractDigest === context.contractDigest,
    "no current sealed decision",
  );
  assert.deepEqual(
    prove(context, decision.summary),
    decision.proof,
    "evidence changed since parent judgment",
  );
  return {
    status: "verified",
    contractDigest: context.contractDigest,
    decision: context.decision,
    limitation:
      "Mechanical freshness/completeness only; parent owns semantic judgment and required independent review.",
  };
}

export function goalEvidenceKey(goal) {
  let enabled = false;
  function shape(tasks) {
    return (tasks ?? []).map((task) => {
      if (
        typeof task.verificationContract === "string" &&
        task.verificationContract.startsWith("team-evidence/")
      )
        enabled = true;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        lightweightSubtasks: task.lightweightSubtasks === true,
        contract: task.verificationContract ?? null,
        subtasks: shape(task.subtasks),
      };
    });
  }
  const tasks = shape(goal?.taskList?.tasks);
  return enabled
    ? identity({
        goalId: goal.id,
        status: goal.status,
        objective: goal.objective,
        blockCompletion: goal.taskList?.blockCompletion === true,
        tasks,
      })
    : null;
}

// Synchronous final-boundary check: does not execute commands or mutate Goal state.
export function goalEvidenceBlockReason(goal, cwd, taskId) {
  try {
    function visit(tasks, selected = taskId === undefined) {
      for (const task of tasks ?? []) {
        if (task.status === "skipped") {
          if (taskId !== undefined) visit(task.subtasks, false);
          continue;
        }
        const include = selected || task.id === taskId;
        if (
          include &&
          typeof task.verificationContract === "string" &&
          task.verificationContract.startsWith("team-evidence/")
        ) {
          const match = /^team-evidence\/1:([a-f0-9]{64}):(.+)$/.exec(
            task.verificationContract,
          );
          assert.ok(match, "invalid evidence reference");
          const file = relativeArtifact(cwd, match[2]);
          verifyAcceptance(file, match[1], {
            cwd,
            goalId: goal.id,
            taskId: task.id,
          });
        }
        visit(task.subtasks, include && !task.lightweightSubtasks);
      }
    }
    visit(goal?.taskList?.tasks);
    return null;
  } catch (error) {
    return "Team evidence blocks completion: " + error.message;
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    const [command, inputFile, output] = process.argv.slice(2);
    assert.ok(
      ["run", "verify", "seal", "accept", "reference"].includes(command),
      "unknown command",
    );
    assert.equal(
      process.argv.length,
      ["accept", "reference"].includes(command) ? 4 : 5,
      "usage: host-evidence.mjs run|verify check.json receipt.json; seal contract.json observations.json; accept|reference contract.json",
    );
    let result;
    if (command === "reference")
      result = { verificationContract: acceptanceReference(inputFile) };
    else if (command === "seal") result = sealAcceptance(inputFile, output);
    else if (command === "accept") result = verifyAcceptance(inputFile);
    else
      result =
        command === "run"
          ? runCheck(readJson(inputFile), output)
          : verifyCheck(readJson(inputFile), output);
    console.log(
      JSON.stringify(
        command === "run"
          ? { status: result.status, receipt: path.resolve(output) }
          : result,
      ),
    );
    if (result.status && result.status !== "verified") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
