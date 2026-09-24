import { spawnFrankDaemonWorker } from "./frank-daemon-worker";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { answerExitDecision, foldEventsToText, FrankWorkerExitError } from "./frank-worker-fold";
import type { AgentDefinition } from "./types";

type FrankControl =
	| { kind: "ack"; version: 1; turn_id: number; accepted: boolean; pending_id?: number; error?: string }
	| { kind: "heartbeat"; version: 1; at_ms: number }
	| { kind: "terminal"; version: 1; turn_id: number; terminal: "Answer" | "Error" | "Cancelled" | "BudgetExceeded"; final_seq: number; error?: string }
	| { kind: "saved"; version: 1; path: string }
	| { kind: "cancelled"; version: 1; turn_id: number }
	| { kind: "error"; version: 1; message: string; turn_id?: number };

export type { FrankControl };

export class FrankProtocolError extends Error {
	foldedText = "";

	constructor(message = "Frank worker event out of contract") {
		super(message);
		this.name = "FrankProtocolError";
	}
}

export interface FrankEvent {
	type: "event";
	seq: number;
	event: unknown;
}

export interface FrankWorkerBudgets {
	maxToolCalls: number;
	wallSecs: number;
}

/** Budget applied to a seat whose frontmatter declares none. */
export const DEFAULT_FRANK_WORKER_BUDGETS: FrankWorkerBudgets = { maxToolCalls: 64, wallSecs: 600 };

/**
 * Resolve a seat's Frank worker budget from its agent definition.
 * A declared field wins; an absent one falls back to {@link DEFAULT_FRANK_WORKER_BUDGETS}.
 */
export function resolveFrankWorkerBudgets(agent: Pick<AgentDefinition, "maxToolCalls" | "wallSecs">): FrankWorkerBudgets {
	return {
		maxToolCalls: agent.maxToolCalls ?? DEFAULT_FRANK_WORKER_BUDGETS.maxToolCalls,
		wallSecs: agent.wallSecs ?? DEFAULT_FRANK_WORKER_BUDGETS.wallSecs,
	};
}

export interface SpawnFrankWorkerOptions {
	exe: string;
	endpoint: string;
	model: string;
	cwd: string;
	budgets: FrankWorkerBudgets;
	text: string;
	onEvent: (event: FrankEvent) => void | Promise<void>;
	apiKey?: string;
	apiKeyEnv?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Frank writes its full event stream here (tool calls, results, faults, token meters). */
	eventsPath?: string;
	/** Role instructions: Frank loads <root>/roles/<name>/instructions/<name>.md as its role layer. */
	role?: { root: string; name: string };
	transport?: "process" | "daemon";
	frankBin?: string;
	sessionId?: string;
	artifactsDir?: string;
}
export type StartFrankWorkerOptions = Omit<SpawnFrankWorkerOptions, "text">;

export interface FrankWorkerHandle {
	runTurn(text: string): Promise<FrankWorkerResult>;
	close(): Promise<void>;
}

export function frankWorkerEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export interface FrankWorkerResult {
	terminal: Extract<FrankControl, { kind: "terminal" }>;
	exitCode: number;
	text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseFrankControl(value: unknown): FrankControl {
	if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") throw new Error("Invalid Frank control envelope");
	switch (value.type) {
		case "ack":
			if (!positiveInteger(value.turn_id) || typeof value.accepted !== "boolean" || (value.pending_id !== undefined && !nonnegativeInteger(value.pending_id)) || (value.error !== undefined && typeof value.error !== "string")) throw new Error("Invalid Frank ack control");
			return { kind: "ack", version: 1, turn_id: value.turn_id, accepted: value.accepted, ...(value.pending_id === undefined ? {} : { pending_id: value.pending_id }), ...(value.error === undefined ? {} : { error: value.error }) };
		case "heartbeat":
			if (!nonnegativeInteger(value.at_ms)) throw new Error("Invalid Frank heartbeat control");
			return { kind: "heartbeat", version: 1, at_ms: value.at_ms };
		case "terminal":
			if (!positiveInteger(value.turn_id) || (value.terminal !== "Answer" && value.terminal !== "Error" && value.terminal !== "Cancelled" && value.terminal !== "BudgetExceeded") || !nonnegativeInteger(value.final_seq) || (value.error !== undefined && typeof value.error !== "string")) throw new Error("Invalid Frank terminal control");
			return { kind: "terminal", version: 1, turn_id: value.turn_id, terminal: value.terminal, final_seq: value.final_seq, ...(value.error === undefined ? {} : { error: value.error }) };
		case "saved":
			if (typeof value.path !== "string") throw new Error("Invalid Frank saved control");
			return { kind: "saved", version: 1, path: value.path };
		case "cancelled":
			if (!positiveInteger(value.turn_id)) throw new Error("Invalid Frank cancelled control");
			return { kind: "cancelled", version: 1, turn_id: value.turn_id };
		case "error":
			if (typeof value.message !== "string" || (value.turn_id !== undefined && !positiveInteger(value.turn_id))) throw new Error("Invalid Frank error control");
			return { kind: "error", version: 1, message: value.message, ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }) };
		default:
			throw new Error(`Unknown Frank control type ${value.type}`);
	}
}

function parseFrankEvent(value: unknown): FrankEvent {
	if (!isRecord(value) || value.type !== "event" || !nonnegativeInteger(value.seq) || !("event" in value)) throw new Error("Invalid Frank event envelope");
	return { type: "event", seq: value.seq, event: value.event };
}

function isFrankBookkeepingEvent(event: FrankEvent): boolean {
	const payload = event.event;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("kind" in payload)) return false;
	const kind = payload.kind;
	return typeof kind === "object" && kind !== null && ("TerminalDone" in kind || "Meter" in kind);
}

function parseLine(line: string): unknown {
	return JSON.parse(line);
}


function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	stream.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
	return promise;
}

// Frank seats mirror native seats, which may read absolute paths outside the session cwd, while Frank writes stay cwd-confined by its own Cwd checks.
export const FRANK_READ_ROOT = "any";

export async function startFrankWorker(options: StartFrankWorkerOptions): Promise<FrankWorkerHandle> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("Frank worker aborted");
	const childEnv = { ...process.env };
	delete childEnv["PI_TRACK_API_KEY"];
	childEnv["WEBFETCH_POLICY"] ??= "on";
	if (options.apiKey && options.apiKey !== "N/A") childEnv["PI_TRACK_API_KEY"] = options.apiKey;
	const executable = options.exe.includes(path.sep) && !path.isAbsolute(options.exe) ? path.resolve(options.cwd, options.exe) : options.exe;
	const child = spawn(executable, [
		"agent", "--endpoint", options.endpoint, "--model", options.model, "--cwd", options.cwd,
		"--max-tool-calls", String(options.budgets.maxToolCalls), "--wall-secs", String(options.budgets.wallSecs), "--tool-choice", "auto",
		"--read-root", FRANK_READ_ROOT,
		...(options.eventsPath ? ["--events-path", options.eventsPath] : []),
		...(options.role ? ["--instructions-root", options.role.root, "--instructions-role", options.role.name] : []),
	], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv });
	const stdout = createInterface({ input: child.stdout });
	const stderr = createInterface({ input: child.stderr });
	const { promise: closed, resolve: markClosed } = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
	let nextTurnId = 1;
	let nextExpectedSeq = 1;
	let deliveredSeq = 0;
	let eventChain = Promise.resolve();
 	let activeTurn: {
 		id: number;
 		accepted: boolean;
 		completing: boolean;
 		completed: boolean;
 		terminal?: Extract<FrankControl, { kind: "terminal" }>;
 		promise: Promise<FrankWorkerResult>;
 		settle: (result: FrankWorkerResult) => void;
 		fail: (error: Error) => void;
 	} | undefined;
	const deliveredEvents: FrankEvent[] = [];
	const seenSeqs = new Set<number>();
	let turnEventStartIndex = 0;
	let closePromise: Promise<void> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let abortReason: Error | undefined;
	let failure: Error | undefined;
 	let shuttingDown = false;
	const closeTimeoutMs = 500;
	const failTurn = (error: Error) => {
		if (failure) return;
		failure = error;
		activeTurn?.fail(error);
	};
 	const abort = () => {
 		abortReason = options.signal?.reason instanceof Error ? options.signal.reason : new Error("Frank worker aborted");
		const turnId = activeTurn?.completed ? undefined : activeTurn?.id;
 		const closing = turnId === undefined
 			? Promise.resolve()
 			: writeLine(child.stdin, { op: "cancel", turn_id: turnId }).catch(() => {});
 		void closing.then(() => {
 			failTurn(abortReason!);
 			return closeWorker();
 		}).catch(() => {});
 	};
	const closeWorker = async () => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
 			shuttingDown = true;
			clearTimeout(timer);
 			if (child.exitCode !== null || child.signalCode !== null) options.signal?.removeEventListener("abort", abort);
 			if (child.exitCode === null && child.signalCode === null) {
 				const graceful = await Promise.race([
 					writeLine(child.stdin, { op: "shutdown" }).then(() => closed).then(() => true),
 					new Promise<false>(resolve => setTimeout(() => resolve(false), closeTimeoutMs)),
 				]);
 				if (!graceful && child.exitCode === null && child.signalCode === null) {
 					failTurn(abortReason ?? new Error("Frank worker shutdown deadline exceeded"));
 					child.kill("SIGTERM");
 					const terminated = await Promise.race([closed.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), closeTimeoutMs))]);
 					if (!terminated && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
 				}
 				await closed;
 			options.signal?.removeEventListener("abort", abort);
			}
			stdout.close();
			stderr.close();
			if (failure) throw failure;
		})();
		return closePromise;
 	};
 	stdout.on("line", line => {
 		try {
			const event = parseFrankEvent(parseLine(line));
			const turn = activeTurn;
			if (!turn) throw new FrankProtocolError("Frank worker emitted an event without an active turn");
			if (turn.terminal !== undefined && event.seq > turn.terminal.final_seq) return;
			if (seenSeqs.has(event.seq)) throw new FrankProtocolError("Frank worker duplicate event sequence");
			seenSeqs.add(event.seq);
			if (event.seq !== nextExpectedSeq) throw new FrankProtocolError();
			nextExpectedSeq++;
 			if (isFrankBookkeepingEvent(event)) {
 				eventChain = eventChain.then(() => {
 					deliveredSeq = event.seq;
 					completeTurn();
 				});
 				eventChain.catch(error => failTurn(error instanceof Error ? error : new Error(String(error))));
 				return;
 			}
			eventChain = eventChain.then(async () => {
				await options.onEvent(event);
				deliveredEvents.push(event);
				deliveredSeq = event.seq;
				completeTurn();
			});
			eventChain.catch(error => failTurn(error instanceof Error ? error : new Error(String(error))));
		} catch (error) {
			failTurn(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const completeTurn = () => {
		const turn = activeTurn;
		if (!turn?.accepted || !turn.terminal || turn.completing || deliveredSeq < turn.terminal.final_seq) return;
		turn.completing = true;
		void eventChain.then(() => {
			if (failure || activeTurn !== turn) return;
			const events = deliveredEvents.slice(turnEventStartIndex).filter(event => event.seq <= turn.terminal!.final_seq);
			turnEventStartIndex = deliveredEvents.length;
			const text = foldEventsToText(events);
			const decision = answerExitDecision(turn.terminal!.terminal, 0, text);
			if (decision.error instanceof FrankWorkerExitError) turn.fail(decision.error);
 			else {
 				turn.completed = true;
 				turn.settle({ terminal: turn.terminal!, exitCode: decision.exitCode, text });
 			}
		}).catch(error => failTurn(error instanceof Error ? error : new Error(String(error))));
	};
 	stderr.on("line", line => {
 			if (shuttingDown) return;
 			try {
 			const control = parseFrankControl(parseLine(line));
			switch (control.kind) {
				case "ack": {
					const turn = activeTurn;
					if (!turn || control.turn_id !== turn.id) throw new Error(`Unexpected Frank ack turn_id ${control.turn_id}`);
					if (!control.accepted) throw new Error(control.error ?? "Frank rejected the submitted turn");
					turn.accepted = true;
					completeTurn();
					return;
				}
				case "heartbeat":
				case "saved":
				case "cancelled":
					return;
				case "terminal": {
					const turn = activeTurn;
					if (!turn || control.turn_id !== turn.id) throw new Error(`Unexpected Frank terminal turn_id ${control.turn_id}`);
					turn.terminal = control;
					completeTurn();
					return;
				}
				case "error":
					throw new FrankProtocolError(control.message);
				default: {
					const exhaustive: never = control;
					throw new Error(`Unhandled Frank control ${String(exhaustive)}`);
				}
			}
		} catch (error) {
			failTurn(error instanceof Error ? error : new Error(String(error)));
		}
	});
	child.on("error", failTurn);
	child.on("close", (code, signal) => {
		markClosed([code, signal]);
		const turn = activeTurn;
 		if (!turn) return;
 		if (!turn.terminal) {
 			failTurn(new Error(`Frank exited before completing the turn (code ${code}, signal ${signal})`));
 			return;
 		}
 		if (turn.terminal.final_seq >= nextExpectedSeq) {
			failTurn(new Error(`Frank exited before completing the turn (code ${code}, signal ${signal})`));
			return;
		}
		void eventChain.then(() => completeTurn()).catch(error => failTurn(error instanceof Error ? error : new Error(String(error))));
	});
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => {
			abortReason = new Error(`Frank worker timed out after ${options.timeoutMs}ms`);
			const turnId = activeTurn?.id;
			if (turnId !== undefined) void writeLine(child.stdin, { op: "cancel", turn_id: turnId }).catch(() => {});
			failTurn(abortReason);
			void closeWorker();
		}, options.timeoutMs);
	}
 	options.signal?.addEventListener("abort", abort, { once: true });
	return {
		runTurn: async text => {
			if (failure) throw failure;
			if (closePromise) throw new Error("Frank worker is closed");
 			if (activeTurn && !activeTurn.completed) throw new Error("Frank worker already has an active turn");
 			const turnId = nextTurnId++;
 			const { promise, resolve, reject } = Promise.withResolvers<FrankWorkerResult>();
 			activeTurn = { id: turnId, accepted: false, completing: false, completed: false, promise, settle: resolve, fail: reject };
 			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				await writeLine(child.stdin, { op: "submit", turn_id: turnId, text });
				return await promise;
			} catch (error) {
				const reason = failure ?? (error instanceof Error ? error : new Error(String(error)));
				activeTurn = undefined;
				throw reason;
			}
		},
		close: closeWorker,
	};
}
export async function spawnFrankWorker(options: SpawnFrankWorkerOptions): Promise<FrankWorkerResult> {
	if (options.transport === "daemon") {
		if (!options.eventsPath) throw new Error("Frank daemon transport requires an events path");
		return spawnFrankDaemonWorker({ ...options, artifactsDir: path.dirname(options.eventsPath), id: options.sessionId ?? path.basename(options.eventsPath, ".frank.jsonl") });
	}
	const worker = await startFrankWorker(options);
	try {
		return await worker.runTurn(options.text);
	} finally {
		await worker.close();
	}
}
