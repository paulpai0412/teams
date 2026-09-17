import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const keys = ["input", "output", "cacheRead", "cacheWrite", "total"];
const zero = () => Object.fromEntries(keys.map((key) => [key, 0]));

export function sumUsage(rows) {
  return rows.reduce((sum, row) => {
    for (const key of keys) sum[key] += row[key] ?? 0;
    return sum;
  }, zero());
}

function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

export function sessionUsage(file, options = {}) {
  return sessionUsageBytes(
    file && fs.existsSync(file) ? fs.readFileSync(file) : null,
    { ...options, file },
  );
}

// Parse the exact bounded snapshot already read by a host consumer, not a second
// read of a growing session file. The legacy file-based reporting API stays intact.
export function sessionUsageBytes(
  bytes,
  { file = null, since = null, strict = false } = {},
) {
  const result = {
    ...zero(),
    available: false,
    file,
    since,
    messages: 0,
    toolErrors: 0,
    malformedLines: 0,
    missingUsage: 0,
  };
  if (bytes === null) return result;
  if (!Buffer.isBuffer(bytes))
    throw new TypeError("session bytes must be a Buffer");
  const seen = new Map();
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      result.malformedLines++;
      continue;
    }
    const summary =
      strict && ["compaction", "branch_summary"].includes(entry.type);
    if (entry.type !== "message" && !summary) continue;
    if (
      since &&
      (!entry.timestamp || Date.parse(entry.timestamp) < Date.parse(since))
    )
      continue;
    if (entry.id && seen.has(entry.id)) {
      if (strict && seen.get(entry.id) !== line) result.malformedLines++;
      continue;
    }
    if (entry.id) seen.set(entry.id, strict ? line : true);
    const message = entry.message;
    if (message?.role === "toolResult" && message.isError) result.toolErrors++;
    const assistant = message?.role === "assistant";
    const nested =
      strict && message?.role === "toolResult" && message.usage !== undefined;
    if (!assistant && !summary && !nested) continue;
    if (assistant) result.messages++;
    if (strict && (typeof entry.id !== "string" || !entry.id)) {
      result.missingUsage++;
      continue;
    }
    const usage = summary ? entry.usage : message.usage;
    const parts = ["input", "output", "cacheRead", "cacheWrite"];
    const invalidStrictUsage =
      strict &&
      usage &&
      (parts.some(
        (key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0,
      ) ||
        !Number.isSafeInteger(
          result.total + parts.reduce((sum, key) => sum + usage[key], 0),
        ) ||
        (usage.totalTokens !== undefined &&
          usage.totalTokens !==
            parts.reduce((sum, key) => sum + usage[key], 0)));
    if (!usage || invalidStrictUsage) {
      result.missingUsage++;
      continue;
    }
    for (const key of keys.filter((key) => key !== "total"))
      result[key] += usage[key] ?? 0;
    result.total +=
      usage.totalTokens ??
      (usage.input ?? 0) +
        (usage.output ?? 0) +
        (usage.cacheRead ?? 0) +
        (usage.cacheWrite ?? 0);
  }
  return {
    ...result,
    available: true,
    sourceBytes: bytes.length,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// Recorded consumption, not a budget or proof that a process has stopped.
export function collectRunUsage(runRoot, sessionsRoot) {
  const runtimeFiles = files(path.join(runRoot, "runtime"));
  const anomalies = [];
  function json(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      anomalies.push({ kind: "invalid-metrics-input", file });
      return null;
    }
  }
  const boots = runtimeFiles
    .filter((file) => file.endsWith("/receipts/boot.json"))
    .map(json)
    .filter(Boolean);
  const sessionFiles = files(sessionsRoot).filter((file) =>
    file.endsWith(".jsonl"),
  );
  const workerIds = [...new Set(boots.map((boot) => boot.workerSessionId))];
  const workers = workerIds.map((sessionId) => ({
    sessionId,
    usage: sessionUsage(
      sessionFiles.find((file) =>
        path.basename(file).endsWith(`_${sessionId}.jsonl`),
      ) ?? null,
    ),
  }));
  const progress = runtimeFiles
    .filter((file) => /\/receipts\/progress-[^/]+\.json$/.test(file))
    .map(json)
    .filter(Boolean);
  const intents = progress.filter(
    (item) =>
      item.kind === "role-wave-launch-intent" ||
      (item.kind === "role-launch-intent" && !item.rootLaunchId),
  );
  const roles = [
    ...new Map(
      progress
        .filter((item) => item.kind === "role-started")
        .map((item) => [item.runId, item]),
    ).values(),
  ];
  const usedFiles = new Set(
    workers.flatMap((worker) =>
      worker.usage.file ? [fs.realpathSync(worker.usage.file)] : [],
    ),
  );
  const leaves = roles.map((role) => {
    const statusRef = role.asyncDir
      ? path.join(role.asyncDir, "status.json")
      : null;
    const status =
      statusRef && fs.existsSync(statusRef) ? json(statusRef) : null;
    const matching = status?.runId === role.runId;
    const candidates = matching
      ? (status.steps ?? []).flatMap((step) =>
          typeof step.sessionFile === "string" ? [step.sessionFile] : [],
        )
      : [];
    const native = matching
      ? {
          statusRef,
          runId: status.runId,
          state: status.state,
          usageBudget: status.usageBudget ?? null,
          steps: (status.steps ?? []).map((step) => ({
            model: step.model ?? null,
            durationMs: step.durationMs ?? null,
            acceptanceStatus: step.acceptance?.status ?? null,
            evidenceStatus: step.acceptance?.evidenceStatus ?? null,
            reviewRequired:
              step.acceptance?.effectiveAcceptance?.review?.required ?? false,
          })),
        }
      : null;
    if (status?.usageBudget?.exhausted)
      anomalies.push({
        kind: "native-budget-exhausted",
        runId: role.runId,
        budget: status.usageBudget,
      });
    const sessions = [];
    for (const candidate of candidates) {
      if (
        !path.isAbsolute(candidate) ||
        !candidate.endsWith(".jsonl") ||
        !fs.existsSync(candidate)
      ) {
        anomalies.push({ kind: "leaf-session-unavailable", runId: role.runId });
        continue;
      }
      const file = fs.realpathSync(candidate);
      const roots = [sessionsRoot, role.asyncDir]
        .filter(Boolean)
        .map((root) => fs.realpathSync(root) + path.sep);
      if (!roots.some((root) => file.startsWith(root))) {
        anomalies.push({
          kind: "leaf-session-outside-roots",
          runId: role.runId,
        });
        continue;
      }
      if (usedFiles.has(file)) continue;
      usedFiles.add(file);
      sessions.push(sessionUsage(file));
    }
    const expectedSessions = role.members?.length ?? null;
    if (expectedSessions !== null && sessions.length !== expectedSessions)
      anomalies.push({
        kind: "wave-session-count-mismatch",
        runId: role.runId,
        expectedSessions,
        found: sessions.length,
      });
    return {
      runId: role.runId,
      asyncDir: role.asyncDir,
      native,
      sessions,
      expectedSessions,
    };
  });
  const rows = [
    ...workers.map((worker) => worker.usage),
    ...leaves.flatMap((leaf) => leaf.sessions),
  ];
  const unknownLaunches = Math.max(0, intents.length - roles.length);
  const complete =
    boots.length > 0 &&
    rows.every(
      (row) => row.available && !row.malformedLines && !row.missingUsage,
    ) &&
    leaves.every(
      (leaf) =>
        leaf.sessions.length &&
        (leaf.expectedSessions === null ||
          leaf.sessions.length === leaf.expectedSessions),
    ) &&
    unknownLaunches === 0;
  return {
    observedAt: new Date().toISOString(),
    scope:
      "Recorded Worker and leaf assistant usage; deterministic host uses no model. Parent orchestration is separate. Cache tokens included; not unique tokens or a billing estimate.",
    complete,
    completenessNote:
      "Snapshot only; unknown launches or missing sessions are not zero usage. Does not prove process termination.",
    workers,
    leaves,
    unknownLaunches,
    knownTotals: sumUsage(rows),
    anomalies,
  };
}
