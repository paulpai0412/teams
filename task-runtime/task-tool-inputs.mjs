// One source for public Task tool parameters and observer classification.
// These are input schemas, not authorization, effect or acceptance evidence.
const execution = {
  type: "object",
  additionalProperties: false,
  required: ["execution_id"],
  properties: { execution_id: { type: "string", pattern: "^[a-f0-9-]{36}$" } },
};

// Same host-check fields as the sealed Task; semantic scope/trust validation
// remains in the contract/origin admission, not in a second check language.
const additionalChecks = {
  type: "array",
  maxItems: 30,
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "commandId",
      "executable",
      "argv",
      "cwd",
      "timeoutMs",
      "expectedExitCode",
      "criterionIds",
    ],
    properties: {
      commandId: { type: "string" },
      executable: { type: "string" },
      argv: { type: "array", maxItems: 128, items: { type: "string" } },
      cwd: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
      expectedExitCode: { type: "integer", const: 0 },
      criterionIds: { type: "array", minItems: 1, items: { type: "string" } },
    },
  },
};

export const taskToolParameters = {
  team_task_dispatch: {
    type: "object",
    additionalProperties: false,
    required: ["spec_path", "benefit", "benefit_detail"],
    properties: {
      spec_path: { type: "string" },
      benefit: {
        type: "string",
        enum: [
          "context-isolation",
          "crash-recovery",
          "worktree-isolation",
          "long-running",
          "unknown-cause",
        ],
      },
      benefit_detail: { type: "string", minLength: 20, maxLength: 500 },
    },
  },
  team_task_revise: {
    type: "object",
    additionalProperties: false,
    required: [
      "previous_execution_id",
      "expected_previous_result_digest",
      "repair_reason",
    ],
    properties: {
      previous_execution_id: execution.properties.execution_id,
      spec_path: { type: "string" },
      expected_previous_result_digest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      repair_reason: { type: "string", minLength: 1, maxLength: 500 },
      origin: {
        type: "string",
        enum: ["blocked-review", "integration-conflict"],
      },
      additional_checks: {
        ...additionalChecks,
        description:
          "Product revision: append these checks (or []) to the inherited sealed contract. Omit spec_path; all other fields and taskRevision are host-derived.",
      },
      failure_receipt_ref: { type: "string" },
      failure_receipt_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      review_failure_ref: { type: "string" },
      review_failure_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    oneOf: [
      {
        required: [
          "spec_path",
          "failure_receipt_ref",
          "failure_receipt_sha256",
        ],
        not: {
          anyOf: [
            { required: ["origin"] },
            { required: ["additional_checks"] },
            { required: ["review_failure_ref"] },
            { required: ["review_failure_sha256"] },
          ],
        },
      },
      {
        required: ["origin", "review_failure_ref", "review_failure_sha256"],
        properties: { origin: { const: "blocked-review" } },
        oneOf: [
          { required: ["additional_checks"], not: { required: ["spec_path"] } },
          { required: ["spec_path"], not: { required: ["additional_checks"] } },
        ],
        not: {
          anyOf: [
            { required: ["failure_receipt_ref"] },
            { required: ["failure_receipt_sha256"] },
          ],
        },
      },
      {
        required: ["origin", "failure_receipt_ref", "failure_receipt_sha256"],
        properties: { origin: { const: "integration-conflict" } },
        oneOf: [
          { required: ["additional_checks"], not: { required: ["spec_path"] } },
          { required: ["spec_path"], not: { required: ["additional_checks"] } },
        ],
        not: {
          anyOf: [
            { required: ["review_failure_ref"] },
            { required: ["review_failure_sha256"] },
          ],
        },
      },
    ],
  },
  team_task_revise_report: {
    type: "object",
    additionalProperties: false,
    required: [
      "previous_execution_id",
      "spec_path",
      "expected_previous_result_digest",
      "review_failure_ref",
      "review_failure_sha256",
      "report_reason",
    ],
    properties: {
      previous_execution_id: execution.properties.execution_id,
      spec_path: { type: "string" },
      expected_previous_result_digest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      review_failure_ref: { type: "string" },
      review_failure_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      report_reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  team_task_collect: {
    ...execution,
    properties: {
      ...execution.properties,
      wait_ms: { type: "integer", minimum: 0, maximum: 1_200_000 },
    },
  },
  team_task_stage_integration: {
    ...execution,
    properties: {
      ...execution.properties,
      action: {
        type: "string",
        enum: [
          "stage",
          "prepare-review",
          "plan-review",
          "start-review",
          "collect-review",
          "seal-review",
          "read-applied-review",
        ],
      },
      wave: { type: "object", additionalProperties: true, properties: {} },
      key: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        description:
          "Required for start-review/collect-review: key returned by plan-review.",
      },
      plan_digest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description:
          "For start-review/collect-review, planDigest returned with the same wave key.",
      },
    },
    anyOf: [
      {
        properties: { action: { enum: ["start-review", "collect-review"] } },
        required: ["action", "key", "plan_digest"],
      },
      {
        properties: { action: { enum: ["plan-review"] } },
        required: ["action", "wave"],
      },
      {
        properties: { action: { enum: ["read-applied-review"] } },
        required: ["action", "plan_digest"],
      },
      {
        properties: {
          action: { enum: ["stage", "prepare-review", "seal-review"] },
        },
      },
    ],
  },
  team_task_target_integration: {
    type: "object",
    additionalProperties: false,
    required: ["execution_id", "action"],
    properties: {
      execution_id: execution.properties.execution_id,
      action: {
        type: "string",
        enum: ["prepare", "inspect", "apply", "rollback"],
      },
      plan_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
  team_task_run_checks: execution,
  team_task_accept: execution,
  team_task_prepare_takeover: execution,
  team_task_takeover: {
    type: "object",
    additionalProperties: false,
    required: ["proof_ref"],
    properties: { proof_ref: { type: "string" } },
  },
  team_task_reconcile: execution,
  team_task_cancel: {
    type: "object",
    additionalProperties: false,
    required: ["execution_id", "reason"],
    properties: {
      execution_id: execution.properties.execution_id,
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  team_task_status: execution,
};
