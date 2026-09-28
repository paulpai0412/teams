// Load installed native launch code with its own host-peer resolver. No live run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
export const pkg =
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/package.json";
const { createJiti } = createRequire(pkg)("jiti");
const { resolveHostPeerAliases } = await createJiti(pkg).import(
  "./src/runs/background/runner-aliases.ts",
);
const host = path.dirname(
  path.dirname(fs.realpathSync(process.execPath.replace(/node$/, "pi"))),
);
const peers = resolveHostPeerAliases(host);
assert.deepEqual(peers.missing, []);
export const native = createJiti(pkg, { alias: peers.aliases });
const { buildInProcessChildLaunch } = await native.import(
  "./src/runs/shared/child-launch.ts",
);
export function nativeBudgetLaunch(extensionBindings, options = {}) {
  return buildInProcessChildLaunch({
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    tools: [],
    extensions: [],
    waitToolEnabled: false,
    cwd: process.cwd(),
    childAgentName: "fixture",
    childIndex: 0,
    extensionBindings,
    host: "parent",
    ...options,
  });
}
