// Task-owned pre-tool admission, carried by the existing native leaf extension.
// Native custom entries prove a blocked call never reached its tool implementation.
// This is not a shell parser, retry controller, or proof that a failed shell was safe.
import assert from "node:assert/strict";
import { bytesDigest } from "./contracts.mjs";

export const RECONSTRUCTION_BINDING = "teams.reconstruction/1";
export const RECONSTRUCTION_ENTRY = "teams-reconstruction-input";
const schemaVersion = "teams-reconstruction-input/1";
const mutators = new Set(["bash", "write", "edit", "ast_grep_replace"]);
const hash = (value) => bytesDigest(Buffer.from(value));
const inputHash = (input) => hash(JSON.stringify(input));

export function reconstructionBinding(command, marker) {
  assert.ok(
    typeof command === "string" &&
      command.length > 0 &&
      Buffer.byteLength(command) <= 16384,
    "bounded reconstruction command required",
  );
  assert.ok(
    typeof marker === "string" && marker.length > 0 && marker.length <= 256,
    "reconstruction marker required",
  );
  return { version: 1, command, marker };
}

function correctionReason(command) {
  return (
    "Reconstruction input rejected before tool execution; no shell or source write ran. Correct this input in the SAME role within the original deadline/budget; this is not a product/process/report retry. Required command:\n" +
    command
  );
}

function succeeded(message, marker) {
  return (
    message?.toolName === "bash" &&
    message.isError === false &&
    message.content?.some(
      (block) => block.type === "text" && block.text.includes(marker),
    )
  );
}

export function installReconstructionHooks(pi, getBinding) {
  let state = null;
  function current(ctx) {
    const value = getBinding();
    if (!value) return null;
    assert.deepEqual(
      value,
      reconstructionBinding(value.command, value.marker),
      "reconstruction binding changed",
    );
    const sessionId = ctx.sessionManager.getSessionId();
    if (state) {
      assert.equal(
        sessionId,
        state.sessionId,
        "reconstruction session changed",
      );
      assert.deepEqual(value, state.binding, "reconstruction binding changed");
      return state;
    }
    const commandDigest = hash(value.command);
    const entries = ctx.sessionManager.getBranch();
    const records = entries
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === RECONSTRUCTION_ENTRY,
      )
      .map((entry) => entry.data);
    for (const record of records) {
      assert.equal(record.schemaVersion, schemaVersion);
      assert.equal(
        record.sessionId,
        sessionId,
        "reconstruction journal session changed",
      );
      assert.equal(
        record.commandDigest,
        commandDigest,
        "reconstruction journal command changed",
      );
    }
    const admissions = records.filter((record) => record.kind === "admitted");
    assert.ok(admissions.length <= 1, "reconstruction was already replayed");
    const admitted = admissions[0];
    const result =
      admitted &&
      entries.find(
        (entry) =>
          entry.message?.role === "toolResult" &&
          entry.message.toolCallId === admitted.toolCallId,
      )?.message;
    state = {
      binding: structuredClone(value),
      sessionId,
      commandDigest,
      callId: admitted?.toolCallId ?? null,
      phase: admitted
        ? succeeded(result, value.marker)
          ? "ready"
          : "failed"
        : "pending",
    };
    return state;
  }
  function record(s, event, kind, extra = {}) {
    pi.appendEntry(RECONSTRUCTION_ENTRY, {
      schemaVersion,
      kind,
      sessionId: s.sessionId,
      commandDigest: s.commandDigest,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputDigest: inputHash(event.input),
      ...extra,
    });
  }
  pi.on("tool_call", (event, ctx) => {
    try {
      const s = current(ctx);
      if (!s || !mutators.has(event.toolName)) return;
      if (s.phase === "failed") {
        ctx.abort();
        return {
          block: true,
          terminate: true,
          reason:
            "Reconstruction executed unsuccessfully or has an unresolved attempt. Stop and reconcile; input correction cannot replay it.",
        };
      }
      const exact =
        event.toolName === "bash" && event.input.command === s.binding.command;
      if (s.phase === "ready" && !exact) return;
      if (s.phase === "pending" && exact) {
        record(s, event, "admitted");
        s.callId = event.toolCallId;
        s.phase = "executing";
        return;
      }
      const reason =
        s.phase === "pending"
          ? correctionReason(s.binding.command)
          : "Reconstruction input rejected before tool execution; no shell or source write ran. Do not repeat reconstruction or race writes with it; wait for its successful result before further source work.";
      record(s, event, "rejected", {
        launchAttempted: false,
        effects: "none",
        reason,
      });
      return { block: true, reason };
    } catch (error) {
      ctx.abort();
      return {
        block: true,
        terminate: true,
        reason: `Reconstruction admission unavailable; stop and reconcile: ${error.message}`,
      };
    }
  });
  pi.on("tool_result", (event, ctx) => {
    try {
      const s = current(ctx);
      if (!s || event.toolCallId !== s.callId) return;
      assert.equal(s.phase, "executing", "duplicate reconstruction result");
      s.phase = succeeded(event, s.binding.marker) ? "ready" : "failed";
      if (s.phase === "failed") ctx.abort();
    } catch (error) {
      if (state) state.phase = "failed";
      ctx.abort();
      throw error;
    }
  });
  // An abandoned branch or changed session cannot reset an attempted operation.
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
  ])
    pi.on(event, () => (getBinding() ? { cancel: true } : undefined));
}

// Read the immutable native transcript, not model prose, stderr patterns, or a
// nonzero exit code. All three records must bind one call in this same session.
export function reconstructionRejections(entries, command) {
  const proofs = entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === RECONSTRUCTION_ENTRY,
  );
  if (!proofs.length) return new Set(); // Old captures keep their original strict path.
  const sessionId = entries.find((entry) => entry.type === "session")?.id;
  assert.ok(
    typeof sessionId === "string" && sessionId.length > 0,
    "reconstruction proof session missing",
  );
  const ids = new Set(
    proofs
      .filter((entry) => entry.data?.kind === "rejected")
      .map((entry) => entry.data.toolCallId),
  );
  const calls = new Map(),
    results = new Map(),
    rejected = new Set();
  entries.forEach((entry, index) => {
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const part of message.content ?? [])
        if (part.type === "toolCall" && ids.has(part.id)) {
          assert.ok(
            !calls.has(part.id),
            "duplicate reconstruction transcript call ID",
          );
          calls.set(part.id, { part, index });
        }
    } else if (message?.role === "toolResult" && ids.has(message.toolCallId)) {
      assert.ok(
        !results.has(message.toolCallId),
        "duplicate reconstruction transcript result ID",
      );
      results.set(message.toolCallId, { message, index });
    }
  });
  entries.forEach((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== RECONSTRUCTION_ENTRY)
      return;
    const data = entry.data;
    assert.equal(
      data?.schemaVersion,
      schemaVersion,
      "invalid reconstruction proof",
    );
    assert.equal(
      data.sessionId,
      sessionId,
      "foreign reconstruction proof session",
    );
    assert.equal(
      data.commandDigest,
      hash(command),
      "foreign reconstruction proof command",
    );
    assert.ok(
      ["admitted", "rejected"].includes(data.kind),
      "unknown reconstruction proof kind",
    );
    if (data.kind !== "rejected") return;
    const call = calls.get(data.toolCallId),
      result = results.get(data.toolCallId);
    assert.ok(
      call && result && call.index < index && index < result.index,
      "reconstruction rejection ordering/proof missing",
    );
    assert.ok(
      mutators.has(data.toolName) &&
        call.part.name === data.toolName &&
        result.message.toolName === data.toolName,
      "reconstruction rejection tool changed",
    );
    assert.equal(
      data.inputDigest,
      inputHash(call.part.arguments),
      "reconstruction rejection input changed",
    );
    assert.equal(
      data.launchAttempted,
      false,
      "reconstruction rejection executed",
    );
    assert.equal(
      data.effects,
      "none",
      "reconstruction rejection effects unknown",
    );
    assert.ok(
      typeof data.reason === "string" &&
        data.reason.startsWith(
          "Reconstruction input rejected before tool execution;",
        ),
      "reconstruction rejection reason missing",
    );
    assert.equal(
      result.message.isError,
      true,
      "reconstruction rejection result changed",
    );
    assert.deepEqual(
      result.message.content,
      [{ type: "text", text: data.reason }],
      "reconstruction rejection result changed",
    );
    assert.ok(
      !rejected.has(data.toolCallId),
      "duplicate reconstruction rejection proof",
    );
    rejected.add(data.toolCallId);
  });
  return rejected;
}
