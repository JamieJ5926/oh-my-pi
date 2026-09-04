/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { createMessageEnvelope, formatSessionAddress, parseMessageEnvelope, type MessageEnvelope, type SessionAddress } from "../bridge/index";
import type { TransportAdapter, TransportDeliveryState } from "../bridge/transport";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { CustomMessage } from "../session/messages";
export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/** Remote address used to route a reply across the transport. */
	remoteSource?: SessionAddress;
}

interface IrcTransportPayload {
	readonly kind: "irc-message";
	readonly from: string;
	readonly body: string;
	readonly replyTo?: string;
	readonly expectsReply?: boolean;
}

function parseIrcTransportPayload(value: unknown): IrcTransportPayload | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = Reflect.get(value, "kind");
	const from = Reflect.get(value, "from");
	const body = Reflect.get(value, "body");
	const replyTo = Reflect.get(value, "replyTo");
	const expectsReply = Reflect.get(value, "expectsReply");
	if (kind !== "irc-message" || typeof from !== "string" || from.length === 0 || typeof body !== "string") return undefined;
	if (replyTo !== undefined && typeof replyTo !== "string") return undefined;
	if (expectsReply !== undefined && typeof expectsReply !== "boolean") return undefined;
	return {
		kind: "irc-message",
		from,
		body,
		...(replyTo === undefined ? {} : { replyTo }),
		...(expectsReply === undefined ? {} : { expectsReply }),
	};
}

export type IrcTarget = string | SessionAddress;

export interface IrcBusOptions {
	registry?: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
	transport?: TransportAdapter;
	localAddress?: SessionAddress;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/**
 * Rejection reason for a `send await:true` whose awaited peer reached a
 * terminal stop (ended its turn, parked, was aborted, or unregistered)
 * without ever replying. Distinct from a plain timeout so the sender can
 * surface "they stopped" instead of stranding the caller on the full
 * `irc.timeoutMs` window.
 */
export class IrcAwaitTargetStopped extends Error {
	constructor(target: string) {
		super(`Awaited peer "${target}" stopped without replying.`);
		this.name = "IrcAwaitTargetStopped";
	}
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
#transport?: TransportAdapter;
#localAddress?: SessionAddress;
	readonly #transportAddresses = new Map<string, SessionAddress>();
	#transportClosed = false;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();

	constructor(options: IrcBusOptions | AgentRegistry = {}) {
		const deps = options instanceof AgentRegistry ? { registry: options } : options;
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#transport = deps.transport;
		this.#localAddress = deps.localAddress;
	}

	/** Attach one process transport and register its local inbound address. */
	async attachTransport(options: { transport: TransportAdapter; localAddress: SessionAddress }): Promise<void> {
		if (this.#transport && this.#transport !== options.transport) throw new Error("IRC transport is already attached");
		if (this.#transportClosed) throw new Error("IRC transport is closed");
		this.#transport = options.transport;
		this.#localAddress = options.localAddress;
		await this.registerAddress(options.localAddress);
	}

	/** Register a published address as an inbound delivery endpoint. */
	async registerAddress(address: SessionAddress): Promise<void> {
		if (!this.#transport) throw new Error("IRC transport is not attached");
		if (this.#transportClosed) throw new Error("IRC transport is closed");
		const key = formatSessionAddress(address);
		if (this.#transportAddresses.has(key)) return;
		this.#transportAddresses.set(key, address);
		try {
			await this.#transport.register(address, envelope => this.#receiveTransportEnvelope(envelope, address));
		} catch (error) {
			this.#transportAddresses.delete(key);
			throw error;
		}
	}

	async unregisterAddress(address: SessionAddress): Promise<void> {
		const key = formatSessionAddress(address);
		this.#transportAddresses.delete(key);
		await this.#transport?.unregister(address);
	}

	async closeTransport(): Promise<void> {
		if (this.#transportClosed) return;
		this.#transportClosed = true;
		const transport = this.#transport;
		this.#transportAddresses.clear();
		if (transport) await transport.close();
	}

	async #receiveTransportEnvelope(rawEnvelope: MessageEnvelope, address: SessionAddress): Promise<void> {
		if (this.#transportClosed) return;
		let envelope: MessageEnvelope;
		try {
			envelope = parseMessageEnvelope(rawEnvelope);
		} catch {
			return;
		}
		if (envelope.destination.generation !== address.generation) return;
		const payload = parseIrcTransportPayload(envelope.body.kind === "payload" ? envelope.body.payload : undefined);
		if (!payload) return;
		const ref = this.#registry.getByAddress(envelope.destination);
		if (!ref) return;
		const msg: IrcMessage = {
			id: envelope.id,
			from: payload.from,
			to: ref.id,
			body: payload.body,
			ts: envelope.createdAt,
			...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
			remoteSource: envelope.source,
		};
		await this.#deliverLocally(msg, { expectsReply: payload.expectsReply }, true);
	}

	async #deliverLocally(message: IrcMessage, opts?: { expectsReply?: boolean }, queueIfUnavailable = false): Promise<"injected" | "woken" | undefined> {
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			return "injected";
		}
		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			if (queueIfUnavailable) this.#enqueue(message);
			return undefined;
		}
		return session.deliverIrcMessage(message, opts);
	}

	/**
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts" | "to"> & { to: IrcTarget },
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, to: typeof msg.to === "string" ? msg.to : msg.to.session, id: Snowflake.next(), ts: Date.now() };
		const targetAddress = typeof msg.to === "string" ? undefined : msg.to;
		// A bare string is normally an agent id, but it may be a published bridge-address session (Main's real session id). Ids win.
		const directRef = targetAddress ? undefined : this.#registry.get(message.to);
		const sessionRef = targetAddress || directRef ? undefined : this.#registry.getBySession(message.to);
		const ref = targetAddress ? this.#registry.getByAddress(targetAddress) : (directRef ?? sessionRef);
		if (sessionRef) message.to = sessionRef.id;
		if (!ref && targetAddress && this.#transport && this.#localAddress) {
			const source = this.#registry.get(message.from)?.address ?? this.#localAddress;
			const envelope = createMessageEnvelope({
				id: message.id,
				source,
				destination: targetAddress,
				body: {
					kind: "payload",
					payload: {
						kind: "irc-message",
						from: message.from,
						body: message.body,
						...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
						...(opts?.expectsReply === undefined ? {} : { expectsReply: opts.expectsReply }),
					},
				},
				sequence: 1,
				idempotencyKey: message.id,
				createdAt: message.ts,
			});
			const result = await this.#transport.send(envelope);
			return this.#remoteReceipt(message.to, result);
		}
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}
		// A session id that resolved to a ref with no live session lives in another process: route it over the
		// transport envelope path (mirroring the address-object branch above) instead of failing it locally.
		// Parked refs stay on the lifecycle-revival path below, exactly like an id send.
		if (sessionRef && !ref.session && ref.status !== "parked" && this.#transport && this.#localAddress) {
			const source = this.#registry.get(message.from)?.address ?? this.#localAddress;
			const envelope = createMessageEnvelope({
				id: message.id,
				source,
				destination: ref.address,
				body: {
					kind: "payload",
					payload: {
						kind: "irc-message",
						from: message.from,
						body: message.body,
						...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
						...(opts?.expectsReply === undefined ? {} : { expectsReply: opts.expectsReply }),
					},
				},
				sequence: 1,
				idempotencyKey: message.id,
				createdAt: message.ts,
			});
			const result = await this.#transport.send(envelope);
			return this.#remoteReceipt(message.to, result);
		}

		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				return { to: message.to, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
			}
		}

		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			this.#enqueue(message);
			return { to: message.to, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
		}
	}

	#remoteReceipt(to: string, result: TransportDeliveryState): IrcDeliveryReceipt {
		switch (result.kind) {
			case "delivered":
				return { to, outcome: "injected" };
			case "queued":
				return { to, outcome: "woken" };
			case "backpressure":
				return { to, outcome: "failed", error: `Transport backpressure (${result.bytes}/${result.limit} bytes).` };
			case "dead-letter":
				return { to, outcome: "failed", error: result.reason };
			case "stale-generation":
				return { to, outcome: "failed", error: `Transport stale generation (expected ${result.expected}, actual ${result.actual ?? "unknown"}).` };
			case "rejected":
				return { to, outcome: "failed", error: result.reason };
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: {
			drainPending?: boolean;
			liveness?: { registry: AgentRegistry; senderId: string };
			awaitTarget?: { registry: AgentRegistry; target: string };
		},
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let unsubscribeAwaitTarget: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
			unsubscribeAwaitTarget?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry.listVisibleTo(senderId).some(ref => registry.isRunning(ref) && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		// `send await:true`: settle the sender promptly once the awaited peer
		// reaches a terminal stop without replying, instead of stranding it on
		// the full timeout. Unlike `liveness`, this tolerates a peer that is
		// idle/parked when the send lands (the send is about to wake or revive
		// it): it only aborts once the peer has actually been observed running
		// and then stopped, or is unambiguously gone (unregistered / aborted).
		// A real reply resolves the waiter first (the recipient sends it mid-turn,
		// before the turn-end idle transition), so cleanup tears this down.
		const awaitTarget = options?.awaitTarget;
		if (awaitTarget) {
			const { registry, target } = awaitTarget;
			let subscribedSession: AgentSession | null = null;
			let unsubscribeSession: (() => void) | undefined;
			let active = true;
			// The peer's terminal `agent_end` is the authoritative "stopped" signal.
			// It is emitted only after the peer's prompt fully unwinds (see
			// AgentSession#flushPendingAgentEnd) and supersedes scheduled
			// continuations. A side-channel auto-reply may outlive that main turn,
			// though, so wait for it before declaring the peer stopped: its bus send
			// resolves this waiter first; an empty/failed reply then falls through to
			// the clean stopped result.
			const onSessionEvent = (event: AgentSessionEvent): void => {
				if (event.type !== "agent_end" || event.isTerminal === false) return;
				const session = subscribedSession;
				if (!session) {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				void session.waitForIrcAutoReplies().then(() => {
					if (!active || (registry.get(target) ?? registry.getBySession(target))?.session !== session) return;
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
				});
			};
			const sync = (): void => {
				const ref = registry.get(target) ?? registry.getBySession(target);
				// Gone or hard-aborted: no reply will ever come.
				if (!ref || ref.status === "aborted") {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				// Follow the live session across a park→revive rebuild; tolerate a
				// parked peer with no session yet (the send is about to revive it).
				const session = ref.session;
				if (session && session !== subscribedSession) {
					unsubscribeSession?.();
					subscribedSession = session;
					unsubscribeSession = session.subscribe(onSessionEvent);
				}
			};
			const unsubscribeChange = registry.onChange(sync);
			unsubscribeAwaitTarget = () => {
				active = false;
				unsubscribeChange();
				unsubscribeSession?.();
			};
			sync();
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block: peeking with `inbox` and consuming afterwards would open a window
	 * for a concurrent consumer of the same mailbox to take the message in
	 * between, and a plain `inbox` drain would swallow the whole backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, from);
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
