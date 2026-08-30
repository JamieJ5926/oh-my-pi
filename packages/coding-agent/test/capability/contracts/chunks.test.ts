import { describe, expect, it } from "bun:test";
import {
	type ChunkPlan,
	createChunkPlan,
	isValidChunkPlan,
	type ReadChunk,
	validateChunkPlan,
} from "../../../src/capability/contracts/chunks";
import {
	type ArtifactMeta,
	createChunkId,
	createChunkPlanId,
	createManifestEntryId,
	createManifestId,
	createOperationId,
} from "../../../src/capability/contracts/ids";
import { createManifest, type Manifest, type ManifestEntry } from "../../../src/capability/contracts/manifest";

const meta: ArtifactMeta = {
	schemaVersion: "1",
	createdAt: "2026-08-29T12:34:56.000Z",
	operationId: createOperationId("op_chunk-tests"),
};
const root = "/repo/project";

function manifestEntryId(id: string) {
	return createManifestEntryId(id.startsWith("entry_") ? id : `entry_${id}`);
}

function chunkId(id: string) {
	return createChunkId(id.startsWith("chunk_") ? id : `chunk_${id}`);
}

function entry(id: string, filePath: string, kind: ManifestEntry["kind"] = { kind: "file" }): ManifestEntry {
	return { entryId: manifestEntryId(id), path: filePath, kind, sizeBytes: 10, line_count: 1, metadata: {} };
}

function manifest(entries: readonly ManifestEntry[]): Manifest {
	return createManifest({
		meta,
		manifestId: createManifestId("manifest_chunk-tests"),
		repositoryRoot: root,
		repositoryRevision: "HEAD",
		selectors: [{ kind: "repository" }],
		exclusions: [],
		entries,
	});
}

function chunk(
	id: string,
	assignedPaths: readonly [string, ...string[]],
	dependencies: readonly string[] = [],
): ReadChunk {
	const [firstAssignedPath, ...remainingAssignedPaths] = assignedPaths;
	return {
		chunkId: chunkId(id),
		objective: "inspect files",
		assignedEntryIds: [manifestEntryId(firstAssignedPath), ...remainingAssignedPaths.map(manifestEntryId)],
		readDependencyEntryIds: dependencies.map(manifestEntryId),
		estimatedSourceTokens: 10,
		expectedOutputSchema: { type: "object" },
	};
}

function plan(chunks: readonly ReadChunk[], target: Manifest): ChunkPlan {
	return {
		meta,
		chunkPlanId: createChunkPlanId("chunk_plan_tests"),
		manifestId: target.manifestId,
		policy: { targetSourceTokensPerChunk: 100, maxFilesPerChunk: 2 },
		chunks,
	};
}

describe("chunk plan contracts", () => {
	it("requires every required manifest ID to have exactly one owner", () => {
		const target = manifest([entry("a", "a.ts"), entry("b", "b.ts")]);
		expect(() => createChunkPlan(plan([chunk("one", ["a"])], target), target)).toThrow(/not assigned/);
		expect(() => createChunkPlan(plan([chunk("one", ["a", "a"]), chunk("two", ["b"])], target), target)).toThrow(
			/duplicate ID/,
		);
		expect(() => createChunkPlan(plan([chunk("one", ["a"]), chunk("two", ["a", "b"])], target), target)).toThrow(
			/multiple owners/,
		);
	});

	it("allows dependency overlap while keeping assigned ownership disjoint", () => {
		const target = manifest([entry("a", "a.ts"), entry("b", "b.ts"), entry("c", "c.ts")]);
		const valid = createChunkPlan(
			plan([chunk("one", ["a"], ["c"]), chunk("two", ["b"], ["c"]), chunk("three", ["c"])], target),
			target,
		);
		expect(valid.chunks.map(item => item.chunkId)).toEqual([chunkId("one"), chunkId("two"), chunkId("three")]);
		expect(valid.chunks[0].readDependencyEntryIds).toEqual([manifestEntryId("c")]);
		expect(Object.isFrozen(valid)).toBe(true);
		expect(Object.isFrozen(valid.chunks)).toBe(true);
	});

	it("sorts chunk order deterministically and rejects unsorted canonical plans", () => {
		const target = manifest([entry("a", "a.ts"), entry("b", "b.ts")]);
		const normalized = createChunkPlan(plan([chunk("two", ["b"]), chunk("one", ["a"])], target), target);
		expect(normalized.chunks.map(item => item.assignedEntryIds[0])).toEqual([
			manifestEntryId("a"),
			manifestEntryId("b"),
		]);
		const unsorted = plan([chunk("two", ["b"]), chunk("one", ["a"])], target);
		expect(() => validateChunkPlan(unsorted, target)).toThrow(/deterministic order|assigned-entry order/);
	});

	it("supports empty manifests with no chunks", () => {
		const target = manifest([]);
		const empty = createChunkPlan(plan([], target), target);
		expect(empty.chunks).toEqual([]);
		expect(validateChunkPlan(empty, target)).toBe(empty);
		expect(isValidChunkPlan(empty, target)).toBe(true);
	});

	it("supports a one-file manifest with one owning chunk", () => {
		const target = manifest([entry("only", "README.md")]);
		const one = createChunkPlan(plan([chunk("one", ["only"])], target), target);
		expect(validateChunkPlan(one, target)).toBe(one);
		expect(one.chunks[0].assignedEntryIds).toEqual([manifestEntryId("only")]);
	});

	it("does not assign unsupported or unreadable status-only entries", () => {
		const target = manifest([
			entry("file", "a.ts"),
			entry("unsupported", "a.bin", { kind: "unsupported", reason: "binary" }),
			entry("unreadable", "secret.ts", { kind: "unreadable", reason: "permission denied" }),
		]);
		const valid = createChunkPlan(plan([chunk("one", ["file"])], target), target);
		expect(valid.chunks[0].assignedEntryIds).toEqual([manifestEntryId("file")]);
	});
});
