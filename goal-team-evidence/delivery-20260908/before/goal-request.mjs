// Parent-only packet preparation. No launches, mission/Goal writes or new tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function prepareGoalRequest(input, requestRef) {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    "request required",
  );
  assert.ok(path.isAbsolute(requestRef), "absolute saved packet path required");
  const request = Object.fromEntries(
    [
      "goalId",
      "taskId",
      "phase",
      "attempt",
      "agent",
      "task",
      "cwd",
      "sourceState",
    ].map((key) => [key, input[key]]),
  );
  for (const [key, value] of Object.entries(request)) {
    if (key !== "attempt")
      assert.ok(typeof value === "string" && value.trim(), "missing " + key);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(request)) <= 64 * 1024,
    "packet must be at most 64 KiB",
  );
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  return {
    ...request,
    goalStatus: input.goalStatus,
    taskStatus: input.taskStatus,
    requestDigest,
    requestRef,
  };
}

if (process.argv[1] === import.meta.filename) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "usage: node goal-request.mjs /absolute/saved-request.json",
    );
    const file = fs.realpathSync(process.argv[2]);
    const stat = fs.statSync(file);
    assert.ok(
      stat.isFile() && stat.size <= 70 * 1024,
      "bounded regular packet file required",
    );
    console.log(
      JSON.stringify(
        prepareGoalRequest(JSON.parse(fs.readFileSync(file, "utf8")), file),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
