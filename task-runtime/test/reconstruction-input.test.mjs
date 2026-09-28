import test from "node:test";
import assert from "node:assert/strict";
import { bytesDigest } from "../contracts.mjs";
import { verifyWriterReconstruction } from "../review-product-lineage.mjs";
import {
  installReconstructionHooks,
  reconstructionBinding,
  RECONSTRUCTION_ENTRY,
} from "../reconstruction-input.mjs";
import { nativeToolDriver } from "./public-recovery-fixture.mjs";
import { createRequire } from "node:module";
const { Type } = createRequire(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/package.json",
)("@sinclair/typebox");

const command = "host-bound reconstruction",
  marker = "RECONSTRUCTED\n";
const sessionId = "writer-session";
const call = (id, name, input) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: input }],
  },
});
const result = (id, name, text, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: "text", text }],
  },
});
function native(entries) {
  return {
    lanes: [
      {
        mode: "mutation",
        runId: "writer",
        sessionFile: "/native/writer.jsonl",
      },
    ],
    files: [
      {
        path: "/native/writer.jsonl",
        sha256: "a".repeat(64),
        bytes: Buffer.from(
          [{ type: "session", id: sessionId }, ...entries]
            .map((e) => JSON.stringify(e))
            .join("\n"),
        ),
      },
    ],
  };
}
const corrected = [
  call("correct", "bash", { command }),
  result("correct", "bash", marker),
];

function hookFixture({ failure = false, bound = true } = {}) {
  const entries = [],
    hooks = new Map(),
    effects = [];
  let aborts = 0,
    driver;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    abort() {
      aborts++;
      driver?.agent.abort();
    },
  };
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data }),
  };
  const binding = bound ? reconstructionBinding(command, marker) : null;
  const reload = () => {
    hooks.clear();
    installReconstructionHooks(pi, () => binding);
  };
  reload();
  const tools = new Map([
    [
      "bash",
      {
        name: "bash",
        label: "Bash fixture",
        description: "In-memory effect counter; never a shell.",
        parameters: Type.Object({ command: Type.String() }),
        execute(_id, input) {
          effects.push(input.command);
          if (failure) throw new Error("executed failure");
          return { content: [{ type: "text", text: marker }], details: {} };
        },
      },
    ],
    [
      "write",
      {
        name: "write",
        label: "Write fixture",
        description: "In-memory write counter.",
        parameters: Type.Object({ path: Type.String() }),
        execute(_id, input) {
          effects.push(input.path);
          return { content: [{ type: "text", text: "written" }], details: {} };
        },
      },
    ],
  ]);
  driver = nativeToolDriver(
    tools,
    ctx,
    (event) => hooks.get("tool_call")(event, ctx),
    (event) => hooks.get("tool_result")(event, ctx),
  );
  driver.agent.subscribe((event) => {
    if (event.type === "message_end")
      entries.push({
        type: "message",
        message: structuredClone(event.message),
      });
  });
  return {
    ...driver,
    entries,
    hooks,
    effects,
    ctx,
    reload,
    aborts: () => aborts,
  };
}

test("reconstruction retains strict rejection of an actually executed failed Bash", () => {
  assert.throws(
    () =>
      verifyWriterReconstruction(
        native([
          call("wrong", "bash", { command: "wrong path" }),
          result("wrong", "bash", "Missing patch; exit 128", true),
          ...corrected,
        ]),
        command,
        marker,
      ),
    /must precede writes/,
  );
  assert.doesNotThrow(() =>
    verifyWriterReconstruction(native(corrected), command, marker),
  );
});

test("reconstruction accepts a native host-proven pre-execution rejection before the corrected command", () => {
  const input = { command: "wrong path" };
  const reason =
    "Reconstruction input rejected before tool execution; no shell or source write ran. Correct this input in the SAME role within the original deadline/budget; this is not a product/process/report retry. Required command:\n" +
    command;
  assert.doesNotThrow(() =>
    verifyWriterReconstruction(
      native([
        call("wrong", "bash", input),
        {
          type: "custom",
          customType: "teams-reconstruction-input",
          data: {
            schemaVersion: "teams-reconstruction-input/1",
            kind: "rejected",
            sessionId,
            commandDigest: bytesDigest(Buffer.from(command)),
            toolCallId: "wrong",
            toolName: "bash",
            inputDigest: bytesDigest(Buffer.from(JSON.stringify(input))),
            launchAttempted: false,
            effects: "none",
            reason,
          },
        },
        result("wrong", "bash", reason, true),
        ...corrected,
      ]),
      command,
      marker,
    ),
  );
});

test("native tool loop blocks repeated typos and early writes, then the SAME writer reconstructs and edits", async () => {
  const f = hookFixture();
  for (const typo of ["wrong path one", "wrong path two", "wrong path three"]) {
    const event = await f.call("bash", { command: typo });
    assert.equal(event.isError, true);
    assert.match(event.result.content[0].text, /SAME role/);
  }
  assert.equal((await f.call("write", { path: "too-early" })).isError, true);
  assert.deepEqual(f.effects, []);
  assert.equal(f.aborts(), 0);
  assert.equal((await f.call("bash", { command })).isError, false);
  f.reload(); // Rebuild readiness from the native session, never reset an attempt.
  assert.equal(
    (await f.call("write", { path: "repaired-source" })).isError,
    false,
  );
  assert.deepEqual(f.effects, [command, "repaired-source"]);
  assert.doesNotThrow(() =>
    verifyWriterReconstruction(native(f.entries), command, marker),
  );
  assert.equal((await f.call("bash", { command })).isError, true);
  assert.deepEqual(
    f.effects,
    [command, "repaired-source"],
    "reconstruction cannot execute twice",
  );
  assert.doesNotThrow(() =>
    verifyWriterReconstruction(native(f.entries), command, marker),
  );
});

test("executed reconstruction failure stops and cannot be retried or reset by reload", async () => {
  const f = hookFixture({ failure: true });
  assert.equal((await f.call("bash", { command })).isError, true);
  assert.equal(f.aborts(), 1);
  f.reload();
  assert.equal((await f.call("bash", { command })).isError, true);
  assert.deepEqual(f.effects, [command]);
  assert.throws(() =>
    verifyWriterReconstruction(native(f.entries), command, marker),
  );
});

test("native reconstruction proof rejects missing, copied, changed and unpaired records", async () => {
  const f = hookFixture();
  await f.call("bash", { command: "bad path" });
  await f.call("bash", { command });
  const edits = [
    (entries) => entries.filter((e) => e.type !== "custom"),
    (entries) => {
      entries.find((e) => e.data?.kind === "rejected").data.sessionId =
        "foreign";
      return entries;
    },
    (entries) => {
      entries.find((e) => e.data?.kind === "rejected").data.commandDigest =
        "0".repeat(64);
      return entries;
    },
    (entries) => {
      entries.find((e) => e.data?.kind === "rejected").data.inputDigest =
        "0".repeat(64);
      return entries;
    },
    (entries) => {
      entries.find((e) => e.data?.kind === "rejected").data.launchAttempted =
        true;
      return entries;
    },
    (entries) => {
      entries.find((e) => e.data?.kind === "rejected").data.effects = "unknown";
      return entries;
    },
    (entries) => {
      entries.find((e) => e.message?.role === "toolResult").message.isError =
        false;
      return entries;
    },
    (entries) => {
      entries.find((e) => e.message?.role === "toolResult").message.content = [
        { type: "text", text: "forged no-write claim" },
      ];
      return entries;
    },
    (entries) =>
      entries.filter(
        (e) =>
          e.message?.role !== "toolResult" ||
          e.message.toolCallId !== "public-1",
      ),
    (entries) => {
      const index = entries.findIndex((e) => e.data?.kind === "rejected");
      entries.push(entries.splice(index, 1)[0]);
      return entries;
    },
    (entries) => {
      const index = entries.findIndex((e) => e.data?.kind === "rejected");
      entries.splice(index, 0, structuredClone(entries[index]));
      return entries;
    },
  ];
  for (const mutate of edits)
    assert.throws(() =>
      verifyWriterReconstruction(
        native(mutate(structuredClone(f.entries))),
        command,
        marker,
      ),
    );
});

test("concurrent mutation/reconstruction inputs cannot race the admitted reconstruction", () => {
  const f = hookFixture();
  const invoke = (toolName, toolCallId, input) =>
    f.hooks.get("tool_call")({ toolName, toolCallId, input }, f.ctx);
  assert.equal(invoke("bash", "first", { command }), undefined);
  assert.equal(
    invoke("write", "racing-write", { path: "too-early" }).block,
    true,
  );
  assert.equal(invoke("bash", "duplicate", { command }).block, true);
  f.hooks.get("tool_result")(
    {
      toolName: "bash",
      toolCallId: "first",
      isError: false,
      content: [{ type: "text", text: marker }],
    },
    f.ctx,
  );
  assert.equal(
    invoke("write", "later-write", { path: "after-result" }),
    undefined,
  );
  assert.equal(f.aborts(), 0);
});

test("unbound ordinary roles remain unchanged and interrupted admission cannot replay", async () => {
  const ordinary = hookFixture({ bound: false });
  await ordinary.call("bash", { command: "ordinary" });
  assert.deepEqual(ordinary.effects, ["ordinary"]);
  assert.ok(
    !ordinary.entries.some((e) => e.customType === RECONSTRUCTION_ENTRY),
  );
  const f = hookFixture();
  f.hooks.get("tool_call")(
    { toolName: "bash", toolCallId: "interrupted", input: { command } },
    f.ctx,
  );
  f.reload();
  await f.call("bash", { command });
  assert.deepEqual(f.effects, []);
  assert.equal(f.aborts(), 1);
});
