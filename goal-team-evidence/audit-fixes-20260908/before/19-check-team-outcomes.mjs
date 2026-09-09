import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercises the installed workflow body; no agents, model calls or shell commands.
export async function checkOutcomeGate() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const gate = new AsyncFunction(
    "state",
    "runs",
    readFileSync(new URL("./gate-candidate.js", import.meta.url), "utf8"),
  );
  const candidate = {
    task: "CLI greeting",
    sourceState: "fixture-sha+dirty-digest",
    criteria: ["named greeting", "missing-name usage"],
    validationCommands: ["node check.mjs"],
    evidencePaths: ["fixture.log"],
    timeoutMs: 123456,
    validationLocation: "child-safe",
  };
  const pass = {
    ok: true,
    runId: "fixture",
    structuredOutput: {
      verdict: "pass",
      sourceState: candidate.sourceState,
      evidence: ["fixture.log"],
      residualRisks: [],
      criterionResults: candidate.criteria.map((criterion) => ({
        criterion,
        status: "met",
        entrypoint: "fixture CLI invocation",
        observed: "expected fixture output observed",
        evidence: ["fixture.log"],
      })),
    },
  };
  async function exercise(results, input = candidate) {
    const data = { teamCandidate: input, teamGate: null };
    const calls = [];
    try {
      const outcome = await gate(
        {
          get: async (key) => data[key],
          set: async (key, value) => {
            data[key] = value;
          },
        },
        {
          run: async (key) => {
            calls.push(key);
            const result = results.shift();
            if (result instanceof Error) throw result;
            return result;
          },
        },
      );
      return { outcome, calls, data };
    } catch (error) {
      return { error, calls, data };
    }
  }
  let checks = 0;
  const good = await exercise([pass, pass]);
  assert.equal(good.outcome.verdict, "pass");
  assert.equal(good.calls.length, 2);
  checks++;
  const badReports = [
    { verdict: "blocked" },
    { sourceState: "stale" },
    { evidence: [] },
    { evidence: [" "] },
    { residualRisks: [null] },
    { criterionResults: undefined },
    { criterionResults: pass.structuredOutput.criterionResults.slice(1) },
    {
      criterionResults: [
        pass.structuredOutput.criterionResults[0],
        pass.structuredOutput.criterionResults[0],
      ],
    },
    ...["not_met", "indeterminate", "needs_user", "pass"].map((status) => ({
      criterionResults: pass.structuredOutput.criterionResults.map((row) => ({
        ...row,
        status,
      })),
    })),
    ...["criterion", "entrypoint", "observed"].map((field) => ({
      criterionResults: pass.structuredOutput.criterionResults.map((row) => ({
        ...row,
        [field]: " ",
      })),
    })),
    {
      criterionResults: pass.structuredOutput.criterionResults.map((row) => ({
        ...row,
        evidence: [],
      })),
    },
    {
      criterionResults: pass.structuredOutput.criterionResults.map((row) => ({
        ...row,
        evidence: [" "],
      })),
    },
    {
      criterionResults: [
        ...pass.structuredOutput.criterionResults,
        {
          ...pass.structuredOutput.criterionResults[0],
          criterion: "unrequested",
        },
      ],
    },
  ];
  for (const bad of [
    { ok: false },
    { ok: true, output: "PASS" },
    { ...pass, runId: "" },
    ...badReports.map((patch) => ({
      ...pass,
      structuredOutput: { ...pass.structuredOutput, ...patch },
    })),
  ]) {
    const first = await exercise([bad, pass]);
    assert.equal(first.outcome.verdict, "blocked", JSON.stringify(bad));
    assert.equal(first.calls.length, 1);
    checks++;
    const second = await exercise([pass, bad]);
    assert.equal(second.outcome.verdict, "blocked");
    checks++;
  }
  for (const input of [
    {},
    { ...candidate, criteria: ["same", "same"] },
    { ...candidate, timeoutMs: undefined },
    { ...candidate, validationLocation: "parent-only" },
    { ...candidate, validationLocation: "isolated-only" },
  ]) {
    const invalid = await exercise([], input);
    assert.ok(invalid.error);
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.data.teamGate.verdict, "blocked");
    checks++;
  }
  for (const results of [
    [new Error("tool failed")],
    [pass, new Error("review failed")],
  ]) {
    const crashed = await exercise(results);
    assert.ok(crashed.error);
    assert.equal(crashed.data.teamGate.verdict, "blocked");
    let calls = 0;
    const restored = await gate(
      {
        get: async (key) => crashed.data[key],
        set: async (key, value) => {
          crashed.data[key] = value;
        },
      },
      {
        run: async () => {
          calls++;
          return pass;
        },
      },
    );
    assert.equal(calls, 0);
    assert.equal(restored.stage, "reconcile");
    checks++;
  }
  // A new workflow evaluation must not rerun commands after a malformed report.
  const retained = await exercise([
    { ok: false, runId: "bad-report", artifactPaths: ["preserved.log"] },
    pass,
  ]);
  let replayCalls = 0;
  const replay = await gate(
    {
      get: async (key) => retained.data[key],
      set: async (key, value) => {
        retained.data[key] = value;
      },
    },
    {
      run: async () => {
        replayCalls++;
        return pass;
      },
    },
  );
  assert.equal(
    replayCalls,
    0,
    "handoff failure must not replay completed work",
  );
  assert.equal(replay.stage, "reconcile");
  assert.deepEqual(retained.data.teamGate.verification.artifactPaths, [
    "preserved.log",
  ]);
  checks++;
  // Persistence failure before admission never starts a child.
  let unsafeCalls = 0;
  await assert.rejects(
    gate(
      {
        get: async (key) => (key === "teamCandidate" ? candidate : null),
        set: async () => {
          throw new Error("disk failure");
        },
      },
      {
        run: async () => {
          unsafeCalls++;
          return pass;
        },
      },
    ),
  );
  assert.equal(unsafeCalls, 0);
  checks++;
  // Even a changed input must reconcile the prior run, not silently replace it.
  retained.data.teamCandidate = { ...candidate, sourceState: "new-source" };
  const changed = await gate(
    {
      get: async (key) => retained.data[key],
      set: async () => {
        throw new Error("must preserve old receipt");
      },
    },
    {
      run: async () => {
        throw new Error("must not launch");
      },
    },
  );
  assert.equal(changed.stage, "reconcile");
  checks++;
  const legacy = {
    verdict: "blocked",
    stage: "verification",
    runId: "legacy",
    report: {},
  };
  const old = await gate(
    {
      get: async (key) => (key === "teamGate" ? legacy : candidate),
      set: async () => {
        throw new Error("must retain legacy receipt");
      },
    },
    {
      run: async () => {
        throw new Error("must not replay legacy");
      },
    },
  );
  assert.equal(old.stage, "reconcile");
  assert.deepEqual(old.retained, legacy);
  checks++;
  return checks;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(
    JSON.stringify({
      status: "PASS",
      cases: await checkOutcomeGate(),
      modelCalls: 0,
      limitations:
        "Report consistency only; parent must inspect actual source, evidence and user decisions.",
    }),
  );
}
