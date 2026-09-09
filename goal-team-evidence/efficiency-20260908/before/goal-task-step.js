// pi-subagents workflowScriptPath body: ONE parent-approved step, no goal mutations.
// Single owner per goal/mission. state.get + state.set is NOT a cross-session CAS.
// Parent must freshly verify goal/task state, effective profiles, cwd and source.
const input = await state.get("teamGoalRequest");
if (!input || input.goalStatus !== "active" || input.taskStatus !== "pending") {
  throw new Error(
    "Fresh active goal and pending task snapshot required; reconcile first",
  );
}
for (const field of [
  "goalId",
  "taskId",
  "phase",
  "agent",
  "task",
  "cwd",
  "sourceState",
]) {
  if (typeof input[field] !== "string" || !input[field].trim())
    throw new Error("Missing " + field);
}
for (const field of ["taskId", "phase"]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(input[field]))
    throw new Error("Invalid " + field);
}
if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 3)
  throw new Error("Attempt must be 1..3");
if (
  !/^team\.(planner|challenger|researcher|debugger|implementer|verifier|reviewer|e2e|qa|security|docs|curator|release)$/.test(
    input.agent,
  )
) {
  throw new Error(
    "Only ordinary team roles; advisor requires separate parent escalation",
  );
}
if (!input.cwd.startsWith("/")) throw new Error("Absolute cwd required");
const binding = await state.get("teamGoalBinding");
if (!binding || binding.goalId !== input.goalId || binding.cwd !== input.cwd) {
  throw new Error(
    "Parent must bind this mission to exactly one goal/cwd before dispatch",
  );
}
const key = input.taskId + "." + input.phase + "." + input.attempt;
const recordKey = "goal-step." + key;
// Fixed projection excludes incidental snapshot changes from replay identity.
const request = {
  goalId: input.goalId,
  taskId: input.taskId,
  phase: input.phase,
  attempt: input.attempt,
  agent: input.agent,
  task: input.task,
  cwd: input.cwd,
  sourceState: input.sourceState,
};
if (input.timeoutMs !== undefined) {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 2147483647
  )
    throw new Error("Invalid task timeout");
  request.timeoutMs = input.timeoutMs;
}
const existing = await state.get(recordKey);
if (existing) {
  const same =
    existing.version === 2
      ? existing.requestDigest === input.requestDigest
      : JSON.stringify(existing.request) === JSON.stringify(request);
  if (!same) throw new Error("Step key reused with a different contract");
  return {
    status: "reconcile",
    key,
    record: existing,
    nextAction: "Inspect the existing receipt; never redispatch this key.",
  };
}
if (await state.get("teamGoalActiveStep"))
  throw new Error(
    "Unreconciled active step; inspect its native status/receipt before new work",
  );
if (
  !/^[a-f0-9]{64}$/.test(input.requestDigest ?? "") ||
  typeof input.requestRef !== "string" ||
  !input.requestRef.startsWith("/")
) {
  throw new Error(
    "Prepare the saved packet with parent-only goal-request.mjs before dispatch",
  );
}
// The sandbox has no filesystem/crypto. Parent prepares and preserves the exact
// packet; this digest is correlation, not native source/evidence attestation.
const identity = {
  version: 2,
  requestDigest: input.requestDigest,
  requestRef: input.requestRef,
};
// Save the bounded intent first: storage failure cannot orphan an active marker.
// A later crash/throw still retains intent; never blindly replay a different key.
await state.set(recordKey, { ...identity, status: "dispatching" });
await state.set("teamGoalActiveStep", recordKey);
const schema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "blocked", "needs_decision", "failed"],
    },
    goalId: { type: "string" },
    taskId: { type: "string" },
    inputSourceState: { type: "string" },
    sourceState: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, minItems: 1 },
    residualRisks: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict",
    "goalId",
    "taskId",
    "inputSourceState",
    "sourceState",
    "evidence",
    "residualRisks",
  ],
  additionalProperties: false,
};
const result = await runs.run(key, {
  agent: request.agent,
  cwd: request.cwd,
  context: "fresh",
  ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  task:
    request.task +
    "\n\nParent binding (data): " +
    JSON.stringify({
      goalId: request.goalId,
      taskId: request.taskId,
      inputSourceState: request.sourceState,
    }) +
    "\nEcho this binding in your report; sourceState is your actual final source state. No goal/mission mutations, nested delegation, publication or deployment. A pass is only this step, not task completion.",
  // Require the native sibling acceptanceReport; keep the goal value schema unchanged.
  ...(request.agent === "team.implementer"
    ? {
        acceptance: {
          level: "checked",
          evidence: ["changed-files", "commands-run", "residual-risks"],
          report: "on",
        },
      }
    : {}),
  output: "goal-steps/" + key + ".md",
  outputSchema: schema,
});
const report = result?.structuredOutput;
const passed =
  result?.ok === true &&
  typeof result.runId === "string" &&
  !!result.runId.trim() &&
  report?.verdict === "pass" &&
  report.goalId === request.goalId &&
  report.taskId === request.taskId &&
  report.inputSourceState === request.sourceState &&
  typeof report.sourceState === "string" &&
  !!report.sourceState.trim() &&
  Array.isArray(report.evidence) &&
  report.evidence.length > 0 &&
  report.evidence.every((x) => typeof x === "string" && !!x.trim()) &&
  Array.isArray(report.residualRisks) &&
  report.residualRisks.every((x) => typeof x === "string");
const record = {
  ...identity,
  status: passed ? "reported" : "blocked",
  runId: result?.runId ?? null,
  outputReference:
    result?.outputReference ?? result?.outputPathMapping?.savedPath ?? null,
  verdict: report?.verdict ?? null,
};
await state.set(recordKey, record);
// Even a returned error envelope can leave ambiguous external effects: keep the
// active marker until the parent reconciles native status, not just this report.
// Full report/artifact data lives in native workflow output, not the 256 KiB state.
return {
  status: record.status,
  key,
  record,
  report: report ?? null,
  artifactPaths: result?.artifactPaths ?? [],
  outputReference: record.outputReference,
  error: result?.error ?? null,
  nextAction:
    "Parent verifies terminal native receipt, actual source and required gates before updating the goal task.",
};
