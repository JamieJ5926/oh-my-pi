const MAX_JSON_BYTES = 2 * 1024 * 1024;

export type PiRequestId = string | number;
export interface PiRpcPromptCommand { readonly type: "prompt"; readonly message: string; readonly id?: PiRequestId }
export interface PiRpcSteerCommand { readonly type: "steer"; readonly message: string; readonly id?: PiRequestId }
export interface PiRpcFollowUpCommand { readonly type: "follow_up"; readonly message: string; readonly id?: PiRequestId }
export interface PiRpcAbortCommand { readonly type: "abort"; readonly id?: PiRequestId }
export interface PiRpcStateCommand { readonly type: "get_state"; readonly id?: PiRequestId }
export interface PiRpcMessagesCommand { readonly type: "get_messages"; readonly id?: PiRequestId }
export interface PiRpcModelCommand { readonly type: "set_model"; readonly provider: string; readonly modelId: string; readonly id?: PiRequestId }
export interface PiRpcNewSessionCommand { readonly type: "new_session"; readonly id?: PiRequestId }
export type PiRpcCommand = PiRpcPromptCommand | PiRpcSteerCommand | PiRpcFollowUpCommand | PiRpcAbortCommand | PiRpcStateCommand | PiRpcMessagesCommand | PiRpcModelCommand | PiRpcNewSessionCommand;
export interface PiRpcResponse { readonly type: "response"; readonly command: string; readonly success: boolean; readonly id?: PiRequestId; readonly error?: string; readonly data?: unknown }
export interface PiSessionEvent { readonly type: "session"; readonly id: string; readonly version?: number; readonly timestamp?: string; readonly cwd?: string; readonly sessionFile?: string }
export interface PiExtensionUIRequest { readonly type: "extension_ui_request"; readonly id: string; readonly method: string; readonly [key: string]: unknown }
export interface PiExtensionError { readonly type: "extension_error"; readonly [key: string]: unknown }
export type PiGenericEventType = `${"agent" | "turn" | "message" | "tool"}_${string}`;
export interface PiGenericEvent { readonly type: PiGenericEventType; readonly [key: string]: unknown }
export type PiRpcEvent = PiRpcResponse | PiSessionEvent | PiExtensionUIRequest | PiExtensionError | PiGenericEvent;

export function encodePiCommand(command: PiRpcCommand): string { return `${JSON.stringify(command)}\n`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringField(record: Record<string, unknown>, key: string): string | undefined { const value = record[key]; return typeof value === "string" ? value : undefined; }
function requestId(value: unknown): PiRequestId | undefined { return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined; }
function isPiGenericEventType(value: string): value is PiGenericEventType { return /^(agent|turn|message|tool)_/.test(value); }

export function parsePiFrame(line: string): PiRpcEvent {
	if (Buffer.byteLength(line, "utf8") > MAX_JSON_BYTES) throw new Error("Pi RPC frame exceeds 2 MiB limit");
	let parsed: unknown;
	try { parsed = JSON.parse(line); } catch (error) { throw new Error(`Invalid Pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`); }
	if (!isRecord(parsed)) throw new Error("Pi RPC frame must be a JSON object");
	const type = stringField(parsed, "type");
	if (!type) throw new Error("Pi RPC frame is missing type");
	if (type === "response") {
		const command = stringField(parsed, "command");
		const success = parsed.success;
		if (!command || typeof success !== "boolean") throw new Error("Invalid Pi RPC response");
		const id = requestId(parsed.id);
		return { type, command, success, ...(id === undefined ? {} : { id }), ...(typeof parsed.error === "string" ? { error: parsed.error } : {}), ...(Object.hasOwn(parsed, "data") ? { data: parsed.data } : {}) };
	}
    if (type === "session") {
        const id = stringField(parsed, "id");
        if (!id) throw new Error("Invalid Pi session event");
        return { type, id, ...(typeof parsed.version === "number" ? { version: parsed.version } : {}), ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}), ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}), ...(typeof parsed.sessionFile === "string" ? { sessionFile: parsed.sessionFile } : {}) };
    }
    if (type === "extension_ui_request") {
        const id = stringField(parsed, "id");
        const method = stringField(parsed, "method");
        if (!id || !method) throw new Error("Invalid Pi extension UI request");
        return { ...parsed, type, id, method };
    }
    if (type === "extension_error") return { ...parsed, type };
    if (!isPiGenericEventType(type)) throw new Error(`Unknown Pi RPC event type: ${type}`);
    return { ...parsed, type };
}

export function frameJsonValue(value: unknown): string {
	const line = JSON.stringify(value);
	if (Buffer.byteLength(line, "utf8") > MAX_JSON_BYTES) throw new Error("Pi RPC frame exceeds 2 MiB limit");
	return line;
}
