import type { Stats } from "node:fs";
import { readdir, rm, stat as statFile } from "node:fs/promises";
import * as path from "node:path";
import { getLogsDir, isBunTestRuntime } from "@oh-my-pi/pi-utils";
import * as AIError from "../error/flags";
import { isCopilotTransientModelError } from "./retry.js";
import { formatErrorMessageWithRetryAfter } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

const SENSITIVE_HEADERS = ["authorization", "x-api-key", "api-key", "cookie", "set-cookie", "proxy-authorization"];

/**
 * Build the JSON persisted for a rejected request. Request fields stay at the
 * top level (so existing dump parsers still read `body`); the provider's error
 * is added under `errorResponse` so a failed request is diagnosable from the
 * dump file rather than the request alone.
 */
export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

/** HTTP statuses whose rejected request we persist for post-hoc diagnosis: the
 *  request-content rejections that wedge a session. 400 (bad request) and 413
 *  (payload too large — an oversized image / snapcompact frame payload that 413s
 *  and empties the turn). Auth (401/403), not-found (404), rate limits and 5xx
 *  are excluded: 429/5xx are retried, so persisting them here would write one
 *  dump per attempt. */
export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

/**
 * Byte ceiling for the rejected-request dump directory. Same policy as the
 * document-conversion cache (`packages/coding-agent/src/utils/markit-cache.ts`):
 * a coarse disk-footprint safety valve, evicted FIFO by mtime, oldest first.
 * Content dedupe alone still lets genuinely distinct rejections accumulate
 * forever, so the directory needs this bound as well.
 */
export const MAX_HTTP_400_DUMP_BYTES = 256 * 1024 * 1024;

/** Content hashes on disk per dump directory. A retried request re-sends a
 *  byte-identical payload, so without this the writer appends one dump per
 *  attempt (observed: 11 files for one payload in 70 s, 157 files in an hour
 *  carrying 16 distinct payloads). The *promise* is memoized before it is
 *  awaited, so two concurrent first writes share one directory walk instead of
 *  each building an index. Dedupe needs names only: no stat, because the stat
 *  pass over the cold HDD-backed directory costs minutes. */
const dumpHashIndexes = new Map<string, Promise<Map<string, string>>>();

function indexDumpHashes(dir: string): Promise<Map<string, string>> {
	const cached = dumpHashIndexes.get(dir);
	if (cached) return cached;

	const loading = (async () => {
		const byHash = new Map<string, string>();
		try {
			for (const entry of await readdir(dir)) {
				// File name is `<epoch-ms>-<base36-content-hash>.json`.
				if (!entry.endsWith(".json")) continue;
				const separator = entry.lastIndexOf("-");
				if (separator <= 0) continue;
				const hash = entry.slice(separator + 1, -".json".length);
				if (!byHash.has(hash)) byHash.set(hash, entry);
			}
		} catch {
			// No directory yet is the normal first-dump case.
		}
		return byHash;
	})();
	dumpHashIndexes.set(dir, loading);
	return loading;
}

/** At most one sweep per directory, with a rerun flag for writes that landed
 *  while it ran. Concurrent sweeps would race over the same entries and each
 *  evict against a total the other had already changed. */
const dumpPruneRuns = new Map<string, { running: Promise<void>; rerun: boolean }>();

function scheduleDumpPrune(dir: string, maxBytes: number): Promise<void> {
	const active = dumpPruneRuns.get(dir);
	if (active) {
		active.rerun = true;
		return active.running;
	}

	const state = { running: Promise.resolve(), rerun: false };
	state.running = (async () => {
		try {
			do {
				state.rerun = false;
				await pruneDumpDir(dir, maxBytes);
			} while (state.rerun);
			// Retire the entry in the same synchronous block as the exit check:
			// a write that lands after the loop's last await either sets the flag
			// and forces another pass, or finds no entry and starts a fresh sweep.
			// Deleting it from an async continuation instead would leave a window
			// where that write's flag is set on an entry about to disappear.
			dumpPruneRuns.delete(dir);
		} catch {
			dumpPruneRuns.delete(dir);
		}
	})();
	dumpPruneRuns.set(dir, state);
	return state.running;
}

/**
 * Retain the newest dumps under `maxBytes`, oldest evicted first by the write
 * time recorded in the file name. Deliberately not awaited by the write path,
 * the same fire-and-forget policy the conversion cache uses
 * (`markit-cache.ts:163`): the stat pass costs minutes on a cold HDD-backed
 * directory and must never delay an error message. At least the newest dump
 * always survives, whatever the cap.
 */
async function pruneDumpDir(dir: string, maxBytes: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}

	const entries: { path: string; size: number; writtenAt: number }[] = [];
	let totalBytes = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const filePath = path.join(dir, name);
		let stats: Stats;
		try {
			stats = await statFile(filePath);
		} catch {
			continue;
		}
		// Order by the write time the file name records (`<epoch-ms>-...`), not
		// mtime: it is the writer's own record and does not depend on whether the
		// directory survived a copy.
		const writtenAt = Number.parseInt(name, 10);
		entries.push({ path: filePath, size: stats.size, writtenAt: Number.isFinite(writtenAt) ? writtenAt : 0 });
		totalBytes += stats.size;
	}
	if (totalBytes <= maxBytes) return;

	entries.sort((a, b) => a.writtenAt - b.writtenAt);
	for (let index = 0; index < entries.length - 1 && totalBytes > maxBytes; index++) {
		const entry = entries[index];
		try {
			await rm(entry.path, { force: true });
		} catch {
			continue;
		}
		totalBytes -= entry.size;
	}
}

/**
 * Persist a rejected-request dump once per distinct payload, then schedule the
 * byte-cap sweep. An identical payload returns the path of the dump already on
 * disk instead of writing a duplicate, so the operator pointer stays valid
 * while retries cannot multiply files and distinct payloads are bounded by
 * eviction rather than growing forever.
 */
export async function writeRejectedRequestDump(
	dir: string,
	payload: unknown,
	maxBytes: number = MAX_HTTP_400_DUMP_BYTES,
): Promise<{ filePath: string; duplicate: boolean; prune: Promise<void> }> {
	const byHash = await indexDumpHashes(dir);
	const hash = Bun.hash(JSON.stringify(payload)).toString(36);
	const existing = byHash.get(hash);
	if (existing !== undefined) {
		const existingPath = path.join(dir, existing);
		// A sweep may have evicted it since the index was built; write a fresh copy then.
		if (await Bun.file(existingPath).exists()) {
			return { filePath: existingPath, duplicate: true, prune: dumpPruneRuns.get(dir)?.running ?? Promise.resolve() };
		}
		byHash.delete(hash);
	}

	const fileName = `${Date.now()}-${hash}.json`;
	const filePath = path.join(dir, fileName);
	// Reserve before the write so concurrent retries in this process dedupe too.
	byHash.set(hash, fileName);
	await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);

	return { filePath, duplicate: false, prune: scheduleDumpPrune(dir, maxBytes) };
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	// Never persist dumps under the test runner: providers exercise the 400 path
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);

	try {
		const { filePath } = await writeRejectedRequestDump(path.join(getLogsDir(), "http-400-requests"), payload);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\nraw-http-request-save-failed=${writeMessage}`;
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	let message = formatErrorMessageWithRetryAfter(error, capturedErrorResponse?.headers);
	const capturedMessage = formatCapturedHttpError(capturedErrorResponse);
	if (capturedMessage) {
		if (/\bstatus code\s*\(no body\)/i.test(message)) {
			message = `${capturedErrorResponse?.status ?? "HTTP"} status code: ${capturedMessage}`;
		} else if (!message.includes(capturedMessage)) {
			message = `${message}\n${capturedMessage}`;
		}
	}
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

/**
 * Rewrite error message for GitHub Copilot request failures.
 * Must run AFTER finalizeErrorMessage since it replaces the message entirely.
 *
 * 400 `model_not_supported` = Copilot fleet skew. A model that `/models`
 *        advertises can flap between 200 and 400 because only part of
 *        Copilot's fleet has it in the integrator allowlist. After the
 *        in-request retry exhausts, surface guidance rather than the raw error.
 * 401 = token invalid/expired → credential removal is safe, prompt re-login.
 * 403 = token valid but access denied (plan, model policy, org restriction) →
 *       do NOT reuse the auth-failed string (which triggers credential removal).
 */
export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your account may not have access to this model or feature. Check your Copilot plan or model policy settings.`;
	}
	if (isCopilotTransientModelError(error)) {
		return `GitHub Copilot rejected this model (HTTP 400) after retries: only part of its fleet currently serves this model id, even though /models advertises it. Try again in a few seconds or switch to a model Copilot serves fleet-wide (claude-opus-4.7, claude-sonnet-4.5, gpt-4.1).`;
	}
	return errorMessage;
}

const CLINE_PASS_NOT_SUBSCRIBED_PATTERN =
	/not subscribed to required model plan|no access to clinepass subscription models/i;
const CLINE_PASS_ORG_ACCOUNT_PATTERN = /organization accounts cannot use individual model inference subscriptions/i;
const CLINE_PASS_MODEL_NOT_FOUND_PATTERN = /model not found/i;

/**
 * Rewrite error messages for ClinePass request failures. Gated to the
 * cline-pass provider: the "model not found" marker is too generic to match
 * for other hosts.
 *
 * not-subscribed (400) = the key is valid but the account has no ClinePass
 *        subscription; free-tier models remain usable on the same key.
 * org restriction (400) = organization accounts cannot use individual
 *        inference subscriptions; a personal-account key is required.
 * model-not-found (400) = roster rotation removed the model since selection;
 *        the fix is reselection, not retry. (Quota windows — "clinepass
 *        limit", "free limit reached on model" — are classified upstream in
 *        error/rate-limit and need no rewrite.)
 * surface-gate (403) = the model is restricted to Cline's official clients.
 *        Requests carry the mirrored CLI identity headers, so reaching this
 *        means Cline's gate policy changed; the classifier exempts it from
 *        credential rotation (sibling keys fail identically).
 */
export function rewriteClinePassError(errorMessage: string, provider: string): string {
	if (provider !== "cline-pass") return errorMessage;
	if (CLINE_PASS_NOT_SUBSCRIBED_PATTERN.test(errorMessage)) {
		return 'This model requires a ClinePass subscription. Free-tier models (marked "(free)" in the picker) work with any Cline account.';
	}
	if (CLINE_PASS_ORG_ACCOUNT_PATTERN.test(errorMessage)) {
		return "ClinePass is unavailable for organization accounts: individual inference subscriptions are personal-plan only. Log in with a personal Cline API key.";
	}
	if (AIError.isClinePassSurfaceGateMessage(errorMessage)) {
		return "Cline restricts this model to its official product surfaces and the mirrored CLI client identity was not accepted. Pick another model with /model and report the regression — the header mirror may need updating.";
	}
	if (CLINE_PASS_MODEL_NOT_FOUND_PATTERN.test(errorMessage)) {
		return "Cline removed this model from the roster since it was selected. Pick another with /model — the roster refreshes automatically while your API key is configured.";
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		headers: redactHeaders(dump.headers),
	};
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function formatCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return bodyText;

	const errorPayload = getObjectProperty(payload, "error") ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getStringProperty(payload, "error") : undefined;
	const message =
		getStringProperty(errorPayload, "message") ?? getStringProperty(payload, "message") ?? stringError ?? bodyText;
	const extras = [
		getStringProperty(errorPayload, "type") ?? getStringProperty(payload, "type"),
		getStringProperty(errorPayload, "param") ?? getStringProperty(payload, "param"),
		getStringProperty(errorPayload, "code") ?? getStringProperty(payload, "code"),
	]
		.filter(Boolean)
		.map((value, index) => {
			if (index === 0) return `type=${value}`;
			if (index === 1) return `param=${value}`;
			return `code=${value}`;
		});
	return extras.length > 0 ? `${message} (${extras.join(" ")})` : message;
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isObject(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		const parsed = JSON.parse(captured.bodyText);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const property = value[key];
	return isObject(property) ? property : undefined;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const property = value[key];
	return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
