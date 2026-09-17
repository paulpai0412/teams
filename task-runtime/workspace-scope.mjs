import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { snapshot } from "../host-evidence.mjs";
import { digest } from "./contracts.mjs";

const inside = (root, file) =>
  file === root || file.startsWith(root + path.sep);

// Git, the host-selected runtime tree, and the source project's official Goal
// metadata are control data, not delivered files. This is not an OS sandbox.
// No gitignore, node_modules, report-name or native-returned-path exemptions.
export function captureWorkspace(contract, runtimeRoot) {
  assert.equal(
    fs.realpathSync(runtimeRoot),
    runtimeRoot,
    "canonical runtime root required",
  );
  const roots = [
    ...new Set([
      contract.workspace.sourceRoot,
      contract.workspace.worktreePath ?? contract.workspace.sourceRoot,
    ]),
  ];
  return {
    requestDigest: digest(contract),
    workspaces: roots.map((cwd) => {
      assert.ok(
        !inside(runtimeRoot, cwd),
        "workspace cannot be inside the runtime tree",
      );
      const excludedPaths = [".git"];
      if (
        contract.schemaVersion === "teams-task-runtime/3" &&
        cwd === contract.workspace.sourceRoot
      ) {
        const pool = fs.lstatSync(
          path.join(cwd, ".pi/.goals-pool-snapshot.json"),
          { throwIfNoEntry: false },
        );
        assert.ok(
          !pool || pool.isFile(),
          "Goal pool snapshot must be a regular file",
        );
        excludedPaths.push(".pi/goals", ".pi/.goals-pool-snapshot.json");
      }
      if (inside(cwd, runtimeRoot))
        excludedPaths.push(path.relative(cwd, runtimeRoot));
      for (const name of contract.workspace.allowedWritePaths) {
        const file = path.resolve(cwd, name);
        for (const excluded of excludedPaths) {
          const reserved = path.resolve(cwd, excluded);
          assert.ok(
            !inside(reserved, file) && !inside(file, reserved),
            "write scope overlaps harness-owned paths",
          );
        }
      }
      // ponytail: retain snapshot's 512-file/64-MiB bound; enlarge the shared
      // reader only when an approved workspace actually needs a larger corpus.
      return { ...snapshot(cwd, ["."], excludedPaths), excludedPaths };
    }),
  };
}

export function verifyWorkspaceScope(contract, mailbox) {
  if (contract.schemaVersion !== "teams-task-runtime/3") return null;
  const bootstrap = mailbox.readJson("bootstrap.json", 16 * 1024);
  assert.ok(
    typeof bootstrap.workspaceBaselineDigest === "string",
    "workspace baseline missing; task-start state cannot be reconstructed",
  );
  const baseline = mailbox.readJson("receipts/workspace-baseline.json");
  assert.equal(
    digest(baseline),
    bootstrap.workspaceBaselineDigest,
    "workspace baseline changed",
  );
  assert.equal(
    baseline.requestDigest,
    digest(contract),
    "workspace baseline belongs to another task",
  );
  const current = captureWorkspace(
    contract,
    path.resolve(mailbox.root, "../../../.."),
  );
  assert.deepEqual(
    baseline.workspaces.map((row) => [row.cwd, row.excludedPaths]),
    current.workspaces.map((row) => [row.cwd, row.excludedPaths]),
    "workspace inventory changed",
  );
  for (const [index, after] of current.workspaces.entries()) {
    const beforeFiles = new Map(
      baseline.workspaces[index].files.map((file) => [file.path, file]),
    );
    const afterFiles = new Map(after.files.map((file) => [file.path, file]));
    for (const name of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
      const before = beforeFiles.get(name) ?? null;
      const next = afterFiles.get(name) ?? null;
      if (digest(before) === digest(next)) continue;
      const allowed = contract.workspace.allowedWritePaths.some(
        (prefix) =>
          name === prefix ||
          name.startsWith(prefix + path.sep) ||
          (!before &&
            next?.kind === "directory" &&
            prefix.startsWith(name + path.sep)),
      );
      assert.ok(
        allowed,
        `workspace change outside allowed write scope: ${name || "."}`,
      );
    }
  }
  return current;
}

export function verifyWorkspaceResult(contract, mailbox, result) {
  if (
    contract.schemaVersion !== "teams-task-runtime/3" ||
    result.outcome !== "ready_for_acceptance"
  )
    return null;
  const current = verifyWorkspaceScope(contract, mailbox);
  const sealed = mailbox.readJson(
    `receipts/workspace-r${result.resultRevision}.json`,
  );
  assert.equal(
    sealed.resultDigest,
    digest(result),
    "workspace result binding changed",
  );
  assert.deepEqual(
    current,
    sealed.state,
    "workspace changed after result sealing",
  );
  return current;
}
