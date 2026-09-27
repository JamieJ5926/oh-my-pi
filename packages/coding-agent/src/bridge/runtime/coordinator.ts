import type {
    ExecutionBackendFactory,
    ExecutionEvent,
    ExecutionHandle,
    ExecutionLifecycle,
    ExecutionRequest,
    ExecutionResult,
    ExecutionSession,
    ModelAttribution,
    OmpAdmissionHooks,
} from "./contracts";
import { modelAttribution, truncateUtf8, utf8ByteLength } from "./contracts";
import { ResourceAdmissionController } from "./resource-policy";
import type { ResourcePolicy } from "./resource-policy";

export interface ExecutionBackendRegistry {
	get(backend: string): ExecutionBackendFactory | undefined;
}

export interface ExecutionCoordinatorOptions {
	readonly policy: ResourcePolicy;
	readonly admission: OmpAdmissionHooks;
	readonly backends: ExecutionBackendRegistry;
	readonly now?: () => number;
	readonly id?: () => string;
}

interface EventQueue {
	readonly values: AsyncIterable<ExecutionEvent>;
	push(event: ExecutionEvent): void;
	close(): void;
}

function createEventQueue(maxEvents: number, maxBytes: number): EventQueue {
	const buffered: ExecutionEvent[] = [];
	const waiters: Array<(result: IteratorResult<ExecutionEvent>) => void> = [];
	let bufferedBytes = 0;
	let closed = false;
	const values: AsyncIterable<ExecutionEvent> = {
		[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
			return {
				next: async () => {
					if (buffered.length > 0) {
						const event = buffered.shift() as ExecutionEvent;
						bufferedBytes -= utf8ByteLength(JSON.stringify(event));
						return { done: false, value: event };
					}
					if (closed) return { done: true, value: undefined };
					return await new Promise<IteratorResult<ExecutionEvent>>(resolve => waiters.push(resolve));
				},
			};
		},
	};
	return {
		values,
		push(event) {
			if (closed) return;
			const bytes = utf8ByteLength(JSON.stringify(event));
			if (bytes > maxBytes || buffered.length >= maxEvents || bufferedBytes + bytes > maxBytes) return;
			const waiter = waiters.shift();
			if (waiter) waiter({ done: false, value: event });
			else {
				buffered.push(event);
				bufferedBytes += bytes;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
		},
	};
}

function defaultId(): string {
	return `execution-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorResult(request: ExecutionRequest, executionId: string, startedAt: number, reason: "cancelled" | "failed" | "overflow", error: unknown, now: () => number, attribution: ModelAttribution): ExecutionResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		executionId,
		sessionId: request.sessionId,
		output: "",
		outputBytes: 0,
		stopReason: reason,
		attribution,
		telemetry: { startedAt, finishedAt: now(), eventCount: 0, droppedEventCount: 0, cancellationRequested: reason === "cancelled", backend: request.backend },
		error: { code: reason === "cancelled" ? "CANCELLED" : reason === "overflow" ? "RESULT_OVERFLOW" : "EXECUTION_FAILED", message },
	};
}

class CoordinatorHandle implements ExecutionHandle {
	readonly #executionId: string;
	readonly #events: EventQueue;
	readonly #result: Promise<ExecutionResult>;
	readonly #resolveResult: (result: ExecutionResult) => void;
	readonly #coordinator: ExecutionCoordinator;
	readonly #request: ExecutionRequest;
	#lifecycle: ExecutionLifecycle;
	#cancel: ((reason?: string) => Promise<void>) | undefined;
	#resume: (() => Promise<ExecutionHandle>) | undefined;

	constructor(coordinator: ExecutionCoordinator, request: ExecutionRequest, executionId: string, queue: EventQueue) {
		this.#coordinator = coordinator;
		this.#request = request;
		this.#executionId = executionId;
		this.#events = queue;
		this.#lifecycle = { kind: "queued", executionId };
		const resultPromise = Promise.withResolvers<ExecutionResult>();
		this.#result = resultPromise.promise;
		this.#resolveResult = resultPromise.resolve;
	}
	get executionId(): string { return this.#executionId; }
	get events(): AsyncIterable<ExecutionEvent> { return this.#events.values; }
	get result(): Promise<ExecutionResult> { return this.#result; }
	state(): ExecutionLifecycle { return this.#lifecycle; }
	cancel(reason?: string): Promise<void> { return this.#cancel?.(reason) ?? Promise.resolve(); }
	resume(): Promise<ExecutionHandle> { return this.#resume?.() ?? Promise.reject(new Error("Execution has not started")); }
	setLifecycle(lifecycle: ExecutionLifecycle): void { this.#lifecycle = lifecycle; }
	setCancel(cancel: (reason?: string) => Promise<void>): void { this.#cancel = cancel; }
	setResume(resume: () => Promise<ExecutionHandle>): void { this.#resume = resume; }
	resolve(result: ExecutionResult): void { this.#resolveResult(result); this.#events.close(); }
	request(): ExecutionRequest { return this.#request; }
	coordinator(): ExecutionCoordinator { return this.#coordinator; }
}

export class ExecutionCoordinator {
	readonly #resources: ResourceAdmissionController;
	readonly #admission: OmpAdmissionHooks;
	readonly #backends: ExecutionBackendRegistry;
	readonly #now: () => number;
	readonly #id: () => string;

	constructor(options: ExecutionCoordinatorOptions) {
		this.#resources = new ResourceAdmissionController(options.policy);
		this.#admission = options.admission;
		this.#backends = options.backends;
		this.#now = options.now ?? Date.now;
		this.#id = options.id ?? defaultId;
	}

	get resources(): ResourceAdmissionController { return this.#resources; }
	get snapshot() { return this.#resources.snapshot(); }

    execute(request: ExecutionRequest): ExecutionHandle {
        return this.#execute(request, async signal => {
            const factory = this.#backends.get(request.backend);
            if (!factory) throw new Error(`No execution backend registered for ${request.backend}`);
            return factory.start(request, signal);
        });
    }

    #execute(request: ExecutionRequest, acquireSession: (signal: AbortSignal) => Promise<ExecutionSession>): ExecutionHandle {
        const executionId = request.executionId ?? this.#id();
        const queue = createEventQueue(this.#resources.policy.maxEventsPerExecution, this.#resources.policy.maxEventBytes);
        const handle = new CoordinatorHandle(this, request, executionId, queue);
        const abortController = new AbortController();
        let session: ExecutionSession | undefined;
        let grant: { readonly leaseId: string; readonly owner?: string } | undefined;
        let cancellationRequested = false;
        let cancellationReason = "cancelled";
        const startedAt = this.#now();
        const attribution = modelAttribution(request);
        const reservation = this.#resources.admit(executionId, utf8ByteLength(request.prompt));
        if (reservation.kind === "rejected") {
            const result = errorResult(request, executionId, startedAt, "failed", `Admission rejected: ${reservation.reason}`, this.#now, attribution);
            handle.setLifecycle({ kind: "terminal", executionId, result });
            handle.resolve(result);
            return handle;
        }
        const settle = async (result: ExecutionResult): Promise<void> => {
            if (grant) await this.#admission.release?.(grant);
            handle.setLifecycle({ kind: "terminal", executionId, result });
            handle.resolve(result);
        };
        handle.setCancel(async (reason = "cancelled") => {
            cancellationRequested = true;
            cancellationReason = reason;
            abortController.abort(reason);
            if (session) await session.cancel(reason);
            else if (reservation.kind === "queued" || reservation.kind === "admitted") {
                this.#resources.transition({ kind: "cancelled", id: executionId });
                await settle(errorResult(request, executionId, startedAt, "cancelled", reason, this.#now, attribution));
            }
        });
        handle.setResume(async () => {
            if (session) return this.#startResumed(request, executionId, session);
            throw new Error("Execution cannot resume before backend start");
        });
        void (async () => {
            try {
                grant = await this.#admission.admit({ executionId, backend: request.backend, requestBytes: utf8ByteLength(request.prompt), signal: abortController.signal });
                if (cancellationRequested) {
                    this.#resources.transition({ kind: "cancelled", id: executionId });
                    await settle(errorResult(request, executionId, startedAt, "cancelled", cancellationReason, this.#now, attribution));
                    return;
                }
                this.#resources.transition({ kind: "admitted", id: executionId });
                handle.setLifecycle({ kind: "admitted", executionId, leaseId: grant.leaseId });
                session = await acquireSession(abortController.signal);
                this.#resources.transition({ kind: "running", id: executionId });
                handle.setLifecycle({ kind: "running", executionId, leaseId: grant.leaseId });
                const outputParts: string[] = [];
                let eventCount = 0;
                let droppedEventCount = 0;
                let usage: ExecutionResult["usage"];
                let terminal: ExecutionResult | undefined;
                for await (const event of session.events) {
                    eventCount++;
                    if (event.kind === "text-delta") outputParts.push(event.text);
                    if (event.kind === "usage") usage = event.usage;
                    if (event.kind === "overflow") droppedEventCount += event.droppedEvents;
                    queue.push(event);
                    if (event.kind === "terminal") terminal = event.result;
                }
                const backendResult = terminal ?? await session.result;
                const rawOutput = outputParts.length > 0 ? outputParts.join("") : backendResult.output;
                const bounded = truncateUtf8(rawOutput, this.#resources.policy.maxResultBytes);
                const result: ExecutionResult = {
                    ...backendResult,
                    executionId,
                    output: bounded.value,
                    outputBytes: bounded.bytes,
                    stopReason: bounded.truncated ? "overflow" : cancellationRequested ? "cancelled" : backendResult.stopReason,
                    attribution: backendResult.attribution ?? attribution,
                    usage: usage ?? backendResult.usage,
                    telemetry: { ...backendResult.telemetry, eventCount, droppedEventCount, cancellationRequested, finishedAt: this.#now() },
                };
                if (bounded.truncated) this.#resources.transition({ kind: "overflow", id: executionId, droppedBytes: utf8ByteLength(rawOutput) - bounded.bytes });
                else this.#resources.transition({ kind: "terminal", id: executionId, resultBytes: bounded.bytes });
                await settle(result);
            } catch (error) {
                if (grant) this.#resources.transition({ kind: "terminal", id: executionId, resultBytes: 0 });
                await settle(errorResult(request, executionId, startedAt, cancellationRequested ? "cancelled" : "failed", error, this.#now, attribution));
            }
        })();
        return handle;
    }

    #startResumed(request: ExecutionRequest, executionId: string, session: ExecutionSession): ExecutionHandle {
        return this.#execute({ ...request, executionId: `${executionId}:resume`, sessionId: request.sessionId }, () => session.resume());
    }
}
