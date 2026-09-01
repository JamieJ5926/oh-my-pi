import { describe, expect, it } from "bun:test";
import { createPiExecutionBackendFactory } from "../../src/bridge/backends/pi";
import type { PiRpcProcess } from "../../src/bridge/backends/pi";
import type { ExecutionBackendFactory, ExecutionResult, ExecutionSession } from "../../src/bridge/runtime";
import { runSubprocess } from "../../src/task/executor";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function fakePiSpawn(frames: string[]): { spawn: (command: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined> }) => PiRpcProcess; writes: string[]; args: readonly string[] } {
	const writes: string[] = [];
	const captured: string[] = [];
	const encoder = new TextEncoder();
	const output = frames.join("\n") + "\n";
	return {
		writes,
		args: captured,
		spawn: (command: readonly string[], _options: { cwd?: string; env?: Record<string, string | undefined> }): PiRpcProcess => {
			captured.splice(0, captured.length, ...command);
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start(value) {
					controller = value;
				},
			});
			return {
				stdin: {
					write: data => {
						writes.push(data);
						const commandFrame = JSON.parse(data);
						if (typeof commandFrame === "object" && commandFrame !== null && "type" in commandFrame && commandFrame.type === "prompt") {
							controller.enqueue(encoder.encode(output));
						}
					},
				},
				stdout: stream,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		},
	};
}


function fakeOpenStreamFactory(result: ExecutionResult): ExecutionBackendFactory {
	let session!: ExecutionSession;
	session = {
		events: {
			async *[Symbol.asyncIterator]() {
				await new Promise<never>(() => {});
			},
		},
		result: Promise.resolve(result),
		cancel: async () => {},
		resume: async () => session,
		dispose: async () => {},
	};
	return {
		backend: "pi",
		start: async () => session,
	};
}

describe("runSubprocess Pi execution backend", () => {
	it("normalizes nested assistantMessageEvent.delta through the registered factory", async () => {
		const fake = fakePiSpawn([
			'{"type":"response","command":"prompt","success":true,"id":1}',
			'{"type":"session","id":"pi-session"}',
			'{"type":"message_start","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.6-sol"}}',
			'{"type":"message_update","usage":{"input":2,"output":1,"total":3,"cost":0.01},"assistantMessageEvent":{"type":"text_delta","delta":"OK"}}',
			'{"type":"message_update","usage":{"input":2,"output":1,"total":3,"cost":0.01},"assistantMessageEvent":{"type":"text_delta","delta":"OK"}}',
			'{"type":"agent_end","messages":[]}',
		]);
		const piFactory = createPiExecutionBackendFactory({
			cwd: "/tmp/pi-external-proof",
			spawn: fake.spawn,
		});
		const events: unknown[] = [];
		const terminalEvent = Promise.withResolvers<void>();
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, event => {
			events.push(event);
			if (JSON.stringify(event).includes("\"terminal\"")) terminalEvent.resolve();
		});
		const result = await runSubprocess({
			cwd: "/tmp/pi-external-proof",
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				model: ["requested/model"],
			},
			task: "reply OK",
			assignment: "reply OK",
			index: 0,
			id: "pi-external-proof",
			executionBackend: "pi",
			executionBackendRegistry: {
				get: backend => (backend === "pi" ? piFactory : undefined),
			},
			eventBus,
		});
		expect(result).toMatchObject({
			id: "pi-external-proof",
			exitCode: 0,
			output: "OKOK",
			resolvedModel: "openai-codex/gpt-5.6-sol",
			resolvedModelIsFallback: true,
			aborted: false,
			tokens: 3,
		});
		expect(result.requests).toBeGreaterThan(0);
		expect(fake.writes.some(write => write.includes('"type":"prompt"') && write.includes("reply OK"))).toBe(true);
		expect(fake.args).toEqual(expect.arrayContaining(["--mode", "rpc", "--provider", "requested", "--model", "model"]));
		expect(events.some(event => JSON.stringify(event).includes("text-delta"))).toBe(true);
		await terminalEvent.promise;
		expect(events.some(event => JSON.stringify(event).includes("\"terminal\""))).toBe(true);
	});

	it("does not wait for a custom backend event stream after the result resolves", async () => {
		const result = await runSubprocess({
			cwd: "/tmp/open-stream-proof",
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				model: ["requested/model"],
			},
			task: "reply OK",
			assignment: "reply OK",
			index: 1,
			id: "open-stream-proof",
			executionBackend: "pi",
			executionBackendRegistry: {
				get: backend =>
					backend === "pi"
						? fakeOpenStreamFactory({
								executionId: "open-stream-proof",
								output: "done",
								outputBytes: 4,
								stopReason: "completed",
								attribution: {
									fallback: "unobserved",
								},
								telemetry: {
									startedAt: 1,
									finishedAt: 2,
									eventCount: 0,
									droppedEventCount: 0,
									cancellationRequested: false,
									backend: "pi",
								},
							})
						: undefined,
			},
		});
		expect(result).toMatchObject({
			id: "open-stream-proof",
			exitCode: 0,
			output: "done",
			aborted: false,
		});
	});
});
