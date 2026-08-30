import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createManifestEntryId, createManifestId, type OperationId } from "../contracts/ids";
import {
	type Manifest,
	type ManifestEntry,
	normalizeManifest,
	type RevisionIdentity,
	type ScopeSelector,
} from "../contracts/manifest";

export interface GenerateManifestRequest {
	readonly operationId: OperationId;
	readonly repositoryRoot: string;
	readonly repositoryRevision: RevisionIdentity;
	readonly selectors: readonly ScopeSelector[];
	readonly exclusions: readonly ScopeSelector[];
	readonly generatedAt: string;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function physicalLineCount(bytes: Uint8Array): number {
	if (bytes.byteLength === 0) return 0;
	let lineCount = 0;
	for (const byte of bytes) if (byte === 0x0a) lineCount += 1;
	return lineCount + (bytes[bytes.byteLength - 1] === 0x0a ? 0 : 1);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeRelative(root: string, candidate: string): string {
	const absolute = path.resolve(root, candidate);
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (
		relative === "" ||
		relative === "." ||
		relative === ".." ||
		relative.startsWith("../") ||
		path.isAbsolute(relative)
	) {
		throw new Error(`Scope path is outside repository root: ${candidate}`);
	}
	return relative;
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				source += ".*";
			} else source += "[^/]*";
		} else if (character === "?") source += "[^/]";
		else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${source}$`);
}

function selectorMatches(selector: ScopeSelector, relativePath: string): boolean {
	switch (selector.kind) {
		case "repository":
			return true;
		case "path": {
			const selected = selector.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
			return relativePath === selected || relativePath.startsWith(`${selected}/`);
		}
		case "glob":
			return globRegex(selector.pattern.replace(/^\.\//, "")).test(relativePath);
		case "package":
			return relativePath === `packages/${selector.name}` || relativePath.startsWith(`packages/${selector.name}/`);
		case "module":
			return relativePath === selector.name || relativePath.startsWith(`${selector.name}/`);
	}
}

function included(
	relativePath: string,
	selectors: readonly ScopeSelector[],
	exclusions: readonly ScopeSelector[],
): boolean {
	return (
		selectors.some(selector => selectorMatches(selector, relativePath)) &&
		!exclusions.some(selector => selectorMatches(selector, relativePath))
	);
}

function languageFor(relativePath: string): string | undefined {
	const extension = path.extname(relativePath).slice(1).toLowerCase();
	return extension || undefined;
}

function packageFor(relativePath: string): string | undefined {
	const parts = relativePath.split("/");
	return parts[0] === "packages" && parts[1] ? parts[1] : undefined;
}

async function walk(root: string): Promise<string[]> {
	const files: string[] = [];
	const visitedDirectories = new Set<string>();

	async function visit(relativeDirectory: string): Promise<void> {
		const absoluteDirectory = path.join(root, relativeDirectory);
		const canonical = await realpath(absoluteDirectory);
		if (visitedDirectories.has(canonical)) return;
		visitedDirectories.add(canonical);
		const entries = await readdir(absoluteDirectory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relative = path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name).replace(/^\.\//, "");
			if (entry.isDirectory()) await visit(relative);
			else files.push(relative);
		}
	}

	await visit(".");
	return files;
}

async function createEntry(root: string, relativePath: string): Promise<ManifestEntry> {
	const absolute = path.join(root, relativePath);
	const entryId = createManifestEntryId(`entry_${sha256(relativePath).slice(0, 24)}`);
	try {
		const info = await lstat(absolute);
		if (info.isSymbolicLink()) {
			return {
				entryId,
				path: relativePath,
				kind: { kind: "symlink", target: await readlink(absolute) },
				sizeBytes: info.size,
				line_count: 0,
				metadata: {},
			};
		}
		if (!info.isFile()) {
			return {
				entryId,
				path: relativePath,
				kind: { kind: "unsupported", reason: "not a regular file" },
				sizeBytes: info.size,
				line_count: 0,
				metadata: {},
			};
		}
		const bytes = await readFile(absolute);
		return {
			entryId,
			path: relativePath,
			kind: { kind: "file" },
			sizeBytes: bytes.byteLength,
			line_count: physicalLineCount(bytes),
			estimatedTokens: Math.ceil(bytes.byteLength / 4),
			contentHash: sha256(bytes),
			language: languageFor(relativePath),
			package: packageFor(relativePath),
			metadata: {},
		};
	} catch (error) {
		let sizeBytes = 0;
		try {
			sizeBytes = (await stat(absolute)).size;
		} catch {}
		return {
			entryId,
			path: relativePath,
			kind: { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) },
			sizeBytes,
			line_count: 0,
			metadata: {},
		};
	}
}

export async function generateManifest(request: GenerateManifestRequest): Promise<Manifest> {
	const repositoryRoot = await realpath(path.resolve(request.repositoryRoot));
	if (request.selectors.length === 0) throw new Error("Manifest generation requires at least one scope selector");
	for (const selector of [...request.selectors, ...request.exclusions]) {
		if (selector.kind === "path") normalizeRelative(repositoryRoot, selector.path);
	}
	const candidates = await walk(repositoryRoot);
	const selected = candidates.filter(candidate => included(candidate, request.selectors, request.exclusions));
	const entries = await Promise.all(selected.map(candidate => createEntry(repositoryRoot, candidate)));
	entries.sort((left, right) => left.path.localeCompare(right.path));
	const logical = {
		repositoryRoot,
		repositoryRevision: request.repositoryRevision,
		selectors: request.selectors,
		exclusions: request.exclusions,
		entries: entries.map(entry => ({ ...entry, metadata: entry.metadata })),
	};
	return normalizeManifest({
		meta: { schemaVersion: "1", createdAt: request.generatedAt, operationId: request.operationId },
		manifestId: createManifestId(`manifest_${sha256(stableJson(logical)).slice(0, 24)}`),
		repositoryRoot,
		repositoryRevision: request.repositoryRevision,
		selectors: request.selectors,
		exclusions: request.exclusions,
		entries,
	});
}
