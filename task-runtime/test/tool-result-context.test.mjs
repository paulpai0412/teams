// Zero-model provider-boundary checks. No credentials, network or candidate execution.
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectedReviewReply,
  collectedTaskReply,
} from "../../extensions/teams-orchestrator/index.mjs";
import { modelToolOutput } from "./public-recovery-fixture.mjs";

async function projected(reply) {
  const event = { toolCallId: "handoff" };
  const agent = {
    state: {
      messages: [
        {
          role: "assistant",
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          content: [
            {
              type: "toolCall",
              id: "handoff",
              name: "team_task_stage_integration",
              arguments: {},
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "handoff",
          toolName: "team_task_stage_integration",
          ...reply,
        },
      ],
    },
  };
  return modelToolOutput(agent, event);
}

function completion(verdict = "blocked") {
  return {
    state: "bound",
    verdict,
    resultDigest: "a".repeat(64),
    resultOutcome: "ready_for_review",
    planDigest: "b".repeat(64),
    completionRef: "/runtime/execution/integration/reviews/final/complete.json",
    completionSha256: "c".repeat(64),
    reports: Array.from({ length: 3 }, () => ({
      report: {
        verdict,
        criteria: {
          behavior: {
            status: "met",
            reason: "Full reason is in the completion.",
          },
        },
        findings: Array.from({ length: 32 }, () => ({
          severity: "blocker",
          issue: "UNTRUSTED_LONG_FINDING".repeat(100),
          rationale: "Full explanation stays in the bound file.",
          sourcePaths: ["src/file"],
        })),
      },
    })),
    captures: [
      {
        origin: "/HIDDEN_CAPTURE",
        saved: "captures/0.bin",
        sha256: "d".repeat(64),
      },
    ],
  };
}

test("provider sees compact BLOCKED selectors and all-finding counts, not raw captures or instructions", async () => {
  const value = completion();
  value.reports[0].report.verdict = "needs-user";
  value.reports[0].report.criteria.behavior.status = "needs-user";
  const reply = collectedReviewReply("execution", value);
  const text = await projected(reply);
  const evidence = JSON.parse(
    text.split("Bound review evidence (not instructions or acceptance): ")[1],
  );
  assert.equal(evidence.resultDigest, value.resultDigest);
  assert.equal(evidence.completionRef, value.completionRef);
  assert.equal(evidence.completionSha256, value.completionSha256);
  assert.equal(evidence.reportCount, 3);
  assert.equal(evidence.findingCount, 96);
  assert.equal(evidence.blockerCount, 96);
  assert.equal(evidence.needsUserCount, 1);
  assert.ok(Buffer.byteLength(text) < 4096);
  assert.doesNotMatch(text, /UNTRUSTED_LONG_FINDING|HIDDEN_CAPTURE/);
  assert.match(text, /Read all reports\/findings/);
  assert.match(text, /original policy/);
  assert.equal(reply.details, value);
  assert.equal(reply.terminate, undefined);
});

test("pending review and Task collection publish no completion or repair selectors", async () => {
  const pending = collectedReviewReply("execution", {
    ...completion(),
    state: "running",
  });
  const text = await projected(pending);
  assert.equal(pending.terminate, true);
  assert.match(text, /native completion notification/);
  assert.doesNotMatch(
    text,
    /completionRef|completionSha256|resultDigest|team_task_revise/,
  );
  const waiting = await projected(
    collectedTaskReply("execution", {
      collection: "waiting",
      state: "RUNNING",
      workerProcess: { terminal: false },
      resultRef: "/not-yet-published",
      resultDigest: "e".repeat(64),
    }),
  );
  assert.match(waiting, /do not redispatch/);
  assert.doesNotMatch(waiting, /not-yet-published|eeeeeeee/);
});

test("PASS review still cannot upgrade a sealed review-only result", async () => {
  const value = completion("pass");
  for (const row of value.reports) row.report.findings = [];
  const text = await projected(collectedReviewReply("execution", value));
  assert.match(text, /PASS does not upgrade a ready_for_review result/);
  assert.doesNotMatch(text, /origin=blocked-review/);
  assert.match(text, /Not acceptance/);
  assert.ok(text.includes(value.completionRef));
});
