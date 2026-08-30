import { describe, expect, test } from "bun:test";
import type { ChunkPlan } from "../../../src/capability/contracts/chunks";
import {
	createChunkId,
	createChunkPlanId,
	createManifestEntryId,
	createManifestId,
	createOperationId,
} from "../../../src/capability/contracts/ids";
import type { Manifest } from "../../../src/capability/contracts/manifest";
import { buildReaderJobs } from "../../../src/capability/inspect/reader-job-builder";

const a = createManifestEntryId("entry_a");
const b = createManifestEntryId("entry_b");
const manifest: Manifest = {
	meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_reader") },
	manifestId: createManifestId("manifest_reader"),
	repositoryRoot: "/tmp/repo",
	repositoryRevision: "rev",
	selectors: [{ kind: "repository" }],
	exclusions: [],
	entries: [
		{ entryId: a, path: "a.ts", kind: { kind: "file" }, sizeBytes: 4, line_count: 1, contentHash: "a", metadata: {} },
		{
			entryId: b,
			path: "b.ts",
			kind: { kind: "unreadable", reason: "denied" },
			sizeBytes: 0,
			line_count: 0,
			metadata: {},
		},
	],
};
const chunkPlan: ChunkPlan = {
	meta: manifest.meta,
	chunkPlanId: createChunkPlanId("chunk_plan_reader"),
	manifestId: manifest.manifestId,
	policy: {},
	chunks: [
		{
			chunkId: createChunkId("chunk_reader"),
			objective: "inspect",
			assignedEntryIds: [a],
			readDependencyEntryIds: [b],
			estimatedSourceTokens: 1,
			expectedOutputSchema: { type: "object" },
		},
	],
};

describe("buildReaderJobs", () => {
	test("maps chunks deterministically without embedding source blobs", () => {
		const jobs = buildReaderJobs({
			manifest,
			chunkPlan,
			objective: "inspect",
			agent: { id: "reader", name: "Reader" },
			modelPolicy: { modelRole: "researcher" },
			retryPolicy: { retryLimit: 1 },
			timeoutPolicy: { timeoutMs: 1000 },
			budget: { maxTokens: 100 },
		});
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job?.jobId).toBe("reader-chunk_reader");
		expect(job?.operationId).toBe(manifest.meta.operationId);
		expect(job?.capabilityStage).toBe("inspect_chunk");
		expect(job?.modelPolicy).toEqual({ modelRole: "researcher" });
		expect(job?.budget).toEqual({ maxTokens: 100 });
		const input = job?.input as Record<string, unknown>;
		expect(input.assignedEntries).toEqual([{ entryId: a, path: "a.ts", kind: { kind: "file" }, contentHash: "a" }]);
		expect(input.readDependencies).toEqual([
			{ entryId: b, path: "b.ts", kind: { kind: "unreadable", reason: "denied" } },
		]);
		expect(JSON.stringify(input)).not.toContain("export const");
		expect(JSON.stringify(input)).toContain("Do not modify repository files");
		expect(JSON.stringify(input)).toContain("preserve manifest entry identity");
	});

	test("rejects unknown correlated IDs", () => {
		const invalid: ChunkPlan = {
			...chunkPlan,
			chunks: [{ ...chunkPlan.chunks[0]!, assignedEntryIds: [createManifestEntryId("entry_missing")] }],
		};
		expect(() =>
			buildReaderJobs({ manifest, chunkPlan: invalid, objective: "inspect", agent: { id: "r", name: "R" } }),
		).toThrow("Unknown assigned");
	});
});
