/**
 * Pin: a lane that keeps producing output must never be straggler-cancelled.
 *
 * Context (omp-owned #27, Jamie verbatim): "The straggler timer cancels a lane
 * that still produces output." To pass, two consecutive probes run a lane that
 * produces output for 3 minutes and confirm no probe straggler-cancels it.
 *
 * On main HEAD (feeb155e2c) no lane straggler scheduler exists — the P07
 * opt-in straggler cancellation lives only on unmerged owned/18.0.8-* branches
 * and `STRAGGLER_CANCEL_REASON` / `TASK_CLASS_FLOORS` / `kind="straggler"` have
 * zero matches under packages/coding-agent — so this test pins the ABSENT
 * behavior: a slow but productive lane survives a fast sibling settling.
 *
 * Timing is scaled down to seconds. The 3-minute output-producing lane probe
 * is the full-scale oracle; the constants below are named so the mapping is
 * explicit.
 */
import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimitAllSettled } from "@oh-my-pi/pi-coding-agent/task/parallel";

// Full-scale oracle: a lane producing output continuously for 3 minutes
// (ORACLE_OUTPUT_WINDOW_MS). Scaled-down stand-in for this fast pin: the slow
// lane emits output ticks for ~300ms while the fast lane settles in ~10ms.
// Setting STRAGGLER_PIN_FULL=1 selects the full 180s oracle window so the
// acceptance probes run through this same file (the repo's `bun test` entry
// point).
const FULL_SCALE = process.env.STRAGGLER_PIN_FULL === "1";
const ORACLE_OUTPUT_WINDOW_MS = 3 * 60 * 1000;
const PIN_OUTPUT_WINDOW_MS = FULL_SCALE ? ORACLE_OUTPUT_WINDOW_MS : 300;
const PIN_OUTPUT_TICK_MS = FULL_SCALE ? 5000 : 50;
const PIN_FAST_LANE_MS = FULL_SCALE ? 1000 : 10;
// Independent output-intact anchor: ticks expected from the window constants
// minus slack for timer jitter, computed before the batch runs.
const MIN_EXPECTED_TICKS = Math.floor(PIN_OUTPUT_WINDOW_MS / PIN_OUTPUT_TICK_MS) - 2;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
describe("straggler pin (omp-owned #27)", () => {
	it("a lane that keeps producing output survives a fast sibling settling", async () => {
		const slowLaneOutput: string[] = [];
		let slowLaneSawAbort = false;
		let returnedTickCount = -1;

		const settled = await mapWithConcurrencyLimitAllSettled(
			["fast", "slow"],
			2,
			async (item, _index, signal) => {
				if (item === "fast") {
					await delay(PIN_FAST_LANE_MS);
					return "fast-done";
				}
				// Slow lane: keeps producing output for the bounded window,
				// standing in for the ORACLE_OUTPUT_WINDOW_MS (3-minute) probe.
				const deadline = Date.now() + PIN_OUTPUT_WINDOW_MS;
				while (Date.now() < deadline) {
					if (signal.aborted) {
						slowLaneSawAbort = true;
						throw new Error(`slow lane aborted: ${String(signal.reason ?? "unknown reason")}`);
					}
					slowLaneOutput.push(`tick@${Date.now()}`);
					await delay(PIN_OUTPUT_TICK_MS);
				}
				returnedTickCount = slowLaneOutput.length;
				return `slow-done:${returnedTickCount}-ticks`;
			},
		);

		// The batch itself was never cancelled.
		expect(settled.aborted).toBe(false);
		expect(settled.results).toHaveLength(2);

		// Fast lane settled normally.
		expect(settled.results[0]).toEqual({ status: "fulfilled", value: "fast-done" });

		// Slow productive lane completed with its output intact, never cancelled.
		// Intactness anchors to the independent pre-run constant, not to the
		// post-hoc array length, so tick loss fails; the return-time snapshot
		// pins the value the lane actually returned.
		expect(slowLaneSawAbort).toBe(false);
		expect(slowLaneOutput.length).toBeGreaterThanOrEqual(MIN_EXPECTED_TICKS);
		expect(returnedTickCount).toBe(slowLaneOutput.length);
		const slowResult = settled.results[1];
		expect(slowResult?.status).toBe("fulfilled");
		if (slowResult?.status === "fulfilled") {
			expect(slowResult.value).toBe(`slow-done:${returnedTickCount}-ticks`);
		}

		// No settled envelope carries a straggler-style abort marker in either
		// state, so the passing (all-fulfilled) path actually checks something.
		for (const entry of settled.results) {
			if (entry?.status === "rejected") {
				expect(String(entry.reason)).not.toMatch(/straggler|cancelled-by-caller/i);
			} else {
				expect(JSON.stringify(entry?.value ?? "")).not.toMatch(/straggler|cancelled-by-caller/i);
			}
		}
	}, 240_000);
});
