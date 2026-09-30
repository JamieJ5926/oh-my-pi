import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type ArtifactCheck =
	| { kind: "self-json-pointer"; pointer: string; equals?: unknown }
	| { kind: "read" }
	| { kind: "sha256"; digest: string };

export type Artifact = {
	locator: string;
	claim: string;
	check: ArtifactCheck;
};

export type ParsedDelegatedResult = {
	status: string;
	normalizedStatus: string;
	artifacts: unknown;
	payload: unknown;
	routing: unknown;
};

export type RoutingFallback =
	| { state: "used"; from: string; to: string; evidence: string }
	| { state: "not-observed"; observationSource: string }
	| { state: "unknown"; reason: string };

export type RoutingEvidence = {
	resolvedModel: string;
	fallback: RoutingFallback;
};

export type ObservedRouting = {
	models: readonly string[];
};

export type RoutingFailure = {
	reason: string;
	field: string;
};

export type TerminalOutcome = "PASS" | "ISSUES" | "BLOCKED" | "CANCELLED" | "ABORTED" | "TIMED_OUT";

export type TerminalInitiator =
	| { kind: "explicit-parent"; evidence: string }
	| { kind: "runtime"; evidence: string }
	| { kind: "unknown"; evidence: string };

export type TerminalRecord = {
	recordId: string;
	taskRef: string;
	outcome: TerminalOutcome;
	observedAt: string;
	initiator: TerminalInitiator;
	reason: string;
	lastCheckpoint: string | null;
	partialArtifacts: readonly string[];
};

export type TerminalRecordFailure = {
	reason: string;
	field: string;
};

export const FORBIDDEN_CALLER_PHRASE = "Cancelled by caller";
export const NEUTRAL_CANCEL_UNKNOWN =
	"cancellation was observed and initiator is unknown";
export const NEUTRAL_CANCEL_EXPLICIT =
	"explicit parent-session cancel was observed";
export const TERMINAL_RECORD_WRITE_FAILED = "terminal-record-write: failed";
export type ValidationFailure = {
	reason: string;
	index: number;
	field: string;
};

export type ValidationResult =
	| { ok: true }
	| { ok: false; failure: ValidationFailure; failures: ValidationFailure[] };

export const LEGAL_FALLBACK_STATES = "used, not-observed, unknown";
const LEGAL_FALLBACK_HINT = `legal fallback states: ${LEGAL_FALLBACK_STATES} (never none)`;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeStatus(value: string): string {
	return value.trim().toLowerCase();
}

const PORTABLE_TERMINAL: Record<string, true> = {
	pass: true,
	success: true,
	issues: true,
	blocked: true,
	cancelled: true,
	aborted: true,
	timed_out: true,
};

const ADAPTER_TERMINAL: Record<string, true> = {
	finished: true,
	blocker: true,
	"decision-needed": true,
};

export function isTerminalStatus(status: string): boolean {
	const normalized = normalizeStatus(status);
	return PORTABLE_TERMINAL[normalized] === true || ADAPTER_TERMINAL[normalized] === true;
}

function routingFrom(input: unknown): unknown {
	const object = record(input);
	if (!object) return undefined;
	if (object.routing !== undefined) return object.routing;
	const result = record(object.result);
	if (result?.routing !== undefined) return result.routing;
	const data = record(result?.data);
	if (data?.routing !== undefined) return data.routing;
	const error = record(result?.error);
	return error?.routing;
}

export function isSuccessStatus(status: string): boolean {
	const normalized = normalizeStatus(status);
	return normalized === "pass" || normalized === "success";
}

export function extractStatus(input: unknown): string {
	const object = record(input);
	if (!object) return "";
	const direct = stringValue(object.status);
	if (direct) return direct;
	const result = record(object.result);
	if (!result) return "";
	const resultStatus = stringValue(result.status);
	if (resultStatus) return resultStatus;
	const data = record(result.data);
	const dataStatus = stringValue(data?.status);
	if (dataStatus) return dataStatus;
	const error = record(result.error);
	return stringValue(error?.status);
}

function resultPayload(input: unknown): unknown {
	const object = record(input);
	if (!object) return input;
	const result = record(object.result);
	if (result?.data !== undefined) return result.data;
	if (object.result !== undefined) return object.result;
	if (object.data !== undefined) return object.data;
	return object;
}

function artifactsFrom(input: unknown): unknown {
	const object = record(input);
	if (!object) return undefined;
	if (object.artifacts !== undefined) return object.artifacts;
	const result = record(object.result);
	if (result?.artifacts !== undefined) return result.artifacts;
	const data = record(result?.data);
	if (data?.artifacts !== undefined) return data.artifacts;
	const error = record(result?.error);
	return error?.artifacts;
}

export function parseDelegatedResult(input: unknown): ParsedDelegatedResult {
	const status = extractStatus(input);
	return {
		status,
		normalizedStatus: normalizeStatus(status),
		artifacts: artifactsFrom(input),
		payload: resultPayload(input),
		routing: routingFrom(input),
	};
}


function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function jsonPointer(document: unknown, pointer: string): { found: boolean; value: unknown } {
	if (pointer === "") return { found: true, value: document };
	if (!pointer.startsWith("/")) return { found: false, value: undefined };
	let current: unknown = document;
	for (const raw of pointer.slice(1).split("/")) {
		const token = decodePointerToken(raw);
		if (Array.isArray(current)) {
			if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false, value: undefined };
			const index = Number(token);
			if (index >= current.length) return { found: false, value: undefined };
			current = current[index];
			continue;
		}
		const object = record(current);
		if (!object || !(token in object)) return { found: false, value: undefined };
		current = object[token];
	}
	return { found: true, value: current };
}

function parseCheckFailures(value: unknown, index: number): {
	check?: ArtifactCheck;
	failures: ValidationFailure[];
} {
	const object = record(value);
	if (!object) {
		return {
			failures: [
				{ reason: `artifacts[${index}].check must be a discriminated object`, index, field: "check" },
			],
		};
	}
	const kind = stringValue(object.kind);
	if (kind === "self-json-pointer") {
		const pointer = stringValue(object.pointer);
		if (!pointer) {
			return {
				failures: [
					{ reason: `artifacts[${index}].check.pointer is required`, index, field: "check.pointer" },
				],
			};
		}
		const check: ArtifactCheck = { kind: "self-json-pointer", pointer };
		if ("equals" in object) check.equals = object.equals;
		return { check, failures: [] };
	}
	if (kind === "read") return { check: { kind: "read" }, failures: [] };
	if (kind === "sha256") {
		const digest = stringValue(object.digest);
		if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
			return {
				failures: [
					{ reason: `artifacts[${index}].check.digest must be 64 hex chars`, index, field: "check.digest" },
				],
			};
		}
		return { check: { kind: "sha256", digest: digest.toLowerCase() }, failures: [] };
	}
	return {
		failures: [
			{
				reason: `artifacts[${index}].check.kind is unsupported`,
				index,
				field: "check.kind",
			},
		],
	};
}

function parseCheck(value: unknown, index: number): ArtifactCheck | ValidationFailure {
	const parsed = parseCheckFailures(value, index);
	if (!parsed.check) return parsed.failures[0]!;
	return parsed.check;
}

function parseArtifactFailures(value: unknown, index: number): {
	artifact?: Artifact;
	failures: ValidationFailure[];
} {
	const failures: ValidationFailure[] = [];
	const object = record(value);
	if (!object) {
		return {
			failures: [{ reason: `artifacts[${index}] must be an object`, index, field: "artifacts" }],
		};
	}
	const locator = stringValue(object.locator);
	if (!locator) {
		failures.push({ reason: `artifacts[${index}].locator is empty`, index, field: "locator" });
	}
	const claim = stringValue(object.claim);
	if (!claim) {
		failures.push({ reason: `artifacts[${index}].claim is empty`, index, field: "claim" });
	}
	const parsedCheck = parseCheckFailures(object.check, index);
	failures.push(...parsedCheck.failures);
	if (failures.length > 0 || !parsedCheck.check || !locator || !claim) {
		return { failures };
	}
	return { artifact: { locator, claim, check: parsedCheck.check }, failures };
}

function parseArtifact(value: unknown, index: number): Artifact | ValidationFailure {
	const parsed = parseArtifactFailures(value, index);
	if (!parsed.artifact) return parsed.failures[0]!;
	return parsed.artifact;
}

function isLocalFileLocator(locator: string): boolean {
	if (locator === "result:self") return false;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(locator) && !locator.startsWith("file:")) return false;
	return true;
}

function fileBytes(locator: string): Buffer | undefined {
	const path = locator.startsWith("file:") ? locator.slice("file:".length) : locator;
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
}

function evaluateCheck(artifact: Artifact, index: number, payload: unknown): ValidationFailure | undefined {
	const { locator, check } = artifact;
	if (check.kind === "self-json-pointer") {
		if (locator !== "result:self") {
			return {
				reason: `artifacts[${index}].locator must be result:self for self-json-pointer`,
				index,
				field: "locator",
			};
		}
		const selected = jsonPointer(payload, check.pointer);
		if (!selected.found) {
			return {
				reason: `artifacts[${index}].check.pointer did not resolve`,
				index,
				field: "check.pointer",
			};
		}
		if ("equals" in check && JSON.stringify(selected.value) !== JSON.stringify(check.equals)) {
			return {
				reason: `artifacts[${index}].check.equals did not match`,
				index,
				field: "check.equals",
			};
		}
		return undefined;
	}
	if (locator === "result:self") {
		return {
			reason: `artifacts[${index}].locator result:self requires self-json-pointer`,
			index,
			field: "check.kind",
		};
	}
	if (isLocalFileLocator(locator)) {
		const bytes = fileBytes(locator);
		if (!bytes) {
			return { reason: `artifacts[${index}].locator does not exist`, index, field: "locator" };
		}
		if (check.kind === "sha256") {
			const actual = createHash("sha256").update(bytes).digest("hex");
			if (actual !== check.digest) {
				return { reason: `artifacts[${index}].check.digest does not match`, index, field: "check.digest" };
			}
		}
		return undefined;
	}
	return undefined;
}

export function validateSuccessArtifacts(input: unknown): ValidationResult {
	const parsed = parseDelegatedResult(input);
	if (!isSuccessStatus(parsed.status)) return { ok: true };
	if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
		const failure = { reason: "artifacts must be a non-empty array", index: 0, field: "artifacts" };
		return { ok: false, failure, failures: [failure] };
	}
	const failures: ValidationFailure[] = [];
	for (let index = 0; index < parsed.artifacts.length; index++) {
		const parsedArtifact = parseArtifactFailures(parsed.artifacts[index], index);
		failures.push(...parsedArtifact.failures);
		if (parsedArtifact.artifact) {
			const failure = evaluateCheck(parsedArtifact.artifact, index, parsed.payload);
			if (failure) failures.push(failure);
		}
	}
	if (failures.length === 0) return { ok: true };
	return { ok: false, failure: failures[0]!, failures };
}

export function formatArtifactFailure(failure: ValidationFailure): string {
	return `${failure.reason} (artifact ${failure.index}, field ${failure.field})`;
}

export function formatContractBlockReason(parts: string[]): string | undefined {
	if (parts.length === 0) return undefined;
	return `contract: ${parts.join("; ")}`;
}

export function shouldBlockSuccessArtifacts(input: unknown, isLane: boolean): string | undefined {
	if (!isLane) return undefined;
	const parsed = parseDelegatedResult(input);
	if (!isSuccessStatus(parsed.status)) return undefined;
	const result = validateSuccessArtifacts(input);
	if (result.ok) return undefined;
	return formatContractBlockReason(result.failures.map(formatArtifactFailure));
}

function parseFallbackFailures(value: unknown): {
	fallback?: RoutingFallback;
	failures: RoutingFailure[];
} {
	const object = record(value);
	if (!object) {
		return {
			failures: [
				{
					reason: `routing.fallback must be a discriminated object; ${LEGAL_FALLBACK_HINT}`,
					field: "routing.fallback",
				},
			],
		};
	}
	const state = stringValue(object.state);
	if (state === "none") {
		return {
			failures: [
				{
					reason: `routing.fallback.state none is forbidden; ${LEGAL_FALLBACK_HINT}`,
					field: "routing.fallback.state",
				},
			],
		};
	}
	if (state === "used") {
		const from = stringValue(object.from);
		const to = stringValue(object.to);
		const evidence = stringValue(object.evidence);
		const failures: RoutingFailure[] = [];
		if (!from) failures.push({ reason: "routing.fallback.from is empty", field: "routing.fallback.from" });
		if (!to) failures.push({ reason: "routing.fallback.to is empty", field: "routing.fallback.to" });
		if (!evidence) {
			failures.push({ reason: "routing.fallback.evidence is empty", field: "routing.fallback.evidence" });
		}
		if (failures.length > 0) return { failures };
		return { fallback: { state: "used", from, to, evidence }, failures };
	}
	if (state === "not-observed") {
		const observationSource = stringValue(object.observationSource);
		if (!observationSource) {
			return {
				failures: [
					{
						reason: "routing.fallback.observationSource is empty",
						field: "routing.fallback.observationSource",
					},
				],
			};
		}
		return { fallback: { state: "not-observed", observationSource }, failures: [] };
	}
	if (state === "unknown") {
		const reason = stringValue(object.reason);
		if (!reason) {
			return { failures: [{ reason: "routing.fallback.reason is empty", field: "routing.fallback.reason" }] };
		}
		return { fallback: { state: "unknown", reason }, failures: [] };
	}
	return {
		failures: [
			{
				reason: `routing.fallback.state is unsupported; ${LEGAL_FALLBACK_HINT}`,
				field: "routing.fallback.state",
			},
		],
	};
}

function parseFallback(value: unknown): RoutingFallback | RoutingFailure {
	const parsed = parseFallbackFailures(value);
	if (!parsed.fallback) return parsed.failures[0]!;
	return parsed.fallback;
}

function isRoutingFailure(value: RoutingEvidence | RoutingFailure): value is RoutingFailure {
	return !("resolvedModel" in value);
}

export function parseRoutingFailures(value: unknown): {
	evidence?: RoutingEvidence;
	failures: RoutingFailure[];
} {
	const object = record(value);
	if (!object) {
		return {
			failures: [
				{
					reason: `routing must be an object; ${LEGAL_FALLBACK_HINT}`,
					field: "routing",
				},
			],
		};
	}
	const failures: RoutingFailure[] = [];
	const resolvedModel = stringValue(object.resolvedModel);
	if (!resolvedModel) {
		failures.push({
			reason: `routing.resolvedModel is empty; ${LEGAL_FALLBACK_HINT}`,
			field: "routing.resolvedModel",
		});
	}
	const parsedFallback = parseFallbackFailures(object.fallback);
	failures.push(...parsedFallback.failures);
	if (failures.length > 0 || !parsedFallback.fallback || !resolvedModel) {
		return { failures };
	}
	return { evidence: { resolvedModel, fallback: parsedFallback.fallback }, failures };
}

export function parseRouting(value: unknown): RoutingEvidence | RoutingFailure {
	const parsed = parseRoutingFailures(value);
	if (!parsed.evidence) return parsed.failures[0]!;
	return parsed.evidence;
}

export type RoutingValidationResult =
	| { ok: true }
	| { ok: false; failure: RoutingFailure; failures: RoutingFailure[] };

export function validateTerminalRouting(
	input: unknown,
	observed: ObservedRouting,
): RoutingValidationResult {
	const parsed = parseDelegatedResult(input);
	if (!isTerminalStatus(parsed.status)) return { ok: true };
	const parsedRouting = parseRoutingFailures(parsed.routing);
	const failures: RoutingFailure[] = [...parsedRouting.failures];
	if (parsedRouting.evidence) {
		const evidence = parsedRouting.evidence;
		const models = observed.models;
		const latest = models.length > 0 ? models[models.length - 1] : undefined;
		if (latest !== undefined && evidence.resolvedModel !== latest) {
			failures.push({
				reason: `routing.resolvedModel does not match latest observed model ${latest}`,
				field: "routing.resolvedModel",
			});
		}
		const distinct = distinctObservedModels(models);
		if (distinct.length >= 2) {
			if (evidence.fallback.state !== "used") {
				failures.push({
					reason: "observed model switch requires routing.fallback.state used",
					field: "routing.fallback.state",
				});
			} else {
				const first = distinct[0];
				const last = distinct[distinct.length - 1];
				if (evidence.fallback.from !== first || evidence.fallback.to !== last) {
					failures.push({
						reason: `routing.fallback endpoints must match observed ${first} -> ${last}`,
						field: "routing.fallback",
					});
				}
			}
		} else if (distinct.length === 1) {
			if (evidence.fallback.state !== "not-observed") {
				failures.push({
					reason: "single observed model requires routing.fallback.state not-observed",
					field: "routing.fallback.state",
				});
			}
		} else if (evidence.fallback.state !== "unknown") {
			failures.push({
				reason: "no observed model requires routing.fallback.state unknown",
				field: "routing.fallback.state",
			});
		}
	}
	if (failures.length === 0) return { ok: true };
	return { ok: false, failure: failures[0]!, failures };
}

export function formatRoutingFailure(failure: RoutingFailure): string {
	return `${failure.reason} (field ${failure.field})`;
}

export function shouldBlockTerminalRouting(
	input: unknown,
	isLane: boolean,
	observed: ObservedRouting,
): string | undefined {
	if (!isLane) return undefined;
	const parsed = parseDelegatedResult(input);
	if (!isTerminalStatus(parsed.status)) return undefined;
	const result = validateTerminalRouting(input, observed);
	if (result.ok) return undefined;
	return formatContractBlockReason(result.failures.map(formatRoutingFailure));
}

export function shouldBlockTerminalContract(
	input: unknown,
	isLane: boolean,
	observed: ObservedRouting,
): string | undefined {
	if (!isLane) return undefined;
	const parsed = parseDelegatedResult(input);
	const parts: string[] = [];
	if (isSuccessStatus(parsed.status)) {
		const artifacts = validateSuccessArtifacts(input);
		if (!artifacts.ok) parts.push(...artifacts.failures.map(formatArtifactFailure));
	}
	if (isTerminalStatus(parsed.status)) {
		const routing = validateTerminalRouting(input, observed);
		if (!routing.ok) parts.push(...routing.failures.map(formatRoutingFailure));
	}
	return formatContractBlockReason(parts);
}

export function distinctObservedModels(models: readonly string[]): string[] {
	const seen: string[] = [];
	for (const model of models) {
		const value = stringValue(model);
		if (!value) continue;
		if (!seen.includes(value)) seen.push(value);
	}
	return seen;
}

/** Replicates routing-info.ts modelString without importing that hook. */
export function modelString(model: unknown): string | undefined {
	if (typeof model === "string" && model.length > 0) return model;
	if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
	const object = model as Record<string, unknown>;
	const provider = typeof object.provider === "string" ? object.provider : undefined;
	const id = typeof object.id === "string" ? object.id : undefined;
	if (provider && id && id.length > 0) return `${provider}/${id}`;
	if (id && id.length > 0) return id;
	return undefined;
}

const TERMINAL_OUTCOMES: Record<string, TerminalOutcome> = {
	pass: "PASS",
	success: "PASS",
	issues: "ISSUES",
	blocked: "BLOCKED",
	cancelled: "CANCELLED",
	aborted: "ABORTED",
	timed_out: "TIMED_OUT",
};

function parseInitiator(value: unknown): TerminalInitiator | TerminalRecordFailure {
	const object = record(value);
	if (!object) return { reason: "initiator must be a discriminated object", field: "initiator" };
	const kind = stringValue(object.kind);
	const evidence = stringValue(object.evidence);
	if (!evidence) return { reason: "initiator.evidence is empty", field: "initiator.evidence" };
	if (kind === "explicit-parent" || kind === "runtime" || kind === "unknown") {
		return { kind, evidence };
	}
	return { reason: "initiator.kind is unsupported", field: "initiator.kind" };
}

export function parseTerminalRecord(value: unknown): TerminalRecord | TerminalRecordFailure {
	const object = record(value);
	if (!object) return { reason: "terminal record must be an object", field: "record" };
	const recordId = stringValue(object.recordId);
	if (!recordId) return { reason: "recordId is empty", field: "recordId" };
	const taskRef = stringValue(object.taskRef);
	if (!taskRef) return { reason: "taskRef is empty", field: "taskRef" };
	const outcomeKey = normalizeStatus(stringValue(object.outcome));
	const outcome = TERMINAL_OUTCOMES[outcomeKey];
	if (!outcome) return { reason: "outcome is unsupported", field: "outcome" };
	const observedAt = stringValue(object.observedAt);
	if (!observedAt) return { reason: "observedAt is empty", field: "observedAt" };
	const initiator = parseInitiator(object.initiator);
	if (!("kind" in initiator)) return initiator;
	const reason = stringValue(object.reason);
	if (!reason) return { reason: "reason is empty", field: "reason" };
	if (reason.includes(FORBIDDEN_CALLER_PHRASE) && initiator.kind !== "explicit-parent") {
		return {
			reason: "Cancelled by caller is forbidden without explicit-parent correlation",
			field: "reason",
		};
	}
	let lastCheckpoint: string | null = null;
	if (object.lastCheckpoint !== null && object.lastCheckpoint !== undefined) {
		lastCheckpoint = stringValue(object.lastCheckpoint);
		if (!lastCheckpoint) return { reason: "lastCheckpoint is empty", field: "lastCheckpoint" };
	}
	if (!Array.isArray(object.partialArtifacts)) {
		return { reason: "partialArtifacts must be an array", field: "partialArtifacts" };
	}
	const partialArtifacts: string[] = [];
	for (const item of object.partialArtifacts) {
		if (typeof item !== "string") {
			return { reason: "partialArtifacts entries must be strings", field: "partialArtifacts" };
		}
		partialArtifacts.push(item);
	}
	return {
		recordId,
		taskRef,
		outcome,
		observedAt,
		initiator,
		reason,
		lastCheckpoint,
		partialArtifacts,
	};
}

export function validateTerminalRecord(
	value: unknown,
): { ok: true; record: TerminalRecord } | { ok: false; failure: TerminalRecordFailure } {
	const parsed = parseTerminalRecord(value);
	if (!("recordId" in parsed)) return { ok: false, failure: parsed };
	return { ok: true, record: parsed };
}

export function rewriteCancelledByCaller(text: string, explicit: boolean): string {
	if (!text.includes(FORBIDDEN_CALLER_PHRASE)) return text;
	const replacement = explicit ? NEUTRAL_CANCEL_EXPLICIT : NEUTRAL_CANCEL_UNKNOWN;
	return text.split(FORBIDDEN_CALLER_PHRASE).join(replacement);
}

export type ChildTaskResult = {
	taskRef: string;
	text: string;
	cancelled: boolean;
	lastCheckpoint: string | null;
	partialArtifacts: readonly string[];
};

function childRef(item: UnknownRecord, fallback: string): string {
	return (
		stringValue(item.taskRef) ||
		stringValue(item.id) ||
		stringValue(item.name) ||
		stringValue(item.agent) ||
		fallback
	);
}

function childText(item: unknown): string {
	if (typeof item === "string") return item;
	const object = record(item);
	if (!object) return "";
	for (const key of ["content", "text", "error", "message", "status"]) {
		const value = object[key];
		if (typeof value === "string" && value) return value;
	}
	try {
		return JSON.stringify(object);
	} catch {
		return "";
	}
}

function childCancelled(item: unknown, text: string): boolean {
	if (text.includes(FORBIDDEN_CALLER_PHRASE)) return true;
	const object = record(item);
	if (!object) return false;
	if (object.cancelled === true) return true;
	const status = stringValue(object.status).toLowerCase();
	if (status === "cancelled" || status === "canceled") return true;
	const outcome = stringValue(object.outcome).toUpperCase();
	if (outcome === "CANCELLED") return true;
	const nested = record(object.result);
	if (nested) {
		if (nested.cancelled === true) return true;
		const nestedStatus = stringValue(nested.status).toLowerCase();
		if (nestedStatus === "cancelled" || nestedStatus === "canceled") return true;
	}
	return false;
}

function childStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim()) items.push(entry);
	}
	return items;
}

function childCheckpointFields(item: unknown): {
	lastCheckpoint: string | null;
	partialArtifacts: readonly string[];
} {
	const object = record(item);
	if (!object) return { lastCheckpoint: null, partialArtifacts: [] };
	const checkpointRaw = object.lastCheckpoint;
	const lastCheckpoint =
		typeof checkpointRaw === "string" && checkpointRaw.trim() ? checkpointRaw.trim() : null;
	return {
		lastCheckpoint,
		partialArtifacts: childStringList(object.partialArtifacts),
	};
}

const CHECKPOINT_MARKER = /(?:^|\n)\s*(?:checkpoint|lastCheckpoint)\s*[:=]\s*(.+)$/im;

export function extractExplicitCheckpoint(messages: unknown): {
	checkpoint: string | null;
	artifacts: string[];
} {
	const artifacts: string[] = [];
	let checkpoint: string | null = null;
	if (!Array.isArray(messages)) return { checkpoint, artifacts };
	for (const message of messages) {
		const object = record(message);
		if (!object) continue;
		const content = object.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) => {
								const item = record(part);
								return typeof item?.text === "string" ? item.text : "";
							})
							.join("")
					: "";
		const marked = CHECKPOINT_MARKER.exec(text);
		if (marked?.[1]?.trim()) checkpoint = marked[1].trim().slice(0, 240);
		const explicit = stringValue(object.checkpoint) || stringValue(object.lastCheckpoint);
		if (explicit) checkpoint = explicit.slice(0, 240);
		const locator = stringValue(object.locator);
		if (locator) artifacts.push(locator);
	}
	return { checkpoint, artifacts };
}

export function parseChildTaskResults(details: unknown, content: unknown, fallbackRef: string): ChildTaskResult[] {
	const collected: ChildTaskResult[] = [];
	const detail = record(details);
	const candidates: unknown[] = [];
	if (detail) {
		for (const key of ["results", "items", "children", "tasks"]) {
			if (Array.isArray(detail[key])) candidates.push(...detail[key]);
		}
	}
	if (Array.isArray(details)) candidates.push(...details);
	if (candidates.length === 0) {
		const text = typeof content === "string" ? content : childText(content);
		const fields = childCheckpointFields(content);
		collected.push({
			taskRef: fallbackRef,
			text,
			cancelled: childCancelled(content, text),
			lastCheckpoint: fields.lastCheckpoint,
			partialArtifacts: fields.partialArtifacts,
		});
		return collected;
	}
	for (const [index, item] of candidates.entries()) {
		const object = record(item);
		const text = childText(item);
		const fields = childCheckpointFields(item);
		collected.push({
			taskRef: object ? childRef(object, `${fallbackRef}#${index}`) : `${fallbackRef}#${index}`,
			text,
			cancelled: childCancelled(item, text),
			lastCheckpoint: fields.lastCheckpoint,
			partialArtifacts: fields.partialArtifacts,
		});
	}
	return collected;
}

export function disappearanceAbortedRecord(input: {
	recordId: string;
	taskRef: string;
	observedAt: string;
	lastCheckpoint: string | null;
	partialArtifacts: readonly string[];
}): TerminalRecord {
	return {
		recordId: input.recordId,
		taskRef: input.taskRef,
		outcome: "ABORTED",
		observedAt: input.observedAt,
		initiator: { kind: "unknown", evidence: "agent_end without terminal yield" },
		reason: "lane disappeared without a terminal yield",
		lastCheckpoint: input.lastCheckpoint,
		partialArtifacts: [...input.partialArtifacts],
	};
}
