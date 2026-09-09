import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	type AsyncResultEntry,
	buildAsyncResultBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

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
