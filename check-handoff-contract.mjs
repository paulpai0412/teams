// Parent-only offline regression. No model/child launches.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";

export async function checkHandoffContract() {
  const root = new URL("../", import.meta.url);
  const roles = [
    "implementer",
    "docs",
    "release",
    "planner",
    "reviewer",
    "verifier",
    "security",
    "challenger",
    "debugger",
    "researcher",
    "qa",
    "e2e",
    "curator",
    "advisor",
  ];
  for (const role of roles) {
    const text = fs.readFileSync(
      new URL(`agents/team.${role}.md`, root),
      "utf8",
    );
    assert.ok(
      !text.includes("Always include verdict"),
      `${role}: generic keys conflict with outputSchema`,
    );
    assert.match(text, /outputSchema/);
    if (["implementer", "docs", "release"].includes(role))
      assert.match(text, /acceptance:.*report: on/);
  }
  const { prepareHandoff, validateSubmission } = await import(
    "./handoff-contract.mjs"
  );
  const input = {
    agent: "team.implementer",
    cwd: "/home/timmypai",
    task: "Fixture only, do not execute",
    criteria: ["greeting works"],
    sourceState: "fixture-before",
    output: "handoffs/fixture.md",
    timeoutMs: 123456,
    checks: [
      {
        command: "node check.mjs",
        location: "isolated-only",
        resource: "parent-owned disposable fixture",
      },
    ],
  };
  let cases = roles.length;
  const prepared = await prepareHandoff(input);
  assert.equal(prepared.args.timeoutMs, input.timeoutMs);
  assert.equal(prepared.args.acceptance.report, "on");
  assert.equal(prepared.args.context, "fresh");
  assert.equal(prepared.contract.version, "team-handoff/1");
  assert.equal(prepared.contract.sourceState, input.sourceState);
  assert.equal(
    prepared.contract.schemaHash,
    createHash("sha256")
      .update(JSON.stringify(prepared.args.outputSchema))
      .digest("hex"),
  );
  const jiti = createJiti(import.meta.url);
  const { resolveEffectiveAcceptance } = await jiti.import(
    new URL("npm/node_modules/pi-subagents/src/runs/shared/acceptance.ts", root)
      .pathname,
  );
  const effective = resolveEffectiveAcceptance({
    agentName: input.agent,
    acceptanceRole: "writer",
    task: input.task,
    explicit: prepared.args.acceptance,
  });
  const value = {
    summary: "Fixture report only",
    criterionResults: [
      {
        criterion: input.criteria[0],
        status: "met",
        entrypoint: "fixture invocation",
        observed: "fixture greeting",
        evidence: ["fixture.log"],
      },
    ],
    residualRisks: [],
  };
  const acceptanceReport = {
    criteriaSatisfied: effective.criteria.map((x) => ({
      id: x.id,
      status: "satisfied",
      evidence: "fixture only",
    })),
    changedFiles: [],
    testsAddedOrUpdated: [],
    commandsRun: [
      { command: "fixture", result: "passed", summary: "fixture only" },
    ],
    residualRisks: [],
    noStagedFiles: true,
  };
  assert.equal(
    (await validateSubmission(prepared, { value, acceptanceReport })).status,
    "valid",
  );
  cases++;
  for (const submission of [
    { value },
    { value: { ...value, memoryCandidates: [] }, acceptanceReport },
    { value, acceptanceReport: { ...acceptanceReport, redLog: "extra" } },
    { value: { ...value, criterionResults: [] }, acceptanceReport },
    {
      value: {
        ...value,
        criterionResults: [
          { ...value.criterionResults[0], criterion: "wrong task" },
        ],
      },
      acceptanceReport,
    },
  ]) {
    assert.equal(
      (await validateSubmission(prepared, submission)).status,
      "invalid",
    );
    cases++;
  }
  for (const patch of [
    { timeoutMs: undefined },
    { timeoutMs: 0 },
    { output: "../escape.md" },
    { output: "/absolute.md" },
    { criteria: ["same", "same"] },
    { checks: [{ command: "node parent-check.mjs", location: "parent-only" }] },
    { checks: [{ command: "x", location: "unknown" }] },
    { agent: "team.reviewer", checks: input.checks },
    { agent: "team.advisor" },
    { model: "openai-codex/gpt-6-astra" },
  ]) {
    await assert.rejects(prepareHandoff({ ...input, ...patch }));
    cases++;
  }
  const reader = await prepareHandoff({
    ...input,
    agent: "team.reviewer",
    checks: [],
  });
  assert.ok(!("acceptance" in reader.args));
  assert.equal((await validateSubmission(reader, { value })).status, "valid");
  cases++;
  for (const role of ["team.docs", "team.release"]) {
    const writer = await prepareHandoff({ ...input, agent: role, checks: [] });
    assert.deepEqual(writer.args.acceptance.evidence, [
      "changed-files",
      "manual-notes",
      "residual-risks",
    ]);
    assert.equal(writer.args.acceptance.report, "on");
    cases++;
  }
  const two = await prepareHandoff({ ...input, criteria: ["first", "second"] });
  const duplicate = {
    ...value,
    criterionResults: [0, 1].map(() => ({
      ...value.criterionResults[0],
      criterion: "first",
    })),
  };
  assert.equal(
    (await validateSubmission(two, { value: duplicate, acceptanceReport }))
      .status,
    "invalid",
  );
  cases++;
  for (const patch of [
    { evidence: [] },
    { observed: " " },
    { status: "PASS" },
  ]) {
    assert.equal(
      (
        await validateSubmission(prepared, {
          value: {
            ...value,
            criterionResults: [{ ...value.criterionResults[0], ...patch }],
          },
          acceptanceReport,
        })
      ).status,
      "invalid",
    );
    cases++;
  }
  const gaps = await validateSubmission(prepared, {
    value: {
      ...value,
      criterionResults: [
        { ...value.criterionResults[0], status: "indeterminate", evidence: [] },
      ],
    },
    acceptanceReport,
  });
  assert.equal(gaps.status, "valid");
  assert.match(gaps.nextAction, /No product acceptance/);
  cases++;
  // A invented path passes transport shape, but MUST NOT become verified evidence.
  const fake = await validateSubmission(prepared, {
    value: {
      ...value,
      criterionResults: [
        {
          ...value.criterionResults[0],
          evidence: ["does-not-exist-fixture.log"],
        },
      ],
    },
    acceptanceReport,
  });
  assert.equal(fake.status, "valid");
  assert.ok(!("verdict" in fake));
  assert.match(fake.nextAction, /raw evidence/);
  cases++;
  for (const patch of [
    { outputSchema: {} },
    { checks: [{ command: "x", location: "isolated-only" }] },
  ]) {
    await assert.rejects(prepareHandoff({ ...input, ...patch }));
    cases++;
  }
  for (const change of ["version", "schema"]) {
    const stale = structuredClone(prepared);
    if (change === "version") stale.contract.version = "team-handoff/0";
    else stale.args.outputSchema.additionalProperties = true;
    assert.equal(
      (await validateSubmission(stale, { value, acceptanceReport })).status,
      "invalid",
    );
    cases++;
  }
  return cases;
}
if (process.argv[1] === import.meta.filename)
  console.log(
    JSON.stringify({
      status: "PASS",
      cases: await checkHandoffContract(),
      modelCalls: 0,
      childAgents: 0,
    }),
  );
