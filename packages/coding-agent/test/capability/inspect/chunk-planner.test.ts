import { describe, expect, test } from "bun:test";

import { createManifestEntryId, createManifestId, createOperationId } from "../../../src/capability/contracts/ids";
import { createManifest, type Manifest, type ManifestEntry } from "../../../src/capability/contracts/manifest";
import { planChunks } from "../../../src/capability/inspect/chunk-planner";

function entry(name: string, tokens: number, packageName?: string, lineCount = tokens): ManifestEntry {
	return {
		entryId: createManifestEntryId(`entry_${name}`),
		path: packageName ? `packages/${packageName}/${name}.ts` : `src/${name}.ts`,
		kind: { kind: "file" },
		sizeBytes: tokens * 4,
		line_count: lineCount,
		estimatedTokens: tokens,
		contentHash: name,
		...(packageName ? { package: packageName } : {}),
		metadata: {},
	};
}

function manifest(entries: readonly ManifestEntry[]): Manifest {
	return createManifest({
		meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_chunks") },
		manifestId: createManifestId("manifest_chunks"),
		repositoryRoot: "/tmp/repo",
		repositoryRevision: "rev",
		selectors: [{ kind: "repository" }],
		exclusions: [],
		entries,
	});
}

describe("planChunks", () => {
	test("is deterministic and assigns every required entry exactly once", () => {
		const source = manifest([entry("c", 2), entry("a", 2), entry("b", 2)]);
		const request = {
			manifest: source,
			objective: "inspect",
			policy: { maxFilesPerChunk: 2, targetSourceTokensPerChunk: 10 },
			expectedOutputSchema: { type: "object" },
		};
		const first = planChunks(request);
		const second = planChunks(request);
		expect(second).toEqual(first);
		expect(first.chunks.flatMap(chunk => chunk.assignedEntryIds).sort()).toEqual(
			source.entries.map(item => item.entryId).sort(),
		);
		expect(first.chunks.map(chunk => chunk.assignedEntryIds.length)).toEqual([2, 1]);
	});

	test("keeps package groups separate and respects token boundaries", () => {
		const source = manifest([entry("a", 6, "one"), entry("b", 6, "one"), entry("c", 1, "two")]);
		const plan = planChunks({
			manifest: source,
			objective: "inspect",
			policy: { maxFilesPerChunk: 10, targetSourceTokensPerChunk: 10 },
			expectedOutputSchema: {},
		});
		expect(plan.chunks).toHaveLength(3);
		expect(plan.chunks.map(chunk => chunk.estimatedSourceTokens).sort((a, b) => a - b)).toEqual([1, 6, 6]);
	});

	test("supports empty, one-file, and oversized manifests", () => {
		expect(
			planChunks({ manifest: manifest([]), objective: "inspect", policy: {}, expectedOutputSchema: {} }).chunks,
		).toEqual([]);
		const one = planChunks({
			manifest: manifest([entry("large", 100)]),
			objective: "inspect",
			policy: { targetSourceTokensPerChunk: 10, allowLineRangeSplit: false },
			expectedOutputSchema: {},
		});
		expect(one.chunks).toHaveLength(1);
		expect(one.chunks[0]?.estimatedSourceTokens).toBe(100);
	});
	test("splits only above the line boundary into contiguous inclusive ranges", () => {
		const source = manifest([entry("small", 100, undefined, 250), entry("boundary", 100, undefined, 251)]);
		const plan = planChunks({
			manifest: source,
			objective: "inspect",
			policy: { allowLineRangeSplit: true, targetSourceTokensPerChunk: 200 },
			expectedOutputSchema: {},
		});
		expect(
			plan.chunks.find(chunk => chunk.assignedEntryIds.includes(createManifestEntryId("entry_small")))
				?.assignedRanges,
		).toBeUndefined();
		const ranges = plan.chunks.filter(chunk => chunk.assignedRanges).flatMap(chunk => chunk.assignedRanges ?? []);
		expect(ranges.map(range => ({ ...range, entryId: range.entryId.toString() }))).toEqual([
			{ entryId: "entry_boundary", startLine: 1, endLine: 126 },
			{ entryId: "entry_boundary", startLine: 127, endLine: 251 },
		]);
	});
	test("allows dependency overlap without ownership overlap", () => {
		const a = entry("a", 1);
		const b = entry("b", 1);
		const source = manifest([a, b]);
		const plan = planChunks({
			manifest: source,
			objective: "inspect",
			policy: { maxFilesPerChunk: 1 },
			expectedOutputSchema: {},
			dependencyEntryIds: { [a.entryId]: [b.entryId], [b.entryId]: [a.entryId] },
		});
		expect(plan.chunks.map(chunk => chunk.readDependencyEntryIds)).toEqual([[b.entryId], [a.entryId]]);
	});
});
