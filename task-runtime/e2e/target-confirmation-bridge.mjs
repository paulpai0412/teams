// E2E-only RPC UI relay. It presents the native host's exact apply challenge
// to the *real* parent and requires a later, bound ask_user decision. It never
// approves from an L0 message, an environment flag, or an arbitrary file alone.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REQUEST = "target-confirmation-request.json";
const DECISION = "target-confirmation-decision.json";
const RESOLUTION = "target-confirmation-resolution.json";
const YES = "同意套用這一筆精確計畫";
const SHA = /^[a-f0-9]{64}$/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function targetApplyChallenge(ui, sourceRoot, ownerSessionId) {
  assert.equal(
    ui?.method,
    "confirm",
    "only native target apply confirmation may be relayed",
  );
  assert.equal(
    ui.title,
    "Apply staged integration?",
    "unrecognized confirmation title",
  );
  assert.ok(
    typeof ui.id === "string" && ui.id.length > 0 && ui.id.length <= 128,
    "bounded native UI request ID required",
  );
  assert.ok(
    typeof ownerSessionId === "string" && ownerSessionId,
    "native owner required",
  );
  const match =
    /^apply only the sealed patch at ([^\n]{1,1024})\nBranch: ([^\n]{1,256})\nHEAD remains: ([a-f0-9]{40,64})\nIntegration tree: ([a-f0-9]{40,64})\nPlan: ([a-f0-9]{64})\nNo commit, ref movement or acceptance\. Later edits cause refusal\.$/.exec(
      ui.message ?? "",
    );
  assert.ok(match, "exact native apply message required");
  assert.equal(
    match[1],
    sourceRoot,
    "native apply target differs from this disposable source",
  );
  const value = {
    schemaVersion: "teams-e2e-target-confirmation/1",
    requestId: ui.id,
    ownerSessionId,
    title: ui.title,
    message: ui.message,
    targetRoot: match[1],
    branch: match[2],
    baseCommit: match[3],
    mergedTree: match[4],
    planDigest: match[5],
    createdAt: new Date().toISOString(),
  };
  value.requestDigest = digest(JSON.stringify(value));
  return value;
}

// The ask_user call itself must show both the request digest and exact plan,
// and its toolResult must be the positive option, after the native request.
export function confirmParentDecision(sessionFile, approvalEntryId, challenge) {
  assert.match(
    approvalEntryId ?? "",
    /^[a-f0-9]{8}$/,
    "exact parent approval entry required",
  );
  const bytes = fs.readFileSync(sessionFile);
  assert.ok(
    bytes.length <= 128 * 1024 * 1024,
    "parent session too large for approval proof",
  );
  // The live parent may be appending a new JSONL entry; accept only its last
  // fully terminated prefix. The approval result itself must be in that prefix.
  const completeEnd = bytes.lastIndexOf(10) + 1;
  assert.ok(completeEnd > 0, "no complete parent approval entries");
  let rows;
  try {
    rows = bytes
      .subarray(0, completeEnd)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`parent approval session is malformed: ${error.message}`);
  }
  const results = rows.filter((row) => row.id === approvalEntryId);
  assert.equal(results.length, 1, "unique parent ask_user result required");
  const row = results[0],
    message = row.message;
  assert.equal(message?.role, "toolResult");
  assert.equal(message.toolName, "ask_user");
  assert.notEqual(message.isError, true);
  assert.ok(
    Date.parse(row.timestamp) >= Date.parse(challenge.createdAt),
    "prior confirmation cannot be reused",
  );
  const answer =
    message.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  assert.ok(
    answer.split("\n").some((line) => line === `A1: ${YES}`),
    "explicit positive option required",
  );
  const parent = rows.find((entry) => entry.id === row.parentId);
  assert.ok(
    parent && parent.message?.role === "assistant",
    "ask_user call entry missing",
  );
  const calls = (parent.message.content ?? []).filter(
    (part) =>
      part.type === "toolCall" &&
      part.id === message.toolCallId &&
      part.name === "ask_user",
  );
  assert.equal(calls.length, 1, "ask_user call/result identity differs");
  const questions = calls[0].arguments?.questions;
  assert.ok(
    Array.isArray(questions) && questions.length === 1,
    "one exact approval question required",
  );
  const question = questions[0];
  assert.ok(
    [
      challenge.requestDigest,
      challenge.planDigest,
      challenge.targetRoot,
      challenge.mergedTree,
    ].every((part) => question.question?.includes(part)),
    "approval question must include the bound native plan/target/tree/request digest",
  );
  assert.ok(
    question.options?.some((option) => option.label === YES),
    "positive option was not offered",
  );
  return {
    approvalEntryId,
    approvalEntrySha256: digest(JSON.stringify(row)),
    questionEntryId: parent.id,
  };
}

export function createTargetConfirmationBridge({
  outputRoot,
  sourceRoot,
  parentSessionFile,
  ownerSessionId,
  timeoutMs = 3_600_000,
}) {
  assert.ok(
    path.isAbsolute(outputRoot) && fs.statSync(outputRoot).isDirectory(),
    "new evidence directory required",
  );
  assert.equal(
    fs.realpathSync(sourceRoot),
    sourceRoot,
    "canonical target source required",
  );
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000,
    "bounded approval wait required",
  );
  let requested = false;
  return (ui, { signal } = {}) =>
    new Promise((resolve, reject) => {
      let watcher,
        timer,
        done = false,
        challenge;
      function settle(error, value, reason, proof) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        watcher?.close();
        signal?.removeEventListener("abort", cancel);
        try {
          if (challenge)
            fs.writeFileSync(
              path.join(outputRoot, RESOLUTION),
              JSON.stringify(
                {
                  schemaVersion: "teams-e2e-target-confirmation-resolution/1",
                  requestDigest: challenge.requestDigest,
                  confirmed: value === true,
                  reason,
                  proof: proof ?? null,
                  resolvedAt: new Date().toISOString(),
                },
                null,
                2,
              ) + "\n",
              { flag: "wx", mode: 0o600 },
            );
        } catch (writeError) {
          reject(writeError);
          return;
        }
        if (error) reject(error);
        else resolve(value === true);
      }
      function cancel() {
        settle(null, false, "observer-aborted");
      }
      function inspect() {
        const file = path.join(outputRoot, DECISION);
        if (!fs.existsSync(file)) return;
        try {
          const stat = fs.lstatSync(file);
          assert.ok(
            stat.isFile() && stat.size <= 4096,
            "bounded regular decision file required",
          );
          const decision = JSON.parse(fs.readFileSync(file, "utf8"));
          assert.deepEqual(
            Object.keys(decision).sort(),
            ["approved", "parentApprovalEntryId", "requestDigest", "requestId"],
            "decision fields changed",
          );
          assert.equal(
            decision.requestId,
            challenge.requestId,
            "decision UI request differs",
          );
          assert.equal(
            decision.requestDigest,
            challenge.requestDigest,
            "decision plan digest differs",
          );
          assert.equal(
            typeof decision.approved,
            "boolean",
            "explicit yes/no required",
          );
          if (!decision.approved) return settle(null, false, "parent-denied");
          const proof = confirmParentDecision(
            parentSessionFile,
            decision.parentApprovalEntryId,
            challenge,
          );
          settle(null, true, "parent-approved", proof);
        } catch (error) {
          settle(error, false, "invalid-decision");
        }
      }
      try {
        assert.equal(
          requested,
          false,
          "one native apply challenge per E2E attempt",
        );
        requested = true;
        challenge = targetApplyChallenge(ui, sourceRoot, ownerSessionId);
        assert.match(challenge.planDigest, SHA);
        assert.equal(
          fs.existsSync(path.join(outputRoot, DECISION)),
          false,
          "unexpected prior decision file",
        );
        watcher = fs.watch(outputRoot, (_event, name) => {
          if (name === DECISION) inspect();
        });
        watcher.on("error", (error) => settle(error, false, "watcher-failed"));
        signal?.addEventListener("abort", cancel, { once: true });
        fs.writeFileSync(
          path.join(outputRoot, REQUEST),
          JSON.stringify(challenge, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        timer = setTimeout(
          () => settle(null, false, "approval-timeout"),
          timeoutMs,
        );
        if (signal?.aborted) cancel();
        else inspect();
      } catch (error) {
        settle(error, false, "request-failed");
      }
    });
}
