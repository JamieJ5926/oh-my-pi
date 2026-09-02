import { describe, expect, it } from "bun:test";
import {
	createJCodeBackend,
	createJCodeExecutionBackendFactory,
	type JCodeBackendOptions,
	type JCodeExecutionBackendFactoryOptions,
	type JCodeHarnessConnection,
} from "../src/bridge/backends/jcode";
import {
	HARNESS_PROTOCOL_VERSION,
	type HarnessEvent,
	type HarnessRequest,
} from "../src/bridge/backends/jcode/harness-protocol";

let nextFakeSession = 0;

function attached(sessionId: string): HarnessEvent {
	return { ev: "attached", session: { session_id: sessionId, status: "ready" } };
}

class FakeHarnessConnection implements JCodeHarnessConnection {
	readonly requests: HarnessRequest[] = [];
	readonly #eventListeners = new Set<(event: HarnessEvent) => void>();
	readonly #deathListeners = new Set<(error?: Error) => void>();
	readonly #holdPrompt: boolean;
	readonly #failPrompt: boolean;
	#dead = false;
	readonly #requestWaiters: Array<() => void> = [];

	constructor(holdPrompt = false, failPrompt = false) {
		this.#holdPrompt = holdPrompt;
		this.#failPrompt = failPrompt;
	}

	async request(req: HarnessRequest, _options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HarnessEvent> {
		if (this.#dead) throw new Error("JCode transport has died");
		this.requests.push(req);
		this.#flushRequestWaiters();
		switch (req.req) {
			case "hello":
				return { ev: "hello_ok", version: HARNESS_PROTOCOL_VERSION, server: "fake" };
			case "create_session":
				return attached(`jcode-session-${++nextFakeSession}`);
			case "attach_session":
				return attached(req.session_id);
			case "send_message":
				if (this.#failPrompt) throw new Error("prompt failed");
				if (!this.#holdPrompt) {
					this.emit({ ev: "text_delta", session_id: req.session_id, text: `reply-${req.session_id}` });
					this.emit({ ev: "turn_done", session_id: req.session_id });
				}
				return { ev: "message_accepted", session_id: req.session_id };
			case "cancel":
				this.emit({ ev: "turn_done", session_id: req.session_id });
				return { ev: "ok" };
			case "detach_session":
			default:
				return { ev: "ok" };
		}
	}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onDeath(listener: (error?: Error) => void): () => void {
		this.#deathListeners.add(listener);
		return () => this.#deathListeners.delete(listener);
	}

	close(): void {}

	emit(event: HarnessEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	die(error?: Error): void {
		this.#dead = true;
		for (const listener of this.#deathListeners) listener(error);
	}

	#flushRequestWaiters(): void {
		const waiters = this.#requestWaiters.splice(0);
		for (const waiter of waiters) waiter();
	}

	async waitFor(predicate: (requests: readonly HarnessRequest[]) => boolean): Promise<void> {
		for (;;) {
			if (predicate(this.requests)) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#requestWaiters.push(resolve);
			await promise;
		}
	}
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
	const collected: T[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

function options(
	connection: FakeHarnessConnection,
	limits: Pick<JCodeBackendOptions, "maxBufferedEvents" | "maxBufferedBytes"> = {},
): JCodeBackendOptions {
	return {
		cwd: process.cwd(),
		provider: "openai",
		model: "gpt-5.6-sol",
		...limits,
		connectionFactory: async () => connection,
	};
}

describe("JCode structured backend", () => {
	it("multiplexes independent logical sessions and preserves attribution", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection));
		const [left, right] = await Promise.all([backend.start({}), backend.start({})]);
		expect(left.address.sessionId).not.toBe(right.address.sessionId);
		expect(left.address.generation).toBe(right.address.generation);
		const [leftResult, rightResult] = await Promise.all([left.prompt("left"), right.prompt("right")]);
		expect(leftResult.output).toContain(left.address.sessionId);
		expect(rightResult.output).toContain(right.address.sessionId);
		expect(leftResult.requestedModel).toBe("gpt-5.6-sol");
		expect(rightResult.requestedProvider).toBe("openai");
		expect(connection.requests.filter(request => request.req === "create_session")).toHaveLength(2);
		await backend.close();
	});

	it("maps cancellation and supports resume without terminal scraping", async () => {
		const connection = new FakeHarnessConnection(true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({ sessionId: "existing", resume: true });
		const prompt = session.prompt("long-running");
		await session.cancel();
		const result = await prompt;
		expect(result.stopReason).toBe("cancelled");
		expect(connection.requests.some(item => item.req === "cancel")).toBe(true);
		await session.resume();
		expect(connection.requests.some(item => item.req === "attach_session")).toBe(true);
		expect(session.state.kind).toBe("running");
		await session.dispose();
		await backend.close();
	});

	it("closes the event stream after one terminal event and suppresses late updates", async () => {
		const connection = new FakeHarnessConnection(true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		const eventsPromise = collectEvents(session.events);
		const prompt = session.prompt("long-running");
		await session.cancel();
		const result = await prompt;
		connection.emit({ ev: "text_delta", session_id: session.address.sessionId, text: "late" });
		const events = await eventsPromise;
		expect(result.stopReason).toBe("cancelled");
		expect(events.filter(event => event.kind === "terminal")).toHaveLength(1);
		expect(events.map(event => event.kind)).toEqual(["terminal"]);
		expect(await session.events[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
		await backend.close();
	});

	it("closes the event stream after a failed prompt", async () => {
		const connection = new FakeHarnessConnection(false, true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		const eventsPromise = collectEvents(session.events);
		await expect(session.prompt("fails")).rejects.toThrow("prompt failed");
		const events = await eventsPromise;
		expect(events.map(event => event.kind)).toEqual(["error"]);
		expect(await session.events[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
		await backend.close();
	});

	it("reopens a usable event stream after resume", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		await session.prompt("first");
		await session.resume();
		const eventsPromise = collectEvents(session.events);
		const result = await session.prompt("second");
		const events = await eventsPromise;
		expect(result.stopReason).toBe("completed");
		expect(events.map(event => event.kind)).toEqual(["text-delta", "terminal"]);
		expect(connection.requests.filter(request => request.req === "attach_session")).toHaveLength(1);
		await backend.close();
	});

	it("keeps buffered events within count and byte bounds while retaining terminal", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection, { maxBufferedEvents: 1, maxBufferedBytes: 1_000 }));
		const session = await backend.start({});
		await session.prompt("bounded");
		const events = await collectEvents(session.events);
		expect(events.map(event => event.kind)).toEqual(["terminal"]);
		await backend.close();
	});

	it("keeps the terminal event observable under a byte bound", async () => {
		const connection = new FakeHarnessConnection();
		const terminalBytes = 1_000;
		const backend = createJCodeBackend(
			options(connection, { maxBufferedEvents: 8, maxBufferedBytes: terminalBytes }),
		);
		const session = await backend.start({});
		await session.prompt("bounded");
		const events = await collectEvents(session.events);
		expect(events.at(-1)?.kind).toBe("terminal");
		await backend.close();
	});

	it("settles the prompt and closes without buffering an oversized terminal", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection, { maxBufferedEvents: 8, maxBufferedBytes: 1 }));
		const session = await backend.start({});
		const result = await session.prompt("too-large");
		expect(result.output).toContain(session.address.sessionId);
		expect(await session.events[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
		await backend.close();
	});

	it("settles a held prompt when disposed and closes the stream", async () => {
		const connection = new FakeHarnessConnection(true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		const eventsPromise = collectEvents(session.events);
		const prompt = session.prompt("held");
		await session.dispose();
		await expect(prompt).rejects.toThrow("JCode session disposed");
		expect(await eventsPromise).toEqual([]);
		expect(await session.events[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
		await session.dispose();
		await backend.close();
	});

	it("processes terminal updates carrying usage before standalone usage", async () => {
		const connection = new FakeHarnessConnection(true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		const eventsPromise = collectEvents(session.events);
		const pending = session.prompt("final");
		connection.emit({ ev: "token_usage", session_id: session.address.sessionId, input: 7, output: 9 });
		connection.emit({ ev: "turn_done", session_id: session.address.sessionId });
		const result = await pending;
		const events = await eventsPromise;
		expect(events.map(event => event.kind)).toEqual(["usage", "terminal"]);
		expect(result.stopReason).toBe("completed");
		expect(result.usage?.inputTokens).toBe(7);
		expect(result.usage?.outputTokens).toBe(9);
		await backend.close();
	});

	it("preserves explicit terminal attribution and leaves absent fallback unobserved", async () => {
		const connection = new FakeHarnessConnection(true);
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		const pending = session.prompt("final");
		connection.emit({
			ev: "model_info",
			session_id: session.address.sessionId,
			provider: "resolved-openai",
			model: "resolved-model",
		});
		connection.emit({ ev: "turn_done", session_id: session.address.sessionId });
		const result = await pending;
		expect(result.resolvedProvider).toBe("resolved-openai");
		expect(result.resolvedModel).toBe("resolved-model");
		expect(result.resolvedModelIsFallback).toBeUndefined();
		await backend.close();
	});
});

describe("JCode host tool callback and soft interrupt", () => {
	const hostTool = { name: "echo", description: "echo", input_schema: { type: "object" } };

	function hostCall(sessionId: string, callId: string, name = "echo", args: unknown = { x: 1 }): HarnessEvent {
		return { ev: "host_tool_call", session_id: sessionId, call_id: callId, name, arguments: args };
	}

	function results(connection: FakeHarnessConnection) {
		return connection.requests.filter(request => request.req === "host_tool_result");
	}

	it("includes host_tools on create_session and replies success/error/terminal outcomes", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend({
			...options(connection),
			hostTools: [hostTool],
			hostToolDispatcher: async call => {
				if (call.name === "fail") return { ok: false, error: "nope", terminal: true };
				return { ok: true, result: { echoed: call.arguments }, terminal: true };
			},
		});
		const session = await backend.start({});
		expect(connection.requests.find(request => request.req === "create_session")).toMatchObject({
			host_tools: [hostTool],
		});
		connection.emit(hostCall(session.address.sessionId, "c-ok"));
		await connection.waitFor(requests =>
			requests.some(request => request.req === "host_tool_result" && request.call_id === "c-ok"),
		);
		expect(results(connection)).toEqual([
			{
				req: "host_tool_result",
				session_id: session.address.sessionId,
				call_id: "c-ok",
				result: { echoed: { x: 1 } },
				terminal: true,
			},
		]);
		connection.emit(hostCall(session.address.sessionId, "c-err", "fail"));
		await connection.waitFor(requests =>
			requests.some(request => request.req === "host_tool_result" && request.call_id === "c-err"),
		);
		expect(results(connection).at(-1)).toEqual({
			req: "host_tool_result",
			session_id: session.address.sessionId,
			call_id: "c-err",
			error: "nope",
			terminal: true,
		});
		await backend.close();
	});

	it("returns an error result when no dispatcher is configured", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		connection.emit(hostCall(session.address.sessionId, "c-none"));
		await connection.waitFor(requests =>
			requests.some(request => request.req === "host_tool_result" && request.call_id === "c-none"),
		);
		expect(results(connection)).toEqual([
			{
				req: "host_tool_result",
				session_id: session.address.sessionId,
				call_id: "c-none",
				error: "no host tool dispatcher",
			},
		]);
		await backend.close();
	});

	it("rejects duplicate call ids without a second dispatcher invocation", async () => {
		const connection = new FakeHarnessConnection();
		let invocations = 0;
		const { promise, resolve } = Promise.withResolvers<void>();
		const backend = createJCodeBackend({
			...options(connection),
			hostToolDispatcher: async () => {
				invocations++;
				await promise;
				return { ok: true, result: "once" };
			},
		});
		const session = await backend.start({});
		connection.emit(hostCall(session.address.sessionId, "dup"));
		connection.emit(hostCall(session.address.sessionId, "dup"));
		await connection.waitFor(requests =>
			requests.some(request => request.req === "host_tool_result" && request.call_id === "dup"),
		);
		expect(invocations).toBe(1);
		expect(results(connection)).toEqual([
			{
				req: "host_tool_result",
				session_id: session.address.sessionId,
				call_id: "dup",
				error: "duplicate host tool call id",
			},
		]);
		resolve();
		await connection.waitFor(
			requests =>
				requests.filter(request => request.req === "host_tool_result" && request.call_id === "dup").length >= 2,
		);
		expect(results(connection).at(-1)).toEqual({
			req: "host_tool_result",
			session_id: session.address.sessionId,
			call_id: "dup",
			result: "once",
		});
		await backend.close();
	});

	it("does not send a late host_tool_result after dispose", async () => {
		const connection = new FakeHarnessConnection();
		const { promise, resolve } = Promise.withResolvers<void>();
		const backend = createJCodeBackend({
			...options(connection),
			hostToolDispatcher: async call => {
				await promise;
				if (call.signal.aborted) return { ok: false, error: "aborted" };
				return { ok: true, result: "late" };
			},
		});
		const session = await backend.start({});
		connection.emit(hostCall(session.address.sessionId, "late"));
		await session.dispose();
		resolve();
		await Promise.resolve();
		expect(results(connection)).toEqual([]);
		await backend.close();
	});

	it("routes host_tool_call by session_id and leaves the sibling idle", async () => {
		const connection = new FakeHarnessConnection();
		const seen: string[] = [];
		const backend = createJCodeBackend({
			...options(connection),
			hostToolDispatcher: async call => {
				seen.push(call.sessionId);
				return { ok: true, result: call.sessionId };
			},
		});
		const [left, right] = await Promise.all([backend.start({}), backend.start({})]);
		connection.emit(hostCall(left.address.sessionId, "only-left"));
		await connection.waitFor(requests =>
			requests.some(request => request.req === "host_tool_result" && request.call_id === "only-left"),
		);
		expect(seen).toEqual([left.address.sessionId]);
		expect(results(connection)).toEqual([
			{
				req: "host_tool_result",
				session_id: left.address.sessionId,
				call_id: "only-left",
				result: left.address.sessionId,
			},
		]);
		expect(right.address.sessionId).not.toBe(left.address.sessionId);
		await backend.close();
	});

	it("sends exact soft_interrupt and cancel_soft_interrupts frames", async () => {
		const connection = new FakeHarnessConnection();
		const backend = createJCodeBackend(options(connection));
		const session = await backend.start({});
		await session.softInterrupt("nudge", true);
		await session.cancelSoftInterrupts();
		expect(
			connection.requests.filter(
				request => request.req === "soft_interrupt" || request.req === "cancel_soft_interrupts",
			),
		).toEqual([
			{ req: "soft_interrupt", session_id: session.address.sessionId, content: "nudge", urgent: true },
			{ req: "cancel_soft_interrupts", session_id: session.address.sessionId },
		]);
		await backend.close();
	});

	it("aborts pending host callbacks on transport death without a late result", async () => {
		const connection = new FakeHarnessConnection(true);
		const { promise, resolve } = Promise.withResolvers<void>();
		let aborted = false;
		const backend = createJCodeBackend({
			...options(connection),
			hostToolDispatcher: async call => {
				call.signal.addEventListener("abort", () => {
					aborted = true;
				});
				await promise;
				return { ok: true, result: "after-death" };
			},
		});
		const session = await backend.start({});
		const prompt = session.prompt("held");
		connection.emit(hostCall(session.address.sessionId, "dying"));
		connection.die(new Error("daemon crashed"));
		await expect(prompt).rejects.toThrow("daemon crashed");
		expect(aborted).toBe(true);
		resolve();
		await Promise.resolve();
		expect(results(connection)).toEqual([]);
		await backend.close();
	});

	it("forwards softInterrupt through the execution adapter", async () => {
		const connection = new FakeHarnessConnection();
		const factory = createJCodeExecutionBackendFactory({
			cwd: process.cwd(),
			connectionFactory: async () => connection,
		});
		const exec = await factory.start({ backend: "jcode", prompt: "go" }, new AbortController().signal);
		await exec.result;
		await exec.softInterrupt?.("ping");
		await exec.cancelSoftInterrupts?.();
		expect(connection.requests.some(request => request.req === "soft_interrupt" && request.content === "ping")).toBe(
			true,
		);
		expect(connection.requests.some(request => request.req === "cancel_soft_interrupts")).toBe(true);
		await factory.close?.();
	});
});

describe("JCode shared execution backend factory", () => {
	class DeathConnection extends FakeHarnessConnection {
		#releaseLongRunning: (() => void) | undefined;

		override async request(
			req: HarnessRequest,
			options?: { timeoutMs?: number; signal?: AbortSignal },
		): Promise<HarnessEvent> {
			if (req.req === "send_message" && req.content === "long-running") {
				this.requests.push(req);
				const { promise, resolve } = Promise.withResolvers<HarnessEvent>();
				this.#releaseLongRunning = () => resolve({ ev: "message_accepted", session_id: req.session_id });
				return promise;
			}
			return super.request(req, options);
		}

		releaseLongRunning(): void {
			this.#releaseLongRunning?.();
			this.#releaseLongRunning = undefined;
		}
	}

	function factoryOptions(transports: DeathConnection[]): JCodeExecutionBackendFactoryOptions {
		return {
			cwd: "/tmp/factory-fallback",
			provider: "openai",
			model: "gpt-5.6-sol",
			connectionFactory: async () => {
				const connection = new DeathConnection();
				transports.push(connection);
				return connection;
			},
		};
	}

	function cwdOf(req: HarnessRequest): string | undefined {
		return req.req === "create_session" ? req.working_dir : undefined;
	}

	it("initializes the transport once and honors each request cwd", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory(factoryOptions(transports));
		const [left, right] = await Promise.all([
			factory.start(
				{ backend: "jcode", prompt: "left", metadata: { cwd: "/tmp/left" } },
				new AbortController().signal,
			),
			factory.start(
				{ backend: "jcode", prompt: "right", metadata: { cwd: "/tmp/right" } },
				new AbortController().signal,
			),
		]);
		expect(transports).toHaveLength(1);
		expect(transports[0].requests.filter(request => request.req === "hello")).toHaveLength(1);
		const creations = transports[0].requests.filter(request => request.req === "create_session");
		expect(creations).toHaveLength(2);
		expect(creations.map(request => cwdOf(request)).sort()).toEqual(["/tmp/left", "/tmp/right"]);
		const [leftResult, rightResult] = await Promise.all([left.result, right.result]);
		expect(leftResult.stopReason).toBe("completed");
		expect(rightResult.stopReason).toBe("completed");
		expect(leftResult.sessionId).not.toBe(rightResult.sessionId);
		expect(leftResult.attribution.fallback).toBe("unobserved");
		expect((await collectEvents(left.events)).map(event => event.kind)).toEqual(["text-delta", "terminal"]);
	});

	it("isolates interleaved sessions and cancels only the cancelled session", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory(factoryOptions(transports));
		const held = await factory.start(
			{ backend: "jcode", prompt: "long-running", metadata: { cwd: "/tmp/held" } },
			new AbortController().signal,
		);
		const quick = await factory.start(
			{ backend: "jcode", prompt: "quick", metadata: { cwd: "/tmp/quick" } },
			new AbortController().signal,
		);
		const heldEvents = collectEvents(held.events);
		const quickResult = await quick.result;
		expect(quickResult.output).toContain(quickResult.sessionId ?? "");
		expect(quickResult.stopReason).toBe("completed");
		await held.cancel();
		const heldResult = await held.result;
		expect(heldResult.stopReason).toBe("cancelled");
		expect((await heldEvents).map(event => event.kind)).toEqual(["terminal"]);
	});

	it("retires the transport on death, bumps generation, and rejects stale resumes", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory(factoryOptions(transports));
		const first = await factory.start(
			{ backend: "jcode", prompt: "first", metadata: { cwd: "/tmp/one" } },
			new AbortController().signal,
		);
		const firstResult = await first.result;
		const staleId = firstResult.sessionId;
		transports[0].die(new Error("daemon crashed"));
		const second = await factory.start(
			{ backend: "jcode", prompt: "second", metadata: { cwd: "/tmp/two" } },
			new AbortController().signal,
		);
		await second.result;
		expect(transports[1]).not.toBe(transports[0]);
		expect(transports).toHaveLength(2);
		expect(transports[1].requests.filter(request => request.req === "hello")).toHaveLength(1);
		await expect(
			factory.start(
				{ backend: "jcode", prompt: "stale", sessionId: staleId, metadata: { cwd: "/tmp/one" } },
				new AbortController().signal,
			),
		).rejects.toThrow(/Stale JCode session/);
		await expect(first.resume()).rejects.toThrow(/transport/);
		await expect(
			factory.start(
				{ backend: "jcode", prompt: "unbound", sessionId: "never-bound", metadata: { cwd: "/tmp/one" } },
				new AbortController().signal,
			),
		).rejects.toThrow(/Stale JCode session/);
	});

	it("uses the factory cwd when the request has none", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory(factoryOptions(transports));
		const session = await factory.start({ backend: "jcode", prompt: "fallback" }, new AbortController().signal);
		const creations = transports[0].requests.filter(request => request.req === "create_session");
		expect(creations.map(request => cwdOf(request))).toEqual(["/tmp/factory-fallback"]);
		expect((await session.result).stopReason).toBe("completed");
	});

	it("forwards prompt failure as an execution error event", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory({
			...factoryOptions(transports),
			connectionFactory: async () => {
				const connection = new DeathConnection();
				transports.push(connection);
				const original = connection.request.bind(connection);
				connection.request = async (req, opts) => {
					if (req.req === "send_message") throw new Error("prompt failed");
					return original(req, opts);
				};
				return connection;
			},
		});
		const session = await factory.start(
			{ backend: "jcode", prompt: "fails", metadata: { cwd: "/tmp/fail" } },
			new AbortController().signal,
		);
		const events = collectEvents(session.events);
		await expect(session.result).rejects.toThrow("prompt failed");
		expect((await events).map(event => event.kind)).toEqual(["error"]);
	});

	it("sends session cancellation when the execution signal aborts", async () => {
		const transports: DeathConnection[] = [];
		const factory = createJCodeExecutionBackendFactory(factoryOptions(transports));
		const controller = new AbortController();
		const session = await factory.start(
			{ backend: "jcode", prompt: "long-running", metadata: { cwd: "/tmp/abort" } },
			controller.signal,
		);
		controller.abort();
		const result = await session.result;
		expect(result.stopReason).toBe("cancelled");
		expect(transports[0].requests.filter(request => request.req === "cancel")).toHaveLength(1);
	});

	it("returns a cancelled terminal when a signal-aware transport would abort the prompt RPC", async () => {
		class AbortAwareConnection extends DeathConnection {
			override async request(
				req: HarnessRequest,
				options?: { timeoutMs?: number; signal?: AbortSignal },
			): Promise<HarnessEvent> {
				const signal = options?.signal;
				if (signal?.aborted) throw new Error("JCode request aborted");
				if (req.req !== "send_message" || !signal) return super.request(req, options);
				const { promise, resolve, reject } = Promise.withResolvers<HarnessEvent>();
				const onAbort = () => reject(new Error("JCode request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				super.request(req).then(
					value => {
						signal.removeEventListener("abort", onAbort);
						resolve(value);
					},
					error => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
				return promise;
			}
		}
		const transports: AbortAwareConnection[] = [];
		const factory = createJCodeExecutionBackendFactory({
			cwd: "/tmp/factory-fallback",
			provider: "openai",
			model: "gpt-5.6-sol",
			connectionFactory: async () => {
				const connection = new AbortAwareConnection();
				transports.push(connection);
				return connection;
			},
		});
		const controller = new AbortController();
		const session = await factory.start(
			{ backend: "jcode", prompt: "long-running", metadata: { cwd: "/tmp/abort-aware" } },
			controller.signal,
		);
		controller.abort();
		const result = await session.result;
		expect(result.stopReason).toBe("cancelled");
		expect(transports[0].requests.filter(request => request.req === "cancel")).toHaveLength(1);

		const already = new AbortController();
		already.abort();
		const preAborted = await factory.start(
			{ backend: "jcode", prompt: "long-running", metadata: { cwd: "/tmp/pre-aborted" } },
			already.signal,
		);
		const preAbortedResult = await preAborted.result;
		expect(preAbortedResult.stopReason).toBe("cancelled");
	});
});
