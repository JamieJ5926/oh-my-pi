import type { ArtifactMeta, ChangeUnitId, IntegrationRunId, PatchId } from "./ids";

export type RevisionIdentity = string;

export interface CapabilityError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly source?: string;
	readonly context: Readonly<Record<string, unknown>>;
}

export type PatchValidation =
	| { readonly kind: "accepted" }
	| { readonly kind: "rejected"; readonly code: string; readonly message: string };

export interface PatchRecord {
	readonly meta: ArtifactMeta;
	readonly patchId: PatchId;
	readonly unitId: ChangeUnitId;
	readonly baseRevision: RevisionIdentity;
	readonly touchedPaths: readonly string[];
	readonly patchPath: string;
	readonly validation: PatchValidation;
}

export type IntegrationState =
	| { readonly kind: "pending" }
	| { readonly kind: "applying"; readonly patchId: PatchId }
	| { readonly kind: "accepted"; readonly patchId: PatchId; readonly revision: RevisionIdentity }
	| { readonly kind: "rejected"; readonly patchId: PatchId; readonly error: CapabilityError }
	| { readonly kind: "reverted"; readonly patchId: PatchId; readonly error: CapabilityError };

export interface IntegrationRecord {
	readonly meta: ArtifactMeta;
	readonly integrationRunId: IntegrationRunId;
	readonly unitId: ChangeUnitId;
	readonly state: IntegrationState;
}

function invalid(message: string): never {
	throw new Error(`Invalid integration state: ${message}`);
}

function assertNonBlank(value: string, label: string): void {
	if (value.trim().length === 0) invalid(`${label} must not be blank`);
}

export function validatePatchRecord(record: PatchRecord): PatchRecord {
	assertNonBlank(record.baseRevision, "base revision");
	assertNonBlank(record.patchPath, "patch path");
	if (record.touchedPaths.length === 0) invalid("patch must touch at least one path");
	const paths = new Set<string>();
	for (const path of record.touchedPaths) {
		assertNonBlank(path, "touched path");
		if (paths.has(path)) invalid(`duplicate touched path ${path}`);
		paths.add(path);
	}
	if (record.validation.kind === "rejected") {
		assertNonBlank(record.validation.code, "patch rejection code");
		assertNonBlank(record.validation.message, "patch rejection message");
	}
	return record;
}

function samePatch(left: IntegrationState, right: IntegrationState): boolean {
	if (left.kind === "pending" || right.kind === "pending") return true;
	return left.patchId === right.patchId;
}

export function transitionIntegration(current: IntegrationState, next: IntegrationState): IntegrationState {
	if (current.kind === "pending") {
		if (next.kind !== "applying") invalid(`cannot transition pending to ${next.kind}`);
		return next;
	}
	if (!samePatch(current, next)) {
		invalid(`cannot transition ${current.kind} for one patch to ${next.kind} for another patch`);
	}

	switch (current.kind) {
		case "applying":
			if (next.kind !== "accepted" && next.kind !== "rejected") {
				invalid(`cannot transition applying to ${next.kind}`);
			}
			return next;
		case "accepted":
			if (next.kind !== "reverted") invalid(`cannot transition accepted to ${next.kind}`);
			return next;
		case "rejected":
			return invalid(`cannot regress rejected state to ${next.kind}`);
		case "reverted":
			return invalid(`cannot transition terminal reverted state to ${next.kind}`);
	}
}
