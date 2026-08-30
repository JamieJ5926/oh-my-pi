import type { ChunkId, ManifestEntryId } from "../contracts/ids";

export type CoverageGapReason =
	| "worker_failure"
	| "worker_timeout"
	| "straggler_cancellation"
	| "invalid_output"
	| "missing_from_packet"
	| "source_changed"
	| "inaccessible_source"
	| "chunk_too_large"
	| "unknown";

export type RecoveryAction =
	| "retry_same_chunk"
	| "retry_with_different_model"
	| "split_chunk"
	| "create_single_entry_chunk"
	| "refresh_manifest_entry"
	| "mark_skipped_with_reason"
	| "fail_operation";

export interface CoverageGap {
	readonly entryId: ManifestEntryId;
	readonly chunkId?: ChunkId;
	readonly reason: CoverageGapReason;
	readonly attempts: number;
	readonly estimatedTokens?: number;
	readonly detail: string;
}

export interface RecoveryLimits {
	readonly maxAttemptsPerEntry: number;
	readonly maxGenerations: number;
	readonly generation: number;
	readonly remainingTokens?: number;
	readonly deadlineMs?: number;
	readonly nowMs?: number;
	readonly allowInaccessibleSkip: boolean;
	readonly splitTokenThreshold: number;
	readonly previousGapIds?: readonly ManifestEntryId[];
}

export interface RecoveryDecision {
	readonly gap: CoverageGap;
	readonly action: RecoveryAction;
	readonly reason: string;
}

export interface RecoveryPlan {
	readonly decisions: readonly RecoveryDecision[];
	readonly terminal: "continue" | "partial" | "failed";
	readonly unresolved: readonly CoverageGap[];
	readonly noProgress: boolean;
}

export function planRecovery(gaps: readonly CoverageGap[], limits: RecoveryLimits): RecoveryPlan {
	const ordered = [...gaps].sort((left, right) => left.entryId.localeCompare(right.entryId));
	const currentIds = ordered.map(gap => gap.entryId);
	const previousIds = [...(limits.previousGapIds ?? [])].sort();
	const noProgress = previousIds.length > 0 && previousIds.join("\u0000") === currentIds.join("\u0000");
	const exhausted =
		limits.generation >= limits.maxGenerations ||
		(limits.deadlineMs !== undefined && (limits.nowMs ?? Date.now()) >= limits.deadlineMs) ||
		(limits.remainingTokens !== undefined && limits.remainingTokens <= 0) ||
		noProgress;
	if (exhausted) {
		return { decisions: [], terminal: "partial", unresolved: ordered, noProgress };
	}
	let failed = false;
	const decisions = ordered.map(gap => {
		let action: RecoveryAction;
		let reason: string;
		if (gap.attempts >= limits.maxAttemptsPerEntry) {
			action = "fail_operation";
			reason = "entry attempt limit exhausted";
		} else {
			switch (gap.reason) {
				case "source_changed":
					action = "fail_operation";
					reason = "pinned source revision changed";
					break;
				case "inaccessible_source":
					action = limits.allowInaccessibleSkip ? "mark_skipped_with_reason" : "fail_operation";
					reason = limits.allowInaccessibleSkip
						? "policy permits explicit inaccessible skip"
						: "inaccessible source is required";
					break;
				case "missing_from_packet":
					action = "create_single_entry_chunk";
					reason = "recover exactly the omitted entry";
					break;
				case "invalid_output":
					action = "retry_with_different_model";
					reason = "retry malformed output with stricter framing";
					break;
				case "worker_timeout":
				case "straggler_cancellation":
				case "chunk_too_large":
					action =
						(gap.estimatedTokens ?? 0) >= limits.splitTokenThreshold
							? "split_chunk"
							: "retry_with_different_model";
					reason = action === "split_chunk" ? "chunk exceeds split threshold" : "reroute bounded retry";
					break;
				case "worker_failure":
					action = "retry_same_chunk";
					reason = "bounded transient retry";
					break;
				case "unknown":
					action = "fail_operation";
					reason = "unclassified gap is not safely retryable";
			}
		}
		if (action === "fail_operation") failed = true;
		return { gap, action, reason };
	});
	return { decisions, terminal: failed ? "failed" : "continue", unresolved: failed ? ordered : [], noProgress };
}
