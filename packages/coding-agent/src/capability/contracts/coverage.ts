import type { ChunkId, EvidencePacketId, ManifestEntryId } from "./ids";
import type { ChunkLineRange } from "./chunks";

/** A reason an entry was intentionally excluded from processing. */
export type SkipReason = string;

export type CoverageState =
	| { readonly kind: "unassigned" }
	| { readonly kind: "assigned"; readonly chunkId: ChunkId }
	| { readonly kind: "processed"; readonly packetId: EvidencePacketId }
	| { readonly kind: "verified"; readonly packetId: EvidencePacketId }
	| { readonly kind: "skipped"; readonly reason: SkipReason }
	| { readonly kind: "failed"; readonly errorCode: string };

export interface CoverageRecord {
	readonly manifestEntryId: ManifestEntryId;
	readonly state: CoverageState;
	readonly attemptCount: number;
	readonly updatedAt: string;
}

export type CoverageErrorCode =
  | "correlation_mismatch"
  | "duplicate_assignment"
  | "duplicate_transition"
  | "invalid_attempt_count"
  | "invalid_transition"
  | "negative_attempt_count"
  | "regression"
  | "retry_limit_reached"
  | "recovery_not_allowed"
  | "retry_without_increment"

export class CoverageError extends Error {
	readonly code: CoverageErrorCode;

	constructor(code: CoverageErrorCode, message: string) {
		super(message);
		this.name = "CoverageError";
		this.code = code;
	}
}

interface CoverageTransitionMetadata {
	readonly updatedAt?: string;
}

export type CoverageTransition =
	| ({
			readonly kind: "assign";
			readonly chunkId: ChunkId;
			readonly attemptCount?: number;
	  } & CoverageTransitionMetadata)
	| ({
			readonly kind: "process";
			readonly chunkId: ChunkId;
			readonly packetId: EvidencePacketId;
	  } & CoverageTransitionMetadata)
	| ({ readonly kind: "verify"; readonly packetId: EvidencePacketId } & CoverageTransitionMetadata)
	| ({ readonly kind: "fail"; readonly errorCode: string } & CoverageTransitionMetadata)
	| ({ readonly kind: "skip"; readonly reason: SkipReason } & CoverageTransitionMetadata)
	| ({
			readonly kind: "recover";
			readonly chunkId: ChunkId;
			readonly attemptCount: number;
			readonly recoverableRanges?: readonly ChunkLineRange[];
	  } & CoverageTransitionMetadata);

export const MAX_COVERAGE_RECOVERY_ATTEMPTS = 3;

export interface CoverageRecovery {
	readonly chunkId: ChunkId;
	readonly attemptCount: number;
	/** Missing or invalid physical ranges eligible for retry. */
	readonly recoverableRanges?: readonly ChunkLineRange[];
	readonly updatedAt?: string;
}

export interface CoverageReport {
	readonly gapIds: readonly ManifestEntryId[];
	readonly duplicateIds: readonly ManifestEntryId[];
}

const isNonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

function assertAttemptCount(value: number): void {
	if (value < 0) {
		throw new CoverageError("negative_attempt_count", "Coverage attempt count cannot be negative");
	}
	if (!Number.isInteger(value)) {
		throw new CoverageError("invalid_attempt_count", "Coverage attempt count must be an integer");
	}
}

function assertRecord(record: CoverageRecord): void {
	assertAttemptCount(record.attemptCount);
	if (!isNonNegativeInteger(record.attemptCount)) {
		throw new CoverageError("invalid_attempt_count", "Coverage attempt count must be a non-negative integer");
	}
	if (record.state.kind === "unassigned" && record.attemptCount !== 0) {
		throw new CoverageError("invalid_attempt_count", "An unassigned entry cannot have attempts");
	}
}

function withMetadata(
	record: CoverageRecord,
	state: CoverageState,
	transition: CoverageTransition,
	attemptCount?: number,
): CoverageRecord {
	return {
		manifestEntryId: record.manifestEntryId,
		state,
		attemptCount: attemptCount ?? record.attemptCount,
		updatedAt: transition.updatedAt ?? record.updatedAt,
	};
}

function invalidTransition(record: CoverageRecord, transition: CoverageTransition): never {
	throw new CoverageError(
		"invalid_transition",
		`Cannot ${transition.kind} coverage entry ${record.manifestEntryId} from ${record.state.kind}`,
	);
}

function regression(record: CoverageRecord, transition: CoverageTransition): never {
	throw new CoverageError(
		"regression",
		`Coverage entry ${record.manifestEntryId} cannot ${transition.kind} after ${record.state.kind}`,
	);
}

/**
 * Apply one legal coverage lifecycle transition without mutating the input.
 * Assignment starts attempt one; recovery must explicitly supply the next attempt.
 */
export function transitionCoverage(record: CoverageRecord, transition: CoverageTransition): CoverageRecord {
	assertRecord(record);

	switch (record.state.kind) {
		case "unassigned":
			switch (transition.kind) {
				case "assign": {
					const attemptCount = transition.attemptCount ?? 1;
					assertAttemptCount(attemptCount);
					if (attemptCount !== 1) {
						throw new CoverageError("retry_without_increment", "Initial assignment must start at attempt one");
					}
					return withMetadata(record, { kind: "assigned", chunkId: transition.chunkId }, transition, attemptCount);
				}
				case "skip":
					return withMetadata(record, { kind: "skipped", reason: transition.reason }, transition);
				case "recover":
					return invalidTransition(record, transition);
				case "process":
				case "verify":
				case "fail":
					return invalidTransition(record, transition);
			}
			return invalidTransition(record, transition);
		case "assigned":
			switch (transition.kind) {
				case "assign":
					throw new CoverageError(
						"duplicate_assignment",
						`Coverage entry ${record.manifestEntryId} is already assigned`,
					);
				case "process":
					if (transition.chunkId !== record.state.chunkId) {
						throw new CoverageError(
							"correlation_mismatch",
							"Processed packet does not belong to the assigned chunk",
						);
					}
					return withMetadata(record, { kind: "processed", packetId: transition.packetId }, transition);
				case "fail":
					return withMetadata(record, { kind: "failed", errorCode: transition.errorCode }, transition);
				case "skip":
					return withMetadata(record, { kind: "skipped", reason: transition.reason }, transition);
				case "recover":
					return invalidTransition(record, transition);
				case "verify":
					return invalidTransition(record, transition);
			}
			return invalidTransition(record, transition);
		case "processed":
			switch (transition.kind) {
				case "verify":
					if (transition.packetId !== record.state.packetId) {
						throw new CoverageError(
							"correlation_mismatch",
							"Verified packet does not match the processed packet",
						);
					}
					return withMetadata(record, { kind: "verified", packetId: transition.packetId }, transition);
				case "assign":
				case "process":
				case "fail":
				case "skip":
				case "recover":
					return regression(record, transition);
			}
			return regression(record, transition);
		case "failed":
			switch (transition.kind) {
				case "recover":
					assertAttemptCount(transition.attemptCount);
					if (transition.attemptCount !== record.attemptCount + 1) {
						throw new CoverageError(
							"retry_without_increment",
							`Recovery must increment attempt count from ${record.attemptCount} to ${record.attemptCount + 1}`,
						);
					}
					return withMetadata(
						record,
						{ kind: "assigned", chunkId: transition.chunkId },
						transition,
						transition.attemptCount,
					);
				case "assign":
					throw new CoverageError(
						"invalid_transition",
						"Failed coverage requires explicit recovery before assignment",
					);
				case "process":
				case "verify":
				case "fail":
				case "skip":
					return regression(record, transition);
			}
			return regression(record, transition);
		case "verified":
			if (transition.kind === "verify" && transition.packetId === record.state.packetId) {
				throw new CoverageError(
					"duplicate_transition",
					`Coverage entry ${record.manifestEntryId} is already verified`,
				);
			}
			return regression(record, transition);
		case "skipped":
			return regression(record, transition);
	}
}

export function recoverCoverage(record: CoverageRecord, recovery: CoverageRecovery): CoverageRecord;
export function recoverCoverage(
	record: CoverageRecord,
	chunkId: ChunkId,
	attemptCount: number,
	updatedAt?: string,
): CoverageRecord;
export function recoverCoverage(
	record: CoverageRecord,
	recoveryOrChunkId: CoverageRecovery | ChunkId,
	attemptCount?: number,
	updatedAt?: string,
): CoverageRecord {
	const recovery: CoverageRecovery =
		typeof recoveryOrChunkId === "string"
			? { chunkId: recoveryOrChunkId, attemptCount: attemptCount ?? Number.NaN, updatedAt }
			: recoveryOrChunkId;
	return transitionCoverage(record, { kind: "recover", ...recovery });
}

function recordsFromInput(
	records: readonly CoverageRecord[] | ReadonlyMap<ManifestEntryId, CoverageRecord>,
): readonly CoverageRecord[] {
	return Array.isArray(records) ? records : [...records.values()];
}

/**
 * Return the exact unresolved and duplicate entry IDs in deterministic input order.
 * An optional expected-ID list makes records absent from the ledger explicit gaps.
 */
export function reportCoverage(
	records: readonly CoverageRecord[] | ReadonlyMap<ManifestEntryId, CoverageRecord>,
	expectedEntryIds?: readonly ManifestEntryId[],
): CoverageReport {
	const entries = recordsFromInput(records);
	const counts = new Map<ManifestEntryId, number>();
	const firstRecords = new Map<ManifestEntryId, CoverageRecord>();
	const duplicateIds: ManifestEntryId[] = [];

	for (const record of entries) {
		const count = (counts.get(record.manifestEntryId) ?? 0) + 1;
		counts.set(record.manifestEntryId, count);
		if (count === 1) firstRecords.set(record.manifestEntryId, record);
		if (count === 2) duplicateIds.push(record.manifestEntryId);
	}

	const gapIds: ManifestEntryId[] = [];
	const addedGaps = new Set<ManifestEntryId>();
	const scope = expectedEntryIds ?? entries.map(record => record.manifestEntryId);
	for (const id of scope) {
		const record = firstRecords.get(id);
		const isDuplicate = (counts.get(id) ?? 0) > 1;
		if ((record === undefined || record.state.kind !== "verified" || isDuplicate) && !addedGaps.has(id)) {
			gapIds.push(id);
			addedGaps.add(id);
		}
	}

	for (const id of duplicateIds) {
		if (!addedGaps.has(id)) {
			gapIds.push(id);
			addedGaps.add(id);
		}
	}

	return { gapIds, duplicateIds };
}

export function createCoverageRecord(manifestEntryId: ManifestEntryId, updatedAt: string): CoverageRecord {
	return {
		manifestEntryId,
		state: { kind: "unassigned" },
		attemptCount: 0,
		updatedAt,
	};
}
