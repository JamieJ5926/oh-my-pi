// Explicit codec for the versioned harness NDJSON API (jcode-harness-api crate).
// Wire contract: one JSON object per line; client frames carry `v`, numeric `id`,
// and a `req` discriminator; server frames carry `v`, optional numeric `reply_to`,
// and an `ev` discriminator. Unknown event kinds decode to an explicit `unknown`
// event instead of throwing. No JSON-RPC framing lives here.
//
// This module is intentionally curated to the OMP-consumed protocol subset. The
// exported SUPPORTED_REQUESTS / SUPPORTED_EVENTS lists name that subset so a
// later parity check against the Rust definitions can compare explicitly.

export type HarnessErrorCode =
	| "unsupported_version"
	| "unknown_request"
	| "unknown_session"
	| "invalid_request"
	| "internal";

export type HarnessUnknownErrorCode = `${HarnessErrorCode}` | (string & {});

export interface HarnessHostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly input_schema: unknown;
}

export interface HarnessSessionInfo {
	readonly session_id: string;
	readonly working_dir?: string;
	readonly title?: string;
	readonly status: string;
	readonly transcript_bytes?: number;
	readonly saved?: boolean;
	readonly updated_at_ms?: number;
	readonly last_active_at_ms?: number;
	readonly archived?: boolean;
	readonly archived_at_ms?: number;
}

export type HarnessRequest =
	| { readonly req: "hello"; readonly min_version: number; readonly max_version: number; readonly client: string }
	| {
			readonly req: "create_session";
			readonly working_dir?: string;
			// Absent means the daemon's tool configuration decides; [] means deny all.
			// Callers must preserve this distinction exactly.
			readonly allowed_tools?: readonly string[];
			readonly disabled_tools?: readonly string[];
			readonly host_tools?: readonly HarnessHostToolDefinition[];
		}
	| { readonly req: "attach_session"; readonly session_id: string }
	| { readonly req: "detach_session"; readonly session_id: string }
	| {
			readonly req: "send_message";
			readonly session_id: string;
			readonly content: string;
			readonly images?: readonly (readonly [string, string])[];
			readonly no_reply?: boolean;
		}
	| { readonly req: "cancel"; readonly session_id: string }
	| { readonly req: "soft_interrupt"; readonly session_id: string; readonly content: string; readonly urgent?: boolean }
	| { readonly req: "cancel_soft_interrupts"; readonly session_id: string }
	| {
			readonly req: "host_tool_result";
			readonly session_id: string;
			readonly call_id: string;
			readonly result?: unknown;
			readonly error?: string;
			readonly terminal?: boolean;
		}
	| { readonly req: "ping" };

export type HarnessEvent =
	| { readonly ev: "hello_ok"; readonly version: number; readonly server: string; readonly capabilities?: readonly string[] }
	| { readonly ev: "ok" }
	| { readonly ev: "error"; readonly code: HarnessUnknownErrorCode; readonly message: string }
	| { readonly ev: "attached"; readonly session: HarnessSessionInfo }
	| { readonly ev: "message_accepted"; readonly session_id: string }
	| { readonly ev: "text_delta"; readonly session_id: string; readonly text: string }
	| { readonly ev: "reasoning_delta"; readonly session_id: string; readonly text: string }
	| { readonly ev: "tool_start"; readonly session_id: string; readonly call_id: string; readonly name: string }
	| { readonly ev: "tool_input_delta"; readonly session_id: string; readonly call_id: string; readonly delta: string }
	| { readonly ev: "tool_exec"; readonly session_id: string; readonly call_id: string; readonly name: string }
	| {
			readonly ev: "tool_done";
			readonly session_id: string;
			readonly call_id: string;
			readonly name: string;
			readonly output: string;
			readonly error?: string;
		}
	| { readonly ev: "host_tool_call"; readonly session_id: string; readonly call_id: string; readonly name: string; readonly arguments: unknown }
	| { readonly ev: "token_usage"; readonly session_id: string; readonly input: number; readonly output: number; readonly cache_read_input?: number }
	| { readonly ev: "turn_done"; readonly session_id: string }
	| { readonly ev: "session_status"; readonly session_id: string; readonly status: string }
	| { readonly ev: "connection_phase"; readonly session_id: string; readonly phase: string }
	| {
			readonly ev: "model_info";
			readonly session_id: string;
			readonly provider?: string;
			readonly model?: string;
			readonly reasoning_effort?: string;
		}
	| { readonly ev: "unknown"; readonly raw: Record<string, unknown> };

export type HarnessClientFrame = { readonly v: 1; readonly id: number } & HarnessRequest;

/** `reply_to` is present only on direct replies; streaming events omit it. */
export type HarnessServerFrame = HarnessEvent extends infer Event ? Event extends HarnessEvent ? { readonly v: 1; readonly reply_to?: number } & Event : never : never;

/** Request discriminators OMP actually encodes. */
export const SUPPORTED_REQUESTS: readonly (HarnessRequest["req"])[] = [
	"hello",
	"create_session",
	"attach_session",
	"detach_session",
	"send_message",
	"cancel",
	"soft_interrupt",
	"cancel_soft_interrupts",
	"host_tool_result",
	"ping",
];

/** Event discriminators OMP actually decodes (unknown falls back, not listed). */
export const SUPPORTED_EVENTS: readonly Exclude<HarnessEvent["ev"], "unknown">[] = [
	"hello_ok",
	"ok",
	"error",
	"attached",
	"message_accepted",
	"text_delta",
	"reasoning_delta",
	"tool_start",
	"tool_input_delta",
	"tool_exec",
	"tool_done",
	"host_tool_call",
	"token_usage",
	"turn_done",
	"session_status",
	"connection_phase",
	"model_info",
];

export const HARNESS_PROTOCOL_VERSION = 1;

export class HarnessFrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessFrameError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeUint(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = readString(record, key);
	if (value === undefined) throw new HarnessFrameError(`${context} missing string field "${key}"`);
	return value;
}

function requireSafeUint(record: Record<string, unknown>, key: string, context: string): number {
	const value = record[key];
	if (!isSafeUint(value)) {
		throw new HarnessFrameError(`${context} field "${key}" is not a non-negative safe integer: ${JSON.stringify(value)}`);
	}
	return value;
}

function readSafeUint(record: Record<string, unknown>, key: string, context: string): number | undefined {
	if (!(key in record)) return undefined;
	return requireSafeUint(record, key, context);
}

/** Present-but-absent distinction: undefined only when the key is missing. */
function readStringStrict(record: Record<string, unknown>, key: string, context: string): string | undefined {
	if (!(key in record)) return undefined;
	const value = record[key];
	if (typeof value !== "string") {
		throw new HarnessFrameError(`${context} field "${key}" is present but not a string: ${JSON.stringify(value)}`);
	}
	return value;
}

function readBooleanStrict(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
	if (!(key in record)) return undefined;
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new HarnessFrameError(`${context} field "${key}" is present but not a boolean: ${JSON.stringify(value)}`);
	}
	return value;
}

/** Present keys must be arrays of strings; malformed arrays throw instead of passing through. */
function readStringArray(record: Record<string, unknown>, key: string, context: string): readonly string[] | undefined {
	if (!(key in record)) return undefined;
	const value = record[key];
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
		throw new HarnessFrameError(`${context} field "${key}" is not an array of strings`);
	}
	return value;
}
function requireVersion(record: Record<string, unknown>, context: string): number {
	const value = record.version;
	if (!isVersion(value)) {
		throw new HarnessFrameError(`${context} field "version" is not a positive safe integer: ${JSON.stringify(value)}`);
	}
	return value;
}

function decodeSessionInfo(value: unknown): HarnessSessionInfo {
	if (!isRecord(value)) throw new HarnessFrameError("attached frame has a non-object session");
	const context = "session info";
	const session: HarnessSessionInfo = {
		session_id: requireString(value, "session_id", context),
		status: requireString(value, "status", context),
	};
	const optional = {
		working_dir: readStringStrict(value, "working_dir", context),
		title: readStringStrict(value, "title", context),
		transcript_bytes: readSafeUint(value, "transcript_bytes", context),
		saved: readBooleanStrict(value, "saved", context),
		updated_at_ms: readSafeUint(value, "updated_at_ms", context),
		last_active_at_ms: readSafeUint(value, "last_active_at_ms", context),
		archived: readBooleanStrict(value, "archived", context),
		archived_at_ms: readSafeUint(value, "archived_at_ms", context),
	};
	for (const [key, field] of Object.entries(optional)) {
		if (field !== undefined) Object.assign(session, { [key]: field });
	}
	return session;
}

/** Encode a client frame as one newline-terminated NDJSON line. */
export function encodeClientFrame(id: number, request: HarnessRequest): string {
	if (!isSafeUint(id)) throw new HarnessFrameError(`client frame id must be a non-negative safe integer: ${JSON.stringify(id)}`);
	return `${JSON.stringify({ v: HARNESS_PROTOCOL_VERSION, id, ...request })}\n`;
}

/** Encode a server frame as one newline-terminated NDJSON line. */
export function encodeServerFrame(frame: HarnessServerFrame): string {
	const { v, reply_to, ...event } = frame;
	if (reply_to !== undefined && !isSafeUint(reply_to)) {
		throw new HarnessFrameError(`server frame reply_to must be a non-negative safe integer: ${JSON.stringify(reply_to)}`);
	}
	const wire = reply_to === undefined ? { v, ...event } : { v, reply_to, ...event };
	return `${JSON.stringify(wire)}\n`;
}

/** Decode one NDJSON server line into a validated frame. Throws on malformed input. */
export function decodeServerLine(line: string): HarnessServerFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (err) {
		throw new HarnessFrameError(`invalid JSON in server frame: ${String(err)}`);
	}
	if (!isRecord(value)) throw new HarnessFrameError("server frame is not a JSON object");
	if (value.v !== HARNESS_PROTOCOL_VERSION) {
		throw new HarnessFrameError(`unsupported protocol version: ${JSON.stringify(value.v)}`);
	}
	let reply_to: number | undefined;
	if ("reply_to" in value) {
		reply_to = readSafeUint(value, "reply_to", "server frame");
	}
	const ev = readString(value, "ev");
	if (ev === undefined) throw new HarnessFrameError("server frame missing ev discriminator");
	const base: { v: 1; reply_to?: number } = reply_to === undefined ? { v: 1 } : { v: 1, reply_to };
	const context = `${ev} frame`;
	switch (ev) {
		case "hello_ok":
			return {
				...base,
				ev,
				version: requireVersion(value, context),
				server: requireString(value, "server", context),
				...(readStringArray(value, "capabilities", context) === undefined ? {} : { capabilities: readStringArray(value, "capabilities", context) }),
			};
		case "ok":
			return { ...base, ev };
		case "error":
			return { ...base, ev, code: requireString(value, "code", context), message: requireString(value, "message", context) };
		case "attached":
			return { ...base, ev, session: decodeSessionInfo(value.session) };
		case "message_accepted":
			return { ...base, ev, session_id: requireString(value, "session_id", context) };
		case "text_delta":
		case "reasoning_delta":
			return { ...base, ev, session_id: requireString(value, "session_id", context), text: requireString(value, "text", context) };
		case "tool_start":
		case "tool_exec":
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				call_id: requireString(value, "call_id", context),
				name: requireString(value, "name", context),
			};
		case "tool_input_delta":
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				call_id: requireString(value, "call_id", context),
				delta: requireString(value, "delta", context),
			};
		case "tool_done": {
			const error = readStringStrict(value, "error", context);
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				call_id: requireString(value, "call_id", context),
				name: requireString(value, "name", context),
				output: requireString(value, "output", context),
				...(error === undefined ? {} : { error }),
			};
		}
		case "host_tool_call":
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				call_id: requireString(value, "call_id", context),
				name: requireString(value, "name", context),
				arguments: value.arguments,
			};
		case "token_usage": {
			const cache_read_input = readSafeUint(value, "cache_read_input", context);
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				input: requireSafeUint(value, "input", context),
				output: requireSafeUint(value, "output", context),
				...(cache_read_input === undefined ? {} : { cache_read_input }),
			};
		}
		case "turn_done":
			return { ...base, ev, session_id: requireString(value, "session_id", context) };
		case "session_status":
			return { ...base, ev, session_id: requireString(value, "session_id", context), status: requireString(value, "status", context) };
		case "connection_phase":
			return { ...base, ev, session_id: requireString(value, "session_id", context), phase: requireString(value, "phase", context) };
		case "model_info": {
			const provider = readStringStrict(value, "provider", context);
			const model = readStringStrict(value, "model", context);
			const reasoning_effort = readStringStrict(value, "reasoning_effort", context);
			return {
				...base,
				ev,
				session_id: requireString(value, "session_id", context),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
				...(reasoning_effort === undefined ? {} : { reasoning_effort }),
			};
		}
		default:
			return { ...base, ev: "unknown", raw: value };
	}
}

/**
 * Stateful NDJSON decoder. Feed it arbitrary transport chunks; it buffers partial
 * lines, skips blank lines, and yields decoded frames in order. A single
 * unterminated line is capped at MAX_BUFFERED_LINE_BYTES; exceeding it throws
 * and resets the buffer so a hostile peer cannot grow memory unboundedly.
 */
export class HarnessDecoder {
	static readonly MAX_BUFFERED_LINE_BYTES = 16 * 1024 * 1024;
	#buffer = "";

	push(chunk: string): HarnessServerFrame[] {
		this.#buffer += chunk;
		const frames: HarnessServerFrame[] = [];
		let newline: number;
		while ((newline = this.#buffer.indexOf("\n")) !== -1) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			frames.push(decodeServerLine(line));
		}
		if (this.#buffer.length > HarnessDecoder.MAX_BUFFERED_LINE_BYTES) {
			const size = this.#buffer.length;
			this.#buffer = "";
			throw new HarnessFrameError(
				`unterminated server line exceeds ${HarnessDecoder.MAX_BUFFERED_LINE_BYTES} byte cap (${size} bytes buffered)`,
			);
		}
		return frames;
	}
}
