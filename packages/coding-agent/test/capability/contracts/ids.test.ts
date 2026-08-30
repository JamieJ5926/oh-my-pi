import { describe, expect, it } from "bun:test";
import {
	type ArtifactMeta,
	createAttemptId,
	createChangePlanId,
	createChangeUnitId,
	createChunkId,
	createChunkPlanId,
	createEvidencePacketId,
	createIntegrationRunId,
	createManifestEntryId,
	createManifestId,
	createOperationId,
	createPatchId,
	createSynthesisNodeId,
	createWriteWaveId,
	parseArtifactMeta,
	parseAttemptId,
	parseChangePlanId,
	parseChangeUnitId,
	parseChunkId,
	parseChunkPlanId,
	parseEvidencePacketId,
	parseIntegrationRunId,
	parseManifestEntryId,
	parseManifestId,
	parseOperationId,
	parsePatchId,
	parseSynthesisNodeId,
	parseWriteWaveId,
} from "../../../src/capability/contracts/ids";

type IdCase = readonly [string, string, (value: string) => string, (value: unknown) => string | undefined];
const idCases: readonly IdCase[] = [
	["OperationId", "op_", createOperationId, parseOperationId],
	["ManifestId", "manifest_", createManifestId, parseManifestId],
	["ManifestEntryId", "entry_", createManifestEntryId, parseManifestEntryId],
	["ChunkPlanId", "chunk_plan_", createChunkPlanId, parseChunkPlanId],
	["ChunkId", "chunk_", createChunkId, parseChunkId],
	["AttemptId", "attempt_", createAttemptId, parseAttemptId],
	["EvidencePacketId", "evidence_", createEvidencePacketId, parseEvidencePacketId],
	["SynthesisNodeId", "synthesis_", createSynthesisNodeId, parseSynthesisNodeId],
	["ChangePlanId", "change_plan_", createChangePlanId, parseChangePlanId],
	["ChangeUnitId", "change_unit_", createChangeUnitId, parseChangeUnitId],
	["WriteWaveId", "wave_", createWriteWaveId, parseWriteWaveId],
	["PatchId", "patch_", createPatchId, parsePatchId],
	["IntegrationRunId", "integration_", createIntegrationRunId, parseIntegrationRunId],
];

describe("capability contract identifiers", () => {
	it("constructs and parses every canonical identifier", () => {
		for (const [name, prefix, create, parse] of idCases) {
			const value = `${prefix}example`;
			const id = create(value);
			expect(id, name).toBe(value);
			expect(parse(id), name).toBe(id);
			expect(parse(value), name).toBe(id);
		}
	});
	it("does not parse chunk plan identifiers as chunk identifiers", () => {
		const chunkPlanId = createChunkPlanId("chunk_plan_example");
		expect(parseChunkId(chunkPlanId)).toBeUndefined();
	});

	it("rejects blank suffixes and wrong prefixes", () => {
		for (const [name, prefix, create, parse] of idCases) {
			expect(() => create(prefix), name).toThrow();
			expect(() => create("wrong_example"), name).toThrow();
			expect(parse(prefix), name).toBeUndefined();
			expect(parse("wrong_example"), name).toBeUndefined();
		}
	});

	it("rejects non-string parser inputs", () => {
		for (const [, , , parse] of idCases) {
			expect(parse(undefined)).toBeUndefined();
			expect(parse(null)).toBeUndefined();
			expect(parse({})).toBeUndefined();
		}
	});
});

describe("parseArtifactMeta", () => {
	const operationId = createOperationId("op_example");
	const validMeta: ArtifactMeta = {
		schemaVersion: "1",
		createdAt: "2026-08-29T12:34:56.000Z",
		operationId,
	};

	it("parses valid versioned metadata", () => {
		expect(parseArtifactMeta(validMeta)).toEqual(validMeta);
	});

	it("rejects malformed metadata", () => {
		const malformedValues: unknown[] = [
			undefined,
			null,
			{},
			{ ...validMeta, schemaVersion: "2" },
			{ ...validMeta, createdAt: "2026-08-29" },
			{ ...validMeta, createdAt: "not-a-timestamp" },
			{ schemaVersion: "1", createdAt: validMeta.createdAt },
			{ schemaVersion: "1", operationId },
			{ ...validMeta, operationId: "manifest_wrong" },
		];

		for (const value of malformedValues) expect(parseArtifactMeta(value)).toBeUndefined();
	});
});
