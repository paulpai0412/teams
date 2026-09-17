// Reads public native lifecycle artifacts only. Never imports a dependency parser
// or guesses a worktree path. These are provenance facts, not review/acceptance.
import assert from "node:assert/strict";
import path from "node:path";
import { readEvidenceBytes } from "../host-evidence.mjs";
import { bytesDigest } from "./contracts.mjs";
import { readNativeTerminal, nativeWorkflowResult } from "./role-lifecycle.mjs";

export function inspectNativeHandoffs(
  mailbox,
  contract,
  childRunRefs,
  readEvidence = readEvidenceBytes,
) {
  const files = new Map();
  let totalBytes = 0;
  function read(file, limit = 1024 * 1024) {
    assert.ok(
      typeof file === "string" &&
        path.isAbsolute(file) &&
        Buffer.byteLength(file) <= 4096,
      "absolute native artifact path required",
    );
    if (files.has(file)) {
      const bytes = files.get(file).bytes;
      assert.ok(bytes.length <= limit, "native artifact exceeds read limit");
      return bytes;
    }
    const bytes = readEvidence(file, limit);
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "native artifacts exceed 64 MiB");
    files.set(file, { path: file, bytes, sha256: bytesDigest(bytes) });
    return bytes;
  }
  function json(file) {
    try {
      return JSON.parse(read(file).toString("utf8"));
    } catch (cause) {
      throw new Error(`Invalid or unavailable native artifact: ${file}`, {
        cause,
      });
    }
  }
  const roles = mailbox
    .listEvents()
    .filter((event) => event.type === "progress")
    .map((event) => mailbox.readJson(event.payloadRef, 16 * 1024))
    .filter((event) => event.kind === "role-started");
  assert.deepEqual(
    roles.map((role) => role.runId).sort(),
    [...childRunRefs].sort(),
    "native role identity inventory mismatch",
  );
  assert.ok(
    roles.length > 0 && roles.length <= 64,
    "bounded native roles required",
  );
  const lanes = [],
    seenRuns = new Set(roles.map((role) => role.runId));
  for (const role of roles) {
    assert.ok(
      typeof role.asyncDir === "string" && path.isAbsolute(role.asyncDir),
      "native status directory missing",
    );
    const status = json(path.join(role.asyncDir, "status.json"));
    assert.equal(status.runId, role.runId, "native root identity mismatch");
    assert.equal(
      status.cwd,
      contract.workspace.sourceRoot,
      "native root cwd mismatch",
    );
    assert.equal(status.state, "complete", "native root incomplete");
    if (role.hostedWorkflow) {
      assert.equal(contract.schemaVersion, "teams-task-runtime/3");
      const boot = mailbox.readJson("receipts/boot.json");
      assert.equal(
        role.hostedWorkflow.pid,
        boot.processId,
        "hosted root is not the Worker",
      );
      assert.ok(
        readNativeTerminal(
          role,
          [boot.workerSessionId, boot.workerSessionFile],
          read,
        ),
        "hosted workflow unresolved",
      );
      for (const step of status.steps) nativeWorkflowResult(status, step);
    } else {
      assert.equal(
        status.processTerminal?.version,
        1,
        "native terminal version missing",
      );
      assert.equal(
        status.processTerminal?.runId,
        role.runId,
        "native terminal identity mismatch",
      );
      assert.equal(
        status.processTerminal?.state,
        "observed",
        "native terminal not observed",
      );
    }
    assert.notEqual(
      status.usageBudget?.exhausted,
      true,
      "native usage budget exhausted",
    );
    assert.ok(
      Array.isArray(role.members) &&
        role.members.length > 0 &&
        role.members.length <= 64,
      "wave member inventory required",
    );
    assert.equal(
      status.steps?.length,
      role.members.length,
      "native member count mismatch",
    );
    if (contract.schemaVersion === "teams-task-runtime/3") {
      assert.match(
        role.launchId,
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
        "native usage launch identity missing",
      );
      const sessionDir = path.join(
        mailbox.root,
        "role-sessions",
        role.launchId,
      );
      assert.equal(
        role.sessionDir,
        sessionDir,
        "native planned session root missing",
      );
      for (const step of status.steps) {
        assert.ok(
          typeof step.sessionFile === "string" &&
            path.resolve(step.sessionFile) === step.sessionFile &&
            step.sessionFile.startsWith(sessionDir + path.sep),
          "native session outside planned usage root",
        );
        read(step.sessionFile, 8 * 1024 * 1024);
      }
    }
    // Shared readers may precede isolated writers. Shared mutation is not a patch lane.
    assert.ok(
      role.members.every(
        (member) =>
          member.isolation === "worktree" ||
          ["review", "read-only"].includes(member.mode),
      ),
      "shared mutation cannot be integrated as a worktree patch",
    );
    if (role.members.every((member) => member.isolation === "shared")) {
      for (const [index, member] of role.members.entries()) {
        assert.equal(
          status.steps[index].agent,
          member.role,
          "shared reader identity mismatch",
        );
        assert.ok(
          ["complete", "completed"].includes(status.steps[index].status),
          "shared reader incomplete",
        );
      }
      continue;
    }
    // Public hosted workflows publish this sidecar without a status pointer.
    // An explicit invalid pointer must still fail, never fall back silently.
    const receipt = json(
      Object.hasOwn(status, "workflowReceiptPath")
        ? status.workflowReceiptPath
        : path.join(role.asyncDir, "workflow-receipt.json"),
    );
    assert.equal(receipt.version, 1, "unsupported workflow receipt version");
    assert.equal(
      receipt.workflowRunId,
      role.runId,
      "workflow receipt identity mismatch",
    );
    assert.equal(receipt.state, "complete", "workflow receipt incomplete");
    assert.deepEqual(
      Object.keys(receipt.entries ?? {}).sort(),
      role.members.map((member) => member.key).sort(),
      "workflow receipt member identity mismatch",
    );
    const rows = status.workflow?.value;
    assert.ok(
      Array.isArray(rows) && rows.length === role.members.length,
      "compiled wave return missing",
    );
    assert.equal(
      new Set(rows.map((row) => row.key)).size,
      rows.length,
      "duplicate wave return identity",
    );
    assert.equal(
      new Set(status.steps.map((step) => step.workflowKey)).size,
      status.steps.length,
      "duplicate native step identity",
    );
    for (const member of role.members) {
      const row = rows.find((item) => item.key === member.key);
      const step = status.steps.find((item) => item.workflowKey === member.key);
      const entry = receipt.entries[member.key];
      assert.ok(
        row?.ok === true &&
          typeof row.runId === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.runId),
        "native child identity missing",
      );
      assert.equal(entry.key, member.key, "receipt key identity mismatch");
      assert.equal(entry.agent, member.role, "receipt agent identity mismatch");
      assert.equal(
        entry.latestRunId,
        row.runId,
        "receipt child identity mismatch",
      );
      assert.deepEqual(
        entry.continuation?.runIds,
        [row.runId],
        "unexpected continuation lineage; reconcile",
      );
      assert.equal(step?.agent, member.role, "native step identity mismatch");
      assert.ok(
        ["complete", "completed"].includes(step.status),
        "native child incomplete",
      );
      if (step.runId !== undefined)
        assert.equal(
          step.runId,
          row.runId,
          "native step run identity mismatch",
        );
      assert.ok(!seenRuns.has(row.runId), "duplicate native child run");
      seenRuns.add(row.runId);
      if (member.isolation !== "worktree") continue;
      assert.equal(
        role.baseCommit,
        contract.workspace.baseCommit,
        "wave base mismatch",
      );
      assert.ok(
        Array.isArray(row.artifactPaths) && row.artifactPaths.length <= 64,
        "bounded native artifact references required",
      );
      // Only inspect explicit JSON references, not directories, transcripts or guessed names.
      const manifests = [];
      for (const ref of new Set(row.artifactPaths)) {
        assert.ok(
          typeof ref === "string" && path.isAbsolute(ref),
          "invalid native artifact reference",
        );
        if (!ref.endsWith(".json")) continue;
        const value = json(ref);
        if (value && Object.hasOwn(value, "groups"))
          manifests.push({ ref, value });
      }
      assert.equal(manifests.length, 1, "exactly one native handoff required");
      const { ref, value: manifest } = manifests[0];
      assert.equal(manifest.version, 1, "unsupported native handoff version");
      assert.equal(manifest.runId, row.runId, "handoff run identity mismatch");
      assert.equal(manifest.mode, "single", "unsupported child handoff shape");
      assert.ok(
        ["async", "foreground"].includes(manifest.source),
        "native handoff source missing",
      );
      assert.equal(
        manifest.cwd,
        contract.workspace.sourceRoot,
        "handoff cwd mismatch",
      );
      assert.equal(manifest.groups?.length, 1, "ambiguous handoff groups");
      const group = manifest.groups[0];
      assert.equal(
        group.baseCommit,
        contract.workspace.baseCommit,
        "handoff base mismatch",
      );
      assert.equal(
        group.repoRoot,
        contract.workspace.sourceRoot,
        "handoff repository mismatch",
      );
      assert.equal(group.children?.length, 1, "ambiguous handoff children");
      const child = group.children[0];
      assert.equal(child.index, 0, "handoff child index mismatch");
      assert.equal(child.taskIndex, 0, "handoff task index mismatch");
      assert.equal(child.agent, member.role, "handoff agent identity mismatch");
      assert.equal(child.status, "completed", "handoff child incomplete");
      if (child.runId !== undefined)
        assert.equal(child.runId, row.runId, "handoff child identity mismatch");
      if (child.workflowKey !== undefined)
        assert.equal(
          child.workflowKey,
          member.key,
          "handoff key identity mismatch",
        );
      assert.ok(
        child.patch && !child.patch.error,
        "native patch capture failed",
      );
      const patch = read(child.patch.path, 8 * 1024 * 1024);
      assert.equal(
        child.patch.changed,
        patch.length > 0,
        "native patch changed flag mismatch",
      );
      if (["review", "read-only"].includes(member.mode))
        assert.equal(patch.length, 0, "read-only lane changed source");
      lanes.push({
        rootRunId: role.runId,
        key: member.key,
        runId: row.runId,
        role: member.role,
        mode: member.mode,
        baseCommit: group.baseCommit,
        manifestPath: ref,
        manifestSha256: files.get(ref).sha256,
        patchPath: child.patch.path,
        patchSha256: bytesDigest(patch),
        cleanupState: group.cleanup?.state ?? "unknown",
      });
    }
  }
  assert.ok(
    lanes.length > 0 && lanes.length <= 64,
    "isolated lane inventory required",
  );
  return { lanes, files: [...files.values()] };
}
