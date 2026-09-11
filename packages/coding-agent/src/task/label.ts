/**
 * Tiny-model UI labels for spawned subagents.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import taskLabelSystemPrompt from "../prompts/system/task-label.md" with { type: "text" };
import { generateSessionTitle } from "../utils/title-generator";
import { LABEL_MAX, oneLineLabel } from "./types";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(taskLabelSystemPrompt);

/** A leading role mark, plus everything the assignment placed before it. */
const ROLE_MARK_RE = /^[\s\S]*?ROLE_MARK:[A-Za-z][\w.-]*/;
/** A leading markdown-ish section header, e.g. `# Target` or `## Goal`. */
const SECTION_HEADER_RE = /^\s*#{1,6}\s+\S+\s*/;
/** A leading bracketed wrapper: a `⟨…⟩` token or a `<tag>` opening tag. */
const LEADING_WRAPPER_RE = /^\s*(?:⟨[^⟩]*⟩|<[a-z][\w-]*>)\s*/i;
/** A trailing closing tag left behind by an unwrapped envelope. */
const TRAILING_CLOSING_TAG_RE = /\s*<\/[a-z][\w-]*>\s*$/i;
/** A content line, cut at its first sentence end. */
const FIRST_SENTENCE_RE = /^.*?[.!?](?=\s|$)/;
/** Content lines that are still scaffolding, never label text. */
const SCAFFOLD_LINE_RE = /^(?:#{1,6}\s|ROLE_MARK:)/;

/** True when a generated label is just the spawn handle, including `Name-2`. */
export function labelEchoesHandle(handle: string | undefined, label: string): boolean {
	if (!handle) return false;
	if (label.localeCompare(handle, undefined, { sensitivity: "accent" }) === 0) return true;
	const separator = handle.lastIndexOf("-");
	if (separator <= 0) return false;
	const prefix = handle.slice(0, separator);
	const suffix = handle.slice(separator + 1);
	return /^\d+$/.test(suffix) && prefix.localeCompare(label, undefined, { sensitivity: "accent" }) === 0;
}

/** Drops the leading prompt scaffolding an assignment may open with, so no section header, role mark, or envelope tag reaches a HUD row. */
function stripLabelScaffolding(text: string): string {
	let out = text;
	// Each pass strictly shortens the text, so this always terminates.
	for (;;) {
		const next = out
			.replace(ROLE_MARK_RE, "")
			.replace(SECTION_HEADER_RE, "")
			.replace(LEADING_WRAPPER_RE, "");
		if (next === out) break;
		out = next;
	}
	return out.replace(TRAILING_CLOSING_TAG_RE, "");
}

/** The first human line of an assignment, cut at its first sentence end. */
function firstHumanClause(text: string): string {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || SCAFFOLD_LINE_RE.test(line)) continue;
		return (line.match(FIRST_SENTENCE_RE)?.[0] ?? line).trim();
	}
	return "";
}

/**
 * Deterministic local label for the assignments the tiny title model cannot
 * label. Synchronous and infallible — no model call, no I/O, no throw — so a
 * degraded tiny model leaves the row described instead of blank.
 */
function deriveLocalLabel(assignment: string, handle: string | undefined): string | null {
	try {
		const clause = firstHumanClause(stripLabelScaffolding(assignment));
		if (!clause) return null;
		const label = oneLineLabel(clause, LABEL_MAX);
		if (!label || labelEchoesHandle(handle, label)) return null;
		return label;
	} catch {
		return null;
	}
}

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; falls back to a deterministic local label when the model is slow, broke, or silent, and returns null only when the assignment carries no usable text. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		const label = await generateSessionTitle(
			text,
			registry,
			settings,
			sessionId,
			undefined,
			undefined,
			TASK_LABEL_SYSTEM_PROMPT,
			signal,
		);
		if (label && !labelEchoesHandle(sessionId, label)) return label;
	} catch (err) {
		logger.debug("task-label: generation failed", {
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return deriveLocalLabel(text, sessionId);
}
