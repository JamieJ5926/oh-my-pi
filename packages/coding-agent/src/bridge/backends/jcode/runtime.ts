import {
	type ExecutionBackendFactory,
	type ExecutionEvent,
	type ExecutionRequest,
	type ExecutionResult,
	type ExecutionSession,
	modelAttribution,
} from "../../runtime";
import { JCodeBackendImpl, createJCodeBackend } from "./backend";
import type { JCodeBackendOptions, JCodeResult, JCodeSession } from "./protocol";

export interface JCodeExecutionBackendFactoryOptions extends Omit<JCodeBackendOptions, "cwd" | "generation" | "onTransportDeath"> {
	/** Fallback cwd when a request carries no `metadata.cwd`. */
	readonly cwd?: string;
}

type BackendTerminal = { readonly backend: "jcode"; readonly value: JCodeResult };

function toExecutionResult(request: ExecutionRequest, terminal: BackendTerminal): ExecutionResult {
	const value = terminal.value;
	const stopReason = value.stopReason === "cancelled" ? "cancelled" : value.stopReason === "failed" ? "failed" : "completed";
	const attribution = modelAttribution(request, { ...value, fallback: value.resolvedModelIsFallback === true ? "yes" : value.resolvedModelIsFallback === false ? "no" : "unobserved", ...(value.resolvedModelIsFallback === undefined ? {} : { resolvedModelIsFallback: value.resolvedModelIsFallback }) });
	return { executionId: request.executionId ?? "unknown", sessionId: value.sessionId, output: value.output, outputBytes: new TextEncoder().encode(value.output).byteLength, stopReason, attribution, usage: value.usage ? { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, costUsd: value.usage.costUsd } : undefined, telemetry: { ...value.telemetry, backend: "jcode" } };
}

export function adaptJCodeSession(raw: JCodeSession, request: ExecutionRequest, signal: AbortSignal): ExecutionSession {
	const abort = () => { void raw.cancel(); };
	const terminal = raw.prompt(request.prompt, signal).finally(() => signal.removeEventListener("abort", abort));
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	const executionId = request.executionId ?? "unknown";
	const events: AsyncIterable<ExecutionEvent> = {
		async *[Symbol.asyncIterator]() {
			for await (const event of raw.events) {
				const attribution = modelAttribution(request, event.kind === "terminal" ? event.result : undefined);
				if (event.kind === "text-delta") yield { kind: "text-delta", executionId, sequence: event.sequence, text: event.text, attribution };
				else if (event.kind === "tool-call") yield { kind: "tool-call", executionId, sequence: event.sequence, name: event.name, status: event.status, attribution };
				else if (event.kind === "usage") yield { kind: "usage", executionId, sequence: event.sequence, usage: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, costUsd: event.usage.costUsd }, attribution };
				else if (event.kind === "terminal") yield { kind: "terminal", executionId, sequence: event.sequence, result: toExecutionResult(request, { backend: "jcode", value: event.result }) };
				else if (event.kind === "error") yield { kind: "error", executionId, sequence: event.sequence, code: event.error.code, message: event.error.message, attribution };
				else if (event.kind === "buffer-overflow") yield { kind: "overflow", executionId, sequence: event.sequence, droppedEvents: event.droppedEvents, droppedBytes: 0 };
			}
		},
	};
	return { events, result: terminal.then((value: JCodeResult) => toExecutionResult(request, { backend: "jcode", value })), cancel: () => raw.cancel(), resume: async () => { await raw.resume(); return adaptJCodeSession(raw, request, signal); }, dispose: () => raw.dispose(), softInterrupt: (content, urgent) => raw.softInterrupt(content, urgent), cancelSoftInterrupts: () => raw.cancelSoftInterrupts() };
}

/**
 * One JCode transport (one daemon) pooled across every execution that goes
 * through this factory. The transport is initialized once per lifetime and
 * each start only opens a session. A transport death retires the backend and
 * bumps the generation; sessions bound to an older generation fail closed on
 * resume instead of silently `session/load`-ing across daemons.
 */
export function createJCodeExecutionBackendFactory(options: JCodeExecutionBackendFactoryOptions): ExecutionBackendFactory {
	const bindings = new Map<string, number>();
	let backend: JCodeBackendImpl | undefined;
	let generation = 0;

	const ensureBackend = () => {
		if (backend) return backend;
		const lifetimeGeneration = generation;
		backend = createJCodeBackend({
			...options,
			cwd: options.cwd ?? process.cwd(),
			generation: lifetimeGeneration,
			onTransportDeath: () => {
				if (backend?.generation !== lifetimeGeneration) return;
				generation = lifetimeGeneration + 1;
				backend = undefined;
			},
		});
		return backend;
	};

	return {
		backend: "jcode",
		async start(request, signal) {
			const target = ensureBackend();
			if (request.sessionId !== undefined && request.sessionId !== "") {
				const bound = bindings.get(request.sessionId);
				if (bound !== target.generation) {
					throw new Error(`Stale JCode session ${request.sessionId}: bound to transport generation ${bound ?? "none"}, current generation is ${target.generation}`);
				}
			}
			const cwd = typeof request.metadata?.cwd === "string" ? request.metadata.cwd : options.cwd;
			const raw = await target.start({ cwd, provider: request.provider, model: request.model, sessionId: request.sessionId, resume: request.sessionId !== undefined });

			bindings.set(raw.address.sessionId, target.generation);
			return adaptJCodeSession(raw, request, signal);
		},
		async close() {
			const current = backend;
			backend = undefined;
			bindings.clear();
			await current?.close();
		},
	};
}
