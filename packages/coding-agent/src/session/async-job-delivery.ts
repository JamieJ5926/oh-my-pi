/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS } from "../async/job-manager";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/**
 * Result payloads longer than this never embed in full in the transcript
 * message: the batch carries a preview plus a truncation note instead. The
 * session sink (`AgentSession.#formatAsyncResultForFollowUp`) spills
 * over-threshold results to an artifact with a pointer before enqueueing, so
 * this cap is the backstop for any raw entry that reaches flush unformatted.
 * Single-sourced from the job manager's retain budget so the transcript bound
 * and the row-retention bound can never drift apart.
 */
export const ASYNC_INLINE_RESULT_MAX_CHARS = ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

/**
 * Bound one job's inline transcript payload. Short results pass through
 * verbatim; over-threshold bodies collapse to a preview plus a truncation
 * note so a multi-MB lane result can never pin its full text in
 * `context.messages` indefinitely. Mirrors the session spill wording without
 * the artifact pointer (this layer has no artifact access; the session sink
 * adds the pointer when it spills before enqueueing).
 */
export function capInlineResult(result: string): string {
	if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) return result;
	return (
		`${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n` +
		`[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters of ${result.length.toLocaleString()}.]`
	);
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: capInlineResult(entry.result),
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
