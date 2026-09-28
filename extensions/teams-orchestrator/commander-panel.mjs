import { projectGoal, projectTask } from "../../task-runtime/commander-projection.mjs";
import { SubagentsRpcClient } from "../../task-runtime/capabilities.mjs";

const STRIP = /[\x00-\x1f\x7f\x1b]/g;
function safe(value, max = 180) {
  return String(value ?? "-").replace(STRIP, " ").slice(0, max);
}
function line(value, width) {
  return safe(value, 1024).slice(0, Math.max(1, width - 2));
}

// Pi's TUI delivers raw terminal bytes, including Kitty CSI-u when enabled.
// Match only the panel's unmodified navigation keys; pasted/modified input is ignored.
function pressed(data, key) {
  const raw = { escape: "\x1b", enter: "\r", down: "\x1b[B", up: "\x1b[A", pageDown: "\x1b[6~", pageUp: "\x1b[5~", space: " " };
  if (data === (raw[key] ?? key) || (key === "enter" && data === "\n")) return true;
  if ((key === "up" || key === "down") &&
      data === `\x1b[1;1${key === "up" ? "A" : "B"}`) return true;
  const match = /^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?u$/.exec(data);
  const cp = { escape: 27, enter: 13, space: 32, up: 57419, down: 57420,
    pageUp: 57421, pageDown: 57422 }[key] ?? key.charCodeAt(0);
  return !!match && Number(match[1]) === cp && Number(match[2] ?? 1) === 1 && Number(match[3] ?? 1) !== 3;
}

export function actionGuide(task) {
  if (!task?.executionId) return "Goal-X-only task: inspect /goal-status; no Task Pi action is available.";
  if (task.ownership !== "owned") return "Read-only: this L0 does not own the Task. Do not stop, repair, or re-dispatch it.";
  if (task.phase === "unobservable" || task.phase === "reconcile") return `Inspect team_task_reconcile with execution_id=${task.executionId} from the original owner. Unknown effects prohibit replay.`;
  if (task.alerts?.some((alert) => /Role failed|stopped/.test(alert))) return `Inspect Worker role evidence for ${task.executionId}; diagnose before bounded team_role_control repair. Do not replace siblings.`;
  if (task.alerts?.some((alert) => /Review blocked/.test(alert))) return `Read every bound review finding for ${task.executionId}; never seal a BLOCKED wave or accept the old candidate.`;
  if (task.phase === "roles") return "View the Worker pane and its /subagents-fleet. Wait for role completion AND process-terminal proof.";
  if (task.phase === "independent-review") return "Wait for native completion notification; collect the SAME review key/plan_digest once. Do not poll or relaunch.";
  if (task.phase === "candidate" || task.phase === "staged" || task.phase === "post-review") return `Next gate: ${task.next}. Use the existing L0 public tools; this panel never approves or applies.`;
  return `Next: ${task.next}. Completion requires AcceptanceReceipt and matching Goal-X readback.`;
}

export class CommanderPanel {
  constructor(tui, _theme, done, readBoard, readFleet = null) {
    this.tui = tui;
    this.done = done;
    this.readBoard = readBoard;
    this.readFleet = readFleet;
    this.fleet = { state: "unavailable", entries: [], omitted: 0 };
    this.fleetBusy = false;
    this.board = null;
    this.error = null;
    this.selected = 0;
    this.detail = false;
    this.detailOffset = 0;
    this.view = "tasks";
    this.refresh();
    void this.refreshFleet();
    this.timer = setInterval(() => this.refresh(), 1200);
    this.timer.unref?.();
    this.fleetTimer = setInterval(() => void this.refreshFleet(), 5000);
    this.fleetTimer.unref?.();
  }

  refresh() {
    try {
      this.board = this.readBoard();
      this.error = null;
      this.selected = Math.min(this.selected, Math.max(0, this.board.tasks.length - 1));
    } catch (error) {
      this.error = String(error.message ?? error).slice(0, 180);
    }
    this.tui.requestRender?.();
  }

  async refreshFleet() {
    if (!this.readFleet || this.fleetBusy) return;
    this.fleetBusy = true;
    try {
      const reply = await this.readFleet();
      if (reply?.fleet?.version !== 1 || !Array.isArray(reply.fleet.entries))
        throw new Error("public fleet projection unavailable");
      this.fleet = {
        state: "observed", entries: reply.fleet.entries.slice(0, 12),
        omitted: reply.fleet.omitted ?? 0,
      };
    } catch (error) {
      this.fleet = { state: "unavailable", entries: [], omitted: 0,
        reason: String(error.message ?? error).slice(0, 120) };
    } finally {
      this.fleetBusy = false;
      this.tui.requestRender?.();
    }
  }

  invalidate() {}
  dispose() { clearInterval(this.timer); clearInterval(this.fleetTimer); this.readFleet = null; }

  handleInput(data) {
    if (pressed(data, "escape") || pressed(data, "q") || data === "\x03") { this.done(); return; }
    if (["j", "k", "down", "up"].some((key) => pressed(data, key))) {
      const choices = (this.board?.tasks ?? []).map((task, index) => ({ task, index }))
        .filter(({ task }) => this.view !== "alerts" || task.alerts.length)
        .map(({ index }) => index);
      const position = Math.max(0, choices.indexOf(this.selected));
      const delta = pressed(data, "j") || pressed(data, "down") ? 1 : -1;
      this.selected = choices[Math.max(0, Math.min(choices.length - 1, position + delta))] ?? 0;
      this.detailOffset = 0;
    }
    else if (pressed(data, "pageDown") || pressed(data, "pageUp"))
      this.detailOffset = Math.max(0, this.detailOffset + (pressed(data, "pageDown") ? 4 : -4));
    else if (pressed(data, "enter") || pressed(data, "space")) { this.detail = !this.detail; this.detailOffset = 0; }
    else if (pressed(data, "r")) this.refresh();
    else if (pressed(data, "a")) {
      this.view = "alerts";
      this.detailOffset = 0;
      if (!this.board?.tasks[this.selected]?.alerts.length)
        this.selected = Math.max(0, this.board?.tasks.findIndex((task) => task.alerts.length) ?? 0);
    }
    else if (pressed(data, "t")) { this.view = "tasks"; this.detailOffset = 0; }
    else if (pressed(data, "h")) { this.view = "help"; this.detailOffset = 0; }
    else if (pressed(data, "w")) {
      const task = this.board?.tasks[this.selected];
      if (task?.paneId) this.done({ paneId: task.paneId });
      return;
    }
    this.tui.requestRender?.();
  }

  render(width) {
    const out = [
      line("AGENT TEAMS COMMANDER  |  live read-only inspection", width),
      line(`Goal ${this.board?.goalId ?? "?"}  Goal-X ${this.board?.goal.status ?? "unavailable"}  captured ${this.board?.capturedAt ?? "-"}`, width),
      line(`L0 native fleet ${this.fleet.state}: ${this.fleet.entries.map((entry) => safe(entry.agent ?? entry.role, 25)).join(", ") || this.fleet.reason || "none"}${this.fleet.omitted ? ` (+${this.fleet.omitted} omitted)` : ""}`, width),
      line("j/k select  Enter details  PgUp/Dn scroll  t tasks  a alerts  h help  w Worker workspace  r refresh  q/Esc close", width),
      line("-".repeat(Math.min(80, Math.max(1, width - 2))), width),
    ];
    if (this.error) out.push(line(`PROJECTION UNKNOWN: ${this.error}`, width));
    if (!this.board) return out;
    if (this.board.goal.reason) out.push(line(`Goal-X: ${this.board.goal.reason}`, width));
    const visible = this.board.tasks.map((task, index) => ({ task, index }))
      .filter(({ task }) => this.view !== "alerts" || task.alerts.length);
    if (visible.length === 0) out.push(this.board.tasks.length ? "No alerts in this Goal." : "No Task Pi execution in the focused Goal.");
    const maxLines = Math.max(9, Math.floor((this.tui.terminal?.rows ?? 32) * 0.8));
    const slots = Math.max(2, maxLines - out.length - 7);
    const selectedPos = Math.max(0, visible.findIndex(({ index }) => index === this.selected));
    const start = Math.max(0, Math.min(selectedPos - Math.floor(slots / 2), visible.length - slots));
    if (start > 0) out.push(line(`  ... ${start} preceding task(s)`, width));
    for (const { task, index } of visible.slice(start, start + slots)) {
      const selection = index === this.selected ? ">" : " ";
      out.push(line(`${selection} ${task.goalId ?? "?"}/${task.taskId}  ${task.phase}  ${task.state}  ${task.ownership}  ${task.alerts.length ? `!${task.alerts.length}` : ""}`, width));
    }
    if (start + slots < visible.length) out.push(line(`  ... ${visible.length - start - slots} following task(s)`, width));
    const task = this.board.tasks[this.selected];
    if (task && (this.view !== "alerts" || task.alerts.length)) {
      const details = [
        `  execution ${task.executionId ?? "none"}  revision ${task.revision ?? "-"}  pane ${task.paneId ?? "none"}`,
        `  next ${task.next}  evidence ${task.recentAt ?? "-"}`,
      ];
      if (this.detail || this.view === "help") {
        details.push(`  Goal commit ${task.goalCommitState ?? "unknown"}  reservation ${task.reservationOpen ?? "-"}  unresolved ${task.unresolvedRunCount ?? "-"}`);
        details.push(`  Task token ceiling ${task.taskTokenCeiling ?? "unavailable"}; actual usage requires native metering receipt`);
        for (const wave of task.waves) {
          details.push(`  wave ${wave.key} ${wave.status}${wave.terminal ? " [terminal]" : ""} run ${wave.runId ?? "pending"}`);
          for (const member of wave.members) details.push(`    ${member.key}: ${member.role} ${member.mode} ${member.status}`);
        }
        for (const review of task.reviews) details.push(`  review ${review.key}: ${review.status}${review.completionRef ? `  evidence ${review.completionRef}` : ""}`);
      }
      for (const alert of task.alerts) details.push(`  ! ${alert}`);
      if (this.view === "help") details.push(`  Guidance: ${actionGuide(task)}`);
      const remaining = Math.max(1, maxLines - out.length - 1);
      this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - remaining));
      if (this.detailOffset) out.push(line(`  ... ${this.detailOffset} preceding detail(s)`, width));
      out.push(...details.slice(this.detailOffset, this.detailOffset + remaining).map((item) => line(item, width)));
      if (details.length > this.detailOffset + remaining)
        out.push(line(`  ... ${details.length - this.detailOffset - remaining} more detail(s); PgDn to scroll`, width));
    }
    out.push(line("Pane IDs navigate workspaces, not completion proof. Inspect the Worker Fleet for leaf detail.", width));
    return out;
  }
}

export async function openCommander(ctx, orchestrator, projectId, sessionManager, events) {
  if (ctx.mode !== "tui" || !orchestrator || !projectId) {
    ctx.ui.notify("Commander needs an interactive L0 session with a Task Pi controller.", "warning");
    return;
  }
  const branch = sessionManager.getBranch();
  const focus = branch.findLast((row) => row.type === "custom" && row.customType === "pi-goal-focus");
  const goalId = focus?.data?.version === 1 ? focus.data.focusedGoalId : null;
  const readBoard = () => {
    const board = goalId ? projectGoal(orchestrator, {
      projectId, goalId, sourceRoot: ctx.cwd,
      ownerSessionId: sessionManager.getSessionId(),
    }) : { goalId: "unfocused", goal: { status: "unfocused", reason: "Other open project Tasks are shown below; focus a Goal-X goal for its full task list" }, tasks: [], capturedAt: new Date().toISOString() };
    const other = orchestrator.ledger.listProjectOpen(projectId)
      .filter((execution) => execution.goalId !== goalId);
    if (other.length > 256) throw new Error("Project open Task Pi inventory exceeds display bound");
    for (const execution of other) board.tasks.push({
      ...projectTask(orchestrator, execution),
      ownership: execution.ownerSessionId === sessionManager.getSessionId() ? "owned" : "read-only",
    });
    if (board.tasks.length > 256) throw new Error("Combined Task Pi inventory exceeds display bound");
    return board;
  };
  const readFleet = () => new SubagentsRpcClient(events).request("status", {}, 2000);
  const action = await ctx.ui.custom((tui, theme, _keybindings, done) => new CommanderPanel(tui, theme, done, readBoard, readFleet), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "95%", minWidth: 48, maxHeight: "85%", margin: 1 },
  });
  if (action?.paneId) {
    try {
      if (!orchestrator.herdr) throw new Error("Herdr is unavailable");
      const focused = orchestrator.herdr.focusWorkspaceForPane(action.paneId);
      ctx.ui.notify(`Focused Herdr workspace ${focused.workspaceId}; select pane ${focused.paneId} and open its /subagents-fleet for leaf details.`, "info");
    } catch (error) {
      ctx.ui.notify(`Workspace navigation failed: ${String(error.message ?? error).slice(0, 180)}`, "warning");
    }
  }
}
