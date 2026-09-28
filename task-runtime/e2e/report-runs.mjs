#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectRunUsage, sessionUsage, sumUsage } from "./usage.mjs";
import { auditRpcAttempt } from "./audit-rpc-attempt.mjs";
import { readEvidenceBytes } from "../../host-evidence.mjs";

function readJsonEvidence(file) {
  try {
    return JSON.parse(
      readEvidenceBytes(file, 8 * 1024 * 1024).toString("utf8"),
    );
  } catch (cause) {
    throw new Error(`Invalid run evidence: ${file}`, { cause });
  }
}

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
  const rpcFile = path.join(runRoot, "live", "rpc-observation.json");
  assert.ok(
    !reportFile || !fs.existsSync(rpcFile),
    "ambiguous legacy and native reports in one run",
  );
  if (!reportFile && !fs.existsSync(rpcFile)) continue;
  if (!reportFile) {
    const report = readJsonEvidence(rpcFile);
    const auditFile = path.join(runRoot, "main-audit.json");
    const mainAudit = fs.existsSync(auditFile)
      ? readJsonEvidence(auditFile)
      : null;
    if (mainAudit) {
      assert.equal(mainAudit.schemaVersion, "teams-e2e-main-audit/1");
      assert.deepEqual(
        mainAudit,
        auditRpcAttempt(rpcFile, mainAudit.runtimeRoot),
        "native audit no longer matches the exact post-run evidence",
      );
    }
    const complete =
      Number.isSafeInteger(report.rootUsage?.total) &&
      report.taskUsage?.status === "measured" &&
      Number.isSafeInteger(report.taskUsage.totals?.total);
    const tokens = {
      knownTotals: sumUsage([
        report.rootUsage ?? {},
        report.taskUsage?.totals ?? {},
      ]),
      complete,
      completenessNote: complete
        ? "Observer root plus reconciled native closed usage; campaign parent/history are separate"
        : "Native root or Task usage unknown: known totals are a lower bound",
      unknownLaunches: complete ? [] : (report.executionIds ?? []),
      anomalies: complete ? [] : [{ kind: "incomplete-native-usage" }],
    };
    const tokensFile = path.join(runRoot, "metrics.json");
    fs.writeFileSync(tokensFile, `${JSON.stringify(tokens, null, 2)}\n`, {
      mode: 0o600,
    });
    runs.push({
      runId: directory.name,
      status: mainAudit?.decision ?? "not-assessed",
      harnessStatus: report.status,
      mainAudit,
      elapsedMs: report.elapsedMs,
      preflightRejected: false,
      reportFile: rpcFile,
      tokensFile,
      tokensComplete: complete,
      knownTokens: tokens.knownTotals,
      unknownLaunches: tokens.unknownLaunches,
      toolErrors: report.faults?.length ?? 0,
      anomalies: tokens.anomalies,
    });
    continue;
  }
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
