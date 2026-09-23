import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimit } from "@oh-my-pi/pi-coding-agent/task/parallel";

// G4 width: OMP-side cap mirroring spawn_children(bound) so fan-out never
// crashes the TUI; measured, not guessed. (plans/SUBAGENT-RPC.md:82)
describe("g4 width cap", () => {
	it("bounds a 50-item fan-out at cap 10 and returns every result", async () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		let inFlight = 0;
		let maxObserved = 0;
		let startedCount = 0;
		const tenStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = mapWithConcurrencyLimit(items, 10, async item => {
			// Synchronous section: no await before counting, so the driver
			// observes the exact started set deterministically.
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			startedCount++;
			if (startedCount === 10) tenStarted.resolve();
			await release.promise;
			inFlight--;
			return item * 2;
		});
		await tenStarted.promise;
		// Ten parked workers must hold the whole pool: no 11th start.
		expect(startedCount).toBe(10);
		release.resolve();
		const { results, aborted } = await pending;
		expect(aborted).toBe(false);
		expect(results).toEqual(items.map(i => i * 2));
		expect(maxObserved).toBeLessThanOrEqual(10);
	});

	it("documents the non-finite-cap fallback: it completes every item", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const { results } = await mapWithConcurrencyLimit(items, Number.NaN, async item => item);
		expect(results).toEqual(items);
	});
});
