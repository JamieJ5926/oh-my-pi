import { randomUUID } from "node:crypto";
import { type AsyncJob, type AsyncJobManager, STRAGGLER_CANCEL_REASON } from "../async/job-manager";
import type { AgentSource, SingleResult, StructuredSubagentOutput } from "../task/types";

export const JOB_EXECUTOR_TIMEOUT_REASON = Symbol("JobExecutor timeout");

export interface ExecutableJobAgent {
	id: string;
	name: string;
	source?: AgentSource;
}

export interface JobModelPolicy {
	modelOverride?: string | string[];
	modelRole?: string;
}

export interface JobTimeoutPolicy {
	timeoutMs?: number;
	stragglerFloorMs?: number;
}

export interface JobRetryPolicy {
	retryLimit?: number;
	classifyExhaustedAsMissing?: boolean;
}

export interface JobBudget {
	maxRequests?: number;
	maxTokens?: number;
	maxCostUsd?: number;
}

export interface ExecutableJob {
	jobId: string;
	operationId: string;
	capabilityStage: string;
	objective: string;
	input: unknown;
	outputSchema?: unknown;
	modelPolicy?: JobModelPolicy;
	timeoutPolicy?: JobTimeoutPolicy;
	retryPolicy?: JobRetryPolicy;
	budget?: JobBudget;
	agent: ExecutableJobAgent;
}

export interface ExecutionPolicy {
	batchId?: string;
	ownerId?: string;
	timeoutMs?: number;
	stragglerFloorMs?: number;
}

export interface JobRunContext {
	asyncJobId: string;
	attemptId: string;
	signal: AbortSignal;
	reportProgress(text: string, details?: Record<string, unknown>): Promise<void>;
}

export interface JobExecutionSubstrate {
	execute(job: ExecutableJob, context: JobRunContext): Promise<unknown>;
}

export interface JobExecutor {
	executeBatch(jobs: readonly ExecutableJob[], policy?: ExecutionPolicy): Promise<JobOutcome[]>;
}

export type JobDisposition =
	| { kind: "success" }
	| { kind: "timeout"; retryable: boolean }
	| { kind: "straggler_cancelled"; retryable: boolean }
	| { kind: "malformed_result"; reason: MalformedResultReason; message: string; retryable: boolean }
	| { kind: "failed"; exitCode?: number; retryable: boolean }
	| { kind: "cancelled"; retryable: boolean };

export type MalformedResultReason = "missing_result" | "invalid_result_shape" | "schema_invalid" | "schema_unavailable";

export interface RoutingRecord {
	modelOverride?: string | string[];
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
}

export interface JobRetryMetadata {
	logicalItemId: string;
	attempt: number;
	retryLimit?: number;
	classifyExhaustedAsMissing?: boolean;
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
}

export interface JobIdentity {
	jobId: string;
	operationId: string;
	capabilityStage: string;
	objective: string;
	agentId: string;
	agentName: string;
	agentSource?: AgentSource;
}

export interface JobDiagnostics {
	asyncJobId: string;
	asyncJobStatus: AsyncJob["status"] | "not_registered";
	batchId: string;
	startedAtMs?: number;
	actualStartedAtMs?: number;
	durationMs?: number;
	exitCode?: number;
	stderr?: string;
	error?: string;
	rawText?: string;
	messages: string[];
}

export interface JobOutcome {
	jobId: string;
	attemptId: string;
	disposition: JobDisposition;
	output?: unknown;
	identity: JobIdentity;
	routing: RoutingRecord;
	retry: JobRetryMetadata;
	diagnostics: JobDiagnostics;
}

interface PendingRegisteredJob {
	kind: "registered";
	job: ExecutableJob;
	asyncJobId: string;
	attemptId: string;
	batchId: string;
	attempt: number;
	timedOut: () => boolean;
	completion: Promise<void>;
	state: {
		returned?: unknown;
		thrown?: unknown;
	};
}

interface PendingRejectedJob {
	kind: "rejected";
	job: ExecutableJob;
	attemptId: string;
	batchId: string;
	attempt: number;
	error: unknown;
	completion: Promise<void>;
}

type PendingJob = PendingRegisteredJob | PendingRejectedJob;

interface ParsedEnvelope {
	result?: SingleResult;
	malformed?: {
		reason: MalformedResultReason;
		message: string;
	};
	rawText?: string;
}

interface ProgressRouting {
	id?: string;
	modelOverride?: string | string[];
	modelRole?: string;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
}

const DEFAULT_OWNER_ID = "capability-job-executor";

export class AsyncJobManagerJobExecutor implements JobExecutor {
	readonly #manager: AsyncJobManager;
	readonly #substrate: JobExecutionSubstrate;
	readonly #ownerId: string;

	constructor(options: { manager: AsyncJobManager; substrate: JobExecutionSubstrate; ownerId?: string }) {
		this.#manager = options.manager;
		this.#substrate = options.substrate;
		this.#ownerId = normalizeNonEmpty(options.ownerId) ?? DEFAULT_OWNER_ID;
	}

	async executeBatch(jobs: readonly ExecutableJob[], policy: ExecutionPolicy = {}): Promise<JobOutcome[]> {
		const ownerId = normalizeNonEmpty(policy.ownerId) ?? this.#ownerId;
		const batchId = normalizeNonEmpty(policy.batchId) ?? `capability-${randomUUID()}`;
		const pending = jobs.map(job => this.#submit(job, ownerId, batchId, policy));
		await Promise.all(pending.map(job => job.completion));
		return pending.map(job => this.#buildOutcome(job));
	}

	#submit(job: ExecutableJob, ownerId: string, batchId: string, policy: ExecutionPolicy): PendingJob {
		const attempt = 0;
		const attemptId = `${job.operationId}:${job.jobId}:attempt-${attempt}`;
		const state: PendingRegisteredJob["state"] = {};
		let timeoutFired = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutMs = normalizePositiveInteger(job.timeoutPolicy?.timeoutMs ?? policy.timeoutMs);
		try {
			const asyncJobId = this.#manager.register(
				"task",
				job.objective,
				async ({ jobId, signal, reportProgress }) => {
					try {
						const returned = await this.#substrate.execute(job, {
							asyncJobId: jobId,
							attemptId,
							signal,
							reportProgress,
						});
						state.returned = returned;
						return renderDeliveryText(returned);
					} catch (error) {
						state.thrown = error;
						throw error;
					}
				},
				{
					id: job.jobId,
					agentId: job.agent.id,
					ownerId,
					batchId,
					logicalItemId: job.jobId,
					attempt,
					stragglerFloorMs: normalizePositiveInteger(
						job.timeoutPolicy?.stragglerFloorMs ?? policy.stragglerFloorMs,
					),
				},
			);
			const managerJob = this.#manager.getJob(asyncJobId);
			let completion = managerJob?.promise.then(() => {}) ?? Promise.resolve();
			if (timeoutMs !== undefined) {
				const timedOut = Promise.withResolvers<void>();
				timeout = setTimeout(() => {
					timeoutFired = true;
					this.#manager.cancel(asyncJobId, { ownerId }, JOB_EXECUTOR_TIMEOUT_REASON);
					timedOut.resolve();
				}, timeoutMs);
				completion = Promise.race([completion, timedOut.promise]).then(() => {});
			}
			completion = completion.finally(() => {
				if (timeout) clearTimeout(timeout);
			});
			return {
				kind: "registered",
				job,
				asyncJobId,
				attemptId,
				batchId,
				attempt,
				timedOut: () => timeoutFired,
				completion,
				state,
			};
		} catch (error) {
			return {
				kind: "rejected",
				job,
				attemptId,
				batchId,
				attempt,
				error,
				completion: Promise.resolve(),
			};
		}
	}

	#buildOutcome(pending: PendingJob): JobOutcome {
		if (pending.kind === "rejected") {
			return buildRejectedOutcome(pending);
		}
		const asyncJob = this.#manager.getJob(pending.asyncJobId);
		const parsed = parseSubstrateEnvelope(pending.job, pending.state.returned);
		const progressRouting = extractProgressRouting(asyncJob?.latestDetails, pending.job.agent.id, pending.job.jobId);
		const disposition = dispositionFor({
			job: pending.job,
			asyncJob,
			parsed,
			timedOut: pending.timedOut(),
		});
		return {
			jobId: pending.job.jobId,
			attemptId: pending.attemptId,
			disposition,
			...(disposition.kind === "success" && parsed.result ? { output: outputFor(parsed.result) } : {}),
			identity: identityFor(pending.job),
			routing: routingFor(pending.job, parsed.result, progressRouting),
			retry: retryFor(pending.job, pending.attempt, parsed.result),
			diagnostics: diagnosticsFor({
				job: pending.job,
				asyncJob,
				batchId: pending.batchId,
				parsed,
				thrown: pending.state.thrown,
			}),
		};
	}
}

function dispositionFor(args: {
	job: ExecutableJob;
	asyncJob: AsyncJob | undefined;
	parsed: ParsedEnvelope;
	timedOut: boolean;
}): JobDisposition {
	const retryable = (args.job.retryPolicy?.retryLimit ?? 0) > 0;
	const signal = args.asyncJob?.abortController.signal;
	if (args.timedOut || signal?.reason === JOB_EXECUTOR_TIMEOUT_REASON) {
		return { kind: "timeout", retryable };
	}
	if (signal?.reason === STRAGGLER_CANCEL_REASON) {
		return { kind: "straggler_cancelled", retryable };
	}
	if (args.asyncJob?.status === "cancelled") {
		return { kind: "cancelled", retryable };
	}
	if (args.parsed.malformed) {
		return { kind: "malformed_result", ...args.parsed.malformed, retryable };
	}
	const result = args.parsed.result;
	if (!result) {
		return {
			kind: "malformed_result",
			reason: "missing_result",
			message: "Substrate did not return a SingleResult",
			retryable,
		};
	}
	if (result.structuredOutput?.status === "invalid") {
		return {
			kind: "malformed_result",
			reason: "schema_invalid",
			message: result.structuredOutput.error ?? "Structured output failed validation",
			retryable,
		};
	}
	if (result.structuredOutput?.status === "unavailable") {
		return {
			kind: "malformed_result",
			reason: "schema_unavailable",
			message: result.structuredOutput.error ?? "Structured output was unavailable",
			retryable,
		};
	}
	if (result.aborted ?? false) {
		return { kind: "cancelled", retryable };
	}
	if (args.asyncJob?.status === "failed" || result.exitCode !== 0 || result.error) {
		return { kind: "failed", exitCode: result.exitCode, retryable };
	}
	return { kind: "success" };
}

function buildRejectedOutcome(pending: PendingRejectedJob): JobOutcome {
	const message = errorMessage(pending.error);
	return {
		jobId: pending.job.jobId,
		attemptId: pending.attemptId,
		disposition: { kind: "failed", retryable: (pending.job.retryPolicy?.retryLimit ?? 0) > 0 },
		identity: identityFor(pending.job),
		routing: routingFor(pending.job),
		retry: retryFor(pending.job, pending.attempt),
		diagnostics: {
			asyncJobId: pending.job.jobId,
			asyncJobStatus: "not_registered",
			batchId: pending.batchId,
			error: message,
			messages: [`Failed to register job: ${message}`],
		},
	};
}

function identityFor(job: ExecutableJob): JobIdentity {
	return {
		jobId: job.jobId,
		operationId: job.operationId,
		capabilityStage: job.capabilityStage,
		objective: job.objective,
		agentId: job.agent.id,
		agentName: job.agent.name,
		...(job.agent.source ? { agentSource: job.agent.source } : {}),
	};
}

function retryFor(job: ExecutableJob, attempt: number, result?: SingleResult): JobRetryMetadata {
	return {
		logicalItemId: job.jobId,
		attempt,
		...(job.retryPolicy?.retryLimit !== undefined ? { retryLimit: job.retryPolicy.retryLimit } : {}),
		...(job.retryPolicy?.classifyExhaustedAsMissing !== undefined
			? { classifyExhaustedAsMissing: job.retryPolicy.classifyExhaustedAsMissing }
			: {}),
		...(result?.retryFailure ? { retryFailure: result.retryFailure } : {}),
	};
}

function routingFor(job: ExecutableJob, result?: SingleResult, progress?: ProgressRouting): RoutingRecord {
	const modelOverride = result?.modelOverride ?? progress?.modelOverride ?? job.modelPolicy?.modelOverride;
	const modelRole = result?.modelRole ?? progress?.modelRole ?? job.modelPolicy?.modelRole;
	const resolvedModel = result?.resolvedModel ?? progress?.resolvedModel;
	const resolvedModelIsFallback = result?.resolvedModelIsFallback ?? progress?.resolvedModelIsFallback;
	return {
		...(modelOverride !== undefined ? { modelOverride } : {}),
		...(modelRole !== undefined ? { modelRole } : {}),
		...(resolvedModel !== undefined ? { resolvedModel } : {}),
		...(resolvedModelIsFallback !== undefined ? { resolvedModelIsFallback } : {}),
	};
}

function diagnosticsFor(args: {
	job: ExecutableJob;
	asyncJob: AsyncJob | undefined;
	batchId: string;
	parsed: ParsedEnvelope;
	thrown?: unknown;
}): JobDiagnostics {
	const result = args.parsed.result;
	const messages: string[] = [];
	if (args.parsed.malformed) messages.push(args.parsed.malformed.message);
	if (args.thrown !== undefined) messages.push(`Substrate threw: ${errorMessage(args.thrown)}`);
	if (result?.retryFailure)
		messages.push(`Retry failed at attempt ${result.retryFailure.attempt}: ${result.retryFailure.errorMessage}`);
	return {
		asyncJobId: args.asyncJob?.id ?? args.job.jobId,
		asyncJobStatus: args.asyncJob?.status ?? "not_registered",
		batchId: args.batchId,
		startedAtMs: args.asyncJob?.startTime,
		actualStartedAtMs: args.asyncJob?.actualStartedAt,
		durationMs: result?.durationMs,
		exitCode: result?.exitCode,
		stderr: nonEmpty(result?.stderr),
		error:
			nonEmpty(result?.error) ??
			nonEmpty(args.asyncJob?.errorText) ??
			(args.thrown === undefined ? undefined : errorMessage(args.thrown)),
		rawText: args.parsed.rawText ?? args.asyncJob?.resultText ?? args.asyncJob?.errorText,
		messages,
	};
}

function outputFor(result: SingleResult): unknown {
	if (result.structuredOutput?.status === "valid" && "data" in result.structuredOutput) {
		return result.structuredOutput.data;
	}
	return result.output;
}

function parseSubstrateEnvelope(job: ExecutableJob, value: unknown): ParsedEnvelope {
	if (value === undefined) {
		return { malformed: { reason: "missing_result", message: "Substrate returned no result" } };
	}
	if (isSingleResult(value)) return { result: value, rawText: value.output };
	const record = asRecord(value);
	if (!record) {
		return { malformed: { reason: "invalid_result_shape", message: "Substrate result is not an object" } };
	}
	const details = asRecord(record.details);
	if (!details) {
		return {
			malformed: { reason: "invalid_result_shape", message: "Substrate result has no details object" },
			rawText: contentText(record),
		};
	}
	const results = details.results;
	if (!Array.isArray(results) || results.length === 0) {
		return {
			malformed: { reason: "missing_result", message: "Substrate details did not include any results" },
			rawText: contentText(record),
		};
	}
	const matching = results.find(
		result => isSingleResult(result) && (result.id === job.agent.id || result.id === job.jobId),
	);
	if (isSingleResult(matching)) return { result: matching, rawText: contentText(record) ?? matching.output };
	if (results.length === 1 && isSingleResult(results[0]))
		return { result: results[0], rawText: contentText(record) ?? results[0].output };
	return {
		malformed: {
			reason: "invalid_result_shape",
			message: `Substrate details did not include a SingleResult for ${job.jobId}`,
		},
		rawText: contentText(record),
	};
}

function renderDeliveryText(value: unknown): string {
	if (isSingleResult(value)) return value.output || value.stderr || value.error || "";
	const record = asRecord(value);
	if (record) {
		const text = contentText(record);
		if (text !== undefined) return text;
	}
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function contentText(record: Record<string, unknown>): string | undefined {
	const content = record.content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		const partRecord = asRecord(part);
		if (partRecord?.type === "text" && typeof partRecord.text === "string") return partRecord.text;
	}
	return undefined;
}

function extractProgressRouting(
	details: Record<string, unknown> | undefined,
	agentId: string,
	jobId: string,
): ProgressRouting | undefined {
	const progress = details?.progress;
	if (!Array.isArray(progress)) return undefined;
	for (const entry of progress) {
		if (!isProgressRouting(entry)) continue;
		if (entry.id === agentId || entry.id === jobId) return entry;
	}
	return progress.find(isProgressRouting);
}

function isSingleResult(value: unknown): value is SingleResult {
	const record = asRecord(value);
	if (!record) return false;
	return (
		typeof record.index === "number" &&
		typeof record.id === "string" &&
		typeof record.agent === "string" &&
		isAgentSource(record.agentSource) &&
		typeof record.task === "string" &&
		typeof record.exitCode === "number" &&
		typeof record.output === "string" &&
		typeof record.stderr === "string" &&
		typeof record.truncated === "boolean" &&
		typeof record.durationMs === "number" &&
		typeof record.tokens === "number" &&
		typeof record.requests === "number" &&
		optionalString(record.assignment) &&
		optionalString(record.description) &&
		optionalString(record.lastIntent) &&
		optionalModelOverride(record.modelOverride) &&
		optionalString(record.modelRole) &&
		optionalString(record.resolvedModel) &&
		optionalBoolean(record.resolvedModelIsFallback) &&
		optionalString(record.error) &&
		optionalBoolean(record.aborted) &&
		optionalString(record.abortReason) &&
		optionalStructuredOutput(record.structuredOutput) &&
		optionalRetryFailure(record.retryFailure)
	);
}

function isProgressRouting(value: unknown): value is ProgressRouting {
	const record = asRecord(value);
	if (!record) return false;
	return (
		optionalString(record.id) &&
		optionalModelOverride(record.modelOverride) &&
		optionalString(record.modelRole) &&
		optionalString(record.resolvedModel) &&
		optionalBoolean(record.resolvedModelIsFallback)
	);
}

function optionalStructuredOutput(value: unknown): value is StructuredSubagentOutput | undefined {
	if (value === undefined) return true;
	const record = asRecord(value);
	if (!record) return false;
	return (
		(record.source === "caller" ||
			record.source === "agent" ||
			record.source === "session" ||
			record.source === "none") &&
		(record.mode === "permissive" || record.mode === "strict") &&
		(record.status === "valid" || record.status === "invalid" || record.status === "unavailable") &&
		optionalString(record.error)
	);
}

function optionalRetryFailure(value: unknown): value is SingleResult["retryFailure"] | undefined {
	if (value === undefined) return true;
	const record = asRecord(value);
	return Boolean(record && typeof record.attempt === "number" && typeof record.errorMessage === "string");
}

function optionalModelOverride(value: unknown): value is string | string[] | undefined {
	return (
		value === undefined ||
		typeof value === "string" ||
		(Array.isArray(value) && value.every(item => typeof item === "string"))
	);
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === "boolean";
}

function isAgentSource(value: unknown): value is AgentSource {
	return value === "bundled" || value === "user" || value === "project";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
