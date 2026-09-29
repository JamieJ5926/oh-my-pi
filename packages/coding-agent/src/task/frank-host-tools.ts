import { createHash } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { Provider } from "@oh-my-pi/pi-ai";
import { executeCancel } from "../tools/hub/jobs";
import { IrcBus, type IrcMessage } from "../irc/bus";
import { BUILTIN_TOOLS } from "../tools";
import type { ToolSession } from "../tools";
import type { AsyncJob } from "../async";
import type { TaskToolDetails } from "./types";
import { ASYNC_PREVIEW_MAX_CHARS } from "../session/async-job-delivery";
import { ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS } from "../async/job-manager";
import { writeArtifact } from "../session/artifacts";
import { buildAsyncResultBatchMessage } from "../session/async-job-delivery";
import type { ReadonlySessionManager } from "../session/session-manager";
import type { SessionInitEntry, SessionMessageEntry } from "../session/session-entries";

interface FrankBashArgs {
	argv: string[];
	cwd?: string;
	timeout_ms?: number;
}

interface FrankEditArgs {
	path: string;
	old: string;
	new: string;
	then_run?: unknown;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function absoluteToolPath(path: string, workerCwd?: string): string {
	if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return path;
	return `${workerCwd ?? process.cwd()}/${path}`;
}

function translateMutatingArgs(name: string, args: unknown, workerCwd?: string): unknown {
	if (typeof args !== "object" || args === null) return args;
	if (name === "bash" || name === "run") {
		if (!("argv" in args) || !Array.isArray(args.argv) || !args.argv.every(part => typeof part === "string"))
			return args;
		const argv = args.argv;
		const shellCommand = "command" in args && typeof args.command === "string" ? args.command.trim() : "";
		const command = argv.length > 0 ? argv.map(shellQuote).join(" ") : shellCommand;
		if (command === "") throw new Error(`${name} requires a non-empty argv or a command string`);
		const cwd = "cwd" in args && typeof args.cwd === "string" ? absoluteToolPath(args.cwd, workerCwd) : workerCwd;
		const timeout = "timeout_ms" in args && typeof args.timeout_ms === "number" ? args.timeout_ms / 1000 : undefined;
		return {
			command,
			...(cwd !== undefined ? { cwd } : {}),
			...(timeout !== undefined ? { timeout } : {}),
		};
	}
	if (name === "edit") {
		if (
			!("path" in args) ||
			typeof args.path !== "string" ||
			!("old" in args) ||
			typeof args.old !== "string" ||
			!("new" in args) ||
			typeof args.new !== "string"
		)
			return args;
		return { path: absoluteToolPath(args.path, workerCwd), old_string: args.old, new_string: args.new };
	}
	if (name === "write") {
		if (!("path" in args) || typeof args.path !== "string") return args;
		return { ...args, path: absoluteToolPath(args.path, workerCwd) };
	}
	return args;
}

export interface FrankHostToolResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export interface FrankHostToolService {
	handle(name: string, args: unknown, toolCallId?: string): Promise<FrankHostToolResult>;
	toolNames(): string[];
	close(): void;
	closed: boolean;
}

/**
 * Default budget for a bridged `hub` wait that names a child but carries no
 * `timeoutMs`. Bounded so a worker cannot park on a child that never settles.
 */
const CHILD_WAIT_DEFAULT_MS = 120_000;
function hostMailFor(agentId: string): string {
	const pending = IrcBus.global().inbox(agentId);
	if (pending.length === 0) return "";
	return `Host messages:\n${pending.map(message => `[hub from ${message.from}] ${message.body}`).join("\n")}\n\n`;
}

function prependHostMail(
	pending: string[],
	result: { ok: boolean; content?: string; error?: string },
): { ok: boolean; content?: string; error?: string } {
	if (pending.length === 0) return result;
	const note = `Host messages:\n${pending.join("\n")}`;
	if (!result.ok) return { ok: false, error: `${note}\n\n${result.error ?? "hub failed"}` };
	return { ok: true, content: result.content ? `${note}\n\n${result.content}` : note };
}

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

/**
 * The host session as the bridged worker's hooks must see it: the worker's own
 * session_init (its seat) and rendered prompt, exactly as a native lane's
 * session starts, so seat- and lane-keyed guards classify the worker, not the
 * host. Without the seat, profile policy reads an anonymous lane and confines it.
 */
function laneSessionView(
	host: ReadonlySessionManager,
	lane: { prompt: string; agent: string },
): ReadonlySessionManager {
	const timestamp = new Date().toISOString();
	const init = {
		type: "session_init",
		id: "frank-bridge-init",
		parentId: null,
		timestamp,
		systemPrompt: "",
		task: lane.prompt,
		tools: [],
		agent: lane.agent,
	} satisfies SessionInitEntry;
	const lanePrompt = {
		type: "message",
		id: "frank-bridge-lane",
		parentId: init.id,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: lane.prompt }], timestamp: Date.now() },
	} satisfies SessionMessageEntry;
	return new Proxy(host, {
		get(target, key) {
			if (key === "getEntries") return () => [init, lanePrompt];
			const value: unknown = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const COORDINATOR_SEATS: Readonly<Record<string, true>> = {
	"frank-poteto-agent": true,
	"frank-poteto-agent-deep": true,
	"poteto-agent": true,
	"poteto-agent-deep": true,
};

const FIRST_WORK_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	ast_grep: true,
	ast_edit: true,
	bash: true,
	run: true,
	edit: true,
	write: true,
	eval: true,
};

function coordinatorItemsMissingDelegable(args: unknown): string[] {
	if (typeof args !== "object" || args === null || !("tasks" in args) || !Array.isArray(args.tasks)) return ["batch"];
	if (args.tasks.length === 0) return ["batch"];
	return args.tasks.flatMap((item, index) => {
		if (typeof item !== "object" || item === null) return [String(index + 1)];
		if (!("agent" in item) || typeof item.agent !== "string" || !COORDINATOR_SEATS[item.agent]) return [];
		const task = "task" in item && typeof item.task === "string" ? item.task : "";
		return /^[ \t]*(?:delegable[ \t]*:|single-slice[ \t]*:)[ \t]*\S/im.test(task) ? [] : [String(index + 1)];
	});
}
function parseRefreshKeyRequest(args: unknown): { model: string; stale_key_sha256: string } | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	if (!("op" in args) || args.op !== "refresh_key") return undefined;
	if (!("model" in args) || typeof args.model !== "string") return undefined;
	if (
		!("stale_key_sha256" in args) ||
		typeof args.stale_key_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(args.stale_key_sha256)
	)
		return undefined;
	return { model: args.model, stale_key_sha256: args.stale_key_sha256 };
}
export function createFrankHostToolService(options: {
	session: ToolSession;
	agentId: string;
	signal?: AbortSignal;
	names?: string[];
	workerCwd?: string;
	apiKey?: string;
	authProvider?: Provider;
	modelId?: string;
	sessionId?: string;
	/** The worker seat's spawn list ("" none, "*" any, or CSV). Omitted keeps the host session's. */
	spawns?: string;
	/** The worker's rendered prompt and seat; when set, bridged tool hooks run in the worker's lane scope. */
	workerLane?: { prompt: string; agent: string };
}): FrankHostToolService {
	const bridgedSession: ToolSession = {
		...options.session,
		getAgentId: () => options.agentId,
		...(options.spawns !== undefined ? { getSessionSpawns: () => options.spawns ?? "" } : {}),
	};
	let currentWorkerKey = options.apiKey;
	const manager = options.session.asyncJobManager;
	const hostOwnerId = options.session.getAgentId?.() ?? undefined;
	const deliveredBodies = new Map<string, { job: AsyncJob | undefined; text: string }>();
	const unregisterDeliverySink = manager?.registerDeliverySink(options.agentId, async (jobId, text, job) => {
		if (text.length > ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS) {
			const artifact = await options.session.allocateOutputArtifact?.("async");
			if (!artifact?.path || !artifact.id) {
				if (!closed) {
					const preview = `${text.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]\nFull output unavailable: session artifact storage is not configured.`;
					deliveredBodies.set(jobId, { job, text: preview });
				}
				return;
			}
			if (closed) return;
			await writeArtifact(artifact.path, text);
			if (closed) return;
			const preview = `${text.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]\nFull output: artifact://${artifact.id}`;
			deliveredBodies.set(jobId, { job, text: preview });
			return;
		}
		deliveredBodies.set(jobId, { job, text });
	});
	const isMatchingOwner = (job: AsyncJob): boolean =>
		job.ownerId === options.agentId || (hostOwnerId !== undefined && job.ownerId === hostOwnerId);
	/** Child ids this bridge dispatched, so an `inbox` drain cannot read a sibling's child. */
	const dispatched = new Set<string>();
	const enabled: Record<string, true> = Object.fromEntries(
		(options.names ?? ["task", "hub"]).map(name => [name, true]),
	);
	let closed = false;
	const coordinator = options.workerLane !== undefined && COORDINATOR_SEATS[options.workerLane.agent] === true;
	let dispatchedTask =
		!coordinator ||
		(options.workerLane !== undefined && /^[ \t]*single-slice[ \t]*:[ \t]*\S/im.test(options.workerLane.prompt));
	const abortSignal = options.signal;
	const onAbort = () => {
		closed = true;
		unregisterDeliverySink?.();
		deliveredBodies.clear();
	};
	if (abortSignal) {
		if (abortSignal.aborted) onAbort();
		else abortSignal.addEventListener("abort", onAbort, { once: true });
	}

	const ownedJobs = (): AsyncJob[] => manager?.getAllJobs().filter(isMatchingOwner) ?? [];

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
				if (!isMatchingOwner(job)) continue;
				jobs.set(job.id, job);
			}
			return [...jobs.values()];
		}
		if (params.op !== "inbox") return [];
		return ownedJobs().filter(
			job =>
				dispatched.has(job.id) &&
				job.status !== "running" &&
				(deliveredBodies.has(job.id) ||
					(!manager.isJobResultConsumed(job.id) && (job.resultText !== undefined || job.errorText !== undefined))),
		);
	};

	/** Wait for children to settle, bounded by the caller's budget and the worker's own abort signal. */
	const settle = async (jobs: AsyncJob[], budgetMs: number, firstSettled: boolean): Promise<void> => {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			if (firstSettled && jobs.some(job => job.status !== "running")) return;
			const running = jobs.filter(job => job.status === "running");
			if (running.length === 0 || closed || options.signal?.aborted || Date.now() >= deadline) return;
			await Promise.race([
				...(firstSettled ? running.map(job => job.promise) : [Promise.all(running.map(job => job.promise))]),
				Bun.sleep(Math.max(1, Math.min(deadline - Date.now(), 1_000))),
			]);
			if (firstSettled && jobs.some(job => job.status !== "running")) return;
		}
	};
	/**
	 * If a body exceeds the job manager retention budget, spill it to the
	 * session artifact store before consuming it. When artifact storage is not
	 * available, leave the full body intact on the job row.
	 */
	const drainBodies = async (jobs: AsyncJob[]): Promise<string> => {
		const entries = jobs
			.filter(job => job.status !== "running")
			.map(job => ({
				jobId: job.id,
				result:
					deliveredBodies.get(job.id)?.job === job
						? (deliveredBodies.get(job.id)?.text ?? job.resultText ?? job.errorText ?? "")
						: (job.resultText ?? job.errorText ?? ""),
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
		for (const entry of oversized) {
			if (deliveredBodies.get(entry.jobId)?.job === entry.job) continue;
			const artifact = await options.session.allocateOutputArtifact?.("async");
			if (!artifact?.path || !artifact.id) {
				parts.push(
					`Body over the inline budget, left intact on the job row: ${entry.jobId}. Re-read with hub op jobs.`,
				);
				continue;
			}
			await writeArtifact(artifact.path, entry.result);
			parts.push(`Full output for ${entry.jobId}: artifact://${artifact.id}`);
			manager?.consumeJobResults([entry.jobId]);
			deliveredBodies.delete(entry.jobId);
		}
		const running = jobs.filter(job => job.status === "running").map(job => job.id);
		if (running.length > 0) parts.push(`Still running: ${running.join(", ")} (no body yet).`);
		manager?.consumeJobResults(
			entries.filter(entry => entry.result.length <= ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS).map(entry => entry.jobId),
		);
		for (const entry of entries) {
			if (entry.result.length <= ASYNC_CONSUMED_BODY_RETAIN_MAX_CHARS) deliveredBodies.delete(entry.jobId);
		}
		return parts.join("\n\n");
	};

	return {
		toolNames: () => Object.keys(enabled),
		close() {
			if (closed) return;
			onAbort();
			if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
		},
		get closed() {
			return closed;
		},
		async handle(name, args, toolCallId) {
			if (closed || options.signal?.aborted) {
				return { ok: false, error: "host tool service is closed" };
			}
			if (name === "refresh_key") {
				const request = parseRefreshKeyRequest(args);
				logger.debug("Frank host key refresh request", {
					provider: options.authProvider,
					model: request?.model,
					staleKeySha256Prefix: request?.stale_key_sha256.slice(0, 12),
				});
				if (!request || !options.authProvider || !currentWorkerKey || !options.session.modelRegistry) {
					return { ok: true, content: JSON.stringify({ ok: false, error: "key refresh is unavailable" }) };
				}
				try {
					const currentKey = currentWorkerKey;
					if (createHash("sha256").update(currentKey).digest("hex") !== request.stale_key_sha256) {
						return { ok: true, content: JSON.stringify({ ok: true, key: currentKey }) };
					}
					const refreshedKey = await options.session.modelRegistry?.getApiKeyForProvider(
						options.authProvider,
						options.sessionId,
						{ modelId: options.modelId, forceRefresh: true, signal: options.signal },
					);
					if (!refreshedKey)
						return {
							ok: true,
							content: JSON.stringify({ ok: false, error: "key refresh did not return a key" }),
						};
					currentWorkerKey = refreshedKey;
					return { ok: true, content: JSON.stringify({ ok: true, key: refreshedKey }) };
				} catch {
					return { ok: true, content: JSON.stringify({ ok: false, error: "key refresh failed" }) };
				}
			}
			if (!enabled[name]) return { ok: false, error: `host tool is not enabled: ${name}` };
			if (coordinator && !dispatchedTask && FIRST_WORK_TOOLS[name]) {
				return {
					ok: false,
					error: `Delegation required: dispatch a task before calling \`${name}\`, or declare \`single-slice: <reason>\` in the worker brief.`,
				};
			}
			if (name === "task" && coordinator) {
				const missing = coordinatorItemsMissingDelegable(args);
				if (missing.length > 0) {
					const reason = missing.includes("batch")
						? "call must contain a non-empty tasks batch"
						: `item${missing.length === 1 ? "" : "s"} ${missing.join(", ")} must each declare their own \`delegable: <scope>\` or \`single-slice: <reason>\` in its task text`;
					return { ok: false, error: `Delegation required: coordinator task ${reason}.` };
				}
			}
			const params = (args ?? {}) as ChildDrainCall;
			const hostMail = hostMailFor(options.agentId);
			if (name === "hub" && params.op === "wait") {
				const children = drainableChildren(params);
				if (children.length > 0) {
					const requested =
						typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
							? params.timeoutMs
							: CHILD_WAIT_DEFAULT_MS;
					const budget = requested === 0 ? CHILD_WAIT_MAX_MS : Math.max(0, Math.min(requested, CHILD_WAIT_MAX_MS));
					await settle(children, budget, Array.isArray(params.ids) && params.ids.length > 0);
					return { ok: true, content: `${hostMail}${await drainBodies(children)}` };
				}
			}
			if (name === "hub" && params.op === "cancel") {
				if (!manager) return { ok: false, error: "Async execution is disabled; no background jobs are available." };
				if (
					!Array.isArray(params.ids) ||
					!params.ids.every(id => typeof id === "string") ||
					params.ids.length === 0
				) {
					return { ok: false, error: '`ids` is required for op="cancel".' };
				}
				const result = await executeCancel(bridgedSession, manager, options.agentId, params.ids);
				const text = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map(part => part.text)
					.join("");
				return { ok: true, content: `${hostMail}${text}` };
			}
			const factory = Object.entries(BUILTIN_TOOLS).find(([toolName]) => toolName === name)?.[1];
			if (!factory)
				return {
					ok: false,
					error: hostMail ? `${hostMail}${`unknown host tool: ${name}`}` : `unknown host tool: ${name}`,
				};
			const requireRegistry = name === "write" || name === "edit" || name === "bash" || name === "run";
			const registeredTool = options.session.toolRegistry?.get(name);
			if (requireRegistry && !registeredTool) {
				return {
					ok: false,
					error: hostMail
						? `${hostMail}host tool is not registered in the host session: ${name}`
						: `host tool is not registered in the host session: ${name}`,
				};
			}
			try {
				const beforeDispatch = name === "task" && manager ? new Set(ownedJobs().map(job => job.id)) : undefined;
				const translatedArgs = translateMutatingArgs(name, args, options.workerCwd);
				// Bridged Frank edits arrive as old_string/new_string, which only the
				// replace variant accepts; the session registry instance follows the
				// configured edit mode (hashline by default) and would reject them.
				// The session serves the wrapped replace-mode instance through
				// getEditReplaceTool (undefined when edit was never granted, so the
				// refusal above already fired). Hooks fire: the instance is an
				// ExtensionToolWrapper around the session's own runner.
				const editReplaceTool =
					name === "edit" ? (options.session.getEditReplaceTool?.() ?? registeredTool) : undefined;
				// task files its children under the building session's agent id, and
				// hub sends carry that id as the sender; the host registry instance would
				// nest a Frank worker's children under the host and send its messages
				// as the host, so build both for the worker and wrap with the host's hooks.
				const wrapWithHooks = options.session.wrapWithHooks;
				const buildForWorker =
					name === "hub" || ((name === "task" || name === "bash") && wrapWithHooks !== undefined);
				const built = buildForWorker ? await factory(bridgedSession) : undefined;
				const workerTool = built ? (wrapWithHooks ? wrapWithHooks(built) : built) : undefined;
				const tool = editReplaceTool ?? workerTool ?? registeredTool ?? (await factory(bridgedSession));
				if (!tool)
					return {
						ok: false,
						error: hostMail
							? `${hostMail}host tool is unavailable: ${name}`
							: `host tool is unavailable: ${name}`,
					};
				const hostContext = bridgedSession.getToolContext?.();
				const scoped =
					hostContext && options.workerLane !== undefined
						? {
								...hostContext,
								hookScope: {
									sessionManager: laneSessionView(hostContext.sessionManager, options.workerLane),
								},
							}
						: hostContext;
				const context =
					scoped && name === "bash"
						? {
								...scoped,
								frankBridge: true,
								...(scoped.toolCall ? { toolCall: { ...scoped.toolCall, steeringSignal: undefined } } : {}),
							}
						: scoped;
				const result = await tool.execute(
					toolCallId ?? `frank-bridge:${name}`,
					translatedArgs,
					options.signal,
					undefined,
					context,
				);
				if (name === "task" && coordinator && result.isError !== true) dispatchedTask = true;
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
					return { ok: true, content: `${hostMail}${text}` };
				}
				if (name === "bash") {
					const details = result.details as { async?: { state?: string; jobId?: string } } | undefined;
					if (details?.async?.state === "running") {
						if (details.async.jobId) dispatched.add(details.async.jobId);
						text += `\n\n${BRIDGE_DRAIN_NOTE}`;
					}
					return { ok: true, content: `${hostMail}${text}` };
				}
				if (name !== "hub") return { ok: true, content: `${hostMail}${text}` };
				const children = drainableChildren(params);
				const drained = children.length === 0 ? text : `${text}\n\n${await drainBodies(children)}`;
				return { ok: true, content: `${hostMail}${drained}` };
			} catch (error) {
				return { ok: false, error: `${hostMail}${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}
