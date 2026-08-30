import type { ChunkPlan } from "../contracts/chunks";
import type { Manifest, ManifestEntry } from "../contracts/manifest";
import type {
	ExecutableJob,
	ExecutableJobAgent,
	JobBudget,
	JobModelPolicy,
	JobRetryPolicy,
	JobTimeoutPolicy,
} from "../job-executor";

export interface BuildReaderJobsRequest {
	readonly manifest: Manifest;
	readonly chunkPlan: ChunkPlan;
	readonly objective: string;
	readonly agent: ExecutableJobAgent;
	readonly modelPolicy?: JobModelPolicy;
	readonly retryPolicy?: JobRetryPolicy;
	readonly timeoutPolicy?: JobTimeoutPolicy;
	readonly budget?: JobBudget;
}

export interface ReaderJobEntry {
	readonly entryId: string;
	readonly path: string;
	readonly kind: ManifestEntry["kind"];
	readonly contentHash?: string;
}

export interface ReaderJobInput {
	readonly manifestId: string;
	readonly chunkPlanId: string;
	readonly chunkId: string;
	readonly repositoryRoot: string;
	readonly repositoryRevision: Manifest["repositoryRevision"];
	readonly assignedEntries: readonly ReaderJobEntry[];
	readonly readDependencies: readonly ReaderJobEntry[];
	readonly instructions: readonly string[];
}

function jobEntry(entry: ManifestEntry): ReaderJobEntry {
	return {
		entryId: entry.entryId,
		path: entry.path,
		kind: entry.kind,
		...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
	};
}

export function buildReaderJobs(request: BuildReaderJobsRequest): ExecutableJob[] {
	if (request.chunkPlan.manifestId !== request.manifest.manifestId) {
		throw new Error("Chunk plan does not belong to manifest");
	}
	const entries = new Map(request.manifest.entries.map(entry => [entry.entryId, entry]));
	return request.chunkPlan.chunks.map(chunk => {
		const assignedEntries = chunk.assignedEntryIds.map(entryId => {
			const entry = entries.get(entryId);
			if (!entry) throw new Error(`Unknown assigned manifest entry: ${entryId}`);
			return jobEntry(entry);
		});
		const readDependencies = chunk.readDependencyEntryIds.map(entryId => {
			const entry = entries.get(entryId);
			if (!entry) throw new Error(`Unknown dependency manifest entry: ${entryId}`);
			return jobEntry(entry);
		});
		const input: ReaderJobInput = {
			manifestId: request.manifest.manifestId,
			chunkPlanId: request.chunkPlan.chunkPlanId,
			chunkId: chunk.chunkId,
			repositoryRoot: request.manifest.repositoryRoot,
			repositoryRevision: request.manifest.repositoryRevision,
			assignedEntries,
			readDependencies,
			instructions: [
				"Read only the assigned entries and declared read dependencies.",
				"Do not modify repository files or create patches.",
				"Report inaccessible or unsupported entries explicitly; never infer their contents.",
				"Every finding must preserve manifest entry identity and path evidence.",
				"Return output matching the supplied schema.",
			],
		};
		return {
			jobId: `reader-${chunk.chunkId}`,
			operationId: request.manifest.meta.operationId,
			capabilityStage: "inspect_chunk",
			objective: chunk.objective || request.objective,
			input,
			outputSchema: chunk.expectedOutputSchema,
			...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
			...(request.retryPolicy ? { retryPolicy: request.retryPolicy } : {}),
			...(request.timeoutPolicy ? { timeoutPolicy: request.timeoutPolicy } : {}),
			...(request.budget ? { budget: request.budget } : {}),
			agent: request.agent,
		};
	});
}
