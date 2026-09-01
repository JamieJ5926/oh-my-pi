import { logger, toError } from "@oh-my-pi/pi-utils";
import {
	ResourceAdmissionController,
	type ResourcePolicy,
	type ResourceSnapshot,
	type ResourceTransition,
} from "../bridge/runtime/resource-policy";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const TASK_CLASS_FLOORS = {
	"local-read": 20_000,
	grep: 25_000,
	default: 30_000,
	"web-research": 180_000,
	"build-test": 300_000,
} as const;

const DEFAULT_STRAGGLER_FLOOR_MS = TASK_CLASS_FLOORS.default;

function normalizeStragglerFloorMs(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_STRAGGLER_FLOOR_MS;
	}
	return Math.floor(value);
}

/** Abort reason used only when the manager cancels an overdue batch sibling. */
export const STRAGGLER_CANCEL_REASON = Symbol("AsyncJobManager straggler cancellation");
/** Abort reason used only when the owning session shuts down the entire manager. */
export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

/** Kind of work a managed job runs; drives job-row badges and delivery labels. */
export type AsyncJobType = "bash" | "task" | "eval";

export type AsyncJobResourceState =
	| "queued"
	| "admitted"
	| "running"
	| "terminal"
	| "cancelled"
	| "backpressure"
	| "overflow";

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	/** Time this job left its caller-managed queue and began active work. */
	actualStartedAt?: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: Record<string, unknown>;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/** Unique identity of one task-tool call. Meaningful only together with ownerId. */
	batchId?: string;
	/** Stable caller-defined identity shared by attempts of the same logical item. */
	logicalItemId?: string;
	/** Caller-defined attempt number for this logical item. */
	attempt?: number;
	/** Normalized minimum active-runtime budget used by this job's batch tracker. */
	stragglerFloorMs?: number;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/** Job is registered but parked behind a caller-managed gate. */
	queued?: boolean;
	/** ResourcePolicy lifecycle state, present only when a policy is configured. */
	resourceState?: AsyncJobResourceState;
	/** Logical model/backend attribution retained with resource observations. */
	model?: string;
	backend?: string;
}

export interface AsyncJobResourceTransition {
	readonly kind: AsyncJobResourceState;
	readonly jobId: string;
	readonly model?: string;
	readonly backend?: string;
	readonly requestBytes?: number;
	readonly resultBytes?: number;
	readonly droppedBytes?: number;
	readonly reason?: string;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;
export interface AsyncJobDeliveryState {
	readonly queued: number;
	readonly delivering: boolean;
	readonly nextRetryAt?: number;
	readonly pendingJobIds: string[];
}

export interface AsyncJobReapResult {
	readonly settled: boolean;
	readonly pendingJobIds: string[];
	readonly completion: Promise<void>;
}

interface AsyncJobDelivery {
	readonly jobId: string;
	readonly text: string;
	readonly ownerId?: string;
	attempt: number;
	lastError?: string;
	nextAttemptAt: number;
	promise: Promise<void>;
}
interface AdmissionQueueEntry {
	readonly jobId: string;
	readonly start: () => void;
	readonly settle: () => void;
}

export interface AsyncJobManagerOptions {
	/** Delivery sink for unowned completions. */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
	/** Optional OMP-owned admission and resource accounting policy. */
	resourceAdmission?: ResourcePolicy;
	/** Receives explicit policy lifecycle transitions. */
	onResourceTransition?: (transition: AsyncJobResourceTransition) => void;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	ownerId?: string;
	batchId?: string;
	logicalItemId?: string;
	attempt?: number;
	stragglerFloorMs?: number;
	agentId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	queued?: boolean;
	requestBytes?: number;
	model?: string;
	backend?: string;
}
/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

interface BatchStragglerState {
	readonly ownerId: string;
	readonly batchId: string;
	/** The set size is the number of jobs that registered successfully in this batch. */
	readonly jobIds: Set<string>;
	floorMs: number;
	firstCompletedAt?: number;
	firstCompletionDurationMs?: number;
	timer?: NodeJS.Timeout;
}

type GetAsyncJob = (jobId: string) => AsyncJob | undefined;
type CancelAsyncJob = (jobId: string, filter: AsyncJobFilter, reason?: unknown) => boolean;

class BatchStragglerTracker {
	/** Two-level key prevents collisions between arbitrary owner and batch strings. */
	readonly #batchesByOwner = new Map<string, Map<string, BatchStragglerState>>();
	readonly #getJob: GetAsyncJob;
	readonly #cancelJob: CancelAsyncJob;

	constructor(getJob: GetAsyncJob, cancelJob: CancelAsyncJob) {
		this.#getJob = getJob;
		this.#cancelJob = cancelJob;
	}

	register(job: AsyncJob): void {
		if (job.type !== "task" || job.ownerId === undefined || job.batchId === undefined) return;

		let batches = this.#batchesByOwner.get(job.ownerId);
		if (!batches) {
			batches = new Map<string, BatchStragglerState>();
			this.#batchesByOwner.set(job.ownerId, batches);
		}

		let state = batches.get(job.batchId);
		if (!state) {
			state = {
				ownerId: job.ownerId,
				batchId: job.batchId,
				jobIds: new Set<string>(),
				floorMs: job.stragglerFloorMs ?? DEFAULT_STRAGGLER_FLOOR_MS,
			};
			batches.set(job.batchId, state);
		}

		state.jobIds.add(job.id);
		state.floorMs = Math.max(state.floorMs, job.stragglerFloorMs ?? DEFAULT_STRAGGLER_FLOOR_MS);
		if (job.status !== "running") {
			this.onTerminal(job);
			return;
		}
		this.#reschedule(state, Date.now());
	}

	onStarted(job: AsyncJob, startedAt: number = Date.now()): void {
		if (job.ownerId === undefined || job.batchId === undefined) return;
		const state = this.#batchesByOwner.get(job.ownerId)?.get(job.batchId);
		if (!state?.jobIds.has(job.id)) return;
		job.actualStartedAt ??= startedAt;
		this.#reschedule(state, startedAt);
	}

	onTerminal(job: AsyncJob, settledAt: number = Date.now()): void {
		if (job.ownerId === undefined || job.batchId === undefined) return;
		const state = this.#batchesByOwner.get(job.ownerId)?.get(job.batchId);
		if (!state?.jobIds.has(job.id)) return;

		if (job.status === "completed" && state.firstCompletedAt === undefined) {
			const startedAt = job.actualStartedAt ?? job.startTime;
			state.firstCompletedAt = settledAt;
			state.firstCompletionDurationMs = Math.max(0, settledAt - startedAt);
		}

		if (this.#allTerminal(state)) {
			this.#deleteState(state);
			return;
		}
		this.#reschedule(state, settledAt);
	}

	dispose(): void {
		for (const batches of this.#batchesByOwner.values()) {
			for (const state of batches.values()) {
				clearTimeout(state.timer);
			}
		}
		this.#batchesByOwner.clear();
	}

	#reschedule(state: BatchStragglerState, now: number): void {
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		if (state.jobIds.size < 2 || state.firstCompletionDurationMs === undefined) return;

		const budgetMs = Math.max(state.floorMs, 2 * state.firstCompletionDurationMs);
		let nextDeadline = Number.POSITIVE_INFINITY;
		for (const jobId of state.jobIds) {
			const sibling = this.#getJob(jobId);
			if (
				!sibling ||
				sibling.ownerId !== state.ownerId ||
				sibling.batchId !== state.batchId ||
				sibling.status !== "running" ||
				sibling.queued === true ||
				sibling.actualStartedAt === undefined
			) {
				continue;
			}
			nextDeadline = Math.min(nextDeadline, sibling.actualStartedAt + budgetMs);
		}
		if (!Number.isFinite(nextDeadline)) return;

		const timer = setTimeout(
			() => {
				state.timer = undefined;
				if (this.#batchesByOwner.get(state.ownerId)?.get(state.batchId) !== state) return;
				const firedAt = Date.now();
				for (const jobId of state.jobIds) {
					const sibling = this.#getJob(jobId);
					if (
						!sibling ||
						sibling.ownerId !== state.ownerId ||
						sibling.batchId !== state.batchId ||
						sibling.status !== "running" ||
						sibling.queued === true ||
						sibling.actualStartedAt === undefined ||
						firedAt - sibling.actualStartedAt < budgetMs
					) {
						continue;
					}
					this.#cancelJob(sibling.id, { ownerId: state.ownerId }, STRAGGLER_CANCEL_REASON);
				}

				if (this.#allTerminal(state)) this.#deleteState(state);
				else this.#reschedule(state, firedAt);
			},
			Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextDeadline - now)),
		);
		timer.unref();
		state.timer = timer;
	}

	#allTerminal(state: BatchStragglerState): boolean {
		for (const jobId of state.jobIds) {
			if (this.#getJob(jobId)?.status === "running") return false;
		}
		return true;
	}

	#deleteState(state: BatchStragglerState): void {
		const batches = this.#batchesByOwner.get(state.ownerId);
		if (batches?.get(state.batchId) !== state) return;
		clearTimeout(state.timer);
		batches.delete(state.batchId);
		if (batches.size === 0) this.#batchesByOwner.delete(state.ownerId);
	}
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #resourceController: ResourceAdmissionController | undefined;
	readonly #onResourceTransition: AsyncJobManagerOptions["onResourceTransition"];
	readonly #jobs = new Map<string, AsyncJob>();
	readonly #batchStragglerTracker = new BatchStragglerTracker(
		jobId => this.#jobs.get(jobId),
		(jobId, filter, reason) => this.cancel(jobId, filter, reason),
	);
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #consumedJobResults = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	readonly #admissionReservations = new Set<string>();
	readonly #admissionQueue: AdmissionQueueEntry[] = [];

	#deliveryLoop: Promise<void> | undefined;
	#deliveryQueueChanged = Promise.withResolvers<void>();
	#disposed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#resourceController = options.resourceAdmission
			? new ResourceAdmissionController(options.resourceAdmission)
			: undefined;
		this.#onResourceTransition = options.onResourceTransition;
	}

	/** Current ResourcePolicy accounting, or undefined when disabled. */
	resourceSnapshot(): ResourceSnapshot | undefined {
		return this.#resourceController?.snapshot();
	}

	/** Update the RSS sample used by ResourcePolicy admission. */
	setResourceRssBytes(rssBytes: number | undefined): void {
		this.#resourceController?.setRssBytes(rssBytes);
	}

	#emitResourceTransition(transition: AsyncJobResourceTransition): void {
		try {
			this.#onResourceTransition?.(transition);
		} catch (error) {
			logger.warn("Async job resource transition callback failed", {
				jobId: transition.jobId,
				error: toError(error).message,
			});
		}
	}

	#transitionResource(job: AsyncJob, transition: ResourceTransition): void {
		if (!this.#resourceController) return;
		this.#resourceController.transition(transition);
		job.resourceState = transition.kind;
		this.#emitResourceTransition({
			kind: transition.kind,
			jobId: job.id,
			model: job.model,
			backend: job.backend,
			...(transition.kind === "queued" ? { requestBytes: transition.bytes } : {}),
			...(transition.kind === "terminal" ? { resultBytes: transition.resultBytes } : {}),
			...(transition.kind === "overflow" ? { droppedBytes: transition.droppedBytes } : {}),
		});
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		return this.#admissionReservations.size >= this.#maxRunningJobs;
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		this.#consumedJobResults.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();
		const admissionReserved = options?.queued !== true && this.#reserveAdmission(id);
		let admissionQueued = options?.queued !== true && !admissionReserved;
		const batchId = options?.batchId?.trim() || undefined;
		const stragglerFloorMs = batchId === undefined ? undefined : normalizeStragglerFloorMs(options?.stragglerFloorMs);

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			actualStartedAt: options?.queued === true || admissionQueued ? undefined : startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			batchId,
			logicalItemId: options?.logicalItemId,
			attempt: options?.attempt,
			stragglerFloorMs,
			agentId: options?.agentId,
			queued: options?.queued === true || admissionQueued,
			model: options?.model,
			backend: options?.backend,
		};
		const reservation = this.#resourceController?.admit(id, options?.requestBytes ?? 0);
		if (reservation?.kind === "rejected") {
			if (admissionReserved) this.#releaseAdmission(id);
			this.#emitResourceTransition({
				kind: "backpressure",
				jobId: id,
				model: job.model,
				backend: job.backend,
				reason: reservation.reason,
			});
			throw new Error(`Resource admission rejected: ${reservation.reason}`);
		}
		if (reservation?.kind === "queued") {
			admissionQueued = options?.queued !== true;
			job.queued = options?.queued === true || admissionQueued;
			job.resourceState = "queued";
			this.#emitResourceTransition({
				kind: "queued",
				jobId: id,
				model: job.model,
				backend: job.backend,
				requestBytes: options?.requestBytes ?? 0,
			});
		} else if (reservation?.kind === "admitted") {
			this.#emitResourceTransition({ kind: "admitted", jobId: id, model: job.model, backend: job.backend });
			job.resourceState = "admitted";
		}
		if (admissionQueued) job.actualStartedAt = undefined;

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: toError(error).message,
				});
			}
		};

		let settle: () => void = () => {};
		job.promise = new Promise<void>(resolve => {
			settle = resolve;
		});
		const start = (): void => {
			void (async () => {
				try {
					if (!job.queued && job.resourceState === "admitted")
						this.#transitionResource(job, { kind: "running", id });
					const text = await run({
						jobId: id,
						signal: abortController.signal,
						reportProgress,
						markRunning: () => {
							job.queued = false;
							if (job.resourceState === "queued") this.#transitionResource(job, { kind: "admitted", id });
							if (job.resourceState === "admitted") this.#transitionResource(job, { kind: "running", id });
							if (job.actualStartedAt === undefined) {
								job.actualStartedAt = Date.now();
								this.#batchStragglerTracker.onStarted(job, job.actualStartedAt);
							}
						},
					});
					if (job.status === "cancelled") {
						job.resultText = text;
						if (job.resourceState !== undefined) this.#transitionResource(job, { kind: "cancelled", id });
						this.#batchStragglerTracker.onTerminal(job);
						this.#scheduleEviction(id);
						return;
					}
					job.status = "completed";
					if (this.#resourceController && job.resourceState !== undefined) {
						const bounded = this.#resourceController.boundResult(text);
						job.resultText = bounded.output;
						if (bounded.overflow)
							this.#transitionResource(job, {
								kind: "overflow",
								id,
								droppedBytes: Math.max(0, text.length - bounded.output.length),
							});
						else this.#transitionResource(job, { kind: "terminal", id, resultBytes: bounded.bytes });
					} else {
						job.resultText = text;
					}
					this.#batchStragglerTracker.onTerminal(job);
					this.#enqueueDelivery(id, job.resultText);
					this.#scheduleEviction(id);
				} catch (error) {
					if (job.status === "cancelled") {
						job.errorText = toError(error).message;
						if (job.resourceState !== undefined) this.#transitionResource(job, { kind: "cancelled", id });
						this.#batchStragglerTracker.onTerminal(job);
						this.#scheduleEviction(id);
						return;
					}
					const errorText = toError(error).message;
					job.status = "failed";
					job.errorText = errorText;
					if (job.resourceState !== undefined)
						this.#transitionResource(job, { kind: "terminal", id, resultBytes: 0 });
					this.#batchStragglerTracker.onTerminal(job);
					this.#enqueueDelivery(id, errorText);
					this.#scheduleEviction(id);
				} finally {
					this.#releaseAdmission(id);
				}
			})().then(settle, settle);
		};
		this.#jobs.set(id, job);
		this.#batchStragglerTracker.register(job);
		if (options?.queued === true || !admissionQueued) {
			start();
		} else {
			this.#admissionQueue.push({ jobId: id, start, settle });
		}
		return id;
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter, reason?: unknown): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		this.#batchStragglerTracker.onTerminal(job);
		if (reason === undefined) job.abortController.abort();
		else job.abortController.abort(reason);
		if (this.#cancelAdmission(id)) {
			if (job.resourceState !== undefined) this.#transitionResource(job, { kind: "cancelled", id });
		} else {
			// Keep the manager reservation until the run body settles and its resource
			// transition has released the underlying worker slot.
		}
		this.#scheduleEviction(id);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		this.#notifyDeliveryQueueChanged();
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		this.#notifyDeliveryQueueChanged();
		return before - this.#deliveries.length;
	}

	/**
	 * Mark settled job results as recovered by a foreground snapshot.
	 *
	 * Suppresses queued delivery and marks retained bodies as consumed so later
	 * snapshots report execution state without replaying the same result.
	 */
	consumeJobResults(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		this.acknowledgeDeliveries(uniqueJobIds);
		let consumed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#consumeJobResult(jobId)) consumed += 1;
		}
		return consumed;
	}

	/** True once a result was auto-delivered or recovered by a foreground snapshot. */
	isJobResultConsumed(jobId: string): boolean {
		return this.#consumedJobResults.has(jobId);
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || (job.status !== "completed" && job.status !== "failed")) continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 *
	 * `reason` is forwarded to each job's `AbortController.abort`, so a session
	 * teardown can tag its owned jobs with {@link ASYNC_JOB_MANAGER_SHUTDOWN_REASON}
	 * before `dispose()` runs — the task executor reads it to park (not
	 * tombstone) a subagent interrupted purely by process shutdown.
	 */
	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}
	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		for (const job of this.getRunningJobs(filter)) {
			job.status = "cancelled";
			this.#batchStragglerTracker.onTerminal(job);
			if (reason === undefined) job.abortController.abort();
			else job.abortController.abort(reason);
			if (this.#cancelAdmission(job.id)) {
				if (job.resourceState !== undefined) this.#transitionResource(job, { kind: "cancelled", id: job.id });
			}
			this.#scheduleEviction(job.id);
		}
	}

	#reserveAdmission(jobId: string): boolean {
		if (this.#admissionReservations.size >= this.#maxRunningJobs) return false;
		this.#admissionReservations.add(jobId);
		return true;
	}

	#releaseAdmission(jobId: string): void {
		if (!this.#admissionReservations.delete(jobId)) return;
		this.#drainAdmissionQueue();
	}

	#cancelAdmission(jobId: string): boolean {
		const index = this.#admissionQueue.findIndex(entry => entry.jobId === jobId);
		if (index === -1) return false;
		const [entry] = this.#admissionQueue.splice(index, 1);
		entry?.settle();
		return true;
	}

	#drainAdmissionQueue(): void {
		while (this.#admissionReservations.size < this.#maxRunningJobs) {
			const entry = this.#admissionQueue.shift();
			if (!entry) return;
			const job = this.#jobs.get(entry.jobId);
			if (job?.status !== "running") {
				entry.settle();
				continue;
			}
			if (job.resourceState === "queued") this.#transitionResource(job, { kind: "admitted", id: job.id });
			this.#admissionReservations.add(entry.jobId);
			job.queued = false;
			job.actualStartedAt ??= Date.now();
			this.#batchStragglerTracker.onStarted(job, job.actualStartedAt);
			entry.start();
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job.id) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	/**
	 * Cancel every job owned by `ownerId`, then wait only until `deadlineAt`.
	 * The returned completion keeps waiting for actual process settlement when
	 * the deadline expires, so callers can move that cleanup out of the
	 * user-visible Task wait without losing ownership of the live work.
	 */
	async cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId })
			.filter(job => job.status === "running" || job.status === "cancelled")
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#batchStragglerTracker.dispose();
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#consumedJobResults.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		return jobsSettled && drained;
	}

	#consumeJobResult(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		if (!job || job.status === "running" || this.#consumedJobResults.has(jobId)) return false;
		if (job.resultText === undefined && job.errorText === undefined) return false;
		this.#consumedJobResults.add(jobId);
		return true;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(jobId: string): boolean {
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
		this.#consumedJobResults.delete(jobId);
		return this.#jobs.delete(jobId);
	}

	#scheduleEviction(jobId: string): void {
		if (this.#disposed) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await this.#waitForDeliveryQueueChange(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			this.#notifyDeliveryQueueChanged();
			if (this.isDeliverySuppressed(selected.jobId)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		this.#queueDelivery({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			promise: Promise.resolve(),
			ownerId: this.#jobs.get(jobId)?.ownerId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: toError(error).message });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await this.#waitForDeliveryQueueChange(waitMs);
				continue;
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
			void this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				await sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
				this.#consumeJobResult(delivery.jobId);
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = toError(error).message;
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId) && this.#jobs.has(delivery.jobId)) {
					this.#queueDelivery(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	#queueDelivery(delivery: AsyncJobDelivery): void {
		const index = this.#deliveries.findIndex(candidate => candidate.nextAttemptAt > delivery.nextAttemptAt);
		if (index === -1) this.#deliveries.push(delivery);
		else this.#deliveries.splice(index, 0, delivery);
		this.#notifyDeliveryQueueChanged();
	}

	async #waitForDeliveryQueueChange(delayMs: number): Promise<void> {
		const timerElapsed = Promise.withResolvers<void>();
		const timer = setTimeout(timerElapsed.resolve, delayMs);
		timer.unref();
		try {
			await Promise.race([timerElapsed.promise, this.#deliveryQueueChanged.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#notifyDeliveryQueueChanged(): void {
		this.#deliveryQueueChanged.resolve();
		this.#deliveryQueueChanged = Promise.withResolvers<void>();
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
