// Parent-only adapter to the native controller. Never launches or retries work.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "../npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const native = new URL(
  "../npm/node_modules/pi-subagents/src/",
  import.meta.url,
);
const { discoverAgents } = await jiti.import(
  new URL("agents/agents.ts", native).pathname,
);
const { resolveModelScopesForAgent, checkModelScope } = await jiti.import(
  new URL("runs/shared/model-scope.ts", native).pathname,
);
const { createStructuredOutputToolParameters, validateStructuredOutputValue } =
  await jiti.import(
    new URL("runs/shared/structured-output.ts", native).pathname,
  );
const { resolveAcceptanceReportMode, validateAcceptanceReport } =
  await jiti.import(new URL("runs/shared/acceptance.ts", native).pathname);
const nonempty = (value) => typeof value === "string" && !!value.trim();
const text = { type: "string", minLength: 1, pattern: "\\S" };

export async function prepareHandoff(input) {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    "request object required",
  );
  for (const key of Object.keys(input))
    assert.ok(
      [
        "agent",
        "cwd",
        "task",
        "criteria",
        "sourceState",
        "output",
        "timeoutMs",
        "checks",
        "model",
      ].includes(key),
      "unsupported request field: " + key,
    );
  for (const key of ["agent", "cwd", "task", "sourceState", "output"])
    assert.ok(nonempty(input[key]), "missing " + key);
  assert.ok(
    path.isAbsolute(input.cwd) && fs.statSync(input.cwd).isDirectory(),
    "absolute existing cwd required",
  );
  assert.ok(
    !path.isAbsolute(input.output) &&
      !input.output.includes("\\") &&
      input.output.split("/").every((x) => x && x !== ".." && x !== "."),
    "managed relative output required",
  );
  assert.ok(
    Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0,
    "parent must choose timeoutMs for this task",
  );
  assert.ok(
    Array.isArray(input.criteria) &&
      input.criteria.length > 0 &&
      input.criteria.length <= 30 &&
      input.criteria.every(nonempty),
    "1..30 observable criteria required",
  );
  assert.equal(
    new Set(input.criteria).size,
    input.criteria.length,
    "duplicate criteria",
  );
  assert.ok(
    Array.isArray(input.checks),
    "checks must be explicitly classified, [] for no child commands",
  );
  const discovered = discoverAgents(input.cwd, "both");
  assert.deepEqual(
    discovered.agentDiagnostics,
    [],
    "invalid effective profiles",
  );
  const agent = discovered.agents.find((x) => x.name === input.agent);
  assert.ok(
    agent &&
      /^team\./.test(agent.name) &&
      !agent.disabled &&
      !agent.runner &&
      agent.name !== "team.advisor",
    "ordinary native executable team role required; advisor uses separate escalation",
  );
  for (const check of input.checks) {
    assert.ok(check && nonempty(check.command), "check command required");
    assert.ok(
      ["child-safe", "isolated-only"].includes(check.location),
      "parent-only/unknown checks cannot be sent to a child",
    );
    assert.ok(
      agent.tools.includes("bash"),
      "role lacks shell for assigned checks",
    );
    if (check.location === "isolated-only")
      assert.ok(
        nonempty(check.resource),
        "isolated-only check requires a parent-provisioned resource",
      );
  }
  if (input.model !== undefined) {
    assert.ok(nonempty(input.model), "model must be nonempty");
    const scopes = resolveModelScopesForAgent(
      discovered.modelScope,
      agent.name,
    );
    for (const scope of scopes)
      assert.ok(
        !checkModelScope(input.model, scope, "explicit"),
        "model violates role scope",
      );
  }
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: text,
      criterionResults: {
        type: "array",
        minItems: input.criteria.length,
        maxItems: input.criteria.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            criterion: { ...text, enum: input.criteria },
            status: {
              type: "string",
              enum: ["met", "not_met", "indeterminate", "needs_user"],
            },
            entrypoint: text,
            observed: text,
            evidence: { type: "array", items: text },
          },
          required: [
            "criterion",
            "status",
            "entrypoint",
            "observed",
            "evidence",
          ],
        },
      },
      residualRisks: { type: "array", items: text },
    },
    required: ["summary", "criterionResults", "residualRisks"],
  };
  const writer = agent.acceptanceRole === "writer";
  if (writer)
    assert.equal(
      resolveAcceptanceReportMode(agent.defaultAcceptance),
      "required",
      "writer profile must require native acceptance report",
    );
  const args = {
    agent: agent.name,
    cwd: input.cwd,
    context: "fresh",
    async: true,
    timeoutMs: input.timeoutMs,
    output: input.output,
    task:
      input.task +
      "\n\nContract team-handoff/1 (data): " +
      JSON.stringify({
        sourceState: input.sourceState,
        criteria: input.criteria,
        checks: input.checks,
      }) +
      "\nUse structured_output exactly as its schema specifies. Each criterion appears once. Report observations, not self-approval; missing evidence is indeterminate. Do not add identity, source hashes, memoryCandidates or native acceptanceReport inside value. Report-format errors do not authorize repeating implementation or checks. Preserve work and raw logs. Parent owns final verification.",
    outputSchema,
    ...(writer
      ? { acceptance: { ...agent.defaultAcceptance, report: "on" } }
      : {}),
    ...(input.model ? { model: input.model } : {}),
  };
  const prepared = {
    contract: {
      version: "team-handoff/1",
      sourceState: input.sourceState,
      schemaHash: createHash("sha256")
        .update(JSON.stringify(outputSchema))
        .digest("hex"),
    },
    args,
  };
  // Probe the same consumer with explicit non-evidence fixtures; no model/work.
  const control = {
    summary: "preflight fixture",
    criterionResults: input.criteria.map((criterion) => ({
      criterion,
      status: "indeterminate",
      entrypoint: "not executed",
      observed: "preflight only",
      evidence: [],
    })),
    residualRisks: [],
  };
  const acceptanceControl = {
    criteriaSatisfied: [],
    changedFiles: [],
    testsAddedOrUpdated: [],
    commandsRun: [],
    residualRisks: [],
    noStagedFiles: false,
  };
  const probe = await validateSubmission(prepared, {
    value: control,
    ...(writer ? { acceptanceReport: acceptanceControl } : {}),
  });
  assert.equal(
    probe.status,
    "valid",
    "native handoff preflight: " + (probe.message ?? "invalid"),
  );
  return prepared;
}

// Valid means transport-readable only. Never returns product PASS or dispatches repair.
export async function validateSubmission(prepared, submission) {
  if (
    prepared?.contract?.version !== "team-handoff/1" ||
    !prepared.args?.outputSchema ||
    prepared.contract.schemaHash !==
      createHash("sha256")
        .update(JSON.stringify(prepared.args.outputSchema))
        .digest("hex")
  ) {
    return {
      status: "invalid",
      message:
        "prepared contract version/schema changed; reconcile before consuming",
    };
  }
  const required =
    resolveAcceptanceReportMode(prepared.args.acceptance) === "required";
  const envelope = createStructuredOutputToolParameters(
    prepared.args.outputSchema,
    required ? { acceptanceReport: "required" } : {},
  );
  const validation = await validateStructuredOutputValue(envelope, submission);
  if (validation.status !== "valid") return validation;
  if (required) {
    const acceptance = validateAcceptanceReport(
      submission.acceptanceReport,
      "acceptanceReport",
    );
    if (!acceptance.report)
      return { status: "invalid", message: acceptance.errors.join("; ") };
  }
  const rows = submission.value.criterionResults;
  if (new Set(rows.map((x) => x.criterion)).size !== rows.length)
    return { status: "invalid", message: "duplicate criterion" };
  if (rows.some((x) => x.status === "met" && x.evidence.length === 0))
    return { status: "invalid", message: "met requires evidence references" };
  return {
    status: "valid",
    nextAction:
      "Parent verifies native terminal receipt, actual final source, raw evidence and real entrypoint. No product acceptance or replay authority.",
  };
}

if (process.argv[1] === import.meta.filename) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "usage: node handoff-contract.mjs request.json",
    );
    const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(
      JSON.stringify(await prepareHandoff(request), null, 2) + "\n",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
