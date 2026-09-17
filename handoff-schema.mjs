// Project-owned team-handoff/1 value schema; native acceptanceReport is a sibling.
export function handoffSchema(criteria) {
  const text = { type: "string", minLength: 1, pattern: "\\S" };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: text,
      criterionResults: {
        type: "array",
        minItems: criteria.length,
        maxItems: criteria.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            criterion: { ...text, enum: criteria },
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
}
