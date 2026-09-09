import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "./goal-record.ts";

export const GOAL_TEAM_HOLD_BINDING = "pi-goal-x.team-hold/1";
export const GOAL_TEAM_HOLD_ENTRY = "pi-goal-team-hold";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

const STATUS_MAX_BYTES = 512 * 1024;
const ACTIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "partial", "paused", "stopped", "rejected"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface GoalTeamRunCandidate {
	version: 1;
	goalId: string;
	taskId: string;
	sessionId: string;
	cwd: string;
	toolCallId: string;
	runId: string;
	asyncDir: string;
}

export interface GoalTeamRunBinding extends GoalTeamRunCandidate {
	completionOwnerId: string;
}

export interface GoalTeamRunObservation {
	kind: "active" | "terminal" | "unknown";
	state?: string;
	completionOwnerId?: string;
	runId?: string;
	sessionId?: string;
	cwd?: string;
	toolCallId?: string;
}

interface GoalTeamHoldEntry {
	version: 1;
	state: "bound" | "released";
	binding: GoalTeamRunBinding;
	reason?: string;
	at: number;
}

interface GoalTeamHoldDeps {
	sessionId(): string | null;
	cwd(): string;
	goal(): GoalRecord | null;
	append(entry: GoalTeamHoldEntry): void;
	readStatus(candidate: GoalTeamRunCandidate): Promise<GoalTeamRunObservation>;
	recoverStatus?(binding: GoalTeamRunBinding): Promise<GoalTeamRunObservation>;
	helperPath?: string;
}

interface PendingGoalTeamRun {
	version: 1;
	goalId: string;
	taskId: string;
	sessionId: string;
	cwd: string;
	toolCallId: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function sameBinding(left: GoalTeamRunBinding, right: GoalTeamRunBinding): boolean {
	return left.goalId === right.goalId
		&& left.taskId === right.taskId
		&& left.sessionId === right.sessionId
		&& left.cwd === right.cwd
		&& left.toolCallId === right.toolCallId
		&& left.runId === right.runId
		&& left.asyncDir === right.asyncDir
		&& left.completionOwnerId === right.completionOwnerId;
}

function normalizeBinding(value: unknown): GoalTeamRunBinding | null {
	const input = record(value);
	if (!input || input.version !== 1) return null;
	for (const field of ["goalId", "taskId", "sessionId", "cwd", "toolCallId", "runId", "asyncDir", "completionOwnerId"] as const) {
		if (!text(input[field])) return null;
	}
	if (!isAbsolute(input.cwd as string) || !isAbsolute(input.asyncDir as string)) return null;
	if (!ID_PATTERN.test(input.runId as string)) return null;
	return {
		version: 1,
		goalId: input.goalId as string,
		taskId: input.taskId as string,
		sessionId: input.sessionId as string,
		cwd: input.cwd as string,
		toolCallId: input.toolCallId as string,
		runId: input.runId as string,
		asyncDir: resolve(input.asyncDir as string),
		completionOwnerId: input.completionOwnerId as string,
	};
}

function normalizeEntry(value: unknown): GoalTeamHoldEntry | null {
	const outer = record(value);
	const input = outer?.customType === GOAL_TEAM_HOLD_ENTRY ? record(outer.data) : outer;
	if (!input || input.version !== 1 || (input.state !== "bound" && input.state !== "released")) return null;
	const binding = normalizeBinding(input.binding);
	if (!binding || typeof input.at !== "number" || !Number.isFinite(input.at)) return null;
	return {
		version: 1,
		state: input.state,
		binding,
		...(text(input.reason, 256) ? { reason: input.reason } : {}),
		at: input.at,
	};
}

function currentMatches(
	binding: Pick<GoalTeamRunBinding, "goalId" | "taskId" | "sessionId" | "cwd">,
	goal: GoalRecord | null,
	sessionId: string | null,
	cwd: string,
): boolean {
	return Boolean(
		goal
		&& goal.status === "active"
		&& goal.autoContinue
		&& text(goal.currentTaskId)
		&& binding.goalId === goal.id
		&& binding.taskId === goal.currentTaskId
		&& binding.sessionId === sessionId
		&& binding.cwd === cwd,
	);
}

function defaultAsyncRoot(): string {
	const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (configured) return join(resolve(configured), "async-subagent-runs");
	let scope: string;
	if (typeof process.getuid === "function") scope = `uid-${process.getuid()}`;
	else {
		const raw = process.env.USERNAME || process.env.USER || process.env.LOGNAME || "unknown";
		const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
		scope = `user-${safe}`;
	}
	return join(tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs");
}

function confinedAsyncDir(asyncDir: string, runId: string): string | null {
	if (!isAbsolute(asyncDir) || !ID_PATTERN.test(runId)) return null;
	const resolvedDir = resolve(asyncDir);
	const root = resolve(defaultAsyncRoot());
	const rel = relative(root, resolvedDir);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) return null;
	if (basename(resolvedDir) !== runId || basename(dirname(resolvedDir)) !== "async-subagent-runs") return null;
	return resolvedDir;
}

/** Read only the native bounded status file and validate its complete owner identity. */
export async function inspectGoalTeamRunStatus(candidate: GoalTeamRunCandidate): Promise<GoalTeamRunObservation> {
	const asyncDir = confinedAsyncDir(candidate.asyncDir, candidate.runId);
	if (!asyncDir) return { kind: "unknown" };
	const statusPath = join(asyncDir, "status.json");
	try {
		const dirStat = lstatSync(asyncDir);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { kind: "unknown" };
		const fd = openSync(statusPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let raw: string;
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size < 2 || stat.size > STATUS_MAX_BYTES) return { kind: "unknown" };
			raw = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
		const input = record(JSON.parse(raw));
		if (!input
			|| input.runId !== candidate.runId
			|| input.sessionId !== candidate.sessionId
			|| input.cwd !== candidate.cwd
			|| input.toolCallId !== candidate.toolCallId
			|| !text(input.completionOwnerId)) return { kind: "unknown" };
		if (!text(input.state, 32)) return { kind: "unknown" };
		const identity = {
			state: input.state,
			completionOwnerId: input.completionOwnerId,
			runId: candidate.runId,
			sessionId: candidate.sessionId,
			cwd: candidate.cwd,
			toolCallId: candidate.toolCallId,
		};
		if (ACTIVE_STATES.has(input.state)) return { kind: "active", ...identity };
		if (TERMINAL_STATES.has(input.state)) return { kind: "terminal", ...identity };
		return { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

interface EventBus {
	on(name: string, handler: (data: unknown) => void): (() => void) | void;
	emit(name: string, data: unknown): void;
}

/** One targeted public pi-subagents RPC status request, followed by exact status-file validation. */
export async function recoverGoalTeamRunStatus(events: EventBus, binding: GoalTeamRunBinding): Promise<GoalTeamRunObservation> {
	const requestId = randomUUID();
	const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
	const reply = await new Promise<Record<string, unknown> | null>((resolveReply) => {
		let settled = false;
		let unsubscribe: (() => void) | void;
		const finish = (value: Record<string, unknown> | null) => {
			if (settled) return;
			settled = true;
			if (unsubscribe) unsubscribe();
			clearTimeout(timer);
			resolveReply(value);
		};
		unsubscribe = events.on(replyEvent, (value) => finish(record(value)));
		const timer = setTimeout(() => finish(null), 1000);
		timer.unref?.();
		try {
			events.emit("subagents:rpc:v1:request", {
				version: 1,
				requestId,
				method: "status",
				params: { id: binding.runId },
			});
		} catch {
			finish(null);
		}
	});
	if (!reply || reply.version !== 1 || reply.requestId !== requestId || reply.success !== true) return { kind: "unknown" };
	const data = record(reply.data);
	const snapshot = record(data?.asyncSnapshot);
	if (snapshot?.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) {
		return { kind: "unknown" };
	}
	const row = snapshot.runs.map(record).find((item) => item?.id === binding.runId);
	if (!row || !text(row.state, 32)) return { kind: "unknown" };
	if (TERMINAL_STATES.has(row.state)) return { kind: "terminal", state: row.state };
	if (!ACTIVE_STATES.has(row.state)) return { kind: "unknown" };
	const observed = await inspectGoalTeamRunStatus(binding);
	return observed.kind === "active" && observed.completionOwnerId === binding.completionOwnerId
		? observed
		: { kind: "unknown" };
}

/** Exact, Goal-owned hold state. It suppresses checkpoints; it never launches or wakes work. */
export class GoalTeamHold {
	private pending: PendingGoalTeamRun | null = null;
	private binding: GoalTeamRunBinding | null = null;
	private readonly deps: GoalTeamHoldDeps;

	constructor(deps: GoalTeamHoldDeps) {
		this.deps = deps;
	}

	beginToolCall(event: unknown): boolean {
		const input = record(event);
		if (!input || input.toolName !== "subagent" || !text(input.toolCallId)) return false;
		const args = record(input.input) ?? record(input.args);
		if (!args || args.action !== undefined || args.async !== true) return false;
		if (this.deps.helperPath) {
			if (!text(args.workflowScriptPath) || resolve(args.workflowScriptPath) !== resolve(this.deps.helperPath)) return false;
		}
		const namespaces = record(args.extensionBindings);
		const requested = record(namespaces?.[GOAL_TEAM_HOLD_BINDING]);
		if (!requested || !text(requested.goalId) || !text(requested.taskId) || !text(requested.cwd) || !isAbsolute(requested.cwd)) return false;
		const sessionId = this.deps.sessionId();
		const cwd = this.deps.cwd();
		if (!text(sessionId) || (requested.sessionId !== undefined && requested.sessionId !== sessionId)) return false;
		const proposed = {
			goalId: requested.goalId,
			taskId: requested.taskId,
			sessionId,
			cwd: requested.cwd,
		};
		if (!currentMatches(proposed, this.deps.goal(), sessionId, cwd)) return false;
		if (this.binding || this.pending) return false;
		this.pending = { version: 1, ...proposed, toolCallId: input.toolCallId };
		return true;
	}

	async completeToolResult(event: unknown): Promise<boolean> {
		const input = record(event);
		const pending = this.pending;
		if (!input || !pending || input.toolName !== "subagent" || input.toolCallId !== pending.toolCallId) return false;
		this.pending = null;
		if (input.isError === true) return false;
		const output = record(input.details) ?? record(input.output);
		if (!output || !text(output.runId) || !text(output.asyncId) || output.runId !== output.asyncId
			|| !text(output.asyncDir) || (output.toolCallId !== undefined && output.toolCallId !== pending.toolCallId)) return false;
		const candidate: GoalTeamRunCandidate = {
			version: 1,
			goalId: pending.goalId,
			taskId: pending.taskId,
			sessionId: pending.sessionId,
			cwd: pending.cwd,
			toolCallId: pending.toolCallId,
			runId: output.runId,
			asyncDir: resolve(output.asyncDir),
		};
		if (!currentMatches(candidate, this.deps.goal(), this.deps.sessionId(), this.deps.cwd())) return false;
		const observed = await this.deps.readStatus(candidate);
		if (observed.kind !== "active" || !text(observed.completionOwnerId)
			|| (observed.runId !== undefined && observed.runId !== candidate.runId)
			|| (observed.sessionId !== undefined && observed.sessionId !== candidate.sessionId)
			|| (observed.cwd !== undefined && observed.cwd !== candidate.cwd)
			|| (observed.toolCallId !== undefined && observed.toolCallId !== candidate.toolCallId)) return false;
		const binding: GoalTeamRunBinding = { ...candidate, completionOwnerId: observed.completionOwnerId };
		try {
			this.deps.append({ version: 1, state: "bound", binding, at: Date.now() });
		} catch {
			return false;
		}
		this.binding = binding;
		return true;
	}

	async onNativeCompletion(event: unknown): Promise<boolean> {
		const input = record(event);
		const binding = this.binding;
		if (!input || !binding || !text(input.state, 32) || !TERMINAL_STATES.has(input.state)) return false;
		const runId = text(input.runId) ? input.runId : text(input.id) ? input.id : null;
		if (runId !== binding.runId
			|| input.sessionId !== binding.sessionId
			|| (input.cwd !== undefined && input.cwd !== binding.cwd)
			|| input.completionOwnerId !== binding.completionOwnerId
			|| (input.toolCallId !== undefined && input.toolCallId !== binding.toolCallId)) return false;
		let observed: GoalTeamRunObservation;
		try {
			observed = await this.deps.readStatus(binding);
		} catch {
			return false;
		}
		if (observed.kind !== "terminal"
			|| observed.completionOwnerId !== binding.completionOwnerId
			|| (observed.runId !== undefined && observed.runId !== binding.runId)
			|| (observed.sessionId !== undefined && observed.sessionId !== binding.sessionId)
			|| (observed.cwd !== undefined && observed.cwd !== binding.cwd)
			|| (observed.toolCallId !== undefined && observed.toolCallId !== binding.toolCallId)
			|| !this.binding || !sameBinding(this.binding, binding)) return false;
		this.release(binding, "native-completion");
		return true;
	}

	async recover(entries: readonly unknown[]): Promise<boolean> {
		this.pending = null;
		this.binding = null;
		let latest: GoalTeamHoldEntry | null = null;
		for (const value of entries) {
			const entry = normalizeEntry(value);
			if (entry) latest = entry;
		}
		if (!latest || latest.state === "released") return false;
		const binding = latest.binding;
		if (!currentMatches(binding, this.deps.goal(), this.deps.sessionId(), this.deps.cwd())) {
			this.release(binding, "recovery-context-mismatch");
			return false;
		}
		const observed = await (this.deps.recoverStatus ?? this.deps.readStatus)(binding);
		if (observed.kind !== "active" || observed.completionOwnerId !== binding.completionOwnerId) {
			this.release(binding, `recovery-${observed.kind}`);
			return false;
		}
		this.binding = binding;
		return true;
	}

	shouldHold(ctx: Pick<ExtensionContext, "cwd">, goal: GoalRecord): boolean {
		const sessionId = this.deps.sessionId();
		const cwd = this.deps.cwd();
		if (ctx.cwd !== cwd) {
			this.clear("context-cwd-mismatch");
			return false;
		}
		if (this.pending) {
			if (currentMatches(this.pending, goal, sessionId, cwd)) return true;
			this.pending = null;
		}
		if (!this.binding) return false;
		if (currentMatches(this.binding, goal, sessionId, cwd)) return true;
		this.clear("goal-context-mismatch");
		return false;
	}

	current(): GoalTeamRunBinding | null {
		return this.binding ? { ...this.binding } : null;
	}

	clearPending(): void {
		this.pending = null;
	}

	clear(reason = "cleared"): void {
		this.pending = null;
		if (!this.binding) return;
		this.release(this.binding, reason);
	}

	dispose(): void {
		this.pending = null;
		this.binding = null;
	}

	private release(binding: GoalTeamRunBinding, reason: string): void {
		if (this.binding && sameBinding(this.binding, binding)) this.binding = null;
		try {
			this.deps.append({ version: 1, state: "released", binding, reason, at: Date.now() });
		} catch {
			// In-memory release is fail-safe. Reload revalidates any older bound entry.
		}
	}
}
