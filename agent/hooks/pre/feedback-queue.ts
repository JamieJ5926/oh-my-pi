/**
 * Enforces the outbound feedback contract for dispatched lanes.
 *
 * Two gates. A lane cannot terminally yield finished, blocker, or
 * decision-needed without first filing a row in the feedback queue, and a lane
 * gets two hub sends to root per run before it is told to file instead. Both
 * exist because on 2026-08-27 the root drowned in per-lane IRC while Jamie
 * received nothing, so lane findings never reached a surface he reads.
 *
 * Root is never gated. Manager-to-child and child-to-manager traffic is never
 * gated. Only lane-to-root push is rate limited.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	disappearanceAbortedRecord,
	extractExplicitCheckpoint,
	FORBIDDEN_CALLER_PHRASE,
	modelString,
	parseChildTaskResults,
	isSuccessStatus,
	parseDelegatedResult,
	rewriteCancelledByCaller,
	shouldBlockTerminalContract,
	TERMINAL_RECORD_WRITE_FAILED,
	validateTerminalRecord,
	type TerminalRecord,
} from "../lib/delegated-result-contract.ts";

export type RoleClass = "write" | "read-only" | "unknown";
export type RoleClass = "write" | "read-only" | "unknown";
const WRITE_ROLES: Record<string, true> = { implementer: true, mechanical: true, owner: true };
const READ_ONLY_ROLES: Record<string, true> = { explorer: true, researcher: true, planner: true, synthesizer: true, watcher: true };
export function classifyAgentRole(agent: string): RoleClass {
	const name = agent.trim().toLowerCase();
	if (WRITE_ROLES[name] || name.startsWith("worker-")) return "write";
	if (READ_ONLY_ROLES[name] || name.startsWith("research-")) return "read-only";
	return "unknown";
}
export function taskAgentMap(input: unknown): Map<string, RoleClass> {
	const tasks = record(input)?.tasks;
	const map = new Map<string, RoleClass>();
	if (!Array.isArray(tasks)) return map;
	for (const item of tasks) {
		const task = record(item);
		if (!task) continue;
		const role = classifyAgentRole(stringValue(task.agent));
		for (const key of [task.id, task.name, task.taskRef]) { const value = stringValue(key); if (value) map.set(value, role); }
	}
	return map;
}
export function rewriteWriteRoleSelfOnly(content: string, details: unknown, roles: Map<string, RoleClass>): string {
	for (const child of parseChildTaskResults(details, content, "unknown")) {
		if (roles.get(child.taskRef) !== "write") continue;
		let payload: unknown;
		try {
			payload = JSON.parse(child.text);
		} catch {
			continue;
		}
		const artifacts = record(payload)?.artifacts;
		if (
			isSuccessStatus(parseDelegatedResult(payload).status) &&
			Array.isArray(artifacts) &&
			artifacts.length > 0 &&
			artifacts.every((a) => record(a)?.locator === "result:self")
		)
			return `contract-violation: write-role success without file evidence\n${content}`;
	}
	return content;
}

export const FEEDBACK_QUEUE_PATH = join(homedir(), ".omp", "run", "feedback-queue.jsonl");
export const FEEDBACK_QUEUE_BLOCK_REASON =
	"Terminal yield requires a feedback queue row for this lane in ~/.omp/run/feedback-queue.jsonl before it can finish.";
export const ROOT_SEND_BLOCK_REASON =
	"This lane has reached the two lane-to-root hub sends allowed per run. File the update in ~/.omp/run/feedback-queue.jsonl and let the root drain it.";

const LANE_MARK = "Complete assignment thoroughly";
const QUEUE_KINDS: Record<string, true> = {
	finding: true,
	blocker: true,
	"decision-needed": true,
	finished: true,
	routing: true,
	terminal: true,
};
const QUEUE_STATES: Record<string, true> = { new: true, drained: true };
const TERMINAL_STATUSES: Record<string, true> = {
	finished: true,
	blocker: true,
	"decision-needed": true,
	pass: true,
	success: true,
	issues: true,
	blocked: true,
	cancelled: true,
	aborted: true,
	timed_out: true,
};
const ROOT_NAMES: Record<string, true> = {
	main: true,
	root: true,
	coordinator: true,
};

type UnknownRecord = Record<string, unknown>;

function guard<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function record(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function toolInput(event: { input?: unknown; args?: unknown; arguments?: unknown }): unknown {
	if (event.input !== undefined) return event.input;
	if (event.args !== undefined) return event.args;
	return event.arguments;
}

function environmentValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = stringValue(process.env[name]);
		if (value) return value;
	}
	return undefined;
}

function queuePath(): string {
	return environmentValue("OMP_FEEDBACK_QUEUE", "OMP_FEEDBACK_QUEUE_PATH") ?? FEEDBACK_QUEUE_PATH;
}

function queueRow(value: unknown): { lane: string; kind: string; status: string } | undefined {
	const object = record(value);
	if (!object) return undefined;
	const lane = stringValue(object.lane);
	const kind = stringValue(object.kind);
	const status = stringValue(object.status);
	if (!lane || !QUEUE_KINDS[kind] || !QUEUE_STATES[status]) return undefined;
	return { lane, kind, status };
}

export function queueHasLane(queueText: string, laneId: string): boolean {
	if (!laneId) return false;
	for (const line of queueText.split("\n")) {
		if (!line.trim()) continue;
		const parsed = guard(() => JSON.parse(line) as unknown);
		const row = queueRow(parsed);
		if (row?.lane === laneId) return true;
	}
	return false;
}

export function queueHasLaneAtPath(path: string, laneId: string): boolean {
	if (!laneId || !existsSync(path)) return false;
	return queueHasLane(readFileSync(path, "utf8"), laneId);
}

export function queueHasRecordId(path: string, recordId: string): boolean {
	if (!recordId || !existsSync(path)) return false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const parsed = guard(() => JSON.parse(line) as unknown);
		const object = record(parsed);
		const terminal = record(object?.terminal);
		if (stringValue(terminal?.recordId) === recordId) return true;
	}
	return false;
}

export function queueHasTaskRef(path: string, taskRef: string): boolean {
	if (!taskRef || !existsSync(path)) return false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const parsed = guard(() => JSON.parse(line) as unknown);
		const object = record(parsed);
		const terminal = record(object?.terminal);
		if (stringValue(object?.kind) === "terminal" && stringValue(terminal?.taskRef) === taskRef) return true;
	}
	return false;
}

function collectCancelIds(input: unknown): string[] {
	const object = record(input);
	if (!object) return [];
	const ids: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) ids.push(value.trim());
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item.trim()) ids.push(item.trim());
			}
		}
	};
	push(object.ids);
	push(object.id);
	push(object.to);
	push(object.name);
	return ids;
}

function terminalStatus(value: unknown): string | undefined {
	const object = record(value);
	if (!object) return undefined;
	const direct = stringValue(object.status);
	if (TERMINAL_STATUSES[direct.toLowerCase()]) return direct.toLowerCase();
	const result = record(object.result);
	if (!result) return undefined;
	const resultStatus = stringValue(result.status);
	if (TERMINAL_STATUSES[resultStatus.toLowerCase()]) return resultStatus.toLowerCase();
	const data = record(result.data);
	const dataStatus = stringValue(data?.status);
	if (TERMINAL_STATUSES[dataStatus.toLowerCase()]) return dataStatus.toLowerCase();
	const error = record(result.error);
	const errorStatus = stringValue(error?.status);
	return TERMINAL_STATUSES[errorStatus.toLowerCase()] ? errorStatus.toLowerCase() : undefined;
}

export function isMatchedTerminalYield(toolName: string, input: unknown): boolean {
	return toolName === "yield" && terminalStatus(input) !== undefined;
}

function field(value: unknown, ...keys: string[]): string {
	const object = record(value);
	if (!object) return "";
	for (const key of keys) {
		const result = stringValue(object[key]);
		if (result) return result;
	}
	return "";
}

function targetsRoot(input: unknown): boolean {
	const object = record(input);
	if (!object || field(object, "op").toLowerCase() !== "send") return false;
	const target = field(object, "to", "recipient", "target");
	if (!target) return false;
	const normalized = target.toLowerCase();
	if (ROOT_NAMES[normalized]) return true;
	const parent = environmentValue(
		"OMP_PARENT_SESSION",
		"OMP_PARENT_SESSION_NAME",
		"OMP_PARENT_LANE_ID",
	);
	return parent !== undefined && parent.toLowerCase() === normalized;
}

export function isMatchedRootSend(toolName: string, input: unknown, isLane: boolean): boolean {
	return isLane && toolName === "hub" && targetsRoot(input);
}

function laneId(): string | undefined {
	return environmentValue("OMP_INJECTION_LANE_ID", "OMP_SURFACE_LANE_ID", "OMP_LANE_ID");
}

function runId(sessionId: string | undefined): string {
	return environmentValue("OMP_RUN_ID", "OMP_RUN_TAG", "OMP_SESSION_ID") ?? sessionId ?? "unknown";
}

function counterPath(run: string, lane: string): string {
	const safeRun = run.replace(/[^A-Za-z0-9._-]+/g, "_");
	const safeLane = lane.replace(/[^A-Za-z0-9._-]+/g, "_");
	return join(dirname(queuePath()), `feedback-queue-counter-${safeRun}-${safeLane}.json`);
}

function readCounter(path: string): number | undefined {
	if (!existsSync(path)) return 0;
	const parsed = guard(() => JSON.parse(readFileSync(path, "utf8")) as unknown);
	const count = record(parsed)?.count;
	return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function writeCounter(path: string, count: number): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ count })}\n`, { mode: 0o600 });
		renameSync(temporary, path);
		return true;
	} catch {
		return false;
	}
}

export function shouldBlockTerminalYield(
	input: unknown,
	isLane: boolean,
	lane: string | undefined,
): boolean {
	if (!isLane || !isMatchedTerminalYield("yield", input) || !lane) return false;
	return !queueHasLaneAtPath(queuePath(), lane);
}

export function shouldBlockRootSend(
	isLane: boolean,
	input: unknown,
	lane: string | undefined,
	run: string,
): boolean {
	if (!isLane || !lane) return false;
	const path = counterPath(run, lane);
	const count = readCounter(path);
	if (count === undefined || count >= 2) return true;
	return !writeCounter(path, count + 1);
}

export default function (pi: ExtensionAPI): void {
	let isLane = false;
	let firstUserMessageSeen = false;
	let sessionId: string | undefined;
	const observedModels: string[] = [];

	const taskRoles = new Map<string, RoleClass>();
	const explicitCancels = new Set<string>();
	let sawSuccessfulTerminalYield = false;
	let pendingTerminalYieldToolCallId: string | undefined;
	let lastCheckpoint: string | null = null;
	const partialArtifacts: string[] = [];

	function observeModel(model: unknown): void {
		const value = modelString(model);
		if (!value) return;
		if (observedModels[observedModels.length - 1] === value) return;
		observedModels.push(value);
	}

	function appendTerminal(record: TerminalRecord): boolean {
		const validated = validateTerminalRecord(record);
		if (!validated.ok) return false;
		try {
			if (
				queueHasRecordId(queuePath(), validated.record.recordId) ||
				queueHasTaskRef(queuePath(), validated.record.taskRef)
			) {
				return true;
			}
			mkdirSync(dirname(queuePath()), { recursive: true, mode: 0o700 });
			const row = {
				ts: validated.record.observedAt,
				lane: laneId() ?? validated.record.taskRef,
				parent: environmentValue("OMP_PARENT_SESSION", "OMP_PARENT_SESSION_NAME") ?? "unknown",
				kind: "terminal",
				severity: "info",
				summary: `${validated.record.outcome} ${validated.record.taskRef}`,
				evidence: [
					validated.record.reason,
					`initiator:${validated.record.initiator.kind}`,
					validated.record.initiator.evidence,
				],
				needs_jamie: false,
				status: "new",
				terminal: validated.record,
			};
			appendFileSync(queuePath(), `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}

	pi.on("session_switch", (event) =>
		guard(() => {
			if (event.reason !== "new") return;
			isLane = false;
			firstUserMessageSeen = false;
			sessionId = stringValue(event.sessionId) || undefined;
			observedModels.length = 0;
			explicitCancels.clear();
			sawSuccessfulTerminalYield = false;
			pendingTerminalYieldToolCallId = undefined;
			lastCheckpoint = null;
			partialArtifacts.length = 0;
		}),
	);

	pi.on("model_change", (event) =>
		guard(() => {
			const payload = record(event);
			observeModel(payload?.model);
		}),
	);

	pi.on("message_start", (event, ctx) =>
		guard(() => {
			if (!firstUserMessageSeen) {
				const message = record(event.message);
				if (!message || message.customType !== undefined || message.role !== "user") return;
				firstUserMessageSeen = true;
				const ctxRecord = record(ctx);
				observeModel(ctxRecord?.model);
				const content = message.content;
				const messageText =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.map((part) => {
										const item = record(part);
										return item?.type === "text" && typeof item.text === "string" ? item.text : "";
									})
									.join("")
							: "";
				if (messageText.includes(LANE_MARK)) isLane = true;
			}
		}),
	);

	pi.on("tool_call", (event) =>
		guard(() => {
			const input = toolInput(event);
			if (event.toolName === "task") {
				for (const [key, role] of taskAgentMap(input)) taskRoles.set(`${stringValue(event.toolCallId) || "unknown"}:${key}`, role);
			}
			const lane = laneId();
			if (event.toolName === "hub") {
				const object = record(input);
				if (stringValue(object?.op).toLowerCase() === "cancel") for (const id of collectCancelIds(input)) explicitCancels.add(id);
			}
			if (isMatchedTerminalYield(event.toolName, input)) {
				const contractBlock = shouldBlockTerminalContract(input, isLane, { models: observedModels });
				if (contractBlock) return { block: true, reason: contractBlock };
				if (shouldBlockTerminalYield(input, isLane, lane)) return { block: true, reason: FEEDBACK_QUEUE_BLOCK_REASON };
				pendingTerminalYieldToolCallId = stringValue(event.toolCallId) || undefined;
			}
			if (!isMatchedRootSend(event.toolName, input, isLane)) return undefined;
			if (shouldBlockRootSend(isLane, input, lane, runId(sessionId))) return { block: true, reason: ROOT_SEND_BLOCK_REASON };
			return undefined;
		}),
	);

	pi.on("tool_result", (event) =>
		guard(() => {
			if (pendingTerminalYieldToolCallId && stringValue(event.toolCallId) === pendingTerminalYieldToolCallId) {
				pendingTerminalYieldToolCallId = undefined;
				if (!event.isError) sawSuccessfulTerminalYield = true;
			}
			if (event.toolName !== "task") return undefined;
			const content = typeof event.content === "string" ? event.content : "";
			const toolCallId = stringValue(event.toolCallId) || "unknown";
			const roles = new Map<string, RoleClass>();
			for (const [key, role] of taskRoles) if (key.startsWith(`${toolCallId}:`)) roles.set(key.slice(toolCallId.length + 1), role);
			const contractContent = rewriteWriteRoleSelfOnly(content, event.details, roles);
			let nextContent = contractContent;
			let writeFailed = false;
			const children = parseChildTaskResults(event.details, contractContent, toolCallId);
			for (const child of children) {
				const explicit = explicitCancels.has(child.taskRef) || explicitCancels.has(toolCallId);
				if (child.text.includes(FORBIDDEN_CALLER_PHRASE) || child.cancelled) {
					nextContent = rewriteCancelledByCaller(nextContent, explicit);
					const terminal: TerminalRecord = { recordId: `task:${toolCallId}:${child.taskRef}`, taskRef: child.taskRef, outcome: "CANCELLED", observedAt: new Date().toISOString(), initiator: explicit ? { kind: "explicit-parent", evidence: `hub cancel ids=[${child.taskRef}]` } : { kind: "unknown", evidence: "task result without correlated hub cancel" }, reason: explicit ? NEUTRAL_CANCEL_EXPLICIT : NEUTRAL_CANCEL_UNKNOWN, lastCheckpoint: child.lastCheckpoint, partialArtifacts: [...child.partialArtifacts] };
					if (!appendTerminal(terminal)) writeFailed = true;
				}
			}
			if (nextContent === content && !writeFailed) return undefined;
			if (writeFailed && !nextContent.includes(TERMINAL_RECORD_WRITE_FAILED)) nextContent = `${nextContent}\n${TERMINAL_RECORD_WRITE_FAILED}`;
			return { content: nextContent };
		}),
	);

	pi.on("agent_end", (event) =>
		guard(() => {
			const classifiedLane = laneId();
			if (!isLane || !classifiedLane || sawSuccessfulTerminalYield) return;
			if (queueHasTaskRef(queuePath(), classifiedLane) || queueHasRecordId(queuePath(), `agent_end:${classifiedLane}`)) {
				return;
			}
			const extracted = extractExplicitCheckpoint(event.messages);
			if (extracted.checkpoint) lastCheckpoint = extracted.checkpoint;
			for (const item of extracted.artifacts) {
				if (!partialArtifacts.includes(item)) partialArtifacts.push(item);
			}
			appendTerminal(
				disappearanceAbortedRecord({
					recordId: `agent_end:${classifiedLane}`,
					taskRef: classifiedLane,
					observedAt: new Date().toISOString(),
					lastCheckpoint,
					partialArtifacts,
				}),
			);
		}),
	);
}
