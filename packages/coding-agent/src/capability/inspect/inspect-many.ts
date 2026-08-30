import type { ChunkPlan, ReadChunk } from "../contracts/chunks";
import {
	type CoverageRecord,
	type CoverageReport,
	type CoverageState,
	recoverCoverage,
	reportCoverage,
	transitionCoverage,
} from "../contracts/coverage";
import { type EvidencePacket, type Finding, type Uncertainty, validateEvidencePacket } from "../contracts/evidence";
import {
	createAttemptId,
	createChunkId,
	createOperationId,
	type ManifestEntryId,
	type OperationId,
} from "../contracts/ids";
import type { Manifest, ScopeSelector } from "../contracts/manifest";
import { requiredManifestEntries, requiredManifestEntryIds } from "../contracts/manifest";
import type {
	ExecutableJob,
	ExecutableJobAgent,
	ExecutionPolicy,
	JobBudget,
	JobExecutor,
	JobModelPolicy,
	JobOutcome,
	JobRetryPolicy,
	JobTimeoutPolicy,
} from "../job-executor";
import { type CoverageGap, planRecovery, type RecoveryLimits } from "../recovery/recovery-planner";
import {
	buildSynthesisTree,
	reviewFinalSynthesis,
	type SynthesisPacket,
	type SynthesisPolicy,
} from "../synthesis/synthesis";
import { type PlanChunksRequest, planChunks } from "./chunk-planner";
import { type GenerateManifestRequest, generateManifest } from "./manifest-generator";
import { type BuildReaderJobsRequest, buildReaderJobs } from "./reader-job-builder";

export type InspectState =
	| "Accepted"
	| "ManifestGenerated"
	| "ChunkPlanGenerated"
	| "ReadersDispatched"
	| "EvidenceValidated"
	| "CoverageReconciled"
	| "RecoveryDispatched"
	| "CoverageFinalized"
	| "SynthesisBuilt"
	| "FinalReviewed"
	| "Complete"
	| "Partial"
	| "Failed"
	| "Cancelled";

export type InspectStatus =
	| { readonly kind: "complete" }
	| { readonly kind: "partial"; readonly gapIds: readonly ManifestEntryId[] }
	| { readonly kind: "failed"; readonly error: InspectError }
	| { readonly kind: "cancelled"; readonly reason: string };

export interface InspectError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly context: Readonly<Record<string, unknown>>;
}

export interface InspectConstraints {
	readonly maxConcurrency?: number;
	readonly maxAttemptsPerChunk?: number;
	readonly maxAttemptsPerEntry?: number;
	readonly maxGenerations?: number;
	readonly targetSourceTokensPerChunk?: number;
	readonly maxFilesPerChunk?: number;
	readonly allowLineRangeSplit?: boolean;
	readonly requireCompleteCoverage?: boolean;
	readonly allowInaccessibleSkip?: boolean;
	readonly splitTokenThreshold?: number;
	readonly repositoryRevisionPolicy?: { readonly kind: "pinned" | "detect_and_report" };
	readonly retryPolicy?: JobRetryPolicy;
	readonly timeoutPolicy?: JobTimeoutPolicy;
	readonly modelPolicy?: JobModelPolicy;
	readonly recoveryModelPolicy?: JobModelPolicy;
	readonly budget?: JobBudget;
}

export interface InspectOutputRequirements {
	readonly kind?: string;
	readonly expectedOutputSchema?: unknown;
	readonly synthesisPolicy?: SynthesisPolicy;
}

export interface InspectManyRequest {
	readonly objective: string;
	readonly scope?: readonly [ScopeSelector, ...ScopeSelector[]];
	readonly selectors?: readonly [ScopeSelector, ...ScopeSelector[]];
	readonly exclusions?: readonly ScopeSelector[];
	readonly repositoryRoot?: string;
	readonly repositoryRevision?: string | Readonly<Record<string, unknown>>;
	readonly operationId?: OperationId;
	readonly generatedAt?: string;
	readonly agent?: ExecutableJobAgent;
	readonly agentId?: string;
	readonly agentName?: string;
	readonly constraints?: InspectConstraints;
	readonly output?: InspectOutputRequirements;
	readonly signal?: AbortSignal;
	readonly resume?: InspectResumeSnapshot;
}

export interface InspectServices {
	readonly executor: JobExecutor;
	readonly generateManifest?: (request: GenerateManifestRequest) => Promise<Manifest>;
	readonly planChunks?: (request: PlanChunksRequest) => ChunkPlan;
	readonly buildReaderJobs?: (request: BuildReaderJobsRequest) => ExecutableJob[];
	readonly buildSynthesisTree?: typeof buildSynthesisTree;
	readonly reviewFinalSynthesis?: typeof reviewFinalSynthesis;
	readonly executionPolicy?: ExecutionPolicy;
	readonly now?: () => string;
}

export interface InspectResumeSnapshot {
	readonly version: 1;
	readonly request: InspectManyRequest;
	readonly manifest: Manifest;
	readonly chunkPlan: ChunkPlan;
	readonly coverage: readonly CoverageRecord[];
	readonly packets: readonly EvidencePacket[];
	readonly pendingChunks: readonly ReadChunk[];
	readonly generation: number;
	readonly trace: readonly InspectState[];
	readonly previousGapIds?: readonly ManifestEntryId[];
}

export interface InspectManyResult {
	readonly status: InspectStatus;
	readonly findings: readonly Finding[];
	readonly evidence: readonly EvidencePacket[];
	readonly coverage: CoverageReport;
	readonly uncertainties: readonly Uncertainty[];
	readonly synthesis: readonly SynthesisPacket[];
	readonly manifest: Manifest;
	readonly chunkPlan: ChunkPlan;
	readonly trace: readonly InspectState[];
	readonly snapshot: InspectResumeSnapshot;
	readonly diagnostics: readonly InspectDiagnostic[];
}

export interface InspectDiagnostic {
	readonly jobId?: string;
	readonly chunkId?: string;
	readonly kind: string;
	readonly message: string;
	readonly routing?: JobOutcome["routing"];
}

interface MutableRun {
	manifest: Manifest;
	chunkPlan: ChunkPlan;
	coverage: Map<ManifestEntryId, CoverageRecord>;
	packets: EvidencePacket[];
	pendingChunks: ReadChunk[];
	pendingModelPolicies: Map<string, JobModelPolicy>;
	generation: number;
	trace: InspectState[];
	previousGapIds?: readonly ManifestEntryId[];
	diagnostics: InspectDiagnostic[];
}

const defaultNow = (): string => new Date().toISOString();
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}
function isEvidencePacket(value: unknown): value is EvidencePacket {
	const record = asRecord(value);
	return Boolean(
		record &&
			typeof record.packetId === "string" &&
			typeof record.chunkId === "string" &&
			typeof record.attemptId === "string" &&
			Array.isArray(record.processedEntryIds) &&
			Array.isArray(record.skippedEntries) &&
			Array.isArray(record.findings) &&
			Array.isArray(record.uncertainties) &&
			asRecord(record.meta),
	);
}
function transition(
	ledger: Map<ManifestEntryId, CoverageRecord>,
	entryId: ManifestEntryId,
	change: Parameters<typeof transitionCoverage>[1],
	fallbackTime: string,
): void {
	const current = ledger.get(entryId);
	if (!current) return;
	ledger.set(entryId, transitionCoverage(current, { ...change, updatedAt: change.updatedAt ?? fallbackTime }));
}
function initialCoverage(manifest: Manifest, at: string): Map<ManifestEntryId, CoverageRecord> {
	return new Map(
		requiredManifestEntries(manifest).map(entry => [
			entry.entryId,
			{
				manifestEntryId: entry.entryId,
				state: { kind: "unassigned" } as CoverageState,
				attemptCount: 0,
				updatedAt: at,
			},
		]),
	);
}
function restoreCoverage(records: readonly CoverageRecord[]): Map<ManifestEntryId, CoverageRecord> {
	return new Map(records.map(record => [record.manifestEntryId, record]));
}
function gapReason(outcome: JobOutcome): CoverageGap["reason"] {
	switch (outcome.disposition.kind) {
		case "timeout":
			return "worker_timeout";
		case "straggler_cancelled":
		case "cancelled":
			return "straggler_cancellation";
		case "malformed_result":
			return "invalid_output";
		case "failed":
			return "worker_failure";
		case "success":
			return "missing_from_packet";
	}
}
function recoveryChunk(
	chunk: ReadChunk,
	entryIds: readonly [ManifestEntryId, ...ManifestEntryId[]],
	generation: number,
	suffix: string,
): ReadChunk {
	return {
		...chunk,
		chunkId: createChunkId(`chunk_recovery_${generation}_${suffix}`),
		assignedEntryIds: entryIds,
		readDependencyEntryIds: chunk.readDependencyEntryIds.filter(id => !entryIds.includes(id)),
		estimatedSourceTokens: Math.max(
			1,
			Math.ceil((chunk.estimatedSourceTokens * entryIds.length) / chunk.assignedEntryIds.length),
		),
	};
}
function orderedPackets(packets: readonly EvidencePacket[], chunks: readonly ReadChunk[]): EvidencePacket[] {
	const order = new Map<string, number>(chunks.map((chunk, index) => [chunk.chunkId, index]));
	return [...packets].sort(
		(left, right) =>
			(order.get(left.chunkId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.chunkId) ?? Number.MAX_SAFE_INTEGER) ||
			left.packetId.localeCompare(right.packetId),
	);
}
function defaultSynthesisPolicy(manifest: Manifest): SynthesisPolicy {
	return {
		maxFanIn: 8,
		singleStepThreshold: 8,
		regionForPacket: packet => {
			const entry = manifest.entries.find(candidate => packet.processedEntryIds.includes(candidate.entryId));
			return entry?.package ?? entry?.module ?? entry?.path.split("/").slice(0, -1).join("/") ?? "root";
		},
	};
}
function makeSnapshot(request: InspectManyRequest, run: MutableRun): InspectResumeSnapshot {
	const { resume: _resume, ...requestWithoutResume } = request;
	return {
		version: 1,
		request: requestWithoutResume,
		manifest: run.manifest,
		chunkPlan: run.chunkPlan,
		coverage: [...run.coverage.values()],
		packets: run.packets,
		pendingChunks: run.pendingChunks,
		generation: run.generation,
		trace: run.trace,
		...(run.previousGapIds ? { previousGapIds: run.previousGapIds } : {}),
	};
}
function maxAttempts(constraints: InspectConstraints): number {
	return constraints.maxAttemptsPerEntry ?? constraints.maxAttemptsPerChunk ?? 1;
}
function isCancelled(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false;
}

export async function inspectMany(request: InspectManyRequest, services: InspectServices): Promise<InspectManyResult> {
	const constraints = request.constraints ?? {};
	const output = request.output ?? {};
	const now = services.now ?? defaultNow;
	const scope = request.scope ?? request.selectors;
	if (!scope || scope.length === 0) throw new Error("Inspect scope requires at least one selector");
	if (request.objective.trim().length === 0) throw new Error("Inspect objective must not be blank");
	const operationId = request.operationId ?? createOperationId("op_inspect_many");
	const repositoryRoot = request.repositoryRoot ?? process.cwd();
	const repositoryRevision = request.repositoryRevision ?? "unknown";
	const agent = request.agent ?? {
		id: request.agentId ?? "inspect-reader",
		name: request.agentName ?? "Inspect reader",
	};
	const generatedAt = request.generatedAt ?? now();
	let run: MutableRun;
	if (request.resume) {
		if (request.resume.version !== 1) throw new Error("Unsupported inspect resume snapshot version");
		run = {
			manifest: request.resume.manifest,
			chunkPlan: request.resume.chunkPlan,
			coverage: restoreCoverage(request.resume.coverage),
			packets: [...request.resume.packets],
			pendingChunks: [...request.resume.pendingChunks],
			pendingModelPolicies: new Map(),
			generation: request.resume.generation,
			trace: [...request.resume.trace],
			previousGapIds: request.resume.previousGapIds,
			diagnostics: [],
		};
	} else {
		const manifest = await (services.generateManifest ?? generateManifest)({
			operationId,
			repositoryRoot,
			repositoryRevision,
			selectors: scope,
			exclusions: request.exclusions ?? [],
			generatedAt,
		});
		const at = now();
		const chunker = services.planChunks ?? planChunks;
		const chunkPlan = chunker({
			manifest,
			objective: request.objective,
			policy: {
				targetSourceTokensPerChunk: constraints.targetSourceTokensPerChunk,
				maxFilesPerChunk: constraints.maxFilesPerChunk,
				allowLineRangeSplit: constraints.allowLineRangeSplit,
			},
			expectedOutputSchema: output.expectedOutputSchema,
		});
		const coverage = initialCoverage(manifest, at);
		for (const chunk of chunkPlan.chunks)
			for (const entryId of chunk.assignedEntryIds)
				transition(coverage, entryId, { kind: "assign", chunkId: chunk.chunkId }, at);
		run = {
			manifest,
			chunkPlan,
			coverage,
			packets: [],
			pendingChunks: [...chunkPlan.chunks],
			pendingModelPolicies: new Map(),
			generation: 0,
			trace: ["Accepted", "ManifestGenerated", "ChunkPlanGenerated"],
			diagnostics: [],
		};
	}
	const expectedIds = requiredManifestEntryIds(run.manifest);
	while (run.pendingChunks.length > 0) {
		if (isCancelled(request.signal)) {
			run.trace.push("Cancelled");
			return finalize(
				request,
				run,
				{ kind: "cancelled", reason: "inspection cancelled" },
				services,
				expectedIds,
				output,
			);
		}
		const builder = services.buildReaderJobs ?? buildReaderJobs;
		const jobs = builder({
			manifest: run.manifest,
			chunkPlan: { ...run.chunkPlan, chunks: run.pendingChunks },
			objective: request.objective,
			agent,
			modelPolicy: constraints.modelPolicy,
			retryPolicy: constraints.retryPolicy,
			timeoutPolicy: constraints.timeoutPolicy,
			budget: constraints.budget,
		}).map(job => {
			const input = asRecord(job.input);
			const chunkId = typeof input?.chunkId === "string" ? input.chunkId : "";
			return { ...job, modelPolicy: run.pendingModelPolicies.get(chunkId) ?? job.modelPolicy };
		});
		run.trace.push("ReadersDispatched");
		const outcomes = await services.executor.executeBatch(jobs, services.executionPolicy);
		const gaps: CoverageGap[] = [];
		const acceptedChunks = new Set<string>();
		for (const outcome of outcomes) {
			const chunk = run.pendingChunks.find(candidate => `reader-${candidate.chunkId}` === outcome.jobId);
			if (!chunk) continue;
			if (outcome.disposition.kind === "success" && isEvidencePacket(outcome.output)) {
				try {
					if (outcome.output.chunkId !== chunk.chunkId)
						throw new Error("Evidence packet chunk does not match assigned chunk");
					const assigned = new Set(chunk.assignedEntryIds);
					validateEvidencePacket(outcome.output, assigned);
					if (
						outcome.output.attemptId !==
						createAttemptId(`${outcome.identity.operationId}:${outcome.jobId}:attempt-${outcome.retry.attempt}`)
					) {
						throw new Error("Evidence packet attempt does not match job outcome");
					}
					run.packets.push(outcome.output);
					acceptedChunks.add(chunk.chunkId);
					for (const id of outcome.output.processedEntryIds) {
						transition(
							run.coverage,
							id,
							{ kind: "process", chunkId: chunk.chunkId, packetId: outcome.output.packetId },
							now(),
						);
						transition(run.coverage, id, { kind: "verify", packetId: outcome.output.packetId }, now());
					}
					for (const skipped of outcome.output.skippedEntries)
						transition(run.coverage, skipped.entryId, { kind: "skip", reason: skipped.reason }, now());
					for (const id of chunk.assignedEntryIds) {
						if (
							outcome.output.processedEntryIds.includes(id) ||
							outcome.output.skippedEntries.some(item => item.entryId === id)
						) continue;
						transition(run.coverage, id, { kind: "fail", errorCode: "missing_from_packet" }, now());
						gaps.push({
							entryId: id,
							chunkId: chunk.chunkId,
							reason: "missing_from_packet",
							attempts: run.coverage.get(id)?.attemptCount ?? 0,
							estimatedTokens: chunk.estimatedSourceTokens,
							detail: "Entry was omitted from evidence packet",
						});
					}
				} catch (error) {
					run.diagnostics.push({
						jobId: outcome.jobId,
						chunkId: chunk.chunkId,
						kind: "invalid_output",
						message: errorMessage(error),
						routing: outcome.routing,
					});
					for (const id of chunk.assignedEntryIds) {
						transition(run.coverage, id, { kind: "fail", errorCode: "invalid_output" }, now());
						gaps.push({
							entryId: id,
							chunkId: chunk.chunkId,
							reason: "invalid_output",
							attempts: run.coverage.get(id)?.attemptCount ?? 0,
							estimatedTokens: chunk.estimatedSourceTokens,
							detail: errorMessage(error),
						});
					}
				}
			} else {
				const reason = gapReason(outcome);
				run.diagnostics.push({
					jobId: outcome.jobId,
					chunkId: chunk.chunkId,
					kind: reason,
					message: outcome.disposition.kind,
					routing: outcome.routing,
				});
				for (const id of chunk.assignedEntryIds) {
					transition(run.coverage, id, { kind: "fail", errorCode: reason }, now());
					gaps.push({
						entryId: id,
						chunkId: chunk.chunkId,
						reason,
						attempts: run.coverage.get(id)?.attemptCount ?? 0,
						estimatedTokens: chunk.estimatedSourceTokens,
						detail: outcome.disposition.kind,
					});
				}
			}
		}
		run.trace.push("EvidenceValidated", "CoverageReconciled");
		const report = reportCoverage(run.coverage, expectedIds);
		const unresolved =
			gaps.length > 0
				? gaps
				: report.gapIds.map(entryId => ({
						entryId,
						reason: "missing_from_packet" as const,
						attempts: run.coverage.get(entryId)?.attemptCount ?? 0,
						detail: "Coverage remains unresolved",
					}));
		if (unresolved.length === 0) {
			run.pendingChunks = [];
			break;
		}
		const limits: RecoveryLimits = {
			maxAttemptsPerEntry: maxAttempts(constraints),
			maxGenerations: constraints.maxGenerations ?? 1,
			generation: run.generation,
			allowInaccessibleSkip: constraints.allowInaccessibleSkip ?? false,
			splitTokenThreshold: constraints.splitTokenThreshold ?? Number.MAX_SAFE_INTEGER,
			previousGapIds: run.previousGapIds,
		};
		const recovery = planRecovery(unresolved, limits);
		if (recovery.terminal !== "continue") {
			const kind = recovery.terminal === "failed" ? "failed" : "partial";
			run.trace.push(kind === "failed" ? "Failed" : "Partial");
			const status: InspectStatus =
				kind === "failed"
					? {
							kind: "failed",
							error: {
								code: "recovery_exhausted",
								message: "Recovery cannot resolve all coverage gaps",
								retryable: false,
								context: { gaps: recovery.unresolved.map(gap => gap.entryId) },
							},
						}
					: { kind: "partial", gapIds: recovery.unresolved.map(gap => gap.entryId) };
			return finalize(request, run, status, services, expectedIds, output);
		}
		run.generation += 1;
		run.previousGapIds = unresolved.map(gap => gap.entryId);
		run.trace.push("RecoveryDispatched");
		const sourceById = new Map(run.pendingChunks.map(chunk => [chunk.chunkId, chunk]));
		const next: ReadChunk[] = [];
		const nextPolicies = new Map<string, JobModelPolicy>();
		const scheduled = new Set<string>();
		const schedule = (target: ReadChunk, modelPolicy?: JobModelPolicy): void => {
			if (scheduled.has(target.chunkId)) return;
			scheduled.add(target.chunkId);
			next.push(target);
			if (modelPolicy) nextPolicies.set(target.chunkId, modelPolicy);
			for (const entryId of target.assignedEntryIds) {
				const record = run.coverage.get(entryId);
				if (record?.state.kind === "failed") {
					run.coverage.set(entryId, recoverCoverage(record, target.chunkId, record.attemptCount + 1, now()));
				}
			}
		};
		for (const decision of recovery.decisions) {
			if (decision.action === "mark_skipped_with_reason") {
				transition(run.coverage, decision.gap.entryId, { kind: "skip", reason: decision.reason }, now());
				continue;
			}
			if (decision.action === "fail_operation") continue;
			const source = decision.gap.chunkId ? sourceById.get(decision.gap.chunkId) : undefined;
			if (!source) continue;
			switch (decision.action) {
				case "retry_same_chunk":
					schedule(recoveryChunk(source, source.assignedEntryIds, run.generation, `${source.chunkId}_same`));
					break;
				case "retry_with_different_model":
					schedule(
						recoveryChunk(source, source.assignedEntryIds, run.generation, `${source.chunkId}_reroute`),
						constraints.recoveryModelPolicy ?? { modelRole: "recovery" },
					);
					break;
				case "split_chunk": {
					const midpoint = Math.ceil(source.assignedEntryIds.length / 2);
					const left = source.assignedEntryIds.slice(0, midpoint);
					const right = source.assignedEntryIds.slice(midpoint);
					const [leftFirst, ...leftRest] = left;
					if (leftFirst)
						schedule(
							recoveryChunk(source, [leftFirst, ...leftRest], run.generation, `${source.chunkId}_split_0`),
						);
					const [rightFirst, ...rightRest] = right;
					if (rightFirst)
						schedule(
							recoveryChunk(source, [rightFirst, ...rightRest], run.generation, `${source.chunkId}_split_1`),
						);
					break;
				}
				case "create_single_entry_chunk":
					schedule(recoveryChunk(source, [decision.gap.entryId], run.generation, decision.gap.entryId));
					break;
				case "refresh_manifest_entry":
					throw new Error("Manifest refresh is not permitted under a pinned inspect revision");
			}
		}
		run.pendingChunks = next;
		run.pendingModelPolicies = nextPolicies;
	}
	const coverage = reportCoverage(run.coverage, expectedIds);
	const finalStatus: InspectStatus =
		coverage.gapIds.length === 0 ? { kind: "complete" } : { kind: "partial", gapIds: coverage.gapIds };
	run.trace.push("CoverageFinalized");
	return finalize(request, run, finalStatus, services, expectedIds, output);
}

async function finalize(
	request: InspectManyRequest,
	run: MutableRun,
	status: InspectStatus,
	services: InspectServices,
	expectedIds: readonly ManifestEntryId[],
	output: InspectOutputRequirements,
): Promise<InspectManyResult> {
	const packets = orderedPackets(run.packets, run.chunkPlan.chunks);
	const synthesisBuilder = services.buildSynthesisTree ?? buildSynthesisTree;
	const synthesis =
		packets.length === 0
			? []
			: [...synthesisBuilder(packets, output.synthesisPolicy ?? defaultSynthesisPolicy(run.manifest))];
	run.trace.push("SynthesisBuilt");
	let reviewed = synthesis;
	if (synthesis.length > 0) {
		const reviewer = services.reviewFinalSynthesis ?? reviewFinalSynthesis;
		const final = synthesis[synthesis.length - 1];
		if (final) reviewed = [...synthesis.slice(0, -1), reviewer(final, new Set(expectedIds))];
	}
	run.trace.push("FinalReviewed");
	if (status.kind === "complete") run.trace.push("Complete");
	const findings = reviewed.flatMap(node => node.findings);
	const uncertainties = reviewed.flatMap(node => node.uncertainties);
	return {
		status,
		findings,
		evidence: packets,
		coverage: reportCoverage(run.coverage, expectedIds),
		uncertainties,
		synthesis: reviewed,
		manifest: run.manifest,
		chunkPlan: run.chunkPlan,
		trace: run.trace,
		snapshot: makeSnapshot(request, run),
		diagnostics: run.diagnostics,
	};
}

export const runInspectMany = inspectMany;
export const inspect_many = inspectMany;
