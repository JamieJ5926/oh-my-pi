import {
	type ExecutionBackendFactory,
	type ExecutionEvent,
	type ExecutionRequest,
	type ExecutionResult,
	type ExecutionSession,
	type ModelAttribution,
	modelAttribution,
	utf8ByteLength,
} from "../../runtime";
import {
	createPiBackend,
	type PiBackendOptions,
	type PiExecutionEvent,
	type PiExecutionSession,
	type PiTerminalResult,
} from "./backend";

export interface PiExecutionBackendFactoryOptions extends PiBackendOptions {
	readonly cwd: string;
}

export function createPiExecutionBackendFactory(
	options: PiExecutionBackendFactoryOptions,
): ExecutionBackendFactory {
	return {
		backend: "pi",
		async start(request, signal) {
			const raw = await createPiBackend(options).start({
				cwd: typeof request.metadata?.cwd === "string" ? request.metadata.cwd : options.cwd,
				provider: request.provider,
				model: request.model,
				sessionId: request.sessionId,
				sessionFile: typeof request.metadata?.sessionFile === "string" ? request.metadata.sessionFile : undefined,
			});
			return adaptPiSession(raw, request, signal, Date.now());
		},
		async close() {},
	};
}

function piFallback(fallback: "yes" | "no" | "unknown"): ModelAttribution["fallback"] {
	return fallback === "unknown" ? "unobserved" : fallback;
}

function piAttribution(
	request: ExecutionRequest,
	model: PiExecutionEvent["model"] | PiTerminalResult["model"],
): ModelAttribution {
	return modelAttribution(request, {
		...model,
		fallback: piFallback(model.fallback),
		...(model.fallback === "unknown" ? {} : { resolvedModelIsFallback: model.fallback === "yes" }),
	});
}

function piEventText({ event }: PiExecutionEvent): string | undefined {
	if (event.type !== "message_update") return undefined;
	if ("delta" in event && typeof event.delta === "string") return event.delta;
	const nested = "assistantMessageEvent" in event ? event.assistantMessageEvent : undefined;
	if (nested && typeof nested === "object" && "delta" in nested && typeof nested.delta === "string") {
		return nested.delta;
	}
	return undefined;
}

function toPiExecutionResult(
	request: ExecutionRequest,
	terminal: PiTerminalResult,
	startedAt: number,
	eventCount: number,
	cancellationRequested: boolean,
): ExecutionResult {
	const stopReason = terminal.stopReason === "aborted" || cancellationRequested ? "cancelled" : terminal.ok ? "completed" : "failed";
	return {
		executionId: request.executionId ?? "unknown",
		sessionId: terminal.sessionId,
		output: terminal.text,
		outputBytes: utf8ByteLength(terminal.text),
		stopReason,
		attribution: piAttribution(request, terminal.model),
		usage: terminal.usage
			? {
					inputTokens: terminal.usage.input,
					outputTokens: terminal.usage.output,
					totalTokens: terminal.usage.total,
					costUsd: terminal.usage.cost,
				}
			: undefined,
		telemetry: {
			startedAt,
			finishedAt: Date.now(),
			eventCount,
			droppedEventCount: 0,
			cancellationRequested: stopReason === "cancelled",
			backend: "pi",
		},
		...(terminal.error
			? { error: { code: stopReason === "cancelled" ? "CANCELLED" : "EXECUTION_FAILED", message: terminal.error } }
			: {}),
	};
}

function adaptPiSession(
	raw: PiExecutionSession,
	request: ExecutionRequest,
	signal: AbortSignal,
	startedAt: number,
): ExecutionSession {
	const terminal = raw.prompt(request.prompt, signal);
	let eventCount = 0;
	const result = terminal.then(value =>
		toPiExecutionResult(request, value, startedAt, eventCount, signal.aborted),
	);
	const events: AsyncIterable<ExecutionEvent> = {
		async *[Symbol.asyncIterator]() {
			for await (const event of raw.events) {
				eventCount += 1;
				const attribution = piAttribution(request, event.model);
				const executionId = request.executionId ?? "unknown";
				const text = piEventText(event);
				if (text) {
					yield { kind: "text-delta", executionId, sequence: event.sequence, text, attribution };
				} else if (event.event.type.startsWith("tool_") && "name" in event.event && typeof event.event.name === "string") {
					yield { kind: "tool-call", executionId, sequence: event.sequence, name: event.event.name, attribution };
				} else if (event.usage) {
					yield {
						kind: "usage",
						executionId,
						sequence: event.sequence,
						usage: {
							inputTokens: event.usage.input,
							outputTokens: event.usage.output,
							totalTokens: event.usage.total,
							costUsd: event.usage.cost,
						},
						attribution,
					};
				}
				if (event.event.type === "agent_end") {
					yield { kind: "terminal", executionId, sequence: Number.MAX_SAFE_INTEGER, result: await result };
					return;
				}
			}
			yield { kind: "terminal", executionId: request.executionId ?? "unknown", sequence: Number.MAX_SAFE_INTEGER, result: await result };
		},
	};
	return {
		events,
		result,
		cancel: reason => raw.cancel(reason),
		resume: async () => adaptPiSession(await raw.resume(), request, signal, Date.now()),
		dispose: () => raw.dispose(),
	};
}
