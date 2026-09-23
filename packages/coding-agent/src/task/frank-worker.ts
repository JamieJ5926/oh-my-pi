import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { answerExitDecision, foldEventsToText, FrankWorkerExitError } from "./frank-worker-fold";

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

export interface SpawnFrankWorkerOptions {
	exe: string;
	endpoint: string;
	model: string;
	cwd: string;
	budgets: FrankWorkerBudgets;
	text: string;
	onEvent: (event: FrankEvent) => void | Promise<void>;
	apiKey?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export function frankWorkerEndpoint(baseUrl: string): string {
	return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
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

export async function spawnFrankWorker(options: SpawnFrankWorkerOptions): Promise<FrankWorkerResult> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("Frank worker aborted");
	const childEnv = { ...process.env };
	if (options.apiKey) childEnv["PI_TRACK_API_KEY"] = options.apiKey;
	const child = spawn(options.exe, [
		"agent", "--endpoint", options.endpoint, "--model", options.model, "--cwd", options.cwd,
		"--max-tool-calls", String(options.budgets.maxToolCalls), "--wall-secs", String(options.budgets.wallSecs),
	], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv });
	const stdout = createInterface({ input: child.stdout });
	const stderr = createInterface({ input: child.stderr });
	const { promise: completion, resolve: settle, reject: fail } = Promise.withResolvers<FrankWorkerResult>();
	const { promise: closed, resolve: markClosed } = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
	let deliveredSeq = 0;
	let nextExpectedSeq = 1;
	let accepted = false;
	let terminal: Extract<FrankControl, { kind: "terminal" }> | undefined;
	let failure: Error | undefined;
	let settled = false;
	let abortReason: Error | undefined;
	let timer: NodeJS.Timeout | undefined;
	let shutdownTimer: NodeJS.Timeout | undefined;
	const closeTimeoutMs = 500;
	let completionStarted = false;
	let interruptShutdown: (() => void) | undefined;
	let stdoutClosed = false;
	let foldedText = "";
	const admittedEvents: FrankEvent[] = [];
	let protocolError: FrankProtocolError | undefined;
	const seenSeqs = new Set<number>();
	const rejectOnce = (error: Error) => {
		if (settled) return;
		failure = error;
		if (error instanceof FrankProtocolError) error.foldedText = foldedText;
		settled = true;
		fail(error);
	};
	const maybeComplete = async () => {
		const completedTerminal = terminal;
		if (!completionStarted && accepted && completedTerminal && deliveredSeq >= completedTerminal.final_seq) {
			completionStarted = true;
			try {
				await eventChain;
				if (!failure) {
					foldedText = foldEventsToText(admittedEvents.filter((event): event is FrankEvent => event !== undefined && event.seq <= completedTerminal.final_seq));
					settled = true;
					settle({ terminal: completedTerminal, exitCode: 0, text: foldedText });
				}
			} catch (error) {
				rejectOnce(error instanceof Error ? error : new Error(String(error)));
			}
		}
	};
	const abort = () => {
		abortReason = options.signal?.reason instanceof Error ? options.signal.reason : new Error("Frank worker aborted");
		void writeLine(child.stdin, { op: "cancel", turn_id: 1 }).catch(() => {}).finally(() => {
			interruptShutdown?.();
			rejectOnce(abortReason!);
		});
	};
	let eventChain = Promise.resolve();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => {
			abortReason = new Error(`Frank worker timed out after ${options.timeoutMs}ms`);
			void writeLine(child.stdin, { op: "cancel", turn_id: 1 }).catch(() => {}).finally(() => {
				interruptShutdown?.();
				rejectOnce(abortReason!);
			});
		}, options.timeoutMs);
	}
	stdout.on("close", () => {
		stdoutClosed = true;
		void maybeComplete();
	});
	stdout.on("line", line => {
		try {
			const event = parseFrankEvent(parseLine(line));
			if (terminal !== undefined && event.seq > terminal.final_seq) return;
			if (seenSeqs.has(event.seq)) {
				const error = new FrankProtocolError("Frank worker duplicate event sequence");
				error.foldedText = foldedText;
				protocolError = error;
				if (!completionStarted) rejectOnce(error);
				return;
			}
			seenSeqs.add(event.seq);
			if (event.seq !== nextExpectedSeq) {
				const error = new FrankProtocolError();
				error.foldedText = foldedText;
				protocolError = error;
				rejectOnce(error);
				return;
			}
			if (isFrankBookkeepingEvent(event)) {
				deliveredSeq = event.seq;
				nextExpectedSeq = event.seq + 1;
				void maybeComplete();
				return;
			}
			nextExpectedSeq++;
			eventChain = eventChain.then(async () => {
				await options.onEvent(event);
				admittedEvents[event.seq - 1] = event;
				deliveredSeq = Math.max(deliveredSeq, event.seq);
				void maybeComplete();
			});
			eventChain.catch(error => rejectOnce(error instanceof Error ? error : new Error(String(error))));
		} catch (error) {
			rejectOnce(error instanceof Error ? error : new Error(String(error)));
		}
	});
	stderr.on("line", line => {
		try {
			const control = parseFrankControl(parseLine(line));
			switch (control.kind) {
				case "ack":
					if (control.turn_id !== 1) throw new Error(`Unexpected Frank ack turn_id ${control.turn_id}`);
					if (!control.accepted) throw new Error(control.error ?? "Frank rejected the submitted turn");
					accepted = true;
					void maybeComplete();
					return;
				case "heartbeat":
				case "saved":
				case "cancelled":
					return;
				case "terminal":
					if (control.turn_id !== 1) throw new Error(`Unexpected Frank terminal turn_id ${control.turn_id}`);
					terminal = control;
					foldedText = foldEventsToText(admittedEvents.filter((event): event is FrankEvent => event !== undefined && event.seq <= control.final_seq));
					void maybeComplete();
					return;
				case "error":
					const error = new FrankProtocolError(control.message);
					error.foldedText = foldedText;
					protocolError = error;
					rejectOnce(error);
					return;
				default: {
					const exhaustive: never = control;
					throw new Error(`Unhandled Frank control ${String(exhaustive)}`);
				}
			}
		} catch (error) {
			rejectOnce(error instanceof Error ? error : new Error(String(error)));
		}
	});
	child.on("error", error => rejectOnce(error));
	child.on("close", (code, signal) => {
		markClosed([code, signal]);
		void eventChain.then(() => {
			if (!settled && !completionStarted && accepted && terminal && deliveredSeq >= terminal.final_seq) {
				void maybeComplete();
				return;
			}
			if (!settled && !completionStarted) rejectOnce(new Error(`Frank exited before completing the turn (code ${code}, signal ${signal})`));
		}).catch(error => rejectOnce(error instanceof Error ? error : new Error(String(error))));
	});
	try {
		await writeLine(child.stdin, { op: "submit", turn_id: 1, text: options.text });
		const result = await completion;
		const deadline = new Promise<never>((_, reject) => {
			shutdownTimer = setTimeout(() => reject(new Error("Frank worker shutdown deadline exceeded")), closeTimeoutMs);
		});
		const interrupted = new Promise<never>((_, reject) => {
			interruptShutdown = () => reject(abortReason ?? new Error("Frank worker aborted"));
		});
		await Promise.race([child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : writeLine(child.stdin, { op: "shutdown" }).catch(error => {
			if (!settled && child.exitCode === null && child.signalCode === null) throw error;
		}), deadline, interrupted]);
		const [code, signal] = await Promise.race([closed, deadline, interrupted]);
		if (protocolError) throw protocolError;
		const childCode = code ?? (signal === "SIGKILL" ? 137 : 1);
		const decision = answerExitDecision(result.terminal.terminal, childCode, result.text);
		if (decision.error instanceof FrankWorkerExitError) throw decision.error;
		return { ...result, exitCode: decision.exitCode };
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			let graceTimer: NodeJS.Timeout | undefined;
			const grace = new Promise<void>(resolve => {
				graceTimer = setTimeout(resolve, closeTimeoutMs);
			});
			await Promise.race([closed, grace]);
			clearTimeout(graceTimer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await closed;
		throw failure ?? abortReason ?? (error instanceof Error ? error : new Error(String(error)));
	} finally {
		clearTimeout(timer);
		clearTimeout(shutdownTimer);
		options.signal?.removeEventListener("abort", abort);
		stdout.close();
		stderr.close();
	}
}
