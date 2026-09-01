/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import {
  FileSessionDirectory,
  createSessionAddress,
  sameSessionIdentity,
  sessionIdentity,
  type RevivalDescriptor,
  type SessionAddress,
  type SessionDirectory,
  type SessionGenerationAllocator,
  type SessionRecord,
} from "../bridge/index";
import { canonicalProjectDirSync, daemonBridgeDirectoryPath, daemonRuntimeDir } from "../launch/paths";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";

/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";

/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

/** Historical identity and telemetry that remain available after the live session is disposed. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	/** Stable bridge address used for local and cross-process delivery. */
	address: SessionAddress;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing, for the work-aware roster. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
}

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status?: AgentStatus;
	session?: AgentSession | null;
	sessionFile?: string | null;
	/** Explicit bridge address, normally omitted for local agents. */
	address?: SessionAddress;
	activity?: string;
	createdAt?: number;
	lastActivity?: number;
	history?: AgentHistorySummary;
}

/** Optional filters for synchronous local registry snapshots. */
export interface AgentListFilter {
	status?: AgentStatus | readonly AgentStatus[];
	kind?: AgentKind | readonly AgentKind[];
	parentId?: string;
	includeAdvisors?: boolean;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

export type RegistryListener = (event: RegistryEvent) => void;

export interface AgentRegistryOptions {
  directory?: SessionDirectory;
  generationAllocator?: SessionGenerationAllocator;
  localAddress?: SessionAddress;
}

export interface RegisterPublishedOptions {
  ttlMs?: number;
  revival?: RevivalDescriptor;
}

function defaultLocalAddress(): SessionAddress {
	return createSessionAddress({
		namespace: "omp",
		host: hostname(),
		process: String(process.pid),
		backend: "omp",
		session: "main",
		generation: 1,
	});
}

function productionGlobalOptions(): AgentRegistryOptions {
  const projectDir = canonicalProjectDirSync(process.cwd());
  const runtimeDir = daemonRuntimeDir(projectDir);
  const directory = new FileSessionDirectory(daemonBridgeDirectoryPath(runtimeDir));
  return {
    directory,
    generationAllocator: directory,
    localAddress: defaultLocalAddress(),
  };
}

function isGenerationAllocator(
  directory: SessionDirectory | undefined,
): directory is SessionDirectory & SessionGenerationAllocator {
  return directory !== undefined && "claimNext" in directory && typeof directory.claimNext === "function";
}

const MAX_ADDRESS_SEGMENT_LENGTH = 128;

function addressSegment(value: string, baseSession: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._~-]/g, "-") || "agent";
	const digest = createHash("sha256").update(value, "utf8").digest("hex");
	const suffix = `-${digest}`;
	const readablePrefix = `${baseSession}-${normalized}`;
	const prefixLength = MAX_ADDRESS_SEGMENT_LENGTH - suffix.length;
	return `${readablePrefix.slice(0, prefixLength)}${suffix}`;
}

function addressForAgent(base: SessionAddress, id: string, explicit?: SessionAddress): SessionAddress {
	if (explicit) return explicit;
	if (id === MAIN_AGENT_ID) return base;
	return createSessionAddress({
		...base,
		session: addressSegment(id, base.session),
	});
}

function matchesFilter(ref: AgentRef, filter?: AgentListFilter): boolean {
  if (!filter) return true;
  if (!filter.includeAdvisors && ref.kind === "advisor") return false;
  if (filter.parentId !== undefined && ref.parentId !== filter.parentId) return false;
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(ref.status)) return false;
  }
  if (filter.kind !== undefined) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    if (!kinds.includes(ref.kind)) return false;
  }
  return true;
}

function sameAddress(left: SessionAddress, right: SessionAddress): boolean {
  return sameSessionIdentity(left, right) && left.generation === right.generation;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry(productionGlobalOptions());
		}
		return AgentRegistry.#global;
	}

	/** Reset the process-global registry for isolated tests. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

  readonly #refs = new Map<string, AgentRef>();
  readonly #listeners = new Set<RegistryListener>();
  readonly #directory?: SessionDirectory;
  readonly #generationAllocator?: SessionGenerationAllocator;
  readonly #localAddress: SessionAddress;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(options: AgentRegistryOptions = {}) {
    this.#directory = options.directory;
    this.#generationAllocator =
      options.generationAllocator ?? (isGenerationAllocator(options.directory) ? options.directory : undefined);
    this.#localAddress = options.localAddress ?? defaultLocalAddress();
  }

	get localAddress(): SessionAddress {
		return this.#localAddress;
	}

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

  #rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
    logger.debug("Agent registry status update rejected", { id, status, reason });
    return false;
  }

  #enqueueMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#mutationTails.get(id) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationTails.set(id, tail);
    void tail.finally(() => {
      if (this.#mutationTails.get(id) === tail) this.#mutationTails.delete(id);
    });
    return run;
  }

  register(input: RegisterInput): AgentRef {
    const now = Date.now();
    const address = addressForAgent(this.#localAddress, input.id, input.address);
    const ref: AgentRef = {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      parentId: input.parentId,
      status: input.status ?? "running",
      session: input.session ?? null,
      sessionFile: input.sessionFile ?? null,
      address,
      createdAt: input.createdAt ?? now,
      lastActivity: input.lastActivity ?? now,
      activity: input.activity,
      history: input.history,
    };
    this.#refs.set(ref.id, ref);
    this.#emit({ type: "registered", ref });
    return ref;
  }

  async registerPublished(input: RegisterInput, options: RegisterPublishedOptions = {}): Promise<AgentRef> {
    if (!this.#directory || !this.#generationAllocator) throw new Error("Agent registry publication is not configured");
    return this.#enqueueMutation(input.id, async () => {
      const claim = await this.#generationAllocator!.claimNext({
        identity: sessionIdentity(addressForAgent(this.#localAddress, input.id, input.address)),
        ttlMs: options.ttlMs ?? SESSION_TTL_MS,
        revival: options.revival,
      });
      return this.register({ ...input, address: claim.address });
    });
  }

  async unregisterPublished(id: string, expectedAddress?: SessionAddress): Promise<boolean> {
    if (!this.#directory) return false;
    return this.#enqueueMutation(id, async () => {
      const ref = this.#refs.get(id);
      if (!ref || (expectedAddress && !sameAddress(ref.address, expectedAddress))) return false;
      const result = await this.#directory!.tombstone(ref.address, "unregistered");
      if (!result.ok) return false;
      if (this.#refs.get(id) !== ref) return false;
      this.#refs.delete(id);
      this.#emit({ type: "removed", ref });
      return true;
    });
  }

  async heartbeatPublished(id: string, expectedAddress?: SessionAddress, ttlMs = SESSION_TTL_MS): Promise<boolean> {
    if (!this.#directory) return false;
    return this.#enqueueMutation(id, async () => {
      const ref = this.#refs.get(id);
      if (!ref || (expectedAddress && !sameAddress(ref.address, expectedAddress))) return false;
      const result = await this.#directory!.heartbeat(ref.address, ttlMs);
      if (result.ok) return true;
      if (result.reason === "generation-conflict" && this.#refs.get(id) === ref) {
        this.#refs.delete(id);
        this.#emit({ type: "removed", ref });
      }
      return false;
    });
  }

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	/** Attach transcript-derived identity and telemetry without changing lifecycle state. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesExpected(ref, expected)) {
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		}
		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(id, status, "aborted-is-terminal");
		}
		if (ref.status === status) return true;
		ref.status = status;
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/** Record a bounded, display-only gist for a currently running agent. */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (ref?.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity !== gist) ref.activity = gist;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

  unregister(id: string, expected?: AgentRefExpectation): boolean {
    const ref = this.#refs.get(id);
    if (!ref || !this.#matchesExpected(ref, expected)) return false;
    this.#refs.delete(id);
    this.#emit({ type: "removed", ref });
    return true;
  }

	/** Resolve a local id/address first, then consult the authoritative directory. */
	async resolveAddress(target: string | SessionAddress): Promise<AgentRef | SessionRecord | undefined> {
		if (typeof target === "string") {
			const local = this.#refs.get(target);
			if (local) return local;
		} else {
			const local = this.getByAddress(target);
			if (local) return local;
		}
		if (!this.#directory || typeof target === "string") return undefined;
		return (await this.#directory.lookup(target)) ?? undefined;
	}

	/** Resolve a local ref by exact bridge address without consulting remote state. */
	getByAddress(address: SessionAddress): AgentRef | undefined {
		return this.list().find(
			ref => sameSessionIdentity(ref.address, address) && ref.address.generation === address.generation,
		);
	}

	/** Perform an explicit authoritative directory lookup. */
	async lookupAddress(address: SessionAddress): Promise<SessionRecord | undefined> {
		return (await this.#directory?.lookup(address)) ?? undefined;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(filter?: AgentListFilter): AgentRef[] {
		return [...this.#refs.values()].filter(ref => matchesFilter(ref, filter));
	}

	/**
	 * Returns every alive agent (running | idle) except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list({ includeAdvisors: false }).filter(
			ref => ref.id !== id && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/** Whether a ref's claimed running state is corroborated by its attached live session. */
	isRunning(ref: AgentRef): boolean {
		return ref.status === "running" && ref.session?.isStreaming === true;
	}

	/** Mirror authoritative AgentSession run-state notifications into its registry ref. */
	syncSessionStatus(id: string, session: AgentSession): () => void {
		return session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// A listener must not break the dispatch loop.
			}
		}
	}
}
