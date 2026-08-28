import { afterEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("AsyncJobManager straggler floor", () => {
	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	test("keeps a healthy sibling until normal completion past raw 2T", async () => {
		vi.useFakeTimers();
		setSystemTime(0);

		const aborted = new Map<string, number>();
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: () => {},
		});
		const options = {
			ownerId: "owner",
			batchId: "straggler-floor-batch",
			stragglerFloorMs: 30_000,
		};
		const run = (id: string, durationMs: number) =>
			async ({ signal }: { signal: AbortSignal }): Promise<string> => {
				signal.addEventListener("abort", () => aborted.set(id, (aborted.get(id) ?? 0) + 1), { once: true });
				await new Promise<void>(resolve => setTimeout(resolve, durationMs));
				return `${id} done`;
			};

		const firstJobId = manager.register("task", "first", run("first", 5_000), options);
		const siblingJobId = manager.register("task", "healthy sibling", run("sibling", 20_000), options);

		await flushMicrotasks();
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();

		// B=max(batch floor, 2T)=30s. A bare 2T timeout must not cancel either
		// the already-terminal first job or the still-healthy sibling.
		expect(manager.getJob(firstJobId)?.status).toBe("completed");
		expect(manager.getJob(siblingJobId)?.status).toBe("running");
		expect(aborted).toEqual(new Map());

		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		await manager.waitForAll();

		expect(manager.getJob(firstJobId)?.status).toBe("completed");
		expect(manager.getJob(siblingJobId)?.status).toBe("completed");
		expect(aborted).toEqual(new Map());

		await manager.drainDeliveries();
		await manager.dispose();
	});
});
