import { describe, expect, it } from "bun:test";
import {
	CoverageError,
	type CoverageRecord,
	createCoverageRecord,
	recoverCoverage,
	reportCoverage,
	transitionCoverage,
} from "../../../src/capability/contracts/coverage";
import { createChunkId, createEvidencePacketId, createManifestEntryId } from "../../../src/capability/contracts/ids";

const entryId = createManifestEntryId("entry_one");
const otherEntryId = createManifestEntryId("entry_two");
const chunkId = createChunkId("chunk_one");
const otherChunkId = createChunkId("chunk_two");
const packetId = createEvidencePacketId("evidence_one");
const otherPacketId = createEvidencePacketId("evidence_two");

function record(state: CoverageRecord["state"] = { kind: "unassigned" }, attemptCount = 0): CoverageRecord {
	return {
		manifestEntryId: entryId,
		state,
		attemptCount,
		updatedAt: "2026-08-29T12:00:00.000Z",
	};
}

function expectCoverageError(action: () => unknown, code: CoverageError["code"]): void {
	expect(action).toThrow(CoverageError);
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(CoverageError);
		expect((error as CoverageError).code).toBe(code);
	}
}

describe("coverage lifecycle transitions", () => {
	it("constructs an unassigned record and accepts the complete lifecycle", () => {
		const initial = createCoverageRecord(entryId, "2026-08-29T12:00:00.000Z");
		const assigned = transitionCoverage(initial, { kind: "assign", chunkId });
		const processed = transitionCoverage(assigned, { kind: "process", chunkId, packetId });
		const verified = transitionCoverage(processed, { kind: "verify", packetId });

		expect(initial).toEqual({
			manifestEntryId: entryId,
			state: { kind: "unassigned" },
			attemptCount: 0,
			updatedAt: "2026-08-29T12:00:00.000Z",
		});
		expect(assigned.state).toEqual({ kind: "assigned", chunkId });
		expect(assigned.attemptCount).toBe(1);
		expect(processed.state).toEqual({ kind: "processed", packetId });
		expect(verified.state).toEqual({ kind: "verified", packetId });
		expect(verified.attemptCount).toBe(1);
		expect(verified.updatedAt).toBe(initial.updatedAt);
		expect(initial.state).toEqual({ kind: "unassigned" });
	});

	it("updates the timestamp only when a transition supplies one", () => {
		const assigned = transitionCoverage(record(), {
			kind: "assign",
			chunkId,
			updatedAt: "2026-08-29T12:01:00.000Z",
		});
		expect(assigned.updatedAt).toBe("2026-08-29T12:01:00.000Z");
	});

	it("allows an unassigned entry to be skipped as a terminal state", () => {
		const skipped = transitionCoverage(record(), { kind: "skip", reason: "not applicable" });
		expect(skipped.state).toEqual({ kind: "skipped", reason: "not applicable" });
		expect(skipped.attemptCount).toBe(0);
	});

	it("allows an assigned entry to be skipped", () => {
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		const skipped = transitionCoverage(assigned, { kind: "skip", reason: "excluded by policy" });
		expect(skipped.state).toEqual({ kind: "skipped", reason: "excluded by policy" });
		expect(skipped.attemptCount).toBe(1);
	});

	it("allows assignment to fail and recovery only through explicit incremented retry", () => {
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		const failed = transitionCoverage(assigned, { kind: "fail", errorCode: "reader_timeout" });
		const recovered = recoverCoverage(failed, { chunkId: otherChunkId, attemptCount: 2 });

		expect(failed.state).toEqual({ kind: "failed", errorCode: "reader_timeout" });
		expect(recovered.state).toEqual({ kind: "assigned", chunkId: otherChunkId });
		expect(recovered.attemptCount).toBe(2);
	});

	it("supports the positional recovery helper", () => {
		const failed = transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
			kind: "fail",
			errorCode: "temporary",
		});
		const recovered = recoverCoverage(failed, chunkId, 2, "2026-08-29T12:02:00.000Z");
		expect(recovered.state).toEqual({ kind: "assigned", chunkId });
		expect(recovered.updatedAt).toBe("2026-08-29T12:02:00.000Z");
	});
	it("reproduces unbounded recovery for a transient failure", () => {
		let current = transitionCoverage(record(), { kind: "assign", chunkId });
		for (let attempt = 0; attempt < 10; attempt++) {
			current = transitionCoverage(current, { kind: "fail", errorCode: "reader_timeout" });
			current = recoverCoverage(current, chunkId, current.attemptCount + 1);
		}
		expect(current.attemptCount).toBe(11);
	});
});

describe("illegal coverage transitions", () => {
	it("rejects duplicate assignment", () => {
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		expectCoverageError(
			() => transitionCoverage(assigned, { kind: "assign", chunkId: otherChunkId }),
			"duplicate_assignment",
		);
	});

	it("rejects processing against a different chunk", () => {
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		expectCoverageError(
			() => transitionCoverage(assigned, { kind: "process", chunkId: otherChunkId, packetId }),
			"correlation_mismatch",
		);
	});

	it("rejects verification against a different packet", () => {
		const processed = transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
			kind: "process",
			chunkId,
			packetId,
		});
		expectCoverageError(
			() => transitionCoverage(processed, { kind: "verify", packetId: otherPacketId }),
			"correlation_mismatch",
		);
	});

	it("rejects all lifecycle regressions and terminal-state transitions", () => {
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		const processed = transitionCoverage(assigned, { kind: "process", chunkId, packetId });
		const verified = transitionCoverage(processed, { kind: "verify", packetId });
		const failed = transitionCoverage(assigned, { kind: "fail", errorCode: "broken" });
		const skipped = transitionCoverage(record(), { kind: "skip", reason: "ignored" });

		for (const transition of [
			{ kind: "assign", chunkId },
			{ kind: "process", chunkId, packetId },
			{ kind: "fail", errorCode: "again" },
			{ kind: "skip", reason: "again" },
		] as const) {
			expectCoverageError(() => transitionCoverage(processed, transition), "regression");
			expectCoverageError(() => transitionCoverage(verified, transition), "regression");
			expectCoverageError(() => transitionCoverage(skipped, transition), "regression");
			expectCoverageError(
				() => transitionCoverage(failed, transition),
				transition.kind === "assign" ? "invalid_transition" : "regression",
			);
		}
		const duplicateVerify = { kind: "verify", packetId } as const;
		expectCoverageError(() => transitionCoverage(verified, duplicateVerify), "duplicate_transition");
	});

	it("rejects direct processing, verification, failure, and recovery from unassigned", () => {
		for (const transition of [
			{ kind: "process", chunkId, packetId },
			{ kind: "verify", packetId },
			{ kind: "fail", errorCode: "broken" },
			{ kind: "recover", chunkId, attemptCount: 1 },
		] as const) {
			expectCoverageError(() => transitionCoverage(record(), transition), "invalid_transition");
		}
	});

	it("rejects direct assignment after failure", () => {
		const failed = transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
			kind: "fail",
			errorCode: "broken",
		});
		expectCoverageError(() => transitionCoverage(failed, { kind: "assign", chunkId }), "invalid_transition");
	});

	it("rejects retries that do not increment exactly once", () => {
		const failed = transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
			kind: "fail",
			errorCode: "broken",
		});
		expectCoverageError(() => recoverCoverage(failed, chunkId, 1), "retry_without_increment");
		expectCoverageError(() => recoverCoverage(failed, chunkId, 3), "retry_without_increment");
		expectCoverageError(() => recoverCoverage(failed, chunkId, -1), "negative_attempt_count");
	});

	it("rejects negative and non-integer attempt counts", () => {
		expectCoverageError(
			() => transitionCoverage(record(), { kind: "assign", chunkId, attemptCount: -1 }),
			"negative_attempt_count",
		);
		expectCoverageError(
			() => transitionCoverage(record(), { kind: "assign", chunkId, attemptCount: 1.5 }),
			"invalid_attempt_count",
		);
		expectCoverageError(
			() => transitionCoverage(record({ kind: "assigned", chunkId }, -1), { kind: "fail", errorCode: "broken" }),
			"negative_attempt_count",
		);
		expectCoverageError(
			() => transitionCoverage(record({ kind: "assigned", chunkId }, 1.5), { kind: "fail", errorCode: "broken" }),
			"invalid_attempt_count",
		);
	});

	it("rejects duplicate verification", () => {
		const verified = transitionCoverage(
			transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
				kind: "process",
				chunkId,
				packetId,
			}),
			{ kind: "verify", packetId },
		);
		expectCoverageError(() => transitionCoverage(verified, { kind: "verify", packetId }), "duplicate_transition");
	});
});

describe("coverage reports", () => {
	it("reports unverified entries as gaps and duplicates exactly once", () => {
		const verified = transitionCoverage(
			transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
				kind: "process",
				chunkId,
				packetId,
			}),
			{ kind: "verify", packetId },
		);
		const unassigned = record({ kind: "unassigned" });
		const duplicate = { ...verified };
		const report = reportCoverage([verified, unassigned, duplicate], [entryId, otherEntryId]);

		expect(report.duplicateIds).toEqual([entryId]);
		expect(report.gapIds).toEqual([entryId, otherEntryId]);
	});
	it("reports failed, skipped, assigned, and processed entries as unique gaps", () => {
		const entryThree = createManifestEntryId("entry_three");
		const entryFour = createManifestEntryId("entry_four");
		const assigned = transitionCoverage(record(), { kind: "assign", chunkId });
		const failed = transitionCoverage(
			{ ...assigned, manifestEntryId: otherEntryId },
			{ kind: "fail", errorCode: "broken" },
		);
		const skipped = transitionCoverage(
			{ ...record(), manifestEntryId: entryThree },
			{ kind: "skip", reason: "excluded" },
		);
		const processed = transitionCoverage(
			transitionCoverage({ ...record(), manifestEntryId: entryFour }, { kind: "assign", chunkId }),
			{ kind: "process", chunkId, packetId },
		);

		expect(reportCoverage([assigned, processed, failed, skipped]).gapIds).toEqual([
			entryId,
			entryFour,
			otherEntryId,
			entryThree,
		]);
		expect(reportCoverage([assigned, processed, failed, skipped]).duplicateIds).toEqual([]);
	});

	it("accepts map input and has no gaps for a verified unique record", () => {
		const verified = transitionCoverage(
			transitionCoverage(transitionCoverage(record(), { kind: "assign", chunkId }), {
				kind: "process",
				chunkId,
				packetId,
			}),
			{ kind: "verify", packetId },
		);
		const map = new Map([
			[entryId, verified],
			[otherEntryId, { ...verified, manifestEntryId: otherEntryId }],
		]);
		expect(reportCoverage(map)).toEqual({ gapIds: [], duplicateIds: [] });
	});
});
