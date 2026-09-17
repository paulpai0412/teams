#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectRunUsage, sessionUsage, sumUsage } from "./usage.mjs";

const [rootArg, parentSession, since] = process.argv.slice(2);
if (
  !rootArg ||
  (parentSession && (!since || !Number.isFinite(Date.parse(since))))
)
  throw new Error(
    "Usage: node report-runs.mjs EVIDENCE_ROOT [PARENT_SESSION SINCE_ISO]",
  );
const root = path.resolve(rootArg);
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const runs = [];
for (const directory of fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const runRoot = path.join(root, directory.name);
  const reportFile = ["report.json", "failure.json"]
    .map((name) => path.join(runRoot, name))
    .find((file) => fs.existsSync(file));
  if (!reportFile) continue;
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid run report: ${reportFile}`, { cause });
  }
  const auditFile = path.join(runRoot, "main-audit.json");
  let mainAudit = null;
  if (fs.existsSync(auditFile)) {
    try {
      mainAudit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
    } catch (cause) {
      throw new Error(`Invalid main audit: ${auditFile}`, { cause });
    }
  }
  const tokens = collectRunUsage(runRoot, path.join(agentDir, "sessions"));
  const preflightRejected =
    report.phases.every((phase) => phase.name !== "reserved") &&
    report.phases.some(
      (phase) => phase.capabilities?.backgroundHost?.compatible === false,
    );
  if (preflightRejected && !tokens.workers.length) {
    tokens.complete = true;
    tokens.completenessNote =
      "Host rejected before reservation or Worker launch; this attempt used zero model tokens.";
  }
  const tokensFile = path.join(runRoot, "metrics.json");
  fs.writeFileSync(tokensFile, `${JSON.stringify(tokens, null, 2)}\n`, {
    mode: 0o600,
  });
  runs.push({
    runId: report.runId,
    status: mainAudit?.decision ?? report.status,
    harnessStatus: report.status,
    mainAudit,
    elapsedMs: report.totalElapsedMs,
    preflightRejected,
    reportFile,
    tokensFile,
    tokensComplete: tokens.complete,
    knownTokens: tokens.knownTotals,
    unknownLaunches: tokens.unknownLaunches,
    toolErrors: tokens.workers.reduce(
      (sum, worker) => sum + worker.usage.toolErrors,
      0,
    ),
    anomalies: [...(report.anomalies ?? []), ...tokens.anomalies],
  });
}
const parent = parentSession
  ? sessionUsage(path.resolve(parentSession), { since })
  : null;
const knownRunTokens = sumUsage(runs.map((run) => run.knownTokens));
const result = {
  schemaVersion: "teams-task-pi-e2e-summary/1",
  observedAt: new Date().toISOString(),
  fullE2EPassed: runs.some(
    (run) =>
      run.mainAudit?.decision === "accepted" &&
      run.mainAudit?.fullE2EPassed === true,
  ),
  scope:
    "Recorded attempts plus optional parent usage since the original request. In-flight/unreported/compacted-away usage may be missing; known totals are a lower bound, not a bill. Harness success is separate from main audit and live Goal-X readback.",
  runElapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
  requestWallClockMs: since ? Date.now() - Date.parse(since) : null,
  parent,
  knownRunTokens,
  knownCombinedTokens: sumUsage([knownRunTokens, ...(parent ? [parent] : [])]),
  runs,
};
const output = path.join(root, "summary.json");
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      output,
      knownRunTokens,
      parentTokens: parent?.total,
      knownCombinedTokens: result.knownCombinedTokens,
      runs: runs.map(
        ({
          runId,
          elapsedMs,
          knownTokens,
          unknownLaunches,
          preflightRejected,
        }) => ({
          runId,
          elapsedMs,
          tokens: knownTokens.total,
          unknownLaunches,
          preflightRejected,
        }),
      ),
    },
    null,
    2,
  ),
);
