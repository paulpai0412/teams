// One source for public Task tool parameters and observer classification.
// These are input schemas, not authorization, effect or acceptance evidence.
const execution = {
  type: "object",
  additionalProperties: false,
  required: ["execution_id"],
  properties: { execution_id: { type: "string", pattern: "^[a-f0-9-]{36}$" } },
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
