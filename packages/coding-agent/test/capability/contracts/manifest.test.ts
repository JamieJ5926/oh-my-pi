import { describe, expect, it } from "bun:test";
import {
	type ArtifactMeta,
	createManifestEntryId,
	createManifestId,
	createOperationId,
} from "../../../src/capability/contracts/ids";
import {
	createManifest,
	isValidManifest,
	type Manifest,
	type ManifestEntry,
	normalizeManifestPath,
	requiredManifestEntryIds,
	validateManifest,
} from "../../../src/capability/contracts/manifest";

const meta: ArtifactMeta = {
	schemaVersion: "1",
	createdAt: "2026-08-29T12:34:56.000Z",
	operationId: createOperationId("op_manifest-tests"),
};
const root = "/repo/project";

function manifestEntryId(id: string) {
	return createManifestEntryId(id.startsWith("entry_") ? id : `entry_${id}`);
}

function entry(id: string, filePath: string, kind: ManifestEntry["kind"] = { kind: "file" }): ManifestEntry {
	return { entryId: manifestEntryId(id), path: filePath, kind, sizeBytes: 10, line_count: 1, metadata: { source: "test" } };
}

function manifest(entries: readonly ManifestEntry[]): Manifest {
	return {
		meta,
		manifestId: createManifestId("manifest_tests"),
		repositoryRoot: root,
		repositoryRevision: "HEAD",
		selectors: [{ kind: "repository" }],
		exclusions: [],
		entries,
	};
}

describe("manifest contracts", () => {
	it("normalizes paths, sorts entries, and freezes the result", () => {
		const normalized = createManifest(manifest([entry("b", "src\\z.ts"), entry("a", "./src/a.ts")]));
		expect(normalized.repositoryRoot).toBe(root);
		expect(normalized.entries.map(item => item.path)).toEqual(["src/a.ts", "src/z.ts"]);
		expect(Object.isFrozen(normalized)).toBe(true);
		expect(Object.isFrozen(normalized.entries)).toBe(true);
		expect(Object.isFrozen(normalized.entries[0])).toBe(true);
		expect(() => (normalized.entries as ManifestEntry[]).push(entry("c", "src/c.ts"))).toThrow();
	});

	it("rejects duplicate paths after normalization", () => {
		expect(() => createManifest(manifest([entry("a", "src/a.ts"), entry("b", "./src/a.ts")]))).toThrow(
			/Duplicate manifest path/,
		);
	});

	it("rejects duplicate entry IDs", () => {
		expect(() => createManifest(manifest([entry("same", "src/a.ts"), entry("same", "src/b.ts")]))).toThrow(
			/Duplicate manifest entry ID/,
		);
	});

	it("rejects paths outside the repository root", () => {
		expect(normalizeManifestPath(root, "src/../src/a.ts")).toBe("src/a.ts");
		expect(() => createManifest(manifest([entry("escape", "../outside.ts")]))).toThrow(/outside repositoryRoot/);
		expect(() => createManifest(manifest([entry("absolute", "/outside.ts")]))).toThrow(/outside repositoryRoot/);
	});

	it("requires explicit unsupported and unreadable status reasons", () => {
		expect(() =>
			createManifest(manifest([entry("unsupported", "assets/data.bin", { kind: "unsupported", reason: "binary" })])),
		).not.toThrow();
		expect(() =>
			createManifest(
				manifest([entry("unreadable", "src/secret.ts", { kind: "unreadable", reason: "permission denied" })]),
			),
		).not.toThrow();
		expect(() =>
			createManifest(manifest([entry("missing", "src/missing.ts", { kind: "unsupported", reason: "" })])),
		).toThrow(/require an explicit reason/);
	});

	it("accepts an empty manifest and excludes status-only entries from required IDs", () => {
		expect(requiredManifestEntryIds(createManifest(manifest([])))).toEqual([]);
		const withStatus = createManifest(
			manifest([
				entry("unsupported", "assets/data.bin", { kind: "unsupported", reason: "binary" }),
				entry("readable", "src/a.ts"),
				entry("unreadable", "src/secret.ts", { kind: "unreadable", reason: "permission denied" }),
			]),
		);
		expect(requiredManifestEntryIds(withStatus)).toEqual([manifestEntryId("readable")]);
	});

	it("rejects unsorted entries when validating an already canonical record", () => {
		const unsorted = manifest([entry("b", "src/b.ts"), entry("a", "src/a.ts")]);
		expect(() => validateManifest(unsorted)).toThrow(/must be sorted/);
		expect(isValidManifest(unsorted)).toBe(false);
	});

	it("accepts and validates a one-file manifest", () => {
		const one = createManifest(manifest([entry("only", "README.md")]));
		expect(validateManifest(one)).toBe(one);
		expect(requiredManifestEntryIds(one)).toEqual([manifestEntryId("only")]);
		expect(isValidManifest(one)).toBe(true);
	});
});
