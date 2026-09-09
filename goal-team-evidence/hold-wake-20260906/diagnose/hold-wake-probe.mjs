import fs from "node:fs";
import path from "node:path";
import { createJiti } from "/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-tui":
      "/home/timmypai/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
  },
});
const { GoalRuntime } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-runtime.ts",
);
const { registerGoalEvents } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-events.ts",
);
const { default: registerSubagentNotify } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/notify.ts",
);
const { registerSubagentRpcBridge } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/extension/rpc.ts",
);
const { listAsyncRuns } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/async-status.ts",
);
const { updateActiveRunIndex } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/active-run-index.ts",
);
const { createResultWatcher } = await jiti.import(
  "/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/result-watcher.ts",
);

const out = { env: { node: process.version, cwd: process.cwd() }, cases: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Bus {
  handlers = new Map();
  on(name, handler) {
    const a = this.handlers.get(name) ?? [];
    a.push(handler);
    this.handlers.set(name, a);
    return () =>
      this.handlers.set(
        name,
        a.filter((x) => x !== handler),
      );
  }
  emit(name, payload) {
    for (const handler of this.handlers.get(name) ?? []) handler(payload);
  }
  names() {
    return [...this.handlers.keys()];
  }
}
const bus = new Bus();
const sent = [];
const pi = {
  events: bus,
  on(name, handler) {
    return bus.on(`pi:${name}`, handler);
  },
  sendMessage(message, opts) {
    sent.push({ message, opts });
  },
};

// Real GoalRuntime continuation seam, with only host idleness mocked.
const followUps = [];
const goal = {
  id: "goal-probe",
  status: "active",
  autoContinue: true,
  revision: 7,
  usage: { tokensUsed: 0, activeSeconds: 0 },
};
const runtime = new GoalRuntime({
  sendFollowUp: (content, details) =>
    followUps.push({ at: Date.now(), content, details }),
  getGoal: () => goal,
  isActionable: (id) =>
    id === goal.id && goal.status === "active" && goal.autoContinue,
});
const ctx = { isIdle: () => true, hasPendingMessages: () => false };
const continuationStart = Date.now();
runtime.queueContinuation(ctx, goal, true);
await sleep(25);
out.cases.push({
  id: "C1-continuation",
  seam: "real installed pi-goal-x GoalRuntime.queueContinuation/sendQueuedContinuation; mocked ExtensionContext idle state",
  elapsedMs: Date.now() - continuationStart,
  followUpCount: followUps.length,
  followUps,
  expected:
    "bound active child should hold auto continuation; current runtime has no child binding input",
  observed:
    followUps.length === 1
      ? "empty-goal guard absent: checkpoint follow-up emitted while simulated child is active"
      : `unexpected count ${followUps.length}`,
});

// Real goal-events registration proves the native completion event is not subscribed.
const core = { pi };
registerGoalEvents(core);
const registeredLifecycleEvents = bus
  .names()
  .filter((n) => n.startsWith("pi:"))
  .map((n) => n.slice(3));
const beforeNativeEmit = sent.length;
bus.emit("subagent:async-complete", {
  id: "run-probe",
  runId: "run-probe",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: true,
  state: "complete",
  sessionId: "session-main",
  completionOwnerId: "owner-main",
  triggerTurn: true,
});
out.cases.push({
  id: "goal-native-event-subscription",
  seam: "real installed pi-goal-x registerGoalEvents; event bus payload is a native completion-shaped payload",
  registeredLifecycleEvents,
  includesNativeAsyncComplete: registeredLifecycleEvents.includes(
    "subagent:async-complete",
  ),
  sentMessagesAfterBareNativeEvent: sent.length - beforeNativeEmit,
  observed:
    "goal-events registers Pi lifecycle hooks only; bare subagent:async-complete has no Goal handler",
});

// Real notifier integration on same process-local bus; dispatch is native event-shaped.
const notify = registerSubagentNotify(
  pi,
  { currentSessionId: "session-main", completionOwnerId: "owner-main" },
  { batchConfig: { enabled: false } },
);
bus.emit("subagent:async-complete", {
  id: "run-notify",
  runId: "run-notify",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: true,
  state: "complete",
  summary: "native success",
  sessionId: "session-main",
  completionOwnerId: "owner-main",
  triggerTurn: true,
  timestamp: Date.now(),
});
await sleep(10);
const afterSuccess = sent.length;
bus.emit("subagent:async-complete", {
  id: "run-notify",
  runId: "run-notify",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: true,
  state: "complete",
  summary: "native success duplicate",
  sessionId: "session-main",
  completionOwnerId: "owner-main",
  triggerTurn: true,
  timestamp: Date.now(),
});
bus.emit("subagent:async-complete", {
  id: "run-fail",
  runId: "run-fail",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: false,
  state: "failed",
  summary: "native failure",
  sessionId: "session-main",
  completionOwnerId: "owner-main",
  triggerTurn: true,
  timestamp: Date.now(),
});
await sleep(10);
bus.emit("subagent:async-complete", {
  id: "run-foreign",
  runId: "run-foreign",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: true,
  state: "complete",
  summary: "foreign owner",
  sessionId: "session-main",
  completionOwnerId: "owner-foreign",
  triggerTurn: true,
  timestamp: Date.now(),
});
bus.emit("subagent:async-complete", {
  id: "run-foreign-session",
  runId: "run-foreign-session",
  source: "async",
  mode: "workflow",
  agent: "workflow",
  success: true,
  state: "complete",
  summary: "foreign session",
  sessionId: "session-foreign",
  completionOwnerId: "owner-main",
  triggerTurn: true,
  timestamp: Date.now(),
});
await sleep(10);
out.cases.push({
  id: "native-notification-delivery",
  seam: "real installed pi-subagents registerSubagentNotify on the same process-local event bus; sendMessage mocked",
  successAndFailureMessages: sent
    .slice(afterSuccess)
    .map((x) => ({
      content: x.message.content,
      triggerTurn: x.opts?.triggerTurn,
      display: x.message.display,
    })),
  totalMessages: sent.length,
  duplicateDelta: sent.length - afterSuccess - 1,
  rejectedForeignMessageCount: sent.filter((x) =>
    String(x.message.content).includes("foreign"),
  ).length,
  observed:
    "success and failure notifications are accepted by notifier; duplicate success is deduped; this does not invoke Goal reconciliation because Goal has no listener",
});
// Real result-file watcher -> notifier -> native completion event, on disposable results.
const watcherRoot =
  "/home/timmypai/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/diagnose/result-probe";
fs.rmSync(watcherRoot, { recursive: true, force: true });
fs.mkdirSync(watcherRoot, { recursive: true });
const watcherState = {
  currentSessionId: "session-main",
  completionOwnerId: "owner-main",
  completionSeen: new Map(),
  asyncJobs: new Map([
    ["run-file", { asyncId: "run-file", status: "complete" }],
  ]),
  resultFileCoalescer: { schedule: () => false, clear: () => {} },
  watcher: null,
  watcherRestartTimer: null,
};
const watcherEvents = new Bus();
const watcherPi = { events: watcherEvents };
const watcherNotices = [];
const watcherNotifier = {
  deliver: async (data) => {
    watcherNotices.push(data);
    return true;
  },
};
const watcher = createResultWatcher(
  watcherPi,
  watcherState,
  watcherRoot,
  600000,
  {
    notifier: watcherNotifier,
    deliverIntercomResults: false,
    coalesceDelayMs: 1,
    resultScanLogging: "off",
  },
);
const nativeSeen = [];
watcherEvents.on("subagent:async-complete", (data) => nativeSeen.push(data));
fs.writeFileSync(
  path.join(watcherRoot, "run-file.json"),
  JSON.stringify({
    id: "run-file",
    runId: "run-file",
    source: "async",
    mode: "workflow",
    agent: "workflow",
    success: true,
    state: "complete",
    summary: "file-native completion",
    sessionId: "session-main",
    completionOwnerId: "owner-main",
    timestamp: Date.now(),
  }),
);
watcher.primeExistingResults();
await sleep(80);
const watcherRemaining = fs.readdirSync(watcherRoot);
out.cases.push({
  id: "C2-result-watcher-native-order",
  seam: "real installed createResultWatcher on disposable result file; notifier mocked only to acknowledge delivery",
  notifierCount: watcherNotices.length,
  nativeEventCount: nativeSeen.length,
  nativeEventRunId: nativeSeen[0]?.runId,
  resultFilesAfterProcessing: watcherRemaining,
  observed:
    "result watcher invokes notifier before emitting subagent:async-complete; acknowledged result file is removed, while Goal remains uninvolved",
});
watcher.stopResultWatcher();
fs.rmSync(watcherRoot, { recursive: true, force: true });
notify.dispose();

// Real RPC bridge, in-memory public status projection, no worker and no filesystem mutation.
const rpcReplies = [];
const rpcEvents = new Bus();
const rpcPi = { events: rpcEvents, sendMessage() {} };
const rpcCtx = {
  cwd: "/tmp/hold-wake-probe",
  sessionManager: {
    getSessionFile: () => "session-main",
    getSessionId: () => "session-main",
  },
};
const rpcState = {
  currentSessionId: "session-main",
  statusProjectionSessionId: "session-main",
  completionOwnerId: "owner-main",
  foregroundControls: new Map(),
  asyncJobs: new Map([
    [
      "run-rpc",
      {
        asyncId: "run-rpc",
        asyncDir: "/tmp/hold-wake-probe/run-rpc",
        status: "running",
        sessionId: "session-main",
        mode: "single",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        agents: ["worker"],
      },
    ],
  ]),
};
rpcEvents.on("subagents:rpc:v1:reply:req-status", (x) => rpcReplies.push(x));
const rpcBridge = registerSubagentRpcBridge({
  events: rpcEvents,
  getContext: () => rpcCtx,
  execute: async () => ({
    content: [{ type: "text", text: "unexpected executor path" }],
    details: { mode: "management", results: [] },
  }),
  state: rpcState,
});
rpcEvents.emit("subagents:rpc:v1:request", {
  version: 1,
  requestId: "req-status",
  method: "status",
  params: {},
});
await sleep(10);
out.cases.push({
  id: "public-rpc-status",
  seam: "real installed pi-subagents registerSubagentRpcBridge; in-memory state projection (no worker)",
  reply: rpcReplies[0],
  authoritativeIdentity: {
    sessionId: rpcState.currentSessionId,
    completionOwnerId: rpcState.completionOwnerId,
    runId: "run-rpc",
    state: rpcState.asyncJobs.get("run-rpc").status,
  },
  observed:
    "untargeted public status exposes current-session active run projection; caller must match session/run identities",
});
rpcBridge.dispose();

// Real status reader against disposable synthetic artifacts, proving marker/status distinction.
const root =
  "/home/timmypai/.pi/agent/teams/goal-team-evidence/hold-wake-20260906/diagnose/status-probe";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "run-status"), { recursive: true });
const statusBase = {
  lifecycleArtifactVersion: 3,
  runId: "run-status",
  completionOwnerId: "owner-main",
  sessionId: "session-main",
  mode: "workflow",
  state: "running",
  startedAt: Date.now(),
  lastUpdate: Date.now(),
  cwd: root,
  steps: [],
};
fs.writeFileSync(
  path.join(root, "run-status", "status.json"),
  JSON.stringify(statusBase),
);
updateActiveRunIndex(path.join(root, "run-status"), "running");
const running = listAsyncRuns(root, {
  states: ["running"],
  sessionId: "session-main",
  reconcile: false,
});
fs.writeFileSync(
  path.join(root, "run-status", "status.json"),
  JSON.stringify({ ...statusBase, state: "complete", endedAt: Date.now() }),
);
const completedWithoutProof = listAsyncRuns(root, {
  states: ["complete"],
  sessionId: "session-main",
  reconcile: false,
});
const completedWithReconcile = listAsyncRuns(root, {
  states: ["complete"],
  sessionId: "session-main",
  reconcile: true,
});
out.cases.push({
  id: "status-marker-process-proof",
  seam: "real installed pi-subagents listAsyncRuns/status reader on disposable synthetic status + active marker",
  running,
  completedWithoutProof,
  completedWithReconcile,
  markerFilesAfterTerminal: fs
    .readdirSync(root)
    .filter((x) => x.includes("active") || x.startsWith(".")),
  observed:
    "a terminal-looking status write alone does not yield a completed listing while the active marker remains; normal reconcile does not invent process-terminal proof",
});
fs.rmSync(root, { recursive: true, force: true });

console.log(JSON.stringify(out, null, 2));
