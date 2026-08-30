import {
	type ArtifactMeta,
	type ChunkId,
	type ChunkPlanId,
	type ManifestEntryId,
	type ManifestId,
	parseArtifactMeta,
	parseChunkId,
	parseChunkPlanId,
	parseManifestEntryId,
	parseManifestId,
} from "./ids";
import { type Manifest, requiredManifestEntries } from "./manifest";

/** A canonical inclusive physical line range owned by a chunk. */
export interface ChunkLineRange {
	readonly entryId: ManifestEntryId;
	readonly startLine: number;
	readonly endLine: number;
}

/** A frozen snapshot of the policy inputs used to produce a chunk plan. */
export interface ChunkPolicySnapshot {
	readonly [key: string]: unknown;
	readonly targetSourceTokensPerChunk?: number;
	readonly maxFilesPerChunk?: number;
	readonly allowLineRangeSplit?: boolean;
}

export interface ReadChunk {
	readonly chunkId: ChunkId;
	readonly objective: string;
	readonly assignedEntryIds: readonly [ManifestEntryId, ...ManifestEntryId[]];
	readonly assignedRanges?: readonly ChunkLineRange[];
	readonly readDependencyEntryIds: readonly ManifestEntryId[];
	readonly estimatedSourceTokens: number;
	readonly expectedOutputSchema: unknown;
}

export interface ChunkPlan {
	readonly meta: ArtifactMeta;
	readonly chunkPlanId: ChunkPlanId;
	readonly manifestId: ManifestId;
	readonly policy: ChunkPolicySnapshot;
	readonly chunks: readonly ReadChunk[];
}

export class ChunkPlanValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ChunkPlanValidationError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new ChunkPlanValidationError(field, `${field} must be a non-negative integer`);
	}
	return value;
}

function freezeUnknown(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeUnknown));
	if (!isRecord(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) copy[key] = freezeUnknown(nested);
	return Object.freeze(copy);
}

function freezePolicy(policy: ChunkPolicySnapshot): ChunkPolicySnapshot {
	const copy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(policy)) copy[key] = freezeUnknown(value);
	return Object.freeze(copy);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareRanges(left: ChunkLineRange, right: ChunkLineRange): number {
	return (
		compareStrings(left.entryId, right.entryId) || left.startLine - right.startLine || left.endLine - right.endLine
	);
}

function compareChunks(left: ReadChunk, right: ReadChunk): number {
	const assigned = compareStrings(left.assignedEntryIds.join("\u0000"), right.assignedEntryIds.join("\u0000"));
	if (assigned !== 0) return assigned;
	const leftRanges = left.assignedRanges ?? [];
	const rightRanges = right.assignedRanges ?? [];
	for (let index = 0; index < Math.min(leftRanges.length, rightRanges.length); index++) {
		const range = compareRanges(leftRanges[index], rightRanges[index]);
		if (range !== 0) return range;
	}
	return leftRanges.length - rightRanges.length || compareStrings(left.chunkId, right.chunkId);
}

function parseIds(value: unknown, field: string, allowEmpty: true): ManifestEntryId[];
function parseIds(value: unknown, field: string, allowEmpty: false): [ManifestEntryId, ...ManifestEntryId[]];
function parseIds(value: unknown, field: string, allowEmpty: boolean): ManifestEntryId[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		throw new ChunkPlanValidationError(field, `${field} must be ${allowEmpty ? "an array" : "a non-empty array"}`);
	}
	const ids: ManifestEntryId[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const entryId = parseManifestEntryId(candidate);
		if (entryId === undefined) throw new ChunkPlanValidationError(field, `${field} contains an invalid entry ID`);
		if (seen.has(entryId))
			throw new ChunkPlanValidationError("duplicate_id", `${field} contains duplicate ID: ${entryId}`);
		seen.add(entryId);
		ids.push(entryId);
	}
	return ids;
}

function parseRanges(value: unknown): ChunkLineRange[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw new ChunkPlanValidationError("assignedRanges", "assignedRanges must be a non-empty array when present");
	}
	const ranges: ChunkLineRange[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) throw new ChunkPlanValidationError("assignedRanges", "Line ranges must be records");
		const entryId = parseManifestEntryId(candidate.entryId);
		if (entryId === undefined)
			throw new ChunkPlanValidationError("assignedRanges", "Line ranges require valid entry IDs");
		const startLine = nonNegativeInteger(candidate.startLine, "startLine");
		const endLine = nonNegativeInteger(candidate.endLine, "endLine");
		if (startLine < 1 || endLine < startLine) {
			throw new ChunkPlanValidationError("assignedRanges", "Line ranges must be inclusive and ordered");
		}
		ranges.push({ entryId, startLine, endLine });
	}
	return ranges.sort(compareRanges);
}

function parseChunk(value: unknown): ReadChunk {
	if (!isRecord(value)) throw new ChunkPlanValidationError("chunk", "Chunks must be records");
	const chunkId = parseChunkId(value.chunkId);
	if (chunkId === undefined) throw new ChunkPlanValidationError("chunk_id", "Chunks require valid chunk IDs");
	if (!nonEmptyString(value.objective))
		throw new ChunkPlanValidationError("objective", "Chunk objective must be non-empty");
	const assignedEntryIds = parseIds(value.assignedEntryIds, "assignedEntryIds", false);
	const assignedRanges = parseRanges(value.assignedRanges);
	if (assignedRanges?.some(range => !assignedEntryIds.includes(range.entryId))) {
		throw new ChunkPlanValidationError("assignedRanges", "Line ranges must belong to assigned entries");
	}
	const readDependencyEntryIds = parseIds(value.readDependencyEntryIds, "readDependencyEntryIds", true);
	const estimatedSourceTokens = nonNegativeInteger(value.estimatedSourceTokens, "estimatedSourceTokens");
	return {
		chunkId,
		objective: value.objective,
		assignedEntryIds,
		...(assignedRanges ? { assignedRanges } : {}),
		readDependencyEntryIds,
		estimatedSourceTokens,
		expectedOutputSchema: freezeUnknown(value.expectedOutputSchema),
	};
}

function freezeChunk(chunk: ReadChunk): ReadChunk {
	const [firstAssignedEntryId, ...remainingAssignedEntryIds] = chunk.assignedEntryIds;
	const assignedEntryIds: readonly [ManifestEntryId, ...ManifestEntryId[]] = Object.freeze([
		firstAssignedEntryId,
		...remainingAssignedEntryIds,
	]);
	const assignedRanges = chunk.assignedRanges
		? Object.freeze(chunk.assignedRanges.map(range => Object.freeze({ ...range })))
		: undefined;
	return Object.freeze({
		...chunk,
		assignedEntryIds,
		...(assignedRanges ? { assignedRanges } : {}),
		readDependencyEntryIds: Object.freeze([...chunk.readDependencyEntryIds]),
		expectedOutputSchema: freezeUnknown(chunk.expectedOutputSchema),
	});
}

function freezePlan(plan: ChunkPlan): ChunkPlan {
	return Object.freeze({
		...plan,
		meta: Object.freeze({ ...plan.meta }),
		policy: freezePolicy(plan.policy),
		chunks: Object.freeze(plan.chunks.map(freezeChunk)),
	});
}

function assertChunkOrdering(chunks: readonly ReadChunk[]): void {
	for (let index = 1; index < chunks.length; index++) {
		if (compareChunks(chunks[index - 1], chunks[index]) > 0) {
			throw new ChunkPlanValidationError("order", "Chunks must be in deterministic assigned-entry order");
		}
	}
}

function assertCoverage(chunks: readonly ReadChunk[], manifest: Manifest): void {
	const requiredEntries = new Map(requiredManifestEntries(manifest).map(entry => [entry.entryId, entry]));
	const wholeOwners = new Set<ManifestEntryId>();
	const rangesByEntry = new Map<ManifestEntryId, ChunkLineRange[]>();
	for (const chunk of chunks) {
		for (const entryId of chunk.assignedEntryIds) {
			if (!requiredEntries.has(entryId)) {
				throw new ChunkPlanValidationError(
					"unknown_assignment",
					`Chunk assigns non-required manifest entry ID: ${entryId}`,
				);
			}
		}
		const rangedIds = new Set<ManifestEntryId>();
		for (const range of chunk.assignedRanges ?? []) {
			const entry = requiredEntries.get(range.entryId);
			if (!entry)
				throw new ChunkPlanValidationError("unknown_assignment", `Unknown ranged entry ID: ${range.entryId}`);
			if (range.endLine > entry.line_count) {
				throw new ChunkPlanValidationError(
					"assignedRanges",
					`Line range exceeds manifest line count for ${entry.path}`,
				);
			}
			rangedIds.add(range.entryId);
			const ranges = rangesByEntry.get(range.entryId);
			if (ranges) ranges.push(range);
			else rangesByEntry.set(range.entryId, [range]);
		}
		for (const entryId of chunk.assignedEntryIds) {
			if (rangedIds.has(entryId)) continue;
			if (wholeOwners.has(entryId) || rangesByEntry.has(entryId)) {
				throw new ChunkPlanValidationError(
					"duplicate_ownership",
					`Manifest entry ID has multiple owners: ${entryId}`,
				);
			}
			wholeOwners.add(entryId);
		}
		for (const dependencyId of chunk.readDependencyEntryIds) {
			if (!requiredEntries.has(dependencyId)) {
				throw new ChunkPlanValidationError(
					"unknown_dependency",
					`Chunk depends on non-required manifest entry ID: ${dependencyId}`,
				);
			}
		}
	}
	for (const [entryId, ranges] of rangesByEntry) {
		if (wholeOwners.has(entryId)) {
			throw new ChunkPlanValidationError("duplicate_ownership", `Manifest entry ID has multiple owners: ${entryId}`);
		}
		const entry = requiredEntries.get(entryId);
		if (!entry) continue;
		const ordered = [...ranges].sort(
			(left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
		);
		let nextLine = 1;
		for (const range of ordered) {
			if (range.startLine !== nextLine) {
				throw new ChunkPlanValidationError(
					"coverage",
					`Line ranges for ${entry.path} must be contiguous and non-overlapping`,
				);
			}
			nextLine = range.endLine + 1;
		}
		if (nextLine !== entry.line_count + 1) {
			throw new ChunkPlanValidationError("coverage", `Line ranges for ${entry.path} do not cover the complete file`);
		}
		wholeOwners.add(entryId);
	}
	const requiredIds = [...requiredEntries.keys()];
	if (wholeOwners.size !== requiredIds.length || requiredIds.some(entryId => !wholeOwners.has(entryId))) {
		const missing = requiredIds.filter(entryId => !wholeOwners.has(entryId));
		throw new ChunkPlanValidationError(
			"missing_assignment",
			`Manifest entry IDs are not assigned: ${missing.join(", ")}`,
		);
	}
}

function validatePolicy(policy: unknown): ChunkPolicySnapshot {
	if (!isRecord(policy)) throw new ChunkPlanValidationError("policy", "Chunk policy must be a record");
	for (const [key, value] of Object.entries(policy)) {
		if (key === "targetSourceTokensPerChunk" || key === "maxFilesPerChunk") nonNegativeInteger(value, key);
		if (key === "allowLineRangeSplit" && typeof value !== "boolean") {
			throw new ChunkPlanValidationError(key, `${key} must be boolean`);
		}
	}
	return policy;
}

/** Return an immutable plan sorted by its stable assigned-entry ordering. */
export function normalizeChunkPlan(input: ChunkPlan, manifest: Manifest): ChunkPlan {
	if (!isRecord(input)) throw new ChunkPlanValidationError("plan", "Chunk plan must be a record");
	const meta = parseArtifactMeta(input.meta);
	if (meta === undefined) throw new ChunkPlanValidationError("meta", "Chunk plan metadata is invalid");
	const chunkPlanId = parseChunkPlanId(input.chunkPlanId);
	if (chunkPlanId === undefined) throw new ChunkPlanValidationError("chunk_plan_id", "Chunk plan requires a valid ID");
	const manifestId = parseManifestId(input.manifestId);
	if (manifestId === undefined)
		throw new ChunkPlanValidationError("manifest_id", "Chunk plan requires a valid manifest ID");
	if (manifestId !== manifest.manifestId)
		throw new ChunkPlanValidationError("manifest_id", "Chunk plan manifest ID does not match manifest");
	if (!Array.isArray(input.chunks)) throw new ChunkPlanValidationError("chunks", "Chunk plan chunks must be an array");
	const policy = validatePolicy(input.policy);
	const chunks = input.chunks.map(parseChunk).sort(compareChunks).map(freezeChunk);
	assertCoverage(chunks, manifest);
	return freezePlan({ meta, chunkPlanId, manifestId, policy: freezePolicy(policy), chunks: Object.freeze(chunks) });
}

/** Validate a canonical plan without changing its ordering or identity. */
export function validateChunkPlan(input: ChunkPlan, manifest: Manifest): ChunkPlan {
	if (!isRecord(input)) throw new ChunkPlanValidationError("plan", "Chunk plan must be a record");
	const normalized = normalizeChunkPlan(input, manifest);
	if (normalized.chunks.length !== input.chunks.length) {
		throw new ChunkPlanValidationError("chunks", "Chunk plan contains an invalid chunks array");
	}
	for (let index = 0; index < input.chunks.length; index++) {
		const original = input.chunks[index];
		const canonical = normalized.chunks[index];
		if (
			original.chunkId !== canonical.chunkId ||
			original.assignedEntryIds.join("\u0000") !== canonical.assignedEntryIds.join("\u0000")
		) {
			throw new ChunkPlanValidationError("order", "Chunk plan is not in deterministic order");
		}
	}
	assertChunkOrdering(input.chunks);
	assertCoverage(input.chunks, manifest);
	return input;
}

export function createChunkPlan(input: ChunkPlan, manifest: Manifest): ChunkPlan {
	return normalizeChunkPlan(input, manifest);
}

export function isValidChunkPlan(input: unknown, manifest: Manifest): input is ChunkPlan {
	try {
		validateChunkPlan(input as ChunkPlan, manifest);
		return true;
	} catch {
		return false;
	}
}
