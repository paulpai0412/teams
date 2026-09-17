// Budget-only leaf entrypoint. Native in-process roles need not have a depth
// environment flag and may inherit a parent's Task directory. Only the explicit
// per-launch binding enables accounting; this extension never registers tools.
import {
  installTaskBudgetHooks,
  TASK_BUDGET_BINDING,
} from "../../task-runtime/task-budget.mjs";

export default function teamsBudget(pi) {
  let bindings;
  try {
    bindings = JSON.parse(process.env.PI_SUBAGENT_EXTENSION_BINDINGS ?? "{}");
  } catch (cause) {
    throw new Error("Invalid Task budget extension binding", { cause });
  }
  const binding = bindings[TASK_BUDGET_BINDING];
  if (binding) installTaskBudgetHooks(pi, () => binding);
}
