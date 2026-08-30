type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OperationId = Brand<string, "OperationId">;
export type ManifestId = Brand<string, "ManifestId">;
export type ManifestEntryId = Brand<string, "ManifestEntryId">;
export type ChunkPlanId = Brand<string, "ChunkPlanId">;
export type ChunkId = Brand<string, "ChunkId">;
export type AttemptId = Brand<string, "AttemptId">;
export type EvidencePacketId = Brand<string, "EvidencePacketId">;
export type SynthesisNodeId = Brand<string, "SynthesisNodeId">;
export type ChangePlanId = Brand<string, "ChangePlanId">;
export type ChangeUnitId = Brand<string, "ChangeUnitId">;
export type WriteWaveId = Brand<string, "WriteWaveId">;
export type PatchId = Brand<string, "PatchId">;
export type IntegrationRunId = Brand<string, "IntegrationRunId">;

const OPERATION_PREFIX = "op_";
const MANIFEST_PREFIX = "manifest_";
const MANIFEST_ENTRY_PREFIX = "entry_";
const CHUNK_PLAN_PREFIX = "chunk_plan_";
const CHUNK_PREFIX = "chunk_";
const ATTEMPT_PREFIX = "attempt_";
const EVIDENCE_PACKET_PREFIX = "evidence_";
const SYNTHESIS_NODE_PREFIX = "synthesis_";
const CHANGE_PLAN_PREFIX = "change_plan_";
const CHANGE_UNIT_PREFIX = "change_unit_";
const WRITE_WAVE_PREFIX = "wave_";
const PATCH_PREFIX = "patch_";
const INTEGRATION_RUN_PREFIX = "integration_";

function createBrandedId<Id extends string>(value: string, prefix: string): Id {
	if (!value.startsWith(prefix) || value.slice(prefix.length).trim().length === 0) {
		throw new Error(`Invalid ${prefix} identifier`);
	}
	return value as Id;
}

function parseBrandedId<Id extends string>(value: unknown, prefix: string): Id | undefined {
	return typeof value === "string" ? createBrandedIdSafely<Id>(value, prefix) : undefined;
}

function createBrandedIdSafely<Id extends string>(value: string, prefix: string): Id | undefined {
	if (!value.startsWith(prefix) || value.slice(prefix.length).trim().length === 0) return undefined;
	return value as Id;
}

export function createOperationId(value: string): OperationId {
	return createBrandedId<OperationId>(value, OPERATION_PREFIX);
}

export function parseOperationId(value: unknown): OperationId | undefined {
	return parseBrandedId<OperationId>(value, OPERATION_PREFIX);
}

export function createManifestId(value: string): ManifestId {
	return createBrandedId<ManifestId>(value, MANIFEST_PREFIX);
}

export function parseManifestId(value: unknown): ManifestId | undefined {
	return parseBrandedId<ManifestId>(value, MANIFEST_PREFIX);
}

export function createManifestEntryId(value: string): ManifestEntryId {
	return createBrandedId<ManifestEntryId>(value, MANIFEST_ENTRY_PREFIX);
}

export function parseManifestEntryId(value: unknown): ManifestEntryId | undefined {
	return parseBrandedId<ManifestEntryId>(value, MANIFEST_ENTRY_PREFIX);
}

export function createChunkPlanId(value: string): ChunkPlanId {
	return createBrandedId<ChunkPlanId>(value, CHUNK_PLAN_PREFIX);
}

export function parseChunkPlanId(value: unknown): ChunkPlanId | undefined {
	return parseBrandedId<ChunkPlanId>(value, CHUNK_PLAN_PREFIX);
}

export function createChunkId(value: string): ChunkId {
	return createBrandedId<ChunkId>(value, CHUNK_PREFIX);
}

export function parseChunkId(value: unknown): ChunkId | undefined {
	if (typeof value === "string" && value.startsWith(CHUNK_PLAN_PREFIX)) return undefined;
	return parseBrandedId<ChunkId>(value, CHUNK_PREFIX);
}

export function createAttemptId(value: string): AttemptId {
	return createBrandedId<AttemptId>(value, ATTEMPT_PREFIX);
}

export function parseAttemptId(value: unknown): AttemptId | undefined {
	return parseBrandedId<AttemptId>(value, ATTEMPT_PREFIX);
}

export function createEvidencePacketId(value: string): EvidencePacketId {
	return createBrandedId<EvidencePacketId>(value, EVIDENCE_PACKET_PREFIX);
}

export function parseEvidencePacketId(value: unknown): EvidencePacketId | undefined {
	return parseBrandedId<EvidencePacketId>(value, EVIDENCE_PACKET_PREFIX);
}

export function createSynthesisNodeId(value: string): SynthesisNodeId {
	return createBrandedId<SynthesisNodeId>(value, SYNTHESIS_NODE_PREFIX);
}

export function parseSynthesisNodeId(value: unknown): SynthesisNodeId | undefined {
	return parseBrandedId<SynthesisNodeId>(value, SYNTHESIS_NODE_PREFIX);
}

export function createChangePlanId(value: string): ChangePlanId {
	return createBrandedId<ChangePlanId>(value, CHANGE_PLAN_PREFIX);
}

export function parseChangePlanId(value: unknown): ChangePlanId | undefined {
	return parseBrandedId<ChangePlanId>(value, CHANGE_PLAN_PREFIX);
}

export function createChangeUnitId(value: string): ChangeUnitId {
	return createBrandedId<ChangeUnitId>(value, CHANGE_UNIT_PREFIX);
}

export function parseChangeUnitId(value: unknown): ChangeUnitId | undefined {
	return parseBrandedId<ChangeUnitId>(value, CHANGE_UNIT_PREFIX);
}

export function createWriteWaveId(value: string): WriteWaveId {
	return createBrandedId<WriteWaveId>(value, WRITE_WAVE_PREFIX);
}

export function parseWriteWaveId(value: unknown): WriteWaveId | undefined {
	return parseBrandedId<WriteWaveId>(value, WRITE_WAVE_PREFIX);
}

export function createPatchId(value: string): PatchId {
	return createBrandedId<PatchId>(value, PATCH_PREFIX);
}

export function parsePatchId(value: unknown): PatchId | undefined {
	return parseBrandedId<PatchId>(value, PATCH_PREFIX);
}

export function createIntegrationRunId(value: string): IntegrationRunId {
	return createBrandedId<IntegrationRunId>(value, INTEGRATION_RUN_PREFIX);
}

export function parseIntegrationRunId(value: unknown): IntegrationRunId | undefined {
	return parseBrandedId<IntegrationRunId>(value, INTEGRATION_RUN_PREFIX);
}

export interface ArtifactMeta {
	readonly schemaVersion: "1";
	readonly createdAt: string;
	readonly operationId: OperationId;
}

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRfc3339Timestamp(value: unknown): value is string {
	return typeof value === "string" && RFC3339_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

export function parseArtifactMeta(value: unknown): ArtifactMeta | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (
		!("schemaVersion" in value) ||
		value.schemaVersion !== "1" ||
		!("createdAt" in value) ||
		!isRfc3339Timestamp(value.createdAt)
	) {
		return undefined;
	}
	const operationId = parseOperationId("operationId" in value ? value.operationId : undefined);
	if (operationId === undefined) return undefined;
	return {
		schemaVersion: "1",
		createdAt: value.createdAt,
		operationId,
	};
}
