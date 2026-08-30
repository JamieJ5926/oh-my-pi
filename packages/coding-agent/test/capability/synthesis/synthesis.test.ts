import { describe, expect, test } from "bun:test";
import type { EvidencePacket } from "../../../src/capability/contracts/evidence";
import {
	createAttemptId,
	createChunkId,
	createEvidencePacketId,
	createManifestEntryId,
	createOperationId,
} from "../../../src/capability/contracts/ids";
import { buildSynthesisTree, reviewFinalSynthesis } from "../../../src/capability/synthesis/synthesis";

const entryId = createManifestEntryId("entry_auth");
function packet(id: string, summary: string, withEvidence = true): EvidencePacket {
	return {
		meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_synthesis") },
		packetId: createEvidencePacketId(`evidence_${id}`),
		chunkId: createChunkId(`chunk_${id}`),
		attemptId: createAttemptId(`attempt_${id}`),
		processedEntryIds: [entryId],
		skippedEntries: [],
		findings: [
			{
				summary,
				evidence: withEvidence ? [{ manifestEntryId: entryId, path: "auth.ts", lineRange: [1, 2] }] : ([] as never),
			},
		],
		uncertainties: [{ summary: "version unknown", evidence: [{ manifestEntryId: entryId, path: "auth.ts" }] }],
	};
}
const policy = {
	maxFanIn: 2,
	singleStepThreshold: 2,
	regionForPacket: (value: EvidencePacket) => (value.chunkId.includes("auth") ? "auth" : "api"),
};

describe("synthesis", () => {
	test("uses an explicit deterministic single-step path and deduplicates supported claims", () => {
		const tree = buildSynthesisTree([packet("b", "auth enabled"), packet("a", "auth enabled")], policy);
		expect(tree).toHaveLength(1);
		expect(tree[0]?.findings).toHaveLength(1);
		expect(tree).toEqual(buildSynthesisTree([packet("a", "auth enabled"), packet("b", "auth enabled")], policy));
	});

	test("builds regional nodes and preserves contradictions and uncertainties", () => {
		const tree = buildSynthesisTree(
			[packet("auth-one", "auth enabled"), packet("auth-two", "auth not enabled"), packet("api-one", "api ready")],
			policy,
		);
		const final = tree.at(-1)!;
		expect(final.childNodeIds.length).toBe(2);
		expect(final.contradictions).toHaveLength(1);
		expect(final.uncertainties).toEqual([
			{ summary: "version unknown", evidence: [{ manifestEntryId: entryId, path: "auth.ts" }] },
		]);
		expect(reviewFinalSynthesis(final, new Set([entryId]))).toBe(final);
	});

	test("rejects unsupported and unknown evidence", () => {
		expect(() => buildSynthesisTree([packet("bad", "unsupported", false)], policy)).toThrow("Unsupported finding");
		const final = buildSynthesisTree([packet("a", "supported")], policy)[0]!;
		expect(() => reviewFinalSynthesis(final, new Set())).toThrow("Unknown final evidence identity");
	});
});
