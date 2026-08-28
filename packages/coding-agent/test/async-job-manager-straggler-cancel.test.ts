import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager, STRAGGLER_CANCEL_REASON } from "@oh-my-pi/pi-coding-agent/async/job-manager";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("AsyncJobManager straggler cancellation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("calibrates a same-batch sibling to 2T, preserves other batches, and uses the strict cancel reason", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const fast = Promise.withResolvers<string>();
		let siblingSignal: AbortSignal | undefined;
		let isolatedSignal: AbortSignal | undefined;
		const siblingStopped = Promise.withResolvers<string>();
		const isolatedStopped = Promise.withResolvers<string>();
		const ownerId = "owner-1";
		const batchId = "batch-a";

		const fastJobId = manager.register("task", "fast", async () => fast.promise, {
			ownerId,
			batchId,
			logicalItemId: "fast",
			stragglerFloorMs: 1,
		});
		const siblingJobId = manager.register(
			"task",
			"same-batch sibling",
			async ({ signal }) => {
				siblingSignal = signal;
				if (signal.aborted) {
					siblingStopped.resolve("cancelled");
				} else {
					signal.addEventListener("abort", () => siblingStopped.resolve("cancelled"), { once: true });
				}
				return siblingStopped.promise;
			},
			{
				ownerId,
				batchId,
				logicalItemId: "sibling",
				stragglerFloorMs: 1,
			},
		);
		const isolatedJobId = manager.register(
			"task",
			"different-batch sibling",
			async ({ signal }) => {
				isolatedSignal = signal;
				if (signal.aborted) {
					isolatedStopped.resolve("cancelled");
				} else {
					signal.addEventListener("abort", () => isolatedStopped.resolve("cancelled"), { once: true });
				}
				return isolatedStopped.promise;
			},
			{
				ownerId,
				batchId: "batch-b",
				logicalItemId: "isolated",
				stragglerFloorMs: 1,
			},
		);

		// The first completion at t=10 establishes T=10 and a same-batch deadline at 2T=t=20.
		vi.advanceTimersByTime(10);
		fast.resolve("fast result");
		await flushMicrotasks();
		expect(manager.getJob(fastJobId)?.status).toBe("completed");

		// One millisecond before 2T, both the same-batch sibling and the other batch remain live.
		vi.advanceTimersByTime(9);
		await flushMicrotasks();
		expect(manager.getJob(siblingJobId)?.status).toBe("running");
		expect(manager.getJob(isolatedJobId)?.status).toBe("running");
		expect(siblingSignal?.aborted).toBe(false);
		expect(isolatedSignal?.aborted).toBe(false);

		// At the calibrated deadline only the matching batch is cancelled.
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(manager.getJob(siblingJobId)?.status).toBe("cancelled");
		expect(siblingSignal?.aborted).toBe(true);
		expect(siblingSignal?.reason).toBe(STRAGGLER_CANCEL_REASON);
		expect(manager.getJob(isolatedJobId)?.status).toBe("running");
		expect(isolatedSignal?.aborted).toBe(false);

		await siblingStopped.promise;
		manager.cancel(isolatedJobId);
		await isolatedStopped.promise;
		await manager.waitForAll();
		expect(manager.getJob(fastJobId)?.status).toBe("completed");
		expect(manager.getJob(siblingJobId)?.status).toBe("cancelled");
		expect(manager.getJob(isolatedJobId)?.status).toBe("cancelled");
		await manager.dispose();
	});
});
