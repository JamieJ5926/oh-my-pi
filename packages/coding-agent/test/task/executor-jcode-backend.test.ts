import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createJCodeExecutionBackendFactory, type JCodeHarnessConnection } from "../../src/bridge/backends/jcode";
import { HARNESS_PROTOCOL_VERSION, type HarnessEvent, type HarnessRequest } from "../../src/bridge/backends/jcode/harness-protocol";
import type { ExecutionBackendFactory, ExecutionResult, ExecutionSession } from "../../src/bridge";
import { runSubprocess } from "../../src/task/executor";
import { MAX_OUTPUT_LINES } from "../../src/task/types";
let nextFakeSession = 0;

class FakeConnection implements JCodeHarnessConnection {
	readonly #listeners = new Set<(event: HarnessEvent) => void>();

	async request(request: HarnessRequest): Promise<HarnessEvent> {
		switch (request.req) {
			case "hello":
				return { ev: "hello_ok", version: HARNESS_PROTOCOL_VERSION, server: "test" };
			case "create_session":
				return { ev: "attached", session: { session_id: `jcode-session-${++nextFakeSession}`, status: "ready" } };
			case "send_message":
				this.emit({ ev: "text_delta", session_id: request.session_id, text: `reply-${request.session_id}` });
				this.emit({ ev: "turn_done", session_id: request.session_id });
				return { ev: "message_accepted", session_id: request.session_id };
			default:
				return { ev: "ok" };
		}
	}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onDeath(): () => void { return () => undefined; }
	close(): void {}

	private emit(event: HarnessEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function agentOptions(backend: "jcode") {
	return {
		cwd: "/tmp/jcode-gate-proof",
		agent: {
			name: "task",
			description: "test",
			systemPrompt: "test",
			source: "bundled" as const,
			model: ["requested/model"],
		},
		task: "reply OK",
		assignment: "reply OK",
		index: 0,
		id: "jcode-gate-proof",
		executionBackend: backend,
	};
}

describe("runSubprocess JCode execution backend", () => {
	it("rejects an implicit jcode request with a fail-closed unsupported-route error", async () => {
		expect(runSubprocess(agentOptions("jcode"))).rejects.toThrow(
			"executionBackend 'jcode' is not available without an explicit executionBackendRegistry supplying a caller-scoped JCode backend factory",
		);
	});

	it("runs jcode through an explicitly injected registry", async () => {
		const jcodeFactory = createJCodeExecutionBackendFactory({
			provider: "provider-a",
			model: "model-a",
			connectionFactory: async () => new FakeConnection(),
		});
		const result = await runSubprocess({
			...agentOptions("jcode"),
			executionBackendRegistry: { get: backend => (backend === "jcode" ? jcodeFactory : undefined) },
		});
		expect(result).toMatchObject({
			id: "jcode-gate-proof",
			exitCode: 0,
			aborted: false,
		});
		expect(result.output).toContain("reply-jcode-session-");
	});

	it("disposes the ExecutionSession after a terminal result", async () => {
		let disposed = 0;
		const inner = createJCodeExecutionBackendFactory({
			provider: "provider-a",
			model: "model-a",
			connectionFactory: async () => new FakeConnection(),
		});
		const factory = {
			backend: "jcode" as const,
			async start(request: Parameters<typeof inner.start>[0], signal: AbortSignal) {
				const session = await inner.start(request, signal);
				return {
					...session,
					dispose: async () => {
						disposed += 1;
						await session.dispose?.();
					},
				};
			},
		};
		await runSubprocess({
			...agentOptions("jcode"),
			executionBackendRegistry: { get: backend => (backend === "jcode" ? factory : undefined) },
		});
		expect(disposed).toBe(1);
	});
});

function completedResult(output: string): ExecutionResult {
	return {
		executionId: "jcode-overflow",
		output,
		outputBytes: Buffer.byteLength(output),
		stopReason: "completed",
		attribution: { fallback: "unobserved" },
		telemetry: {
			startedAt: 1,
			finishedAt: 2,
			eventCount: 1,
			droppedEventCount: 0,
			cancellationRequested: false,
			backend: "jcode",
		},
	};
}

function factoryWithOutput(output: string): ExecutionBackendFactory {
	let session!: ExecutionSession;
	session = {
		events: {
			async *[Symbol.asyncIterator]() {},
		},
		result: Promise.resolve(completedResult(output)),
		cancel: async () => {},
		resume: async () => session,
		dispose: async () => {},
	};
	return {
		backend: "jcode",
		start: async () => session,
	};
}

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("runSubprocess JCode oversized output artifacts", () => {
	it("persists complete output and truncates inline when line limit is exceeded", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-overflow-"));
		tempDirs.push(artifactsDir);
		const full = Array.from({ length: MAX_OUTPUT_LINES + 2 }, (_, i) => `line-${i}`).join("\n");
		const result = await runSubprocess({
			...agentOptions("jcode"),
			id: "jcode-overflow",
			artifactsDir,
			executionBackendRegistry: { get: backend => (backend === "jcode" ? factoryWithOutput(full) : undefined) },
		});
		expect(result.truncated).toBe(true);
		expect(result.output).not.toBe(full);
		expect(result.output.length).toBeLessThan(full.length);
		expect(result.outputPath).toBe(path.join(artifactsDir, "jcode-overflow.md"));
		expect(result.outputMeta).toEqual({
			lineCount: full.split("\n").length,
			charCount: full.length,
		});
		expect(await Bun.file(result.outputPath!).text()).toBe(full);
	});

	it("leaves ordinary and exact-boundary output inline without an artifact", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-boundary-"));
		tempDirs.push(artifactsDir);
		const exact = Array.from({ length: MAX_OUTPUT_LINES }, (_, i) => `line-${i}`).join("\n");
		const ordinary = "short-ok";
		for (const [id, output] of [
			["jcode-exact", exact],
			["jcode-ordinary", ordinary],
		] as const) {
			const result = await runSubprocess({
				...agentOptions("jcode"),
				id,
				artifactsDir,
				executionBackendRegistry: { get: backend => (backend === "jcode" ? factoryWithOutput(output) : undefined) },
			});
			expect(result.truncated).toBe(false);
			expect(result.output).toBe(output);
			expect(result.outputPath).toBeUndefined();
			expect(result.outputMeta).toBeUndefined();
			expect(result.error).toBeUndefined();
			expect(await Bun.file(path.join(artifactsDir, `${id}.md`)).exists()).toBe(false);
		}
	});

	it("keeps truncated output when artifact write fails", async () => {
		const blocker = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-block-"));
		tempDirs.push(blocker);
		const artifactsDir = path.join(blocker, "not-a-dir");
		await Bun.write(artifactsDir, "file");
		const full = Array.from({ length: MAX_OUTPUT_LINES + 2 }, (_, i) => `line-${i}`).join("\n");
		const result = await runSubprocess({
			...agentOptions("jcode"),
			id: "jcode-write-fail",
			artifactsDir,
			executionBackendRegistry: { get: backend => (backend === "jcode" ? factoryWithOutput(full) : undefined) },
		});
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeGreaterThan(0);
		expect(result.output).not.toBe(full);
		expect(result.outputPath).toBeUndefined();
		expect(result.error).toContain("artifact write failed");
	});
});

