import test from "node:test";
import assert from "node:assert/strict";
import { measureSessionBytes } from "../task-usage.mjs";

const rows = (role, message = {}) =>
  Buffer.from(
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "native-usage-1",
        cwd: "/tmp",
      }),
      JSON.stringify({
        type: "message",
        id: "system-1",
        message: { role, ...message },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          usage: {
            input: 11,
            output: 7,
            cacheRead: 4,
            cacheWrite: 2,
            totalTokens: 24,
          },
        },
      }),
    ].join("\n") + "\n",
  );

test("native system tool-profile message carries no usage and does not erase assistant cost", () => {
  const measured = measureSessionBytes(
    rows("system", {
      content: "tool profile updated",
      toolsAdded: ["team_task_dispatch"],
    }),
  );
  assert.equal(measured.usage.total, 24);
  assert.deepEqual(
    ["input", "output", "cacheRead", "cacheWrite"].map(
      (key) => measured.usage[key],
    ),
    [11, 7, 4, 2],
  );
});

test("unknown role or usage-bearing system message remains fail-closed", () => {
  assert.throws(
    () => measureSessionBytes(rows("invented")),
    /unknown usage message role/,
  );
  assert.throws(
    () =>
      measureSessionBytes(
        rows("system", {
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }),
      ),
    /system message has unaccounted usage/,
  );
});

test("native context edit hides no raw usage and cannot carry unaccounted metadata", () => {
  const edit = {
    type: "context_edit",
    id: "omit-1",
    targetId: "assistant-1",
    replacement: null,
  };
  const input = (extra) =>
    Buffer.concat([
      rows("system"),
      Buffer.from(JSON.stringify({ ...edit, ...extra }) + "\n"),
    ]);
  assert.equal(measureSessionBytes(input({})).usage.total, 24);
  assert.throws(
    () => measureSessionBytes(input({ usage: { input: 1 } })),
    /unaccounted usage/,
  );
  assert.throws(
    () => measureSessionBytes(input({ message: { role: "assistant" } })),
    /cannot replace usage metadata/,
  );
  assert.throws(
    () => measureSessionBytes(input({ type: "unknown_entry" })),
    /unknown usage session entry type/,
  );
});
