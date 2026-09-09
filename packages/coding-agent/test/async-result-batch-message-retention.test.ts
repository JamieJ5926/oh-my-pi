import { describe, expect, test, vi } from "bun:test";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	buildAsyncResultBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function entry(jobId: string, sizeChars: string | number): AsyncResultEntry {
	const result = typeof sizeChars === "string" ? sizeChars : "x".repeat(sizeChars);
	return { jobId, result, job: undefined, durationMs: 1, epoch: 0 };
}

describe("async-result batch message retention bound", () => {
	test("small results pass through verbatim", () => {
		const message = buildAsyncResultBatchMessage([entry("job-small", "hello world")]);
		expect(message).not.toBeNull();
		expect(message!.content).toContain("hello world");
	});

	test("empty entries produce no message", () => {
		expect(buildAsyncResultBatchMessage([])).toBeNull();
	});

	test("over-threshold results never embed the full body in transcript content", () => {
		const oversize = ASYNC_INLINE_RESULT_MAX_CHARS + 50_000;
		const message = buildAsyncResultBatchMessage([entry("job-big", oversize)]);
		expect(message).not.toBeNull();
		const content = message!.content;
		// Transcript content must stay bounded: preview scale, not payload scale.
		expect(content.length).toBeLessThan(ASYNC_INLINE_RESULT_MAX_CHARS);
		// Preview head is preserved so the follow-up stays useful.
		expect(content).toContain("x".repeat(100));
		// The full 50k+ body must not be embedded.
		expect(content.length).toBeLessThan(oversize / 2);
	});

	test("mixed batch keeps small results intact while capping large ones", () => {
		const oversize = ASYNC_INLINE_RESULT_MAX_CHARS + 50_000;
		const message = buildAsyncResultBatchMessage([entry("job-small", "keep me"), entry("job-big", oversize)]);
		expect(message).not.toBeNull();
		const content = message!.content;
		expect(content).toContain("keep me");
		expect(content.length).toBeLessThan(oversize);
	});

	test("preview length stays at preview scale", () => {
		const oversize = ASYNC_INLINE_RESULT_MAX_CHARS * 4;
		const message = buildAsyncResultBatchMessage([entry("job-big", oversize)]);
		expect(message).not.toBeNull();
		// Preview + truncation note; generous ceiling well below payload scale.
		expect(message!.content.length).toBeLessThan(ASYNC_PREVIEW_MAX_CHARS + 1_000);
	});
});

describe("async job manager evict-on-consume", () => {
	test("large delivered bodies are released on settle; small bodies stay inspectable", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});
		try {
			const big = "y".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 10_000);
			const bigId = manager.register("bash", "big job", async () => big);
			const smallId = manager.register("bash", "small job", async () => "small ok");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });

			// Delivery itself is unaffected: the sink got the full payload.
			expect(delivered.find(d => d.jobId === bigId)?.text).toBe(big);
			expect(manager.isJobResultConsumed(bigId)).toBe(true);
			// Retained floor removed: the row no longer pins the 22KB body.
			expect(manager.getJob(bigId)?.resultText).toBeUndefined();
			// Small-body inspectability contract preserved.
			expect(manager.getJob(smallId)?.resultText).toBe("small ok");
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("snapshot recovery releases large bodies and resume never redelivers them", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
		});
		try {
			const big = "z".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 10_000);
			// Owned with no live sink: no auto-delivery can win the race, so
			// foreground recovery is the first (and only) consume.
			const jobId = manager.register("bash", "big job", async () => big, { ownerId: "TestOwner" });
			await manager.waitForAll();
			// Foreground snapshot recovers the body first (suppresses delivery).
			expect(manager.consumeJobResults([jobId])).toBe(1);
			expect(manager.getJob(jobId)?.resultText).toBeUndefined();
			// Lifting the suppression must not redeliver the consumed result.
			manager.resumeDeliveries([jobId]);
			expect(await manager.drainDeliveries({ timeoutMs: 500 })).toBe(true);
			expect(delivered).toEqual([]);
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});
});

describe("spill-failure retry + row intact", () => {
	async function buildSpillSession(tempDir: TempDir) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});
		return { manager, sessionManager, session, authStorage };
	}

	async function spillFailureCase(mode: "throw" | "falsy") {
		const tempDir = TempDir.createSync("@pi-o32-spill-");
		const { manager, sessionManager, session, authStorage } = await buildSpillSession(tempDir);
		try {
			const allocateSpy = vi.spyOn(sessionManager, "allocateArtifactPath");
			if (mode === "throw") allocateSpy.mockRejectedValue(new Error("disk gone"));
			else allocateSpy.mockResolvedValue({});
			const big = "s".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 10_000);
			const jobId = manager.register("bash", "spill job", async () => big, { ownerId: "SubAgent" });
			await manager.waitForAll();
			// Retryable, not terminal: the delivery is still queued, nothing consumed.
			expect(await manager.drainDeliveries({ timeoutMs: 300 })).toBe(false);
			expect(manager.hasPendingDeliveries()).toBe(true);
			expect(manager.isJobResultConsumed(jobId)).toBe(false);
			expect(manager.getJob(jobId)?.resultText).toBe(big);
			// Spill succeeds on retry: full body lands in the artifact, delivery settles.
			const spillPath = join(tempDir.path(), `async-spill-${mode}.txt`);
			allocateSpy.mockResolvedValue({ path: spillPath, id: `spill-${mode}` });
			expect(await manager.drainDeliveries({ timeoutMs: 5_000 })).toBe(true);
			expect(manager.isJobResultConsumed(jobId)).toBe(true);
			expect(await Bun.file(spillPath).text()).toBe(big);
		} finally {
			await session.dispose();
			authStorage.close();
			AsyncJobManager.resetForTests();
			tempDir.removeSync();
		}
	}

	test("allocate throw: delivery retries with row intact, then recovers", () => spillFailureCase("throw"));
	test("falsy allocate: delivery retries with row intact, then recovers", () => spillFailureCase("falsy"));
});

describe("vibe wait consumed note", () => {
	test("consumed large bodies report delivery instead of (no output)", async () => {
		const manager = new AsyncJobManager({});
		const vibes = VibeSessionRegistry.global();
		try {
			const toolSession = {
				getAgentId: () => "o32-owner",
				getSessionId: () => "test-parent-session",
				getSessionFile: () => null,
				asyncJobManager: manager,
			} as unknown as ToolSession;
			const big = "v".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 10_000);
			const jobId = manager.register("task", "vibe turn", async () => big, { ownerId: "o32-owner" });
			vibes.registerRecordForTests({ id: "o32-worker", ownerId: "o32-owner", jobId });
			await manager.waitForAll();
			// First recovery carries the full body (no regression).
			const first = await vibes.wait(toolSession, { timeoutMs: 1_000 });
			expect(first.settled.map(entry => entry.jobId)).toEqual([jobId]);
			expect(first.settled[0]?.resultText).toBe(big);
			// After foreground recovery releases the row, wait reports delivery.
			expect(manager.consumeJobResults([jobId])).toBe(1);
			const second = await vibes.wait(toolSession, { timeoutMs: 1_000 });
			expect(second.settled[0]?.resultText).toBe("Delivery: already delivered or recovered.");
		} finally {
			await manager.dispose({ timeoutMs: 100 });
			VibeSessionRegistry.resetGlobalForTests();
		}
	});
	test("small consumed bodies still show retained text, not the note", async () => {
		const manager = new AsyncJobManager({});
		const vibes = VibeSessionRegistry.global();
		try {
			const toolSession = {
				getAgentId: () => "o32-owner",
				getSessionId: () => "test-parent-session",
				getSessionFile: () => null,
				asyncJobManager: manager,
			} as unknown as ToolSession;
			const jobId = manager.register("task", "small vibe turn", async () => "small ok", { ownerId: "o32-owner" });
			vibes.registerRecordForTests({ id: "o32-worker-small", ownerId: "o32-owner", jobId });
			await manager.waitForAll();
			const first = await vibes.wait(toolSession, { timeoutMs: 1_000 });
			expect(first.settled[0]?.resultText).toBe("small ok");
			// Consume keeps the small body on the row; the note must not mask it.
			expect(manager.consumeJobResults([jobId])).toBe(1);
			expect(manager.getJob(jobId)?.resultText).toBe("small ok");
			const second = await vibes.wait(toolSession, { timeoutMs: 1_000 });
			expect(second.settled[0]?.resultText).toBe("small ok");
		} finally {
			await manager.dispose({ timeoutMs: 100 });
			VibeSessionRegistry.resetGlobalForTests();
		}
	});
});
