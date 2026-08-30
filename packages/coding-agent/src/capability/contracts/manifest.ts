import * as path from "node:path";

import {
	type ArtifactMeta,
	type ManifestEntryId,
	type ManifestId,
	parseArtifactMeta,
	parseManifestEntryId,
	parseManifestId,
} from "./ids";

export type RevisionIdentity = string | Readonly<Record<string, unknown>>;

export type ScopeSelector =
	| { readonly kind: "path"; readonly path: string }
	| { readonly kind: "glob"; readonly pattern: string }
	| { readonly kind: "package"; readonly name: string }
	| { readonly kind: "module"; readonly name: string }
	| { readonly kind: "repository" };

export type ManifestEntryKind =
	| { readonly kind: "file" }
	| { readonly kind: "symlink"; readonly target: string }
	| { readonly kind: "unsupported"; readonly reason: string }
	| { readonly kind: "unreadable"; readonly reason: string };

export interface ManifestEntry {
	readonly entryId: ManifestEntryId;
	readonly path: string;
	readonly kind: ManifestEntryKind;
	readonly sizeBytes: number;
	readonly line_count: number;
	readonly estimatedTokens?: number;
	readonly contentHash?: string;
	readonly language?: string;
	readonly module?: string;
	readonly package?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Manifest {
	readonly meta: ArtifactMeta;
	readonly manifestId: ManifestId;
	readonly repositoryRoot: string;
	readonly repositoryRevision: RevisionIdentity;
	readonly selectors: readonly ScopeSelector[];
	readonly exclusions: readonly ScopeSelector[];
	readonly entries: readonly ManifestEntry[];
}

export class ManifestValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ManifestValidationError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function freezeUnknown(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeUnknown));
	if (!isRecord(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) copy[key] = freezeUnknown(nested);
	return Object.freeze(copy);
}

function freezeMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const frozen = freezeUnknown(value);
	if (!isRecord(frozen)) throw new ManifestValidationError("metadata", "Manifest metadata must be an object");
	return frozen;
}

function normalizeRoot(repositoryRoot: string): string {
	if (!nonEmptyString(repositoryRoot) || repositoryRoot.includes("\0")) {
		throw new ManifestValidationError("repository_root", "Manifest repositoryRoot must be a non-empty path");
	}
	return path.resolve(repositoryRoot);
}

/** Normalize a manifest path to a slash-separated path relative to repositoryRoot. */
export function normalizeManifestPath(repositoryRoot: string, entryPath: string): string {
	const root = normalizeRoot(repositoryRoot);
	if (!nonEmptyString(entryPath) || entryPath.includes("\0")) {
		throw new ManifestValidationError("path", "Manifest entry paths must be non-empty");
	}
	const slashPath = entryPath.replaceAll("\\", "/");
	const candidate = path.isAbsolute(slashPath) ? slashPath : path.join(root, slashPath);
	const absolute = path.resolve(candidate);
	const relative = path.relative(root, absolute).split(path.sep).join("/");
	if (
		relative.length === 0 ||
		relative === "." ||
		relative === ".." ||
		relative.startsWith("../") ||
		path.isAbsolute(relative)
	) {
		throw new ManifestValidationError("outside_root", `Manifest entry path is outside repositoryRoot: ${entryPath}`);
	}
	return relative;
}

function parseSelector(value: unknown, field: string): ScopeSelector {
	if (!isRecord(value) || !nonEmptyString(value.kind)) {
		throw new ManifestValidationError(field, `${field} must contain a supported selector`);
	}
	switch (value.kind) {
		case "repository":
			return { kind: "repository" };
		case "path":
			if (!nonEmptyString(value.path)) throw new ManifestValidationError(field, `${field} path must be non-empty`);
			return { kind: "path", path: value.path };
		case "glob":
			if (!nonEmptyString(value.pattern))
				throw new ManifestValidationError(field, `${field} pattern must be non-empty`);
			return { kind: "glob", pattern: value.pattern };
		case "package":
		case "module": {
			if (!nonEmptyString(value.name)) throw new ManifestValidationError(field, `${field} name must be non-empty`);
			return { kind: value.kind, name: value.name };
		}
		default:
			throw new ManifestValidationError(field, `${field} contains an unsupported selector kind`);
	}
}

function parseRevision(value: unknown): RevisionIdentity {
	if (typeof value === "string") {
		if (!nonEmptyString(value))
			throw new ManifestValidationError("revision", "Manifest repositoryRevision must be non-empty");
		return value;
	}
	if (!isRecord(value))
		throw new ManifestValidationError("revision", "Manifest repositoryRevision must be a record or string");
	const frozen = freezeUnknown(value);
	if (!isRecord(frozen))
		throw new ManifestValidationError("revision", "Manifest repositoryRevision must be a record or string");
	return frozen;
}

function parseEntryKind(value: unknown): ManifestEntryKind {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ManifestValidationError("kind", "Manifest entry kind must be explicit");
	}
	switch (value.kind) {
		case "file":
			return { kind: "file" };
		case "symlink":
			if (!nonEmptyString(value.target))
				throw new ManifestValidationError("kind", "Symlink target must be non-empty");
			return { kind: "symlink", target: value.target };
		case "unsupported":
		case "unreadable":
			if (!nonEmptyString(value.reason)) {
				throw new ManifestValidationError("kind", `${value.kind} entries require an explicit reason`);
			}
			return { kind: value.kind, reason: value.reason };
		default:
			throw new ManifestValidationError("kind", `Unsupported manifest entry kind: ${value.kind}`);
	}
}

function parseNonNegativeNumber(value: unknown, field: string, integer: boolean): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
		throw new ManifestValidationError(
			field,
			`${field} must be a finite non-negative ${integer ? "integer" : "number"}`,
		);
	}
	return value;
}

function parseEntry(value: unknown, repositoryRoot: string, requireNormalizedPath: boolean): ManifestEntry {
	if (!isRecord(value)) throw new ManifestValidationError("entry", "Manifest entries must be records");
	const entryId = parseManifestEntryId(value.entryId);
	if (entryId === undefined)
		throw new ManifestValidationError("entry_id", "Manifest entries require a valid entry ID");
	if (typeof value.path !== "string") throw new ManifestValidationError("path", "Manifest entries require a path");
	const canonicalPath = normalizeManifestPath(repositoryRoot, value.path);
	if (requireNormalizedPath && value.path !== canonicalPath) {
		throw new ManifestValidationError("path", `Manifest entry path is not normalized: ${value.path}`);
	}
	const kind = parseEntryKind(value.kind);
	const sizeBytes = parseNonNegativeNumber(value.sizeBytes, "sizeBytes", true);
	const lineCount = parseNonNegativeNumber(value.line_count, "line_count", true);
	const estimatedTokens =
		value.estimatedTokens === undefined
			? undefined
			: parseNonNegativeNumber(value.estimatedTokens, "estimatedTokens", true);
	const contentHash = value.contentHash === undefined ? undefined : value.contentHash;
	if (contentHash !== undefined && !nonEmptyString(contentHash))
		throw new ManifestValidationError("content_hash", "contentHash must be non-empty when present");
	const language = value.language === undefined ? undefined : value.language;
	if (language !== undefined && !nonEmptyString(language))
		throw new ManifestValidationError("language", "language must be non-empty when present");
	const moduleName = value.module === undefined ? undefined : value.module;
	if (moduleName !== undefined && !nonEmptyString(moduleName))
		throw new ManifestValidationError("module", "module must be non-empty when present");
	const packageName = value.package === undefined ? undefined : value.package;
	if (packageName !== undefined && !nonEmptyString(packageName))
		throw new ManifestValidationError("package", "package must be non-empty when present");
	if (!isRecord(value.metadata)) throw new ManifestValidationError("metadata", "Manifest metadata must be an object");
	return {
		entryId,
		path: canonicalPath,
		kind,
		sizeBytes,
		line_count: lineCount,
		...(estimatedTokens === undefined ? {} : { estimatedTokens }),
		...(contentHash === undefined ? {} : { contentHash }),
		...(language === undefined ? {} : { language }),
		...(moduleName === undefined ? {} : { module: moduleName }),
		...(packageName === undefined ? {} : { package: packageName }),
		metadata: freezeMetadata(value.metadata),
	};
}

function compareEntries(left: ManifestEntry, right: ManifestEntry): number {
	if (left.path !== right.path) return left.path < right.path ? -1 : 1;
	if (left.entryId !== right.entryId) return left.entryId < right.entryId ? -1 : 1;
	return 0;
}

function validateEntrySet(entries: readonly ManifestEntry[], requireSorted: boolean): void {
	const paths = new Set<string>();
	const ids = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (paths.has(entry.path))
			throw new ManifestValidationError("duplicate_path", `Duplicate manifest path: ${entry.path}`);
		if (ids.has(entry.entryId))
			throw new ManifestValidationError("duplicate_id", `Duplicate manifest entry ID: ${entry.entryId}`);
		paths.add(entry.path);
		ids.add(entry.entryId);
		if (requireSorted && index > 0 && compareEntries(entries[index - 1], entry) > 0) {
			throw new ManifestValidationError("order", "Manifest entries must be sorted by normalized path");
		}
	}
}

function freezeEntry(entry: ManifestEntry): ManifestEntry {
	return Object.freeze({ ...entry, kind: Object.freeze({ ...entry.kind }), metadata: freezeMetadata(entry.metadata) });
}

function freezeManifest(manifest: Manifest): Manifest {
	return Object.freeze({
		...manifest,
		meta: Object.freeze({ ...manifest.meta }),
		selectors: Object.freeze(manifest.selectors.map(selector => Object.freeze({ ...selector }))),
		exclusions: Object.freeze(manifest.exclusions.map(selector => Object.freeze({ ...selector }))),
		entries: Object.freeze(manifest.entries.map(freezeEntry)),
	});
}

/** Return a canonical immutable manifest, normalizing paths and sorting entries by path. */
export function normalizeManifest(input: Manifest): Manifest {
	if (!isRecord(input)) throw new ManifestValidationError("manifest", "Manifest must be a record");
	const meta = parseArtifactMeta(input.meta);
	if (meta === undefined) throw new ManifestValidationError("meta", "Manifest metadata is invalid");
	const manifestId = parseManifestId(input.manifestId);
	if (manifestId === undefined)
		throw new ManifestValidationError("manifest_id", "Manifest requires a valid manifest ID");
	const repositoryRoot = normalizeRoot(input.repositoryRoot);
	const repositoryRevision = parseRevision(input.repositoryRevision);
	if (!Array.isArray(input.selectors))
		throw new ManifestValidationError("selectors", "Manifest selectors must be an array");
	if (!Array.isArray(input.exclusions))
		throw new ManifestValidationError("exclusions", "Manifest exclusions must be an array");
	if (!Array.isArray(input.entries)) throw new ManifestValidationError("entries", "Manifest entries must be an array");
	const selectors = input.selectors.map(selector => parseSelector(selector, "selectors"));
	const exclusions = input.exclusions.map(selector => parseSelector(selector, "exclusions"));
	const entries = input.entries
		.map(entry => parseEntry(entry, repositoryRoot, false))
		.sort(compareEntries)
		.map(freezeEntry);
	validateEntrySet(entries, true);
	return freezeManifest({ meta, manifestId, repositoryRoot, repositoryRevision, selectors, exclusions, entries });
}

/** Validate an already-canonical manifest and return it unchanged. */
export function validateManifest(input: Manifest): Manifest {
	if (!isRecord(input)) throw new ManifestValidationError("manifest", "Manifest must be a record");
	const normalized = normalizeRoot(input.repositoryRoot);
	if (input.repositoryRoot !== normalized)
		throw new ManifestValidationError(
			"repository_root",
			"Manifest repositoryRoot must be normalized to an absolute path",
		);
	if (parseArtifactMeta(input.meta) === undefined)
		throw new ManifestValidationError("meta", "Manifest metadata is invalid");
	if (parseManifestId(input.manifestId) === undefined)
		throw new ManifestValidationError("manifest_id", "Manifest requires a valid manifest ID");
	if (!Array.isArray(input.selectors) || !Array.isArray(input.exclusions) || !Array.isArray(input.entries))
		throw new ManifestValidationError("shape", "Manifest selectors, exclusions, and entries must be arrays");
	parseRevision(input.repositoryRevision);
	for (const selector of input.selectors) parseSelector(selector, "selectors");
	for (const exclusion of input.exclusions) parseSelector(exclusion, "exclusions");
	const entries = input.entries.map(entry => parseEntry(entry, normalized, true));
	validateEntrySet(entries, true);
	return input;
}

export function createManifest(input: Manifest): Manifest {
	return normalizeManifest(input);
}

export function assertValidManifest(input: Manifest): asserts input is Manifest {
	validateManifest(input);
}

export function isValidManifest(input: unknown): input is Manifest {
	try {
		validateManifest(input as Manifest);
		return true;
	} catch {
		return false;
	}
}

/** Explicitly unsupported and unreadable entries are status-only and need no owning chunk. */
export function requiredManifestEntries(manifest: Manifest): readonly ManifestEntry[] {
	validateManifest(manifest);
	return manifest.entries.filter(entry => entry.kind.kind === "file" || entry.kind.kind === "symlink");
}

export function requiredManifestEntryIds(manifest: Manifest): readonly ManifestEntryId[] {
	return requiredManifestEntries(manifest).map(entry => entry.entryId);
}
