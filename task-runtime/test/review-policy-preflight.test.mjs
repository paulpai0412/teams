import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TaskInputRejection } from "../input-rejection.mjs";
import { preflightTaskReviewPolicy } from "../integration-review.mjs";
import { publicReviewResolver } from "../review-runs.mjs";

const cwd = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reviewer = "team.reviewer";
const supported = {
  schemaVersion: "teams-task-runtime/3",
  policy: {
    review: {
      allowedRoles: [reviewer],
      allowedTools: ["read", "structured_output"],
    },
  },
};
const resolution = {
  ok: true,
  contract: {
    version: 2,
    agent: { name: reviewer, source: "user" },
    context: "fresh",
    roots: { cwd },
    diagnostics: [],
    tools: {
      explicitAllowlist: true,
      disableAmbientExtensions: true,
      fanoutAuthorized: false,
      effectiveAllowlist: ["read"],
      effectiveMcpTools: [],
      internalTools: ["structured_output"],
    },
  },
};

test("v3 draft rejects a reviewer internal tool omitted from the sealed ceiling before Task reservation", async () => {
  const calls = [];
  const spec = {
    ...supported,
    policy: {
      review: { ...supported.policy.review, allowedTools: ["read"] },
    },
  };
  await assert.rejects(
    preflightTaskReviewPolicy(spec, cwd, async (input) => {
      calls.push(input);
      return resolution;
    }),
    (error) => {
      assert.ok(error instanceof TaskInputRejection);
      assert.equal(error.phase, "task-spec");
      assert.deepEqual(error.diagnostics.excess, ["structured_output"]);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, reviewer);
  assert.equal(calls[0].agentScope, "user");
  assert.equal(calls[0].context, "fresh");
  assert.ok(
    calls[0].outputSchema,
    "native structured-output tool must be resolved",
  );
});

test("v3 draft allows complete dynamic reviewer tools but unknown preflight stays fatal", async () => {
  const rows = await preflightTaskReviewPolicy(
    supported,
    cwd,
    async () => resolution,
  );
  assert.deepEqual(rows[0].toolDiagnostics.internalTools, [
    "structured_output",
  ]);
  assert.deepEqual(rows[0].toolDiagnostics.excess, []);
  await assert.rejects(
    preflightTaskReviewPolicy(supported, cwd, async () => ({
      ok: false,
      code: "missing_agent",
    })),
    (error) => {
      assert.equal(error instanceof TaskInputRejection, false);
      assert.match(error.message, /public review preflight unavailable/);
      return true;
    },
  );
});

test("installed public preflight exposes the actual reviewer's internal structured_output without a child launch", async () => {
  const resolve = await publicReviewResolver(
    path.join(os.homedir(), ".pi/agent"),
    path.join(path.dirname(process.execPath), "pi"),
  );
  const activeResolver = (input) =>
    resolve({
      ...input,
      availableModels: [
        {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          fullId: "openai-codex/gpt-5.6-luna",
          reasoning: true,
        },
      ],
      parentModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
    });
  let effective;
  await assert.rejects(
    preflightTaskReviewPolicy(supported, cwd, activeResolver),
    (error) => {
      assert.equal(error.phase, "task-spec");
      assert.ok(error.diagnostics.effective.includes("structured_output"));
      effective = error.diagnostics.effective;
      return true;
    },
  );
  const current = await preflightTaskReviewPolicy(
    {
      ...supported,
      policy: {
        review: { ...supported.policy.review, allowedTools: effective },
      },
    },
    cwd,
    activeResolver,
  );
  assert.deepEqual(current[0].toolDiagnostics.internalTools, [
    "structured_output",
  ]);
});
