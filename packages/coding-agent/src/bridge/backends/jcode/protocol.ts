import type { HarnessEvent, HarnessRequest } from "./harness-protocol";

export interface JCodeModelSelection {
	readonly provider?: string;
	readonly model?: string;
}

export type HostToolOutcome =
	| { readonly ok: true; readonly result: unknown; readonly terminal?: boolean }
	| { readonly ok: false; readonly error: string; readonly terminal?: boolean };

export interface HostToolCall {
	readonly sessionId: string;
	readonly callId: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly generation: number;
	readonly signal: AbortSignal;
}

export type HostToolDispatcher = (call: HostToolCall) => Promise<HostToolOutcome>;

export interface JCodeHostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input_schema: unknown;
}

export interface JCodeBackendOptions extends JCodeModelSelection {
	/** Binary for a private harness bridge. Defaults to `jcode`. */
	readonly command?: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Attach to an already-running API bridge over this Unix socket instead of launching one. */
	readonly socketPath?: string;
	/** Named provider profile for the launched instance; defaults to `provider`. */
	readonly providerProfile?: string;
	readonly startupTimeoutMs?: number;
	readonly maxBufferedEvents?: number;
	readonly maxBufferedBytes?: number;
	/** Per-request reply timeout. Defaults to the transport's own default. */
	readonly requestTimeoutMs?: number;
	/** Transport generation. One value per transport lifetime, not per session. */
	readonly generation?: number;
	/** Invoked once when the transport dies outside an explicit close. */
	readonly onTransportDeath?: (error: Error) => void;
	/** Injection seam for tests: supply a connection instead of launching/connecting. */
	readonly connectionFactory?: JCodeConnectionFactory;
	/** Injection seam: override private harness launch. Production default is launchHarness. */
	readonly launchFactory?: (options: JCodeBackendOptions) => Promise<{ readonly socketPath: string; close(): Promise<void> }>;
	/** Injection seam: override Unix-socket open. Production default is openHarnessSocket. */
	readonly openConnection?: (socketPath: string) => Promise<JCodeHarnessConnection>;
	readonly hostTools?: readonly JCodeHostToolDefinition[];
	readonly hostToolDispatcher?: HostToolDispatcher;
}
export interface JCodeSessionSpec extends JCodeModelSelection {
	readonly cwd?: string;
	readonly sessionId?: string;
	readonly resume?: boolean;
	readonly hostTools?: readonly JCodeHostToolDefinition[];
}

export type JCodeSessionState =
	| { readonly kind: "new" }
	| { readonly kind: "starting" }
	| { readonly kind: "running" }
	| { readonly kind: "cancelling" }
	| { readonly kind: "completed"; readonly result: JCodeResult }
	| { readonly kind: "failed"; readonly error: JCodeError }
	| { readonly kind: "disposed" };

export interface JCodeSessionAddress {
	readonly namespace: string;
	readonly host: string;
	readonly process: string;
	readonly backend: "jcode";
	readonly sessionId: string;
	readonly generation: number;
}

export interface JCodeUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly costUsd?: number;
}

export interface JCodeAttribution {
	readonly requestedProvider?: string;
	readonly requestedModel?: string;
	readonly resolvedProvider?: string;
	readonly resolvedModel?: string;
	readonly resolvedModelIsFallback?: boolean;
}

export type JCodeEvent =
	| { readonly kind: "session-created"; readonly address: JCodeSessionAddress }
	| { readonly kind: "status"; readonly status: string; readonly sequence: number; readonly raw?: unknown }
	| { readonly kind: "text-delta"; readonly text: string; readonly sequence: number }
	| { readonly kind: "tool-call"; readonly name: string; readonly status?: string; readonly sequence: number; readonly raw?: unknown }
	| { readonly kind: "usage"; readonly usage: JCodeUsage; readonly sequence: number }
	| { readonly kind: "terminal"; readonly result: JCodeResult; readonly sequence: number }
	| { readonly kind: "error"; readonly error: JCodeError; readonly sequence: number }
	| { readonly kind: "buffer-overflow"; readonly droppedEvents: number; readonly sequence: number };

export interface JCodeResult extends JCodeAttribution {
	readonly sessionId: string;
	readonly output: string;
	readonly stopReason: "completed" | "cancelled" | "failed" | "unknown";
	readonly usage?: JCodeUsage;
	readonly telemetry: JCodeTelemetry;
}

export interface JCodeTelemetry {
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly eventCount: number;
	readonly droppedEventCount: number;
	readonly transport: "harness";
	readonly cancellationRequested: boolean;
	readonly runtimeVersion?: string;
}

export interface JCodeError {
	readonly code: string;
	readonly message: string;
	readonly data?: unknown;
}

/** Narrow connection seam the backend drives; satisfied by HarnessSocketTransport. */
export interface JCodeHarnessConnection {
	request(req: HarnessRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HarnessEvent>;
	onEvent(listener: (event: HarnessEvent) => void): () => void;
	onDeath(listener: (error?: Error) => void): () => void;
	close(): void;
}

export type JCodeConnectionFactory = (options: JCodeBackendOptions) => Promise<JCodeHarnessConnection>;
export interface JCodeSession {
	readonly address: JCodeSessionAddress;
	readonly state: JCodeSessionState;
	readonly events: AsyncIterable<JCodeEvent>;
	prompt(text: string, signal?: AbortSignal): Promise<JCodeResult>;
	cancel(): Promise<void>;
	resume(): Promise<void>;
	dispose(): Promise<void>;
	softInterrupt(content: string, urgent?: boolean): Promise<void>;
	cancelSoftInterrupts(): Promise<void>;
}

export interface JCodeBackend {
	readonly backend: "jcode";
	start(spec: JCodeSessionSpec): Promise<JCodeSession>;
	attach(sessionId: string, spec?: JCodeSessionSpec): Promise<JCodeSession>;
	close(): Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
