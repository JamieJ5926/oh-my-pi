import { describe, expect, it } from "bun:test";
import {
	type EvidencePacket,
	type EvidenceReference,
	type Finding,
	validateEvidencePacket,
	validateFinding,
} from "../../../src/capability/contracts/evidence";
import {
	createAttemptId,
	createChunkId,
	createEvidencePacketId,
	createManifestEntryId,
	createOperationId,
} from "../../../src/capability/contracts/ids";
import type { Manifest } from "../../../src/capability/contracts/manifest";

const operationId = createOperationId("op_evidence_test");
const firstEntry = createManifestEntryId("entry_first");
const secondEntry = createManifestEntryId("entry_second");
const packetMeta = { schemaVersion: "1" as const, createdAt: "2026-08-29T12:00:00.000Z", operationId };
const reference: EvidenceReference = { manifestEntryId: firstEntry, path: "src/first.ts", lineRange: [1, 3] };
const finding: Finding = { summary: "Observed behavior", evidence: [reference] };
const manifest = {
	entries: [
		{ entryId: firstEntry, path: "src/first.ts", line_count: 20 },
		{ entryId: secondEntry, path: "src/second.ts", line_count: 20 },
	],
} as unknown as Manifest;
const validationContext = { manifest, assignedRanges: [{ entryId: firstEntry, startLine: 1, endLine: 3 }] };
const packet: EvidencePacket = {
	meta: packetMeta,
	packetId: createEvidencePacketId("evidence_packet"),
	chunkId: createChunkId("chunk_test"),
	attemptId: createAttemptId("attempt_test"),
	processedEntryIds: [firstEntry],
	skippedEntries: [],
	findings: [finding],
	uncertainties: [],
};

const expectInvalid = (action: () => unknown, message: string): void => {
	expect(action).toThrow(message);
};

describe("evidence contract", () => {
	it("accepts cited findings and known processed entries", () => {
		expect(validateEvidencePacket(packet, [firstEntry], validationContext)).toBe(packet);
	});

	it("rejects uncited findings", () => {
		const uncited = { summary: "Missing support", evidence: [] } as unknown as Finding;
		expectInvalid(() => validateFinding(uncited, [firstEntry]), "must cite evidence");
	});

	it("rejects evidence references for unknown entry IDs", () => {
		const unknownReference: EvidenceReference = { manifestEntryId: secondEntry, path: "src/missing.ts" };
		const unknownFinding: Finding = { summary: "Unsupported", evidence: [unknownReference] };
		expectInvalid(() => validateFinding(unknownFinding, [firstEntry]), "unknown evidence entry");
	});

	it("rejects duplicate and unknown packet entry IDs", () => {
		expectInvalid(
			() => validateEvidencePacket({ ...packet, processedEntryIds: [firstEntry, firstEntry] }, [firstEntry]),
			"duplicate processed entry",
		);
		expectInvalid(
			() => validateEvidencePacket({ ...packet, processedEntryIds: [secondEntry] }, [firstEntry]),
			"unknown processed entry",
		);
	});

	it("rejects entries reported as both processed and skipped", () => {
		expectInvalid(
			() => validateEvidencePacket({ ...packet, skippedEntries: [{ entryId: firstEntry, reason: "not needed" }] }, [firstEntry]),
			"both processed and skipped",
		);
	});

	it("rejects a citation for an assigned entry skipped by the packet", () => {
		const skippedFinding: Finding = {
			summary: "Skipped",
			evidence: [{ ...reference, manifestEntryId: secondEntry, path: "src/second.ts" }],
		};
		const skippedCitation = {
			...packet,
			processedEntryIds: [firstEntry],
			skippedEntries: [{ entryId: secondEntry, reason: "not needed" }],
			findings: [skippedFinding],
		};
		expectInvalid(
			() => validateEvidencePacket(skippedCitation, [firstEntry, secondEntry], validationContext),
			"processed",
		);
	});

	it("rejects a citation whose path differs from the manifest path", () => {
		const wrongPathFinding: Finding = {
			summary: "Wrong path",
			evidence: [{ ...reference, path: "src/other.ts" }],
		};
		const wrongPath = { ...packet, findings: [wrongPathFinding] };
		expectInvalid(() => validateEvidencePacket(wrongPath, [firstEntry], validationContext), "path");
	});

	it("rejects a citation outside an inspected assigned range", () => {
		const outsideRangeFinding: Finding = {
			summary: "Uninspected",
			evidence: [{ ...reference, lineRange: [4, 5] }],
		};
		const outsideRange = { ...packet, findings: [outsideRangeFinding] };
		expectInvalid(() => validateEvidencePacket(outsideRange, [firstEntry], validationContext), "inspected");
	});
});
