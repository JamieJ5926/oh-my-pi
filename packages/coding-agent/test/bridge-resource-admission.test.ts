import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";

describe("AsyncJobManager admission", () => {
	test("reserves synchronously and drains a max-two queue FIFO", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 2, retentionMs: 60_000 });
		const started: string[] = [];
		const releases: Array<() => void> = [];
		const run = (name: string) => async (): Promise<string> => {
			started.push(name);
			await new Promise<void>(resolve => releases.push(resolve));
			return name;
		};

		manager.register("task", "one", run("one"));
		manager.register("task", "two", run("two"));
		const three = manager.register("task", "three", run("three"));
		const four = manager.register("task", "four", run("four"));

		expect(started).toEqual(["one", "two"]);
		expect(manager.atCapacity).toBe(true);
		expect(manager.getJob(three)?.queued).toBe(true);
		expect(manager.getJob(four)?.queued).toBe(true);

		const first = manager.getAllJobs().find(job => job.label === "one");
		releases.shift()?.();
		await first?.promise;
		expect(started).toEqual(["one", "two", "three"]);
		releases.shift()?.();
		const second = manager.getAllJobs().find(job => job.label === "two");
		await second?.promise;
		expect(started).toEqual(["one", "two", "three", "four"]);
		for (const release of releases) release();
		await manager.waitForAll();
		await manager.dispose();
	});

	test("cancelling a queued job settles it without invoking its thunk", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 60_000 });
		const release = Promise.withResolvers<void>();
		let invoked = false;
		const first = manager.register("task", "first", async () => {
			await release.promise;
			return "first";
		});
		const second = manager.register("task", "second", async () => {
			invoked = true;
			return "second";
		});

		expect(manager.cancel(second)).toBe(true);
		expect(manager.cancel(second)).toBe(false);
		release.resolve();
		await manager.waitForAll();
		expect(invoked).toBe(false);
		expect(manager.getJob(second)?.status).toBe("cancelled");
		expect(manager.getJob(first)?.status).toBe("completed");
		await manager.dispose();
	});

	test("promotes the next job after a running cancellation settles", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 60_000 });
		const started = Promise.withResolvers<void>();
		let promoted = false;
		const first = manager.register("task", "first", async ({ signal }) => {
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("aborted");
		});
		const second = manager.register("task", "second", async () => {
			promoted = true;
			started.resolve();
			return "second";
		});

		expect(manager.getJob(second)?.queued).toBe(true);
		expect(manager.cancel(first)).toBe(true);
		await started.promise;
		expect(promoted).toBe(true);
		await manager.waitForAll();
		await manager.dispose();
	});
});
