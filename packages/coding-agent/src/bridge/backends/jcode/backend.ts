// JCode backend over the explicit harness NDJSON API. One lazy private
// launcher/connection per backend; one hello per connection; create_session or
// attach_session per start; send_message → streaming events → turn_done; cancel;
// detach + connection close on dispose/close. Preserved from the ACP era:
// bounded event queue, generation fencing, exactly-once terminal, death failure.
import { createConnection } from "node:net";
import { HARNESS_PROTOCOL_VERSION, type HarnessEvent } from "./harness-protocol";
import { DEFAULT_REQUEST_TIMEOUT_MS, HarnessSocketTransport } from "./harness-transport";
import {
	type JCodeAttribution,
	type JCodeBackend,
	type JCodeBackendOptions,
	type JCodeError,
	type JCodeEvent,
	type JCodeHarnessConnection,
	type JCodeResult,
	type JCodeSession,
	type JCodeSessionAddress,
	type HostToolCall,
	type HostToolOutcome,
	type JCodeSessionSpec,
	type JCodeSessionState,
	type JCodeTelemetry,
	type JCodeUsage,
} from "./protocol";

const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_BYTES = 1_048_576;

interface EventQueue {
	readonly iterable: AsyncIterable<JCodeEvent>;
	push(event: JCodeEvent): void;
	close(): void;
}

function createEventQueue(maxEvents: number, maxBytes: number): EventQueue {
	const events: JCodeEvent[] = [];
	const waiters: Array<(result: IteratorResult<JCodeEvent>) => void> = [];
	let bytes = 0;
	let closed = false;
	let dropped = 0;
	let sequence = 0;

	function eventSize(event: JCodeEvent): number {
		return Buffer.byteLength(JSON.stringify(event), "utf8");
	}

	function evictOldest(): void {
		const removed = events.shift();
		if (!removed) return;
		bytes -= eventSize(removed);
		dropped++;
	}

	function hasRoom(eventCount: number, eventBytes: number): boolean {
		return events.length + eventCount <= maxEvents && bytes + eventBytes <= maxBytes;
	}

	function push(event: JCodeEvent): void {
		if (closed) return;
		const size = eventSize(event);
		const terminal = event.kind === "terminal" || event.kind === "error";
		if (waiters.length > 0) {
			waiters.shift()?.({ value: event, done: false });
			return;
		}
		if (size > maxBytes) {
			dropped++;
			return;
		}
		while (!hasRoom(1, size) && events.length > 0) evictOldest();
		if (!hasRoom(1, size)) {
			if (!terminal) dropped++;
			return;
		}
		if (dropped > 0 && !terminal) {
			const overflow: JCodeEvent = { kind: "buffer-overflow", droppedEvents: dropped, sequence: ++sequence };
			const overflowSize = eventSize(overflow);
			while (!hasRoom(2, overflowSize + size) && events.length > 0) evictOldest();
			if (hasRoom(2, overflowSize + size)) {
				events.push(overflow);
				bytes += overflowSize;
				dropped = 0;
			}
		}
		events.push(event);
		bytes += size;
	}

	function close(): void {
		if (closed) return;
		closed = true;
		while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
	}

	const iterable: AsyncIterable<JCodeEvent> = {
		[Symbol.asyncIterator](): AsyncIterator<JCodeEvent> {
			return {
				next(): Promise<IteratorResult<JCodeEvent>> {
					const event = events.shift();
					if (event) {
						bytes -= eventSize(event);
						return Promise.resolve({ value: event, done: false });
					}
					if (closed) return Promise.resolve({ value: undefined, done: true });
					const { promise, resolve } = Promise.withResolvers<IteratorResult<JCodeEvent>>();
					waiters.push(resolve);
					return promise;
				},
			};
		},
	};
	return { iterable, push, close };
}

async function openHarnessSocket(socketPath: string): Promise<JCodeHarnessConnection> {
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return new HarnessSocketTransport(socket);
}

function usageFromTokenUsage(event: Extract<HarnessEvent, { ev: "token_usage" }>): JCodeUsage {
	return {
		inputTokens: event.input,
		outputTokens: event.output,
		...(event.cache_read_input === undefined ? {} : { cacheReadTokens: event.cache_read_input }),
	};
}

function hasSessionId(event: HarnessEvent): event is HarnessEvent & { session_id: string } {
	return "session_id" in event && typeof event.session_id === "string";
}

/** Session id from a create_session/attach_session reply: `attached` carries it, `ok` defers to the caller's id. */
function sessionIdFromReply(reply: HarnessEvent, requested: string | undefined): string | undefined {
	if (reply.ev === "attached") return reply.session.session_id;
	if (reply.ev === "ok" && requested) return requested;
	return undefined;
}

class JCodeSessionImpl implements JCodeSession {
	readonly address: JCodeSessionAddress;
	readonly #connection: JCodeHarnessConnection;
	readonly #options: JCodeBackendOptions;
	readonly #onDispose: (sessionId: string) => void;
	#queue: EventQueue;
	#startedAt = Date.now();
	#state: JCodeSessionState = { kind: "new" };
	#sequence = 0;
	#output = "";
	#usage: JCodeUsage | undefined;
	#attribution: JCodeAttribution;
	#pending:
		| { resolve: (result: JCodeResult) => void; reject: (error: Error) => void; cancellationRequested: boolean }
		| undefined;
	#eventCount = 0;
	#hostCalls = new Map<string, AbortController>();
	#terminal = false;
	#droppedEvents = 0;
	#disposed = false;

	constructor(
		connection: JCodeHarnessConnection,
		options: JCodeBackendOptions,
		spec: JCodeSessionSpec,
		address: JCodeSessionAddress,
		onDispose: (sessionId: string) => void,
		initialState: JCodeSessionState = { kind: "new" },
	) {
		this.#connection = connection;
		this.address = address;
		this.#onDispose = onDispose;
		this.#queue = createEventQueue(
			options.maxBufferedEvents ?? DEFAULT_MAX_EVENTS,
			options.maxBufferedBytes ?? DEFAULT_MAX_BYTES,
		);
		this.#attribution = {
			requestedProvider: spec.provider ?? options.provider,
			requestedModel: spec.model ?? options.model,
			resolvedProvider: undefined,
			resolvedModel: undefined,
		};
		this.#state = initialState;
	}

	get state(): JCodeSessionState {
		return this.#state;
	}
	get events(): AsyncIterable<JCodeEvent> {
		return this.#queue.iterable;
	}

	async prompt(text: string, signal?: AbortSignal): Promise<JCodeResult> {
		if (this.#disposed) throw new Error("JCode session is disposed");
		if (this.#pending) throw new Error("JCode session already has a prompt in flight");
		this.#state = { kind: "running" };
		const { promise, resolve, reject } = Promise.withResolvers<JCodeResult>();
		this.#pending = { resolve, reject, cancellationRequested: false };
		const turn = this.#pending;
		if (signal) {
			const abort = () => void this.cancel();
			if (signal.aborted) abort();
			else {
				signal.addEventListener("abort", abort, { once: true });
				void promise.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
			}
		}
		void this.#connection
			.request(
				{ req: "send_message", session_id: this.address.sessionId, content: text },
				{ timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, signal },
			)
			.catch(error => {
				if (this.#pending === turn && !turn.cancellationRequested) {
					this.#fail({ code: "JCODE_ERROR", message: error instanceof Error ? error.message : String(error) });
				}
			});
		return promise;
	}

	async cancel(): Promise<void> {
		if (!this.#pending || this.#state.kind === "cancelling" || this.#disposed) return;
		this.#state = { kind: "cancelling" };
		this.#pending.cancellationRequested = true;
		try {
			await this.#connection.request({ req: "cancel", session_id: this.address.sessionId });
		} catch {
			// The connection death handler settles the session if the cancel never lands.
		}
	}

	async softInterrupt(content: string, urgent?: boolean): Promise<void> {
		if (this.#disposed) throw new Error("JCode session is disposed");
		await this.#connection.request(
			{
				req: "soft_interrupt",
				session_id: this.address.sessionId,
				content,
				...(urgent === undefined ? {} : { urgent }),
			},
			{ timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
		);
	}

	async cancelSoftInterrupts(): Promise<void> {
		if (this.#disposed) throw new Error("JCode session is disposed");
		await this.#connection.request(
			{ req: "cancel_soft_interrupts", session_id: this.address.sessionId },
			{ timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
		);
	}

	async resume(): Promise<void> {
		if (this.#disposed) throw new Error("JCode session is disposed");
		await this.#connection.request({ req: "attach_session", session_id: this.address.sessionId });
		this.#queue.close();
		this.#queue = createEventQueue(
			this.#options.maxBufferedEvents ?? DEFAULT_MAX_EVENTS,
			this.#options.maxBufferedBytes ?? DEFAULT_MAX_BYTES,
		);
		this.#state = { kind: "running" };
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortHostCalls();
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending) pending.reject(new Error("JCode session disposed"));
		try {
			await this.#connection.request({ req: "detach_session", session_id: this.address.sessionId });
		} catch {
			// Best effort: the connection may already be gone.
		}
		this.#queue.close();
		this.#state = { kind: "disposed" };
		this.#onDispose(this.address.sessionId);
	}

	onConnectionDeath(error?: Error): void {
		this.#abortHostCalls();
		this.#fail({ code: "JCODE_TRANSPORT_DEAD", message: error?.message ?? "harness connection closed" });
	}

	#makeResult(stopReason: JCodeResult["stopReason"]): JCodeResult {
		return {
			...this.#attribution,
			sessionId: this.address.sessionId,
			output: this.#output,
			stopReason,
			usage: this.#usage,
			telemetry: this.#telemetry(this.#pending?.cancellationRequested ?? false),
		};
	}

	#telemetry(cancellationRequested: boolean): JCodeTelemetry {
		return {
			startedAt: this.#startedAt,
			finishedAt: Date.now(),
			eventCount: this.#eventCount,
			droppedEventCount: this.#droppedEvents,
			transport: "harness",
			cancellationRequested,
		};
	}

	handleEvent(event: HarnessEvent): void {
		if (this.#disposed) return;
		switch (event.ev) {
			case "host_tool_call": {
				void this.#handleHostToolCall(event);
				return;
			}
			case "text_delta": {
				this.#eventCount++;
				this.#output += event.text;
				this.#queue.push({ kind: "text-delta", text: event.text, sequence: ++this.#sequence });
				return;
			}
			case "tool_start":
			case "tool_exec":
			case "tool_done": {
				this.#eventCount++;
				const status = event.ev === "tool_start" ? "running" : event.ev === "tool_exec" ? "executing" : "done";
				this.#queue.push({ kind: "tool-call", name: event.name, status, sequence: ++this.#sequence, raw: event });
				return;
			}
			case "token_usage": {
				this.#usage = usageFromTokenUsage(event);
				this.#eventCount++;
				this.#queue.push({ kind: "usage", usage: this.#usage, sequence: ++this.#sequence });
				return;
			}
			case "model_info": {
				this.#attribution = {
					...this.#attribution,
					...(event.provider === undefined ? {} : { resolvedProvider: event.provider }),
					...(event.model === undefined ? {} : { resolvedModel: event.model }),
				};
				return;
			}
			case "session_status":
			case "connection_phase": {
				this.#eventCount++;
				this.#queue.push({
					kind: "status",
					status: event.ev === "session_status" ? event.status : event.phase,
					sequence: ++this.#sequence,
					raw: event,
				});
				return;
			}
			case "turn_done": {
				this.#finish(this.#makeResult(this.#pending?.cancellationRequested === true ? "cancelled" : "completed"));
				return;
			}
			case "error": {
				this.#fail({ code: event.code, message: event.message });
				return;
			}
			default:
				return;
		}
	}

	#abortHostCalls(): void {
		for (const controller of this.#hostCalls.values()) controller.abort();
		this.#hostCalls.clear();
	}

	async #handleHostToolCall(event: Extract<HarnessEvent, { ev: "host_tool_call" }>): Promise<void> {
		if (this.#disposed || this.#terminal) return;
		if (this.#hostCalls.has(event.call_id)) {
			void this.#sendHostToolResult(event.call_id, { ok: false, error: "duplicate host tool call id" });
			return;
		}
		const generation = this.address.generation;
		const controller = new AbortController();
		this.#hostCalls.set(event.call_id, controller);
		const dispatcher = this.#options.hostToolDispatcher;
		let outcome: HostToolOutcome;
		if (!dispatcher) {
			outcome = { ok: false, error: "no host tool dispatcher" };
		} else {
			const call: HostToolCall = {
				sessionId: this.address.sessionId,
				callId: event.call_id,
				name: event.name,
				arguments: event.arguments,
				generation,
				signal: controller.signal,
			};
			try {
				outcome = await dispatcher(call);
			} catch (error) {
				outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (
			this.#disposed ||
			this.#terminal ||
			this.address.generation !== generation ||
			!this.#hostCalls.has(event.call_id)
		)
			return;
		this.#hostCalls.delete(event.call_id);
		await this.#sendHostToolResult(event.call_id, outcome);
	}

	async #sendHostToolResult(callId: string, outcome: HostToolOutcome): Promise<void> {
		if (this.#disposed || this.#terminal) return;
		const frame = outcome.ok
			? {
					req: "host_tool_result" as const,
					session_id: this.address.sessionId,
					call_id: callId,
					result: outcome.result,
					...(outcome.terminal === undefined ? {} : { terminal: outcome.terminal }),
				}
			: {
					req: "host_tool_result" as const,
					session_id: this.address.sessionId,
					call_id: callId,
					error: outcome.error,
					...(outcome.terminal === undefined ? {} : { terminal: outcome.terminal }),
				};
		try {
			await this.#connection.request(frame, {
				timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			});
		} catch {
			// Best effort: death/dispose may already have torn the connection down.
		}
	}

	#finish(result: JCodeResult): void {
		const pending = this.#pending;
		if (!pending || this.#disposed) return;
		this.#pending = undefined;
		this.#state = { kind: "completed", result };
		this.#terminal = true;
		this.#abortHostCalls();
		this.#eventCount++;
		this.#queue.push({ kind: "terminal", result, sequence: ++this.#sequence });
		this.#queue.close();
		pending.resolve(result);
	}

	#fail(error: JCodeError): void {
		const pending = this.#pending;
		if (!pending || this.#disposed) return;
		this.#pending = undefined;
		this.#state = { kind: "failed", error };
		this.#terminal = true;
		this.#abortHostCalls();
		this.#eventCount++;
		this.#queue.push({ kind: "error", error, sequence: ++this.#sequence });
		this.#queue.close();
		pending.reject(new Error(error.message));
	}
}

export class JCodeBackendImpl implements JCodeBackend {
	readonly backend = "jcode" as const;
	readonly #options: JCodeBackendOptions;
	readonly #sessions = new Map<string, JCodeSessionImpl>();
	#connectionPromise: Promise<JCodeHarnessConnection> | undefined;
	#helloPromise: Promise<void> | undefined;
	#launcher: { readonly socketPath: string; close(): Promise<void> } | undefined;
	#generation: number;
	#dead = false;
	#eventsBound = false;

	constructor(options: JCodeBackendOptions) {
		this.#options = options;
		this.#generation = options.generation ?? 0;
	}

	get generation(): number {
		return this.#generation;
	}

	/** One launcher/connection per backend, created lazily on the first start. */
	#connect(): Promise<JCodeHarnessConnection> {
		if (this.#connectionPromise) return this.#connectionPromise;
		this.#connectionPromise = (async () => {
			const options = this.#options;
			let connection: JCodeHarnessConnection;
			if (options.connectionFactory) {
				connection = await options.connectionFactory(options);
			} else if (options.socketPath) {
				connection = await (options.openConnection ?? openHarnessSocket)(options.socketPath);
			} else {
				this.#launcher = await (
					options.launchFactory ??
					(opts =>
						launchHarness({
							binary: opts.command?.[0] ?? "jcode",
							workingDir: opts.cwd,
							env: { ...opts.env },
							provider: opts.provider,
							providerProfile: opts.providerProfile,
							model: opts.model,
							startupTimeoutMs: opts.startupTimeoutMs,
						}))
				)(options);
				connection = await (options.openConnection ?? openHarnessSocket)(this.#launcher.socketPath);
			}
			if (!this.#eventsBound) {
				this.#eventsBound = true;
				connection.onEvent(event => this.#dispatchEvent(event));
			}
			connection.onDeath(error => this.#onConnectionDeath(error));
			return connection;
		})();
		this.#connectionPromise.catch(() => undefined);
		return this.#connectionPromise;
	}

	/** Exactly one hello per connection lifetime. */
	#hello(): Promise<void> {
		if (this.#helloPromise) return this.#helloPromise;
		this.#helloPromise = (async () => {
			const connection = await this.#connect();
			const reply = await connection.request(
				{
					req: "hello",
					min_version: HARNESS_PROTOCOL_VERSION,
					max_version: HARNESS_PROTOCOL_VERSION,
					client: "omp-jcode-bridge",
				},
				{ timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
			);
			if (reply.ev !== "hello_ok") throw new Error(`harness hello failed: ${reply.ev}`);
		})();
		this.#helloPromise.catch(() => undefined);
		return this.#helloPromise;
	}

	async start(spec: JCodeSessionSpec): Promise<JCodeSession> {
		if (this.#dead) throw new Error("JCode transport has died");
		const connection = await this.#connect();
		await this.#hello();
		if (this.#dead) throw new Error("JCode transport has died");
		const isResume = spec.resume === true && spec.sessionId !== undefined;
		const requestedId = isResume ? spec.sessionId : undefined;
		const hostTools = spec.hostTools ?? this.#options.hostTools;
		const reply = await connection.request(
			isResume
				? { req: "attach_session", session_id: requestedId as string }
				: {
						req: "create_session",
						working_dir: spec.cwd ?? this.#options.cwd,
						...(hostTools === undefined ? {} : { host_tools: hostTools }),
					},
		);
		if (reply.ev === "error") throw new Error(reply.message);
		const sessionId = sessionIdFromReply(reply, requestedId);
		if (sessionId === undefined) throw new Error("harness reply did not contain a session id");
		const session = new JCodeSessionImpl(
			connection,
			this.#options,
			spec,
			{
				namespace: "omp",
				host: process.env.HOSTNAME ?? "localhost",
				process: String(process.pid),
				backend: "jcode",
				sessionId,
				generation: this.#generation,
			},
			id => this.#sessions.delete(id),
			isResume ? { kind: "running" } : { kind: "new" },
		);
		this.#sessions.set(sessionId, session);
		return session;
	}

	async attach(sessionId: string, spec: JCodeSessionSpec = {}): Promise<JCodeSession> {
		return this.start({ ...spec, sessionId, resume: true });
	}

	async close(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		for (const session of sessions) await session.dispose();
		const connectionPromise = this.#connectionPromise;
		this.#connectionPromise = undefined;
		this.#helloPromise = undefined;
		if (connectionPromise) {
			const connection = await connectionPromise.catch(() => undefined);
			connection?.close();
		}
		const launcher = this.#launcher;
		this.#launcher = undefined;
		await launcher?.close();
	}

	#dispatchEvent(event: HarnessEvent): void {
		if (hasSessionId(event)) {
			this.#sessions.get(event.session_id)?.handleEvent(event);
			return;
		}
		for (const session of this.#sessions.values()) session.handleEvent(event);
	}

	#onConnectionDeath(error?: Error): void {
		this.#dead = true;
		for (const session of this.#sessions.values()) session.onConnectionDeath(error);
		this.#options.onTransportDeath?.(error ?? new Error("harness connection closed"));
	}
}

export function createJCodeBackend(options: JCodeBackendOptions): JCodeBackendImpl {
	return new JCodeBackendImpl(options);
}


declare module "./protocol" {
	// (placeholder removed below)
}

