import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
};

const FLUSH_ROUNDS = 8;

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	const promise = new Promise<T>(nextResolve => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < FLUSH_ROUNDS; index++) await Promise.resolve();
}

describe("AsyncJobManager straggler timing", () => {
	let manager: AsyncJobManager | undefined;
	let now = 0;

	beforeEach(() => {
		vi.useFakeTimers();
		now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		manager = new AsyncJobManager({
			maxRunningJobs: 3,
			retentionMs: 60_000,
		});
	});

	afterEach(async () => {
		if (manager) await manager.dispose({ timeoutMs: 1_000 });
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("retains queued state and reschedules a straggler from its actual start", async () => {
		const activeManager = manager!;
		const started: string[] = [];
		const aborted: Array<{ id: string; at: number }> = [];
		const completions = new Map<string, Deferred<string>>();
		const markRunningById = new Map<string, () => void>();
		const queuedStart = deferred<void>();

		const register = (id: string, queued: boolean) => {
			const completion = deferred<string>();
			completions.set(id, completion);
			return activeManager.register(
				"task",
				id,
				async ({ signal, markRunning }) => {
					markRunningById.set(id, markRunning);
					signal.addEventListener(
						"abort",
						() => {
							aborted.push({ id, at: Date.now() });
							completion.resolve("cancelled");
						},
						{ once: true },
					);
					if (id === "C") await queuedStart.promise;
					started.push(id);
					return completion.promise;
				},
				{
					id,
					ownerId: "owner",
					batchId: "batch",
					stragglerFloorMs: 1,
					queued,
				},
			);
		};

		const a = register("A", false);
		const b = register("B", false);
		const c = register("C", true);
		await flushMicrotasks();
		markRunningById.get("A")!();
		markRunningById.get("B")!();
		await flushMicrotasks();
		expect(started).toEqual(["A", "B"]);
		expect(activeManager.getJob(c)?.queued).toBe(true);

		// A's 100ms completion calibrates T=100ms. B therefore receives a
		// 2T=200ms active budget, measured from its actual start at t=0.
		now = 100;
		vi.advanceTimersByTime(100);
		completions.get("A")!.resolve("A done");
		await flushMicrotasks();
		expect(activeManager.getJob(a)?.status).toBe("completed");
		expect(aborted).toEqual([]);
		expect(activeManager.getJob(c)?.status).toBe("running");
		expect(activeManager.getJob(c)?.queued).toBe(true);

		// B is cancelled at its active deadline, while C remains queued and its
		// state is retained rather than being deleted with the first deadline.
		now = 199;
		vi.advanceTimersByTime(99);
		await flushMicrotasks();
		expect(aborted).toEqual([]);
		now = 200;
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(aborted).toEqual([{ id: "B", at: 200 }]);
		expect(activeManager.getJob(b)?.status).toBe("cancelled");
		expect(activeManager.getJob(c)?.status).toBe("running");
		expect(activeManager.getJob(c)?.queued).toBe(true);

		// C starts after 250ms of queue time. Its deadline must be rescheduled
		// from actualStartedAt=250, not inherited from registration at t=0.
		now = 250;
		vi.advanceTimersByTime(50);
		markRunningById.get("C")!();
		queuedStart.resolve();
		await flushMicrotasks();
		expect(started).toEqual(["A", "B", "C"]);
		expect(activeManager.getJob(c)?.queued).toBe(false);
		expect(activeManager.getJob(c)?.status).toBe("running");

		now = 449;
		vi.advanceTimersByTime(199);
		await flushMicrotasks();
		expect(aborted).toEqual([{ id: "B", at: 200 }]);
		expect(activeManager.getJob(c)?.status).toBe("running");

		now = 450;
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(aborted).toEqual([
			{ id: "B", at: 200 },
			{ id: "C", at: 450 },
		]);
		expect(activeManager.getJob(c)?.status).toBe("cancelled");
		await activeManager.waitForAll();
	});
});
