import { createHash } from "node:crypto";
import path from "node:path";
import {
	type ChunkLineRange,
	type ChunkPlan,
	type ChunkPolicySnapshot,
	createChunkPlan,
	type ReadChunk,
} from "../contracts/chunks";
import { createChunkId, createChunkPlanId, type ManifestEntryId } from "../contracts/ids";
import { type Manifest, type ManifestEntry, requiredManifestEntries } from "../contracts/manifest";

export interface PlanChunksRequest {
	readonly manifest: Manifest;
	readonly objective: string;
	readonly policy: ChunkPolicySnapshot;
	readonly expectedOutputSchema: unknown;
	readonly dependencyEntryIds?: Readonly<Record<string, readonly ManifestEntryId[]>>;
}

interface PlannedUnit {
	readonly entry: ManifestEntry;
	readonly range?: ChunkLineRange;
	readonly estimatedTokens: number;
}

const TARGET_LINES = 200;
const SPLIT_THRESHOLD_LINES = 250;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function groupKey(entry: ManifestEntry): string {
	if (entry.package) return `package:${entry.package}`;
	if (entry.module) return `module:${entry.module}`;
	return `directory:${path.posix.dirname(entry.path)}`;
}

function entryTokens(entry: ManifestEntry): number {
	return entry.estimatedTokens ?? Math.ceil(entry.sizeBytes / 4);
}

function splitEntry(entry: ManifestEntry, allowSplit: boolean): PlannedUnit[] {
	if (!allowSplit || entry.line_count <= SPLIT_THRESHOLD_LINES) {
		return [{ entry, estimatedTokens: entryTokens(entry) }];
	}
	const parts = Math.ceil(entry.line_count / TARGET_LINES);
	const width = Math.ceil(entry.line_count / parts);
	const units: PlannedUnit[] = [];
	for (let startLine = 1; startLine <= entry.line_count; startLine += width) {
		const endLine = Math.min(entry.line_count, startLine + width - 1);
		const lineCount = endLine - startLine + 1;
		units.push({
			entry,
			range: { entryId: entry.entryId, startLine, endLine },
			estimatedTokens: Math.ceil((entryTokens(entry) * lineCount) / entry.line_count),
		});
	}
	return units;
}

export function planChunks(request: PlanChunksRequest): ChunkPlan {
	if (request.objective.trim().length === 0) throw new Error("Chunk objective must not be blank");
	const maxFiles = request.policy.maxFilesPerChunk ?? Number.POSITIVE_INFINITY;
	const targetTokens = request.policy.targetSourceTokensPerChunk ?? Number.POSITIVE_INFINITY;
	if (maxFiles <= 0 || targetTokens <= 0) throw new Error("Chunk limits must be positive");
	const allowSplit = request.policy.allowLineRangeSplit !== false;
	const entries = [...requiredManifestEntries(request.manifest)].sort((left, right) => {
		const group = groupKey(left).localeCompare(groupKey(right));
		return group !== 0 ? group : left.path.localeCompare(right.path);
	});
	const groups = new Map<string, ManifestEntry[]>();
	for (const entry of entries) {
		const key = groupKey(entry);
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	}
	const chunks: ReadChunk[] = [];
	for (const group of groups.values()) {
		let batch: PlannedUnit[] = [];
		let batchTokens = 0;
		const flush = (): void => {
			if (batch.length === 0) return;
			const assignedEntryIds = [...new Set(batch.map(unit => unit.entry.entryId))] as [
				ManifestEntryId,
				...ManifestEntryId[],
			];
			const assignedRanges = batch.flatMap(unit => (unit.range ? [unit.range] : []));
			const dependencyIds = new Set<ManifestEntryId>();
			for (const entryId of assignedEntryIds) {
				for (const dependencyId of request.dependencyEntryIds?.[entryId] ?? []) {
					if (!assignedEntryIds.includes(dependencyId)) dependencyIds.add(dependencyId);
				}
			}
			const rangeIdentity = assignedRanges
				.map(range => `${range.entryId}:${range.startLine}-${range.endLine}`)
				.join("\u0000");
			const identity = `${assignedEntryIds.join("\u0000")}\u0001${rangeIdentity}`;
			chunks.push({
				chunkId: createChunkId(`chunk_${sha256(`${request.manifest.manifestId}:${identity}`).slice(0, 24)}`),
				objective: request.objective,
				assignedEntryIds,
				...(assignedRanges.length > 0 ? { assignedRanges } : {}),
				readDependencyEntryIds: [...dependencyIds].sort(),
				estimatedSourceTokens: batchTokens,
				expectedOutputSchema: request.expectedOutputSchema,
			});
			batch = [];
			batchTokens = 0;
		};
		for (const entry of group) {
			const units = splitEntry(entry, allowSplit);
			if (units.length > 1) {
				flush();
				for (const unit of units) {
					batch = [unit];
					batchTokens = unit.estimatedTokens;
					flush();
				}
				continue;
			}
			const unit = units[0];
			if (batch.length > 0 && (batch.length >= maxFiles || batchTokens + unit.estimatedTokens > targetTokens))
				flush();
			batch.push(unit);
			batchTokens += unit.estimatedTokens;
		}
		flush();
	}
	chunks.sort((left, right) => {
		const assigned = left.assignedEntryIds.join("\u0000").localeCompare(right.assignedEntryIds.join("\u0000"));
		if (assigned !== 0) return assigned;
		const leftRanges = left.assignedRanges ?? [];
		const rightRanges = right.assignedRanges ?? [];
		return (leftRanges[0]?.startLine ?? 0) - (rightRanges[0]?.startLine ?? 0);
	});
	const identity = chunks.map(chunk => chunk.chunkId).join("\u0000");
	return createChunkPlan(
		{
			meta: request.manifest.meta,
			chunkPlanId: createChunkPlanId(
				`chunk_plan_${sha256(`${request.manifest.manifestId}:${identity}`).slice(0, 24)}`,
			),
			manifestId: request.manifest.manifestId,
			policy: request.policy,
			chunks,
		},
		request.manifest,
	);
}
