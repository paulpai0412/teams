import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTargetConfirmationBridge,
  targetApplyChallenge,
  confirmParentDecision,
} from "../e2e/target-confirmation-bridge.mjs";

const YES = "同意套用這一筆精確計畫";
const plan = "a".repeat(64),
  tree = "b".repeat(40),
  head = "c".repeat(40);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-target-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    output = path.join(root, "evidence");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const parent = path.join(root, "parent.jsonl");
  const ui = {
    id: "native-ui-1",
    method: "confirm",
    title: "Apply staged integration?",
    message: `apply only the sealed patch at ${source}\nBranch: refs/heads/main\nHEAD remains: ${head}\nIntegration tree: ${tree}\nPlan: ${plan}\nNo commit, ref movement or acceptance. Later edits cause refusal.`,
  };
  return { root, source, output, parent, ui };
}
function approval(
  file,
  challenge,
  { answer = YES, question = true, prior = false } = {},
) {
  const resultTime = new Date(
    Date.now() + (prior ? -60000 : 1000),
  ).toISOString();
  const toolCallId = "call-positive";
  const q = question
    ? `Target ${challenge.targetRoot}; plan ${challenge.planDigest}; tree ${challenge.mergedTree}; request ${challenge.requestDigest}`
    : "different plan";
  fs.writeFileSync(
    file,
    [
      { type: "session", id: "parent" },
      {
        type: "message",
        id: "caller",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: toolCallId,
              name: "ask_user",
              arguments: {
                questions: [
                  {
                    question: q,
                    options: [{ label: YES }, { label: "拒絕套用" }],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "ab123456",
        timestamp: resultTime,
        parentId: "caller",
        message: {
          role: "toolResult",
          toolName: "ask_user",
          toolCallId,
          content: [{ type: "text", text: `Q1: ${q}\nA1: ${answer}` }],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
}
function decision(output, request, approved = true) {
  const file = path.join(output, "target-confirmation-decision.json");
  const temporary = `${file}.draft`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      approved,
      parentApprovalEntryId: approved ? "ab123456" : "",
    }),
  );
  fs.renameSync(temporary, file);
}

test("native apply challenge is exact and cannot point at another target or dialog", (t) => {
  const f = setup(t);
  const c = targetApplyChallenge(f.ui, f.source, "native-owner");
  assert.equal(c.targetRoot, f.source);
  assert.equal(c.planDigest, plan);
  assert.match(c.requestDigest, /^[a-f0-9]{64}$/);
  assert.throws(
    () =>
      targetApplyChallenge(
        { ...f.ui, message: f.ui.message.replace(f.source, "/another") },
        f.source,
        "native-owner",
      ),
    /target differs/,
  );
  assert.throws(
    () =>
      targetApplyChallenge(
        { ...f.ui, title: "Allow shell command?" },
        f.source,
        "native-owner",
      ),
    /unrecognized/,
  );
});

test("only fresh matching parent ask_user positive choice binds approval", (t) => {
  const f = setup(t);
  const c = targetApplyChallenge(f.ui, f.source, "native-owner");
  approval(f.parent, c);
  assert.equal(
    confirmParentDecision(f.parent, "ab123456", c).approvalEntryId,
    "ab123456",
  );
  fs.appendFileSync(f.parent, '{"type":"message","unfinished":');
  assert.equal(
    confirmParentDecision(f.parent, "ab123456", c).approvalEntryId,
    "ab123456",
  );
  approval(f.parent, c, { question: false });
  assert.throws(
    () => confirmParentDecision(f.parent, "ab123456", c),
    /approval question/,
  );
  approval(f.parent, c, { answer: "拒絕套用" });
  assert.throws(
    () => confirmParentDecision(f.parent, "ab123456", c),
    /explicit positive/,
  );
  approval(f.parent, c, { prior: true });
  assert.throws(
    () => confirmParentDecision(f.parent, "ab123456", c),
    /prior confirmation/,
  );
});

test("file relay denies by default and rejects a mismatched or missing parent proof", async (t) => {
  const f = setup(t);
  const bridge = createTargetConfirmationBridge({
    outputRoot: f.output,
    sourceRoot: f.source,
    parentSessionFile: f.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 500,
  });
  const pending = bridge(f.ui);
  const request = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-request.json"),
      "utf8",
    ),
  );
  decision(f.output, request, false);
  assert.equal(await pending, false);
  const result = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-resolution.json"),
      "utf8",
    ),
  );
  assert.equal(result.reason, "parent-denied");
  assert.equal(result.confirmed, false);
  const second = setup(t);
  const relay = createTargetConfirmationBridge({
    outputRoot: second.output,
    sourceRoot: second.source,
    parentSessionFile: second.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 500,
  });
  const wait = relay(second.ui);
  const challenge = JSON.parse(
    fs.readFileSync(
      path.join(second.output, "target-confirmation-request.json"),
      "utf8",
    ),
  );
  decision(second.output, challenge, true);
  await assert.rejects(wait, /parent approval session|ENOENT/);
});

test("confirmation receipt collision fails closed instead of hanging or approving", async (t) => {
  const f = setup(t);
  fs.writeFileSync(
    path.join(f.output, "target-confirmation-resolution.json"),
    "prior receipt",
  );
  const relay = createTargetConfirmationBridge({
    outputRoot: f.output,
    sourceRoot: f.source,
    parentSessionFile: f.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 500,
  });
  const pending = relay(f.ui);
  const request = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-request.json"),
      "utf8",
    ),
  );
  approval(f.parent, request);
  decision(f.output, request, true);
  await assert.rejects(pending, /EEXIST/);
});

test("E2E confirmation permits a bounded 60-minute wait but rejects a longer one", async (t) => {
  const f = setup(t);
  assert.throws(
    () =>
      createTargetConfirmationBridge({
        outputRoot: f.output,
        sourceRoot: f.source,
        parentSessionFile: f.parent,
        ownerSessionId: "native-owner",
        timeoutMs: 3_600_001,
      }),
    /bounded approval wait/,
  );
  const bridge = createTargetConfirmationBridge({
    outputRoot: f.output,
    sourceRoot: f.source,
    parentSessionFile: f.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 3_600_000,
  });
  const controller = new AbortController();
  const pending = bridge(f.ui, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
  const resolved = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-resolution.json"),
      "utf8",
    ),
  );
  assert.equal(resolved.confirmed, false);
  assert.equal(resolved.reason, "observer-aborted");
});

test("file relay permits only a matching later user choice and timeout never approves", async (t) => {
  const f = setup(t);
  const bridge = createTargetConfirmationBridge({
    outputRoot: f.output,
    sourceRoot: f.source,
    parentSessionFile: f.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 500,
  });
  const pending = bridge(f.ui);
  const request = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-request.json"),
      "utf8",
    ),
  );
  approval(f.parent, request);
  decision(f.output, request, true);
  assert.equal(await pending, true);
  const resolved = JSON.parse(
    fs.readFileSync(
      path.join(f.output, "target-confirmation-resolution.json"),
      "utf8",
    ),
  );
  assert.equal(resolved.reason, "parent-approved");
  assert.equal(resolved.proof.approvalEntryId, "ab123456");
  const other = setup(t);
  const relay = createTargetConfirmationBridge({
    outputRoot: other.output,
    sourceRoot: other.source,
    parentSessionFile: other.parent,
    ownerSessionId: "native-owner",
    timeoutMs: 20,
  });
  assert.equal(await relay(other.ui), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(other.output, "target-confirmation-resolution.json"),
        "utf8",
      ),
    ).reason,
    "approval-timeout",
  );
});
