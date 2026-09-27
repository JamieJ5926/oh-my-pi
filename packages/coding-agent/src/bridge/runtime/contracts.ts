/** Backend-neutral bridge runtime contracts. Backend wire formats stay behind adapters. */

export type ExecutionBackendName = "pi" | "jcode" | (string & {});
export type ModelFallbackState = "yes" | "no" | "unobserved";

export interface ModelAttribution {
	readonly requestedProvider?: string;
	readonly requestedModel?: string;
	readonly resolvedProvider?: string;
	readonly resolvedModel?: string;
	readonly fallback: ModelFallbackState;
	readonly resolvedModelIsFallback?: boolean;
}

export interface ExecutionRequest {
	readonly executionId?: string;
	readonly backend: ExecutionBackendName;
	readonly sessionId?: string;
	readonly prompt: string;
	readonly provider?: string;
	readonly model?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

export interface ExecutionTelemetry {
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly eventCount: number;
	readonly droppedEventCount: number;
	readonly cancellationRequested: boolean;
	readonly backend: ExecutionBackendName;
}

export type ExecutionEvent =
	| { readonly kind: "started"; readonly executionId: string; readonly sequence: number; readonly attribution: ModelAttribution }
	| { readonly kind: "text-delta"; readonly executionId: string; readonly sequence: number; readonly text: string; readonly attribution: ModelAttribution }
	| { readonly kind: "tool-call"; readonly executionId: string; readonly sequence: number; readonly name: string; readonly status?: string; readonly attribution: ModelAttribution }
	| { readonly kind: "usage"; readonly executionId: string; readonly sequence: number; readonly usage: ExecutionUsage; readonly attribution: ModelAttribution }
	| { readonly kind: "terminal"; readonly executionId: string; readonly sequence: number; readonly result: ExecutionResult }
	| { readonly kind: "error"; readonly executionId: string; readonly sequence: number; readonly code: string; readonly message: string; readonly attribution: ModelAttribution }
	| { readonly kind: "overflow"; readonly executionId: string; readonly sequence: number; readonly droppedEvents: number; readonly droppedBytes: number };

export type ExecutionStopReason = "completed" | "cancelled" | "failed" | "overflow";

export interface ExecutionResult {
	readonly executionId: string;
	readonly sessionId?: string;
	readonly output: string;
	readonly outputBytes: number;
	readonly stopReason: ExecutionStopReason;
	readonly attribution: ModelAttribution;
	readonly usage?: ExecutionUsage;
	readonly telemetry: ExecutionTelemetry;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface ExecutionSession {
	readonly events: AsyncIterable<ExecutionEvent>;
	readonly result: Promise<ExecutionResult>;
	cancel(reason?: string): Promise<void>;
	resume(): Promise<ExecutionSession>;
	dispose?(): Promise<void>;
	softInterrupt?(content: string, urgent?: boolean): Promise<void>;
	cancelSoftInterrupts?(): Promise<void>;
}

export interface ExecutionBackendFactory {
	readonly backend: ExecutionBackendName;
	start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionSession>;
	close?(): Promise<void>;
}


export interface AdmissionRequest {
	readonly executionId: string;
	readonly backend: ExecutionBackendName;
	readonly requestBytes: number;
	readonly signal: AbortSignal;
}

export interface AdmissionGrant {
	readonly leaseId: string;
	readonly owner?: string;
}

/** OMP supplies these hooks; the runtime never creates a competing scheduler. */
export interface OmpAdmissionHooks {
	admit(request: AdmissionRequest): Promise<AdmissionGrant>;
	release?(grant: AdmissionGrant): Promise<void> | void;
}

export type ExecutionLifecycle =
	| { readonly kind: "queued"; readonly executionId: string }
	| { readonly kind: "admitted"; readonly executionId: string; readonly leaseId: string }
	| { readonly kind: "running"; readonly executionId: string; readonly leaseId: string }
	| { readonly kind: "terminal"; readonly executionId: string; readonly result: ExecutionResult }
	| { readonly kind: "overflow"; readonly executionId: string; readonly message: string };

export interface ExecutionHandle {
	readonly executionId: string;
	readonly events: AsyncIterable<ExecutionEvent>;
	readonly result: Promise<ExecutionResult>;
	readonly state: () => ExecutionLifecycle;
	cancel(reason?: string): Promise<void>;
	resume(): Promise<ExecutionHandle>;
}

export function modelAttribution(request: ExecutionRequest, resolved?: Partial<ModelAttribution>): ModelAttribution {
	const requestedProvider = resolved?.requestedProvider ?? request.provider;
	const requestedModel = resolved?.requestedModel ?? request.model;
	return {
		requestedProvider,
		requestedModel,
		resolvedProvider: resolved?.resolvedProvider,
		resolvedModel: resolved?.resolvedModel,
		fallback: resolved?.fallback ?? "unobserved",
		...(resolved?.resolvedModelIsFallback === undefined ? {} : { resolvedModelIsFallback: resolved.resolvedModelIsFallback }),
	};
}

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** Truncate by UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly bytes: number; readonly truncated: boolean } {
	if (maxBytes < 0 || !Number.isSafeInteger(maxBytes)) throw new Error("maxBytes must be a non-negative safe integer");
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return { value, bytes: encoded.byteLength, truncated: false };
	let end = Math.min(maxBytes, encoded.byteLength);
	while (end > 0 && end < encoded.byteLength && (encoded[end] & 0xc0) === 0x80) end -= 1;
	const result = new TextDecoder().decode(encoded.subarray(0, end));
	return { value: result, bytes: end, truncated: true };
}
