// Task-owned leaf hooks. Resolve launch-local metadata on the session bus,
// after all extension factories loaded; never infer a binding from parent env.
import {
  installTaskBudgetHooks,
  TASK_BUDGET_BINDING,
} from "../../task-runtime/task-budget.mjs";
import {
  installReconstructionHooks,
  RECONSTRUCTION_BINDING,
} from "../../task-runtime/reconstruction-input.mjs";

export default function teamsBudget(pi) {
  let binding = null,
    reconstruction = null;
  pi.on("session_start", () => {
    let replies = 0;
    pi.events.emit("pi-subagents:extension-bindings:v1", {
      namespace: TASK_BUDGET_BINDING,
      reply(value) {
        if (++replies !== 1)
          throw new Error("Ambiguous child extension bindings");
        binding = value;
      },
    });
    let reconstructionReplies = 0;
    pi.events.emit("pi-subagents:extension-bindings:v1", {
      namespace: RECONSTRUCTION_BINDING,
      reply(value) {
        if (++reconstructionReplies !== 1)
          throw new Error("Ambiguous reconstruction binding");
        reconstruction = value;
      },
    });
  });
  installTaskBudgetHooks(pi, () => binding);
  installReconstructionHooks(pi, () => reconstruction);
}
