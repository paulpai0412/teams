#!/usr/bin/env node
// One-shot disposable source setup. No Task, Goal, provider or existing target is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/review-product-revision/", import.meta.url),
);
const destination = process.argv[2];
assert.ok(
  destination && path.isAbsolute(destination),
  "new absolute workspace required",
);
assert.ok(
  !fs.existsSync(destination),
  "workspace already exists; never overwrite or replay",
);
assert.equal(
  fs.realpathSync(path.dirname(destination)),
  path.dirname(destination),
);
fs.mkdirSync(destination, { mode: 0o700 });
fs.mkdirSync(path.join(destination, "app"), { mode: 0o700 });
for (const file of ["requirements.md", "app/records.mjs"])
  fs.copyFileSync(
    path.join(fixture, file),
    path.join(destination, file),
    fs.constants.COPYFILE_EXCL,
  );
function git(...args) {
  const result = spawnSync("git", ["-C", destination, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
  return result.stdout.trim();
}
git("init", "-q");
git("add", "--", "requirements.md", "app/records.mjs");
git(
  "-c",
  "user.name=Disposable E2E",
  "-c",
  "user.email=e2e@invalid",
  "commit",
  "-q",
  "-m",
  "Initial incomplete record codec",
);
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
console.log(
  JSON.stringify({
    sourceRoot: destination,
    baseCommit: git("rev-parse", "HEAD"),
    fixture,
    status: "clean",
  }),
);
