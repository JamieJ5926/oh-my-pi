import { describe, expect, test } from "bun:test";

import { createChunkId, createManifestEntryId } from "../../../src/capability/contracts/ids";
import { type CoverageGap, planRecovery, type RecoveryLimits } from "../../../src/capability/recovery/recovery-planner";

function gap(reason: CoverageGap["reason"], attempts = 0, estimatedTokens = 1): CoverageGap {
	return {
		entryId: createManifestEntryId(`entry_${reason}`),
		chunkId: createChunkId("chunk_one"),
		reason,
		attempts,
		estimatedTokens,
		detail: reason,
	};
}
const limits: RecoveryLimits = {
	maxAttemptsPerEntry: 2,
	maxGenerations: 3,
	generation: 0,
	allowInaccessibleSkip: true,
	splitTokenThreshold: 10,
};

describe("planRecovery", () => {
	test("classifies omissions and bounded retry actions", () => {
		const plan = planRecovery([gap("missing_from_packet"), gap("invalid_output"), gap("worker_failure")], limits);
		expect(plan.decisions.map(decision => decision.action)).toEqual([
			"retry_with_different_model",
			"create_single_entry_chunk",
			"retry_same_chunk",
		]);
		expect(plan.terminal).toBe("continue");
	});

	test("splits large timeout and reroutes small timeout", () => {
		expect(planRecovery([gap("worker_timeout", 0, 20)], limits).decisions[0]?.action).toBe("split_chunk");
		expect(planRecovery([gap("worker_timeout", 0, 2)], limits).decisions[0]?.action).toBe(
			"retry_with_different_model",
		);
	});

	test("skips inaccessible only when policy permits and fails stale sources", () => {
		expect(planRecovery([gap("inaccessible_source")], limits).decisions[0]?.action).toBe("mark_skipped_with_reason");
		expect(planRecovery([gap("source_changed")], limits).terminal).toBe("failed");
		expect(planRecovery([gap("inaccessible_source")], { ...limits, allowInaccessibleSkip: false }).terminal).toBe(
			"failed",
		);
	});

	test("terminates with exact partial gaps on generation, budget, deadline, or no progress", () => {
		const target = gap("missing_from_packet");
		for (const bounded of [
			{ ...limits, generation: 3 },
			{ ...limits, remainingTokens: 0 },
			{ ...limits, nowMs: 10, deadlineMs: 10 },
			{ ...limits, previousGapIds: [target.entryId] },
		]) {
			const result = planRecovery([target], bounded);
			expect(result.terminal).toBe("partial");
			expect(result.unresolved).toEqual([target]);
		}
	});
});
