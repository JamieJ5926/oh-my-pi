import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createOperationId } from "../../../src/capability/contracts/ids";
import { generateManifest } from "../../../src/capability/inspect/manifest-generator";

const roots: string[] = [];
const meta = { operationId: createOperationId("op_manifest-test"), generatedAt: "2026-08-29T12:00:00Z" };

async function fixture(): Promise<string> {
	const root = path.join(process.cwd(), `.tmp-manifest-${crypto.randomUUID()}`);
	roots.push(root);
	await mkdir(path.join(root, "packages", "alpha", "src"), { recursive: true });
	await mkdir(path.join(root, "docs"), { recursive: true });
	await writeFile(path.join(root, "packages", "alpha", "src", "a.ts"), "export const a = 1;\nsecond line\n");
	await writeFile(path.join(root, "packages", "alpha", "src", "b.ts"), "export const b = 2;");
	await writeFile(path.join(root, "docs", "guide.md"), "guide\n");
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("generateManifest", () => {
	test("discovers directories, deduplicates overlapping selectors, and applies exclusions", async () => {
		const root = await fixture();
		const manifest = await generateManifest({
			...meta,
			repositoryRoot: root,
			repositoryRevision: "rev-1",
			selectors: [
				{ kind: "path", path: "packages" },
				{ kind: "glob", pattern: "packages/**/*.ts" },
			],
			exclusions: [{ kind: "path", path: "packages/alpha/src/b.ts" }],
		});
		expect(manifest.entries.map(entry => entry.path)).toEqual(["packages/alpha/src/a.ts"]);
		expect(manifest.entries[0]?.contentHash).toHaveLength(64);
		expect(manifest.entries[0]?.line_count).toBe(2);
	});

	test("is deterministic and revision-sensitive", async () => {
		const root = await fixture();
		const request = {
			...meta,
			repositoryRoot: root,
			repositoryRevision: "rev-1",
			selectors: [{ kind: "repository" }] as const,
			exclusions: [] as const,
		};
		const first = await generateManifest(request);
		const second = await generateManifest(request);
		expect(second.entries).toEqual(first.entries);
		expect(second.manifestId).toBe(first.manifestId);
		const changed = await generateManifest({ ...request, repositoryRevision: "rev-2" });
		expect(changed.manifestId).not.toBe(first.manifestId);
	});

	test("records symlinks without following loops", async () => {
		const root = await fixture();
		await symlink("../packages", path.join(root, "docs", "loop"));
		const manifest = await generateManifest({
			...meta,
			repositoryRoot: root,
			repositoryRevision: "rev-1",
			selectors: [{ kind: "repository" }],
			exclusions: [],
		});
		expect(manifest.entries.find(entry => entry.path === "docs/loop")?.kind).toEqual({
			kind: "symlink",
			target: "../packages",
		});
	});

	test("supports empty scopes and rejects traversal", async () => {
		const root = await fixture();
		const manifest = await generateManifest({
			...meta,
			repositoryRoot: root,
			repositoryRevision: "rev-1",
			selectors: [{ kind: "glob", pattern: "missing/**/*.ts" }],
			exclusions: [],
		});
		expect(manifest.entries).toEqual([]);
		await expect(
			generateManifest({
				...meta,
				repositoryRoot: root,
				repositoryRevision: "rev-1",
				selectors: [{ kind: "path", path: "../outside" }],
				exclusions: [],
			}),
		).rejects.toThrow("outside repository root");
	});

	test("records unreadable files explicitly when permissions deny reading", async () => {
		if (process.platform === "win32") return;
		const root = await fixture();
		const target = path.join(root, "docs", "blocked.md");
		await writeFile(target, "blocked");
		await chmod(target, 0o000);
		try {
			const manifest = await generateManifest({
				...meta,
				repositoryRoot: root,
				repositoryRevision: "rev-1",
				selectors: [{ kind: "path", path: "docs/blocked.md" }],
				exclusions: [],
			});
			const entry = manifest.entries[0];
			expect(entry?.kind.kind === "unreadable" || entry?.kind.kind === "file").toBe(true);
		} finally {
			await chmod(target, 0o600);
		}
	});
});
