import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimit, mapWithConcurrencyLimitAllSettled } from "@oh-my-pi/pi-coding-agent/task/parallel";

describe("mapWithConcurrencyLimitAllSettled", () => {
	it("waits for valid siblings after one item rejects and keeps input order", async () => {
		const started: number[] = [];
		const secondGate = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const thirdStarted = Promise.withResolvers<void>();
		const pending = mapWithConcurrencyLimitAllSettled([0, 1, 2], 2, async item => {
			started.push(item);
			if (item === 0) throw new Error("first failed");
			if (item === 1) {
				secondStarted.resolve();
				await secondGate.promise;
			}
			if (item === 2) thirdStarted.resolve();
			return `item-${item}`;
		});
		await secondStarted.promise;
		await thirdStarted.promise;
		secondGate.resolve();
		const settled = await pending;
		expect(started).toEqual([0, 1, 2]);
		expect(settled.results.map(result => result?.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		const second = settled.results[1];
		const third = settled.results[2];
		expect(second).toEqual({ status: "fulfilled", value: "item-1" });
		expect(third).toEqual({ status: "fulfilled", value: "item-2" });
	});

	it("stops scheduling after cancellation while awaiting an already launched sibling", async () => {
		const controller = new AbortController();
		const release = Promise.withResolvers<void>();
		const firstStarted = Promise.withResolvers<void>();
		const started: number[] = [];
		const pending = mapWithConcurrencyLimitAllSettled(
			[0, 1],
			1,
			async item => {
				started.push(item);
				firstStarted.resolve();
				await release.promise;
				return item;
			},
			controller.signal,
		);

		await firstStarted.promise;
		controller.abort();
		release.resolve();
		const settled = await pending;

		expect(started).toEqual([0]);
		expect(settled.aborted).toBe(true);
		expect(settled.results).toEqual([{ status: "fulfilled", value: 0 }, undefined]);
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("never cancels launched siblings on failure but still rejects with the first error", async () => {
		const siblingStarted = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		let siblingAborted = false;
		let siblingValue: number | undefined;

		const pending = mapWithConcurrencyLimit([0, 1, 2], 2, async (item, _index, signal) => {
			if (item === 0) {
				await siblingStarted.promise;
				throw new Error("first failed");
			}
			if (item === 1) {
				siblingStarted.resolve();
				signal.addEventListener(
					"abort",
					() => {
						siblingAborted = true;
					},
					{ once: true },
				);
				await releaseSibling.promise;
				siblingValue = item;
				return item;
			}
			return item;
		});
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await siblingStarted.promise;
		for (let turn = 0; turn < 5; turn++) await Promise.resolve();
		// The fast failure must not cancel the launched slow sibling, and the
		// pool must still be draining: the promise cannot settle until the
		// launched sibling settles.
		expect(siblingAborted).toBe(false);
		expect(settled).toBe(false);
		releaseSibling.resolve();
		await expect(pending).rejects.toThrow("first failed");
		expect(settled).toBe(true);
		expect(siblingAborted).toBe(false);
		expect(siblingValue).toBe(1);
	});
	it("stops scheduling new items after a sibling fails (fail-fast gate)", async () => {
		const started: number[] = [];
		await expect(
			mapWithConcurrencyLimit([0, 1, 2], 2, async item => {
				started.push(item);
				if (item === 0) throw new Error("first failed");
				return item;
			}),
		).rejects.toThrow("first failed");
		// Item 0 rejects in the first microtask turn, before item 1's worker
		// loops back, so the fail-fast gate must prevent item 2 from launching.
		// Deleting the `if (failed) return;` gate launches item 2 instead.
		expect(started).toEqual([0, 1]);
	});
});
