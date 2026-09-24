import { BUILTIN_TOOLS } from "../tools";
import type { ToolSession } from "../tools";
import type { AsyncJob } from "../async";
import type { TaskToolDetails } from "./types";
import { ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS } from "../async/job-manager";
import { buildAsyncResultBatchMessage } from "../session/async-job-delivery";

export interface FrankHostToolResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export interface FrankHostToolService {
	handle(name: string, args: unknown): Promise<FrankHostToolResult>;
	closed: boolean;
}

/**
 * Default budget for a bridged `hub` wait that names a child but carries no
 * `timeoutMs`. Bounded so a worker cannot park on a child that never settles.
 */
const CHILD_WAIT_DEFAULT_MS = 120_000;
/** Ceiling for the same wait; a longer request is clamped, never honored. */
const CHILD_WAIT_MAX_MS = 3_600_000;

/**
 * Correction appended to a bridged dispatch ack. The ack the `task` tool emits
 * for a background spawn promises auto-delivery "unless a settled `hub
 * jobs`/`wait` snapshot consumes it first", which holds for a parent inside the
 * host session and not for this worker: the worker is its own process, so the
 * completion is delivered to the host session's async-result sink instead. The
 * body is reachable here only through the drain calls this note names.
 */
const BRIDGE_DRAIN_NOTE =
	"Bridge note: this worker runs outside the host session, so a background child's yield does not auto-deliver here. " +
	"Read it with `hub` op `wait` (`to` the child id above) or `hub` op `inbox`.";

/**
 * The slice of a `hub` call the bridge answers from the job rows. Tool arguments
 * arrive as `unknown`, and every field is typed before it is used, so the assert
 * at the call site names this boundary instead of trusting the bag.
 */
interface ChildDrainCall {
	op?: unknown;
	to?: unknown;
	ids?: unknown;
	timeoutMs?: unknown;
}

export function createFrankHostToolService(options: {
	session: ToolSession;
	agentId: string;
	signal?: AbortSignal;
	names?: string[];
}): FrankHostToolService {
	const bridgedSession: ToolSession = {
		...options.session,
		getAgentId: () => options.agentId,
	};
	const manager = options.session.asyncJobManager;
	const ownerId = options.session.getAgentId?.() ?? undefined;
	/** Child ids this bridge dispatched, so an `inbox` drain cannot read a sibling's child. */
	const dispatched = new Set<string>();
	const enabled: Record<string, true> = Object.fromEntries(
		(options.names ?? ["task", "hub"]).map(name => [name, true]),
	);
	let closed = false;
	options.signal?.addEventListener(
		"abort",
		() => {
			closed = true;
		},
		{ once: true },
	);

	const ownedJobs = (): AsyncJob[] => manager?.getAllJobs(ownerId ? { ownerId } : undefined) ?? [];

	/**
	 * Children this worker can drain from the job rows: the ones it names for a
	 * `wait`, every unread body it dispatched for an `inbox`. Reading the job row
	 * rather than a `hub jobs` snapshot is the point: once the host session's
	 * async-result sink consumes a child, the snapshot hides its body while the
	 * row still carries it.
	 */
	const drainableChildren = (params: ChildDrainCall): AsyncJob[] => {
		if (!manager) return [];
		if (params.op === "wait") {
			const named: unknown[] =
				Array.isArray(params.ids) && params.ids.length > 0
					? params.ids
					: typeof params.to === "string"
						? [params.to]
						: [];
			const jobs = new Map<string, AsyncJob>();
			for (const raw of named) {
				if (typeof raw !== "string") continue;
				const job = manager.getJob(raw.trim());
				if (!job) continue;
				if (ownerId !== undefined && job.ownerId !== ownerId) continue;
				jobs.set(job.id, job);
			}
			return [...jobs.values()];
		}
		if (params.op !== "inbox") return [];
		return ownedJobs().filter(
			job =>
				dispatched.has(job.id) &&
				job.status !== "running" &&
				!manager.isJobResultConsumed(job.id) &&
				(job.resultText !== undefined || job.errorText !== undefined),
		);
	};

	/** Wait for children to settle, bounded by the caller's budget and the worker's own abort signal. */
	const settle = async (jobs: AsyncJob[], budgetMs: number): Promise<void> => {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			const running = jobs.filter(job => job.status === "running");
			if (running.length === 0 || closed || options.signal?.aborted || Date.now() >= deadline) return;
			await Promise.race([
				Promise.all(running.map(job => job.promise)),
				Bun.sleep(Math.max(1, Math.min(deadline - Date.now(), 1_000))),
			]);
		}
	};

	/**
	 * The bytes a native parent would have seen for these children, plus what is
	 * still running. A body over the manager's retention budget is never
	 * consumed: consuming evicts it, and this channel has no artifact spill, so
	 * the job row stays the copy of record.
	 */
	const drainBodies = (jobs: AsyncJob[]): string => {
		const entries = jobs
			.filter(job => job.status !== "running")
			.map(job => ({
				jobId: job.id,
				result: job.resultText ?? job.errorText ?? "",
				job,
				durationMs: Math.max(0, Date.now() - job.startTime),
				epoch: 0,
			}));
		const parts: string[] = [];
		const message = buildAsyncResultBatchMessage(entries);
		if (message) {
			parts.push(
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join(""),
			);
		}
		const oversized = entries.filter(entry => entry.result.length > ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS);
		if (oversized.length > 0) {
			parts.push(
				"Body over the inline budget, left intact on the job row: " +
					`${oversized.map(entry => entry.jobId).join(", ")}. Re-read with hub op jobs.`,
			);
		}
		const running = jobs.filter(job => job.status === "running").map(job => job.id);
		if (running.length > 0) parts.push(`Still running: ${running.join(", ")} (no body yet).`);
		if (parts.length === 0) parts.push("No settled child results yet.");
		manager?.consumeJobResults(
			entries.filter(entry => entry.result.length <= ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS).map(entry => entry.jobId),
		);
		return parts.join("\n\n");
	};

	return {
		get closed() {
			return closed;
		},
		async handle(name, args) {
			if (closed || options.signal?.aborted) {
				return { ok: false, error: "host tool service is closed" };
			}
			if (!enabled[name]) return { ok: false, error: `host tool is not enabled: ${name}` };
			const params = (args ?? {}) as ChildDrainCall;
			// A wait that names a child this worker can drain is answered from the job
			// row before the host tool runs. The host path consumes the child and can
			// only render its body while the row is unconsumed, and the host session's
			// own async-result sink usually wins that race.
			if (name === "hub" && params.op === "wait") {
				const children = drainableChildren(params);
				if (children.length > 0) {
					const requested =
						typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
							? params.timeoutMs
							: CHILD_WAIT_DEFAULT_MS;
					await settle(children, Math.max(0, Math.min(requested, CHILD_WAIT_MAX_MS)));
					return { ok: true, content: drainBodies(children) };
				}
			}
			const factory = Object.entries(BUILTIN_TOOLS).find(([toolName]) => toolName === name)?.[1];
			if (!factory) return { ok: false, error: `unknown host tool: ${name}` };
			try {
				const beforeDispatch = name === "task" && manager ? new Set(ownedJobs().map(job => job.id)) : undefined;
				const tool = await factory(bridgedSession);
				if (!tool) return { ok: false, error: `host tool is unavailable: ${name}` };
				const result = await tool.execute(
					options.agentId,
					args,
					options.signal,
					undefined,
					bridgedSession.getToolContext?.(),
				);
				let text = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map(part => part.text)
					.join("");
				if (beforeDispatch) {
					for (const job of ownedJobs()) {
						if (!beforeDispatch.has(job.id)) dispatched.add(job.id);
					}
					const details = result.details as TaskToolDetails | undefined;
					if (details?.async?.state === "running") text += `\n\n${BRIDGE_DRAIN_NOTE}`;
					return { ok: true, content: text };
				}
				if (name !== "hub") return { ok: true, content: text };
				const children = drainableChildren(params);
				if (children.length === 0) return { ok: true, content: text };
				// `inbox` also carries real messages, so drained bodies join the host tool's own reply.
				return { ok: true, content: `${text}\n\n${drainBodies(children)}` };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
