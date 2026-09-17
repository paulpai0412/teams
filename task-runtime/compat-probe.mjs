import assert from "node:assert/strict";
import path from "node:path";
import { inspectGoalTools, writeCapabilityReceipt } from "./capabilities.mjs";

export default function compatibilityProbe(pi) {
  const output = process.env.TEAMS_COMPAT_PROBE_OUTPUT;
  assert.ok(
    output && path.isAbsolute(output),
    "TEAMS_COMPAT_PROBE_OUTPUT required",
  );
  pi.on("session_start", () => {
    const goalX = inspectGoalTools(pi);
    writeCapabilityReceipt(output, {
      schemaVersion: "teams-static-capability-probe/1",
      capturedAt: new Date().toISOString(),
      goalX,
    });
    if (!goalX.compatible)
      throw new Error(
        "Goal-X public task/goal completion schemas are incompatible",
      );
  });
}
