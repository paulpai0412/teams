import assert from "node:assert/strict";
import {
  SubagentsRpcClient,
  inspectSubagentsPing,
  inspectBackgroundHost,
  writeCapabilityReceipt,
} from "../capabilities.mjs";

export default function workerCompatibilityProbe(pi) {
  pi.on("session_start", async () => {
    const host = inspectBackgroundHost(process.env.TEAMS_E2E_WORKER_PI, {
      subagentsExtension: process.env.TEAMS_E2E_SUBAGENTS_EXTENSION,
    });
    const rpc = new SubagentsRpcClient(pi.events);
    const subagents = inspectSubagentsPing(await rpc.ping(10_000));
    const forbidden = pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) =>
        /^(create_goal|update_goal|update_goal_task)$/.test(name),
      );
    const receipt = {
      schemaVersion: "teams-worker-compatibility/1",
      observedAt: new Date().toISOString(),
      host,
      subagents,
      goalTools: forbidden,
      noModelCalls: true,
      liveLeafVerified: false,
    };
    writeCapabilityReceipt(process.env.TEAMS_COMPAT_PROBE_OUTPUT, receipt);
    assert.ok(
      subagents.compatible && !forbidden.length,
      "Worker public-contract probe rejected",
    );
    // This probe advertises contracts only. It cannot mint live runtime readiness.
  });
}
