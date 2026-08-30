import type { ArtifactMeta, AttemptId, ChunkId, EvidencePacketId, ManifestEntryId } from "./ids";
import type { ChunkLineRange } from "./chunks";
import type { Manifest } from "./manifest";

export interface EvidenceReference {
	readonly manifestEntryId: ManifestEntryId;
	readonly path: string;
	readonly symbol?: string;
	readonly lineRange?: readonly [number, number];
}

export interface Finding {
	readonly summary: string;
	readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]];
}

export interface Uncertainty {
	readonly summary: string;
	readonly evidence?: readonly EvidenceReference[];
}

export interface SkippedEntry {
	readonly entryId: ManifestEntryId;
	readonly reason: string;
}

export interface EvidencePacket {
	readonly meta: ArtifactMeta;
	readonly packetId: EvidencePacketId;
	readonly chunkId: ChunkId;
	readonly attemptId: AttemptId;
	readonly processedEntryIds: readonly ManifestEntryId[];
	readonly skippedEntries: readonly SkippedEntry[];
	readonly findings: readonly Finding[];
	readonly uncertainties: readonly Uncertainty[];
}

export type AssignedEntryIds = ReadonlySet<ManifestEntryId> | readonly ManifestEntryId[];

function idSet(ids: AssignedEntryIds): Set<ManifestEntryId> {
	return new Set(ids);
}

function fail(message: string): never {
	throw new Error(`Invalid evidence packet: ${message}`);
}

function assertUniqueAndKnown(
	ids: readonly ManifestEntryId[],
	knownIds: ReadonlySet<ManifestEntryId>,
	label: string,
): void {
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) fail(`duplicate ${label} ${id}`);
		seen.add(id);
		if (!knownIds.has(id)) fail(`unknown ${label} ${id}`);
	}
}

function validateEvidenceReference(
	reference: EvidenceReference,
	knownIds: ReadonlySet<ManifestEntryId>,
	context?: EvidenceValidationContext,
): void {
	if (!knownIds.has(reference.manifestEntryId)) {
		fail(`unknown evidence entry ${reference.manifestEntryId}`);
	}
	if (reference.path.trim().length === 0) fail("evidence path must not be blank");
	if (reference.symbol !== undefined && reference.symbol.trim().length === 0) {
		fail("evidence symbol must not be blank");
	}
	if (reference.lineRange !== undefined) {
		const [start, end] = reference.lineRange;
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
			fail("evidence line range must contain positive ordered integers");
		}
	}
	if (context === undefined) return;
	const entry = context.manifest.entries.find(candidate => candidate.entryId === reference.manifestEntryId);
	if (entry === undefined) fail(`unknown evidence entry ${reference.manifestEntryId} in manifest`);
	if (reference.path !== entry.path) {
		fail(`evidence path does not match manifest path for ${reference.manifestEntryId}`);
	}
	if (reference.lineRange === undefined || context.assignedRanges === undefined) return;
	const [start, end] = reference.lineRange;
	const isInspected = context.assignedRanges.some(
		range =>
			range.entryId === reference.manifestEntryId &&
			range.startLine <= start &&
			range.endLine >= end,
	);
	if (!isInspected) {
		fail(`evidence line range is outside inspected assigned range for ${reference.manifestEntryId}`);
	}
}

export interface EvidenceValidationContext {
	readonly manifest: Manifest;
	readonly assignedRanges?: readonly ChunkLineRange[];
}

export function validateFinding(
	finding: Finding,
	assignedEntryIds: AssignedEntryIds,
	context?: EvidenceValidationContext,
): Finding {
	const knownIds = idSet(assignedEntryIds);
	if (finding.summary.trim().length === 0) fail("finding summary must not be blank");
	if (finding.evidence.length === 0) fail(`finding ${finding.summary} must cite evidence`);
	for (const reference of finding.evidence) validateEvidenceReference(reference, knownIds, context);
	return finding;
}

export function validateEvidencePacket(
	packet: EvidencePacket,
	assignedEntryIds: AssignedEntryIds,
	context?: EvidenceValidationContext,
): EvidencePacket {
	const assignedIds = idSet(assignedEntryIds);
	assertUniqueAndKnown(packet.processedEntryIds, assignedIds, "processed entry");

	const skippedIds = packet.skippedEntries.map(entry => entry.entryId);
	assertUniqueAndKnown(skippedIds, assignedIds, "skipped entry");
	const processedIds = new Set(packet.processedEntryIds);
	for (const id of skippedIds) {
		if (processedIds.has(id)) fail(`entry ${id} is both processed and skipped`);
	}

	for (const entry of packet.skippedEntries) {
		if (entry.reason.trim().length === 0) fail(`skipped entry ${entry.entryId} needs a reason`);
	}
	for (const finding of packet.findings) {
		for (const reference of finding.evidence) {
			if (!processedIds.has(reference.manifestEntryId)) {
				if (!assignedIds.has(reference.manifestEntryId)) {
					fail(`unknown evidence entry ${reference.manifestEntryId}`);
				}
				fail(`evidence entry ${reference.manifestEntryId} was not processed`);
			}
		}
		validateFinding(finding, processedIds, context);
	}
	for (const uncertainty of packet.uncertainties) {
		if (uncertainty.summary.trim().length === 0) fail("uncertainty summary must not be blank");
		for (const reference of uncertainty.evidence ?? []) {
			if (!processedIds.has(reference.manifestEntryId)) {
				if (!assignedIds.has(reference.manifestEntryId)) {
					fail(`unknown evidence entry ${reference.manifestEntryId}`);
				}
				fail(`evidence entry ${reference.manifestEntryId} was not processed`);
			}
			validateEvidenceReference(reference, processedIds, context);
		}
	}
	return packet;
}

