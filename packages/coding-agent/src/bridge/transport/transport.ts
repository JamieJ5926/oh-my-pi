import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
	formatSessionAddress,
	formatSessionIdentity,
	parseMessageEnvelope,
	parseSessionAddress,
} from "../core/index.js";
import type { MessageEnvelope, SessionAddress } from "../core/index.js";

export type TransportDeliveryState =
	| { readonly kind: "delivered"; readonly messageId: string }
	| { readonly kind: "queued"; readonly messageId: string; readonly nextAttemptAt: number }
	| { readonly kind: "backpressure"; readonly messageId: string; readonly bytes: number; readonly limit: number }
	| { readonly kind: "dead-letter"; readonly messageId: string; readonly reason: string }
	| {
			readonly kind: "stale-generation";
			readonly messageId: string;
			readonly expected: number;
			readonly actual?: number;
	  }
	| { readonly kind: "rejected"; readonly messageId: string; readonly reason: string };

export interface TransportLimits {
	readonly maxEnvelopeBytes?: number;
	readonly maxQueueBytes?: number;
	readonly maxJournalBytes?: number;
	readonly maxAttempts?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
}

export type TransportHandler = (envelope: MessageEnvelope) => void | Promise<void>;

export interface TransportAdapter {
	register(address: SessionAddress, handler: TransportHandler): Promise<void>;
	send(envelope: MessageEnvelope): Promise<TransportDeliveryState>;
	unregister(address: SessionAddress): Promise<void>;
	close(): Promise<void>;
}

interface JournalEntry {
	readonly envelope: MessageEnvelope;
	readonly attempts: number;
	readonly nextAttemptAt: number;
}

interface DeadLetterEntry {
	readonly envelope: MessageEnvelope;
	readonly attempts: number;
	readonly reason: string;
	readonly deadLetteredAt: number;
}

function deadLetterLine(entry: DeadLetterEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

async function appendDeadLetter(file: string, entry: DeadLetterEntry): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, deadLetterLine(entry), "utf8");
}
const DEFAULT_LIMITS: Required<TransportLimits> = {
	maxEnvelopeBytes: 2 * 1024 * 1024,
	maxQueueBytes: 16 * 1024 * 1024,
	maxJournalBytes: 64 * 1024 * 1024,
	maxAttempts: 12,
	retryBaseMs: 250,
	retryMaxMs: 30_000,
};

function limitsOf(input?: TransportLimits): Required<TransportLimits> {
	const value = { ...DEFAULT_LIMITS, ...input };
	for (const key of [
		"maxEnvelopeBytes",
		"maxQueueBytes",
		"maxJournalBytes",
		"maxAttempts",
		"retryBaseMs",
		"retryMaxMs",
	] as const) {
		if (!Number.isSafeInteger(value[key]) || value[key] <= 0) value[key] = DEFAULT_LIMITS[key];
	}
	if (value.retryMaxMs < value.retryBaseMs) value.retryMaxMs = value.retryBaseMs;
	return value;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function addressKey(address: SessionAddress): string {
	return formatSessionIdentity(address);
}

function generationOf(address: SessionAddress): number {
	return address.generation;
}

function journalLine(entry: JournalEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

async function readJournal(file: string): Promise<JournalEntry[]> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object") continue;
			const row = value as Record<string, unknown>;
			if (typeof row.attempts !== "number" || typeof row.nextAttemptAt !== "number") continue;
			entries.push({
				envelope: parseMessageEnvelope(row.envelope),
				attempts: row.attempts,
				nextAttemptAt: row.nextAttemptAt,
			});
		} catch {
			// Ignore a torn or malformed line; complete journal entries remain usable.
		}
	}
	return entries;
}

async function appendJournal(file: string, entry: JournalEntry): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, journalLine(entry), "utf8");
}

async function compactJournal(
	file: string,
	entries: readonly JournalEntry[],
	removedIds: readonly string[] = [],
): Promise<void> {
	const current = new Map((await readJournal(file)).map(entry => [entry.envelope.id, entry]));
	for (const id of removedIds) current.delete(id);
	for (const entry of entries) current.set(entry.envelope.id, entry);
	if (current.size === 0) {
		await fs.rm(file, { force: true });
		return;
	}
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(temporary, [...current.values()].map(journalLine).join(""), "utf8");
	await fs.rename(temporary, file);
}

const journalOperations = new Map<string, Promise<void>>();

function enqueueJournalOperation(file: string, operation: () => Promise<void>): Promise<void> {
	const prior = journalOperations.get(file) ?? Promise.resolve();
	const next = prior.catch(() => undefined).then(operation);
	journalOperations.set(file, next);
	void next.then(
		() => {
			if (journalOperations.get(file) === next) journalOperations.delete(file);
		},
		() => {
			if (journalOperations.get(file) === next) journalOperations.delete(file);
		},
	);
	return next;
}

function enqueueJournalCompaction(
	file: string,
	entries: readonly JournalEntry[],
	removedIds: Set<string>,
): Promise<void> {
	const removed = [...removedIds];
	removedIds.clear();
	return enqueueJournalOperation(file, () => compactJournal(file, entries, removed));
}

function retryAt(entry: JournalEntry, limits: Required<TransportLimits>): number {
	const delay = Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** Math.min(entry.attempts, 30));
	return Date.now() + delay;
}

interface WireRegister {
	readonly type: "register";
	readonly address: string;
}
interface WireUnregister {
	readonly type: "unregister";
	readonly address: string;
}
interface WireSend {
	readonly type: "send";
	readonly envelope: unknown;
}
interface WireAck {
	readonly type: "ack";
	readonly messageId: string;
}
interface WireDelivery {
	readonly type: "delivery";
	readonly envelope: unknown;
}
interface WireAccepted {
	readonly type: "accepted";
	readonly messageId: string;
}
interface WireReject {
	readonly type: "reject";
	readonly messageId?: string;
	readonly reason: string;
	readonly expected?: number;
	readonly actual?: number;
}
type WireMessage = WireRegister | WireUnregister | WireSend | WireAck | WireDelivery | WireAccepted | WireReject;

function encodeWire(message: WireMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseWire(value: unknown): WireMessage {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid frame");
	switch (value.type) {
		case "register":
			if (typeof value.address !== "string") throw new Error("invalid register frame");
			return { type: "register", address: value.address };
		case "unregister":
			if (typeof value.address !== "string") throw new Error("invalid unregister frame");
			return { type: "unregister", address: value.address };
		case "send":
			if (!("envelope" in value)) throw new Error("invalid send frame");
			return { type: "send", envelope: value.envelope };
		case "ack":
			if (typeof value.messageId !== "string") throw new Error("invalid ack frame");
			return { type: "ack", messageId: value.messageId };
		case "delivery":
			if (!("envelope" in value)) throw new Error("invalid delivery frame");
			return { type: "delivery", envelope: value.envelope };
		case "accepted":
			if (typeof value.messageId !== "string") throw new Error("invalid accepted frame");
			return { type: "accepted", messageId: value.messageId };
		case "reject":
			if (typeof value.reason !== "string") throw new Error("invalid reject frame");
			return {
				type: "reject",
				messageId: typeof value.messageId === "string" ? value.messageId : undefined,
				reason: value.reason,
				expected: typeof value.expected === "number" ? value.expected : undefined,
				actual: typeof value.actual === "number" ? value.actual : undefined,
			};
		default:
			throw new Error("unknown frame type");
	}
}

async function loadEntries(file: string): Promise<Map<string, JournalEntry>> {
	const result = new Map<string, JournalEntry>();
	for (const entry of await readJournal(file)) result.set(entry.envelope.id, entry);
	return result;
}

/** Process-local transport with a durable undelivered-delivery journal. */
export class LocalTransportAdapter implements TransportAdapter {
	static readonly #handlers = new Map<
		string,
		{ readonly address: SessionAddress; readonly handler: TransportHandler; readonly owner: LocalTransportAdapter }
	>();
	static readonly #seen = new Map<string, Set<string>>();
	readonly #limits: Required<TransportLimits>;
	readonly #journalPath: string;
	readonly #pending = new Map<string, JournalEntry>();
	readonly #owned = new Set<string>();
	readonly #removed = new Set<string>();
	readonly #ready: Promise<void>;
	#closed = false;
	#draining = false;
	#drainTimer: ReturnType<typeof setTimeout> | undefined;
	#journalWrite: Promise<void> = Promise.resolve();

	constructor(options: { readonly journalPath: string; readonly limits?: TransportLimits }) {
		this.#journalPath = options.journalPath;
		this.#limits = limitsOf(options.limits);
		this.#ready = loadEntries(this.#journalPath).then(entries => {
			for (const [id, entry] of entries) this.#pending.set(id, entry);
			void this.#drain();
		});
	}

	async register(address: SessionAddress, handler: TransportHandler): Promise<void> {
		await this.#ready;
		if (this.#closed) throw new Error("transport is closed");
		const key = addressKey(address);
		const prior = LocalTransportAdapter.#handlers.get(key);
		if (prior && prior.owner !== this) throw new Error(`recipient already registered: ${key}`);
		LocalTransportAdapter.#handlers.set(key, { address, handler, owner: this });
		this.#owned.add(key);
		await this.#drain();
	}

	async unregister(address: SessionAddress): Promise<void> {
		await this.#ready;
		const key = addressKey(address);
		const current = LocalTransportAdapter.#handlers.get(key);
		if (current?.owner === this) LocalTransportAdapter.#handlers.delete(key);
		this.#owned.delete(key);
	}

	async send(envelope: MessageEnvelope): Promise<TransportDeliveryState> {
		await this.#ready;
		const id = envelope.id;
		if (this.#closed) return { kind: "rejected", messageId: id, reason: "transport is closed" };
		const size = serializedBytes(envelope);
		if (size > this.#limits.maxEnvelopeBytes)
			return { kind: "backpressure", messageId: id, bytes: size, limit: this.#limits.maxEnvelopeBytes };
		if (this.#pending.has(id)) return { kind: "queued", messageId: id, nextAttemptAt: Date.now() };

		const target = LocalTransportAdapter.#handlers.get(addressKey(envelope.destination));
		if (target && generationOf(target.address) !== generationOf(envelope.destination)) {
			return {
				kind: "stale-generation",
				messageId: id,
				expected: generationOf(envelope.destination),
				actual: generationOf(target.address),
			};
		}
		if (target) {
			const key = addressKey(target.address);
			const seen = LocalTransportAdapter.#seen.get(key) ?? new Set<string>();
			if (seen.has(envelope.idempotencyKey)) return { kind: "delivered", messageId: id };
			try {
				await target.handler(envelope);
				seen.add(envelope.idempotencyKey);
				if (seen.size > 4096) seen.delete(seen.values().next().value ?? envelope.idempotencyKey);
				LocalTransportAdapter.#seen.set(key, seen);
				return { kind: "delivered", messageId: id };
			} catch {
				// Failed handlers are journaled for retry below.
			}
		}
		return this.#queue(envelope, 0);
	}
	async #queue(envelope: MessageEnvelope, attempts: number): Promise<TransportDeliveryState> {
		const id = envelope.id;
		const size = serializedBytes(envelope);
		let currentBytes = 0;
		for (const entry of this.#pending.values()) currentBytes += serializedBytes(entry.envelope);
		const limit = Math.min(this.#limits.maxQueueBytes, this.#limits.maxJournalBytes);
		if (currentBytes + size > limit)
			return { kind: "backpressure", messageId: id, bytes: currentBytes + size, limit };
		const entry: JournalEntry = { envelope, attempts, nextAttemptAt: Date.now() };
		this.#pending.set(id, entry);
		this.#journalWrite = this.#journalWrite.then(() =>
			enqueueJournalOperation(this.#journalPath, () => appendJournal(this.#journalPath, entry)),
		);
		await this.#journalWrite;
		void this.#drain();
		return { kind: "queued", messageId: id, nextAttemptAt: entry.nextAttemptAt };
	}

	async #drain(): Promise<void> {
		await this.#ready.catch(() => undefined);
		if (this.#closed || this.#draining) return;
		this.#draining = true;
		try {
			let nextAt = Number.POSITIVE_INFINITY;
			for (const [id, entry] of this.#pending) {
				if (entry.nextAttemptAt > Date.now()) {
					nextAt = Math.min(nextAt, entry.nextAttemptAt);
					continue;
				}
				const target = LocalTransportAdapter.#handlers.get(addressKey(entry.envelope.destination));
				if (!target) {
					nextAt = Math.min(nextAt, Date.now() + this.#limits.retryBaseMs);
					continue;
				}
				if (generationOf(target.address) !== generationOf(entry.envelope.destination)) {
					this.#pending.delete(id);
					this.#removed.add(id);
					continue;
				}
				const key = addressKey(target.address);
				const seen = LocalTransportAdapter.#seen.get(key) ?? new Set<string>();
				if (seen.has(entry.envelope.idempotencyKey)) {
					this.#pending.delete(id);
					this.#removed.add(id);
					continue;
				}
				try {
					await target.handler(entry.envelope);
					seen.add(entry.envelope.idempotencyKey);
					if (seen.size > 4096) seen.delete(seen.values().next().value ?? entry.envelope.idempotencyKey);
					LocalTransportAdapter.#seen.set(key, seen);
					this.#pending.delete(id);
					this.#removed.add(id);
				} catch {
					const attempts = entry.attempts + 1;
					if (attempts >= this.#limits.maxAttempts) {
						this.#pending.delete(id);
						this.#removed.add(id);
					} else {
						const updated: JournalEntry = {
							envelope: entry.envelope,
							attempts,
							nextAttemptAt: retryAt(entry, this.#limits),
						};
						this.#pending.set(id, updated);
						nextAt = Math.min(nextAt, updated.nextAttemptAt);
					}
				}
			}
			this.#journalWrite = this.#journalWrite.then(() =>
				enqueueJournalCompaction(this.#journalPath, [...this.#pending.values()], this.#removed),
			);
			await this.#journalWrite;
			if (nextAt < Number.POSITIVE_INFINITY && !this.#closed) {
				if (this.#drainTimer) clearTimeout(this.#drainTimer);
				this.#drainTimer = setTimeout(
					() => {
						this.#drainTimer = undefined;
						void this.#drain();
					},
					Math.max(1, nextAt - Date.now()),
				);
			}
		} finally {
			this.#draining = false;
		}
	}

	async close(): Promise<void> {
		await this.#ready;
		this.#closed = true;
		if (this.#drainTimer) clearTimeout(this.#drainTimer);
		for (const key of this.#owned) {
			const current = LocalTransportAdapter.#handlers.get(key);
			if (current?.owner === this) LocalTransportAdapter.#handlers.delete(key);
		}
		this.#owned.clear();
	}
}

/** Client adapter for a broker speaking newline-delimited JSON over a Unix socket. */
export class BrokerBackedTransportAdapter implements TransportAdapter {
	readonly #socketPath: string;
	readonly #journalPath: string;
	readonly #limits: Required<TransportLimits>;
	readonly #pending = new Map<string, JournalEntry>();
	readonly #handlers = new Map<string, { readonly address: SessionAddress; readonly handler: TransportHandler }>();
	readonly #ready: Promise<void>;
	#socket: net.Socket | undefined;
	#buffer = "";
	#closed = false;
	#connecting: Promise<void> | undefined;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#drainTimer: ReturnType<typeof setTimeout> | undefined;
	#journalWrite: Promise<void> = Promise.resolve();

	constructor(options: {
		readonly socketPath: string;
		readonly journalPath: string;
		readonly limits?: TransportLimits;
	}) {
		this.#socketPath = options.socketPath;
		this.#journalPath = options.journalPath;
		this.#limits = limitsOf(options.limits);
		this.#ready = loadEntries(this.#journalPath).then(entries => {
			for (const [id, entry] of entries) this.#pending.set(id, entry);
			void this.#connect();
		});
	}

	async #connect(): Promise<void> {
		if (this.#closed || this.#socket?.writable) return;
		if (this.#connecting) return this.#connecting;
		this.#connecting = new Promise<void>(resolve => {
			const socket = net.createConnection(this.#socketPath);
			let settled = false;
			const finish = (): void => {
				if (!settled) {
					settled = true;
					this.#connecting = undefined;
					resolve();
				}
			};
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				if (this.#closed) {
					socket.destroy();
					finish();
					return;
				}
				this.#socket = socket;
				this.#buffer = "";
				socket.on("data", chunk => this.#onData(String(chunk)));
				socket.on("error", () => undefined);
				socket.on("close", () => {
					if (this.#socket === socket) this.#socket = undefined;
					this.#scheduleReconnect();
				});
				finish();
				void this.#flush();
			});
			socket.once("error", () => {
				socket.destroy();
				finish();
				this.#scheduleReconnect();
			});
		});
		return this.#connecting;
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#retryTimer) return;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			void this.#connect();
		}, this.#limits.retryBaseMs);
	}

	#write(message: WireMessage): boolean {
		if (!this.#socket?.writable) return false;
		const frame = encodeWire(message);
		if (Buffer.byteLength(frame, "utf8") > this.#limits.maxEnvelopeBytes + 4096) return false;
		return this.#socket.write(frame);
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		if (Buffer.byteLength(this.#buffer, "utf8") > this.#limits.maxEnvelopeBytes * 2) {
			this.#socket?.destroy(new Error("transport frame buffer exceeded limit"));
			this.#buffer = "";
			return;
		}
		for (;;) {
			const split = this.#buffer.indexOf("\n");
			if (split < 0) return;
			const line = this.#buffer.slice(0, split);
			this.#buffer = this.#buffer.slice(split + 1);
			if (!line.trim()) continue;
			if (Buffer.byteLength(line, "utf8") > this.#limits.maxEnvelopeBytes + 4096) continue;
			try {
				this.#onWire(parseWire(JSON.parse(line)));
			} catch {
				// Ignore malformed broker frames; the connection remains usable.
			}
		}
	}

	#onWire(message: WireMessage): void {
		if (message.type === "delivery") {
			let envelope: MessageEnvelope;
			try {
				envelope = parseMessageEnvelope(message.envelope);
			} catch {
				return;
			}
			if (serializedBytes(envelope) > this.#limits.maxEnvelopeBytes) return;
			const handler = this.#handlers.get(addressKey(envelope.destination));
			if (!handler || generationOf(handler.address) !== generationOf(envelope.destination)) return;
			void Promise.resolve(handler.handler(envelope))
				.then(() => {
					this.#write({ type: "ack", messageId: envelope.id });
				})
				.catch(() => undefined);
			return;
		}
		if (message.type === "accepted") {
			if (!this.#pending.delete(message.messageId)) return;
			this.#journalWrite = this.#journalWrite.then(() =>
				enqueueJournalOperation(this.#journalPath, () =>
					compactJournal(this.#journalPath, [...this.#pending.values()]),
				),
			);
			void this.#journalWrite;
			return;
		}
		if (message.type === "reject" && message.messageId) {
			this.#pending.delete(message.messageId);
			this.#journalWrite = this.#journalWrite.then(() =>
				enqueueJournalOperation(this.#journalPath, () =>
					compactJournal(this.#journalPath, [...this.#pending.values()]),
				),
			);
			void this.#journalWrite;
		}
	}

	async register(address: SessionAddress, handler: TransportHandler): Promise<void> {
		await this.#ready;
		if (this.#closed) throw new Error("transport is closed");
		this.#handlers.set(addressKey(address), { address, handler });
		await this.#connect();
		this.#write({ type: "register", address: formatSessionAddress(address) });
		await this.#flush();
	}

	async unregister(address: SessionAddress): Promise<void> {
		await this.#ready;
		this.#handlers.delete(addressKey(address));
		this.#write({ type: "unregister", address: formatSessionAddress(address) });
	}

	async send(envelope: MessageEnvelope): Promise<TransportDeliveryState> {
		await this.#ready;
		const id = envelope.id;
		if (this.#closed) return { kind: "rejected", messageId: id, reason: "transport is closed" };
		const size = serializedBytes(envelope);
		if (size > this.#limits.maxEnvelopeBytes)
			return { kind: "backpressure", messageId: id, bytes: size, limit: this.#limits.maxEnvelopeBytes };
		if (this.#pending.has(id)) return { kind: "queued", messageId: id, nextAttemptAt: Date.now() };
		let currentBytes = 0;
		for (const entry of this.#pending.values()) currentBytes += serializedBytes(entry.envelope);
		const limit = Math.min(this.#limits.maxQueueBytes, this.#limits.maxJournalBytes);
		if (currentBytes + size > limit)
			return { kind: "backpressure", messageId: id, bytes: currentBytes + size, limit };
		const entry: JournalEntry = { envelope, attempts: 0, nextAttemptAt: Date.now() };
		this.#pending.set(id, entry);
		this.#journalWrite = this.#journalWrite.then(() =>
			enqueueJournalOperation(this.#journalPath, () => appendJournal(this.#journalPath, entry)),
		);
		await this.#journalWrite;
		await this.#connect();
		await this.#flush();
		return { kind: "queued", messageId: id, nextAttemptAt: entry.nextAttemptAt };
	}

	async #flush(): Promise<void> {
		if (!this.#socket?.writable || this.#closed) {
			this.#scheduleReconnect();
			return;
		}
		const now = Date.now();
		for (const handler of this.#handlers.values())
			this.#write({ type: "register", address: formatSessionAddress(handler.address) });
		let nextAt = Number.POSITIVE_INFINITY;
		for (const [id, entry] of this.#pending) {
			if (entry.nextAttemptAt > now) {
				nextAt = Math.min(nextAt, entry.nextAttemptAt);
				continue;
			}
			if (!this.#write({ type: "send", envelope: entry.envelope })) continue;
			const updated: JournalEntry = {
				envelope: entry.envelope,
				attempts: entry.attempts + 1,
				nextAttemptAt: retryAt(entry, this.#limits),
			};
			this.#pending.set(id, updated);
			nextAt = Math.min(nextAt, updated.nextAttemptAt);
		}
		this.#journalWrite = this.#journalWrite.then(() =>
			enqueueJournalOperation(this.#journalPath, () =>
				compactJournal(this.#journalPath, [...this.#pending.values()]),
			),
		);
		await this.#journalWrite;
		if (nextAt < Number.POSITIVE_INFINITY && !this.#closed) {
			if (this.#drainTimer) clearTimeout(this.#drainTimer);
			this.#drainTimer = setTimeout(
				() => {
					this.#drainTimer = undefined;
					void this.#flush();
				},
				Math.max(1, nextAt - Date.now()),
			);
		}
	}

	async close(): Promise<void> {
		await this.#ready;
		this.#closed = true;
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		if (this.#drainTimer) clearTimeout(this.#drainTimer);
		this.#socket?.destroy();
		this.#socket = undefined;
	}
}

/** Broker server for focused deployments without another launch broker. */
export class BrokerTransportServer {
	readonly #socketPath: string;
	readonly #limits: Required<TransportLimits>;
	readonly #server: net.Server;
	readonly #registrations = new Map<string, { readonly address: SessionAddress; readonly socket: net.Socket }>();
	readonly #pending = new Map<string, JournalEntry>();
	readonly #origins = new Map<string, net.Socket>();
	readonly #seen = new Map<string, Set<string>>();
	readonly #clients = new Set<net.Socket>();
	readonly #deadLetterPath: string;
	readonly #journalPath: string;
	#journalBytes = 0;
	#journalWrite: Promise<void> = Promise.resolve();
	#redelivery: Promise<void> = Promise.resolve();
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#listening = false;

	#scheduleRetry(): void {
		if (this.#retryTimer || !this.#listening) return;
		let nextAt = Number.POSITIVE_INFINITY;
		for (const entry of this.#pending.values()) {
			const target = this.#registrations.get(addressKey(entry.envelope.destination));
			if (!target || generationOf(target.address) !== generationOf(entry.envelope.destination)) continue;
			nextAt = Math.min(nextAt, entry.nextAttemptAt);
		}
		if (nextAt === Number.POSITIVE_INFINITY) return;
		this.#retryTimer = setTimeout(
			() => {
				this.#retryTimer = undefined;
				void this.#redeliverDue();
			},
			Math.max(1, nextAt - Date.now()),
		);
	}

	async #redeliverDue(): Promise<void> {
		this.#redelivery = this.#redelivery.then(async () => {
			if (!this.#listening) return;
			const now = Date.now();
			let changed = false;
			for (const [id, entry] of this.#pending) {
				if (entry.nextAttemptAt > now) continue;
				if (entry.attempts >= this.#limits.maxAttempts) {
					this.#pending.delete(id);
					await appendDeadLetter(this.#deadLetterPath, {
						envelope: entry.envelope,
						attempts: entry.attempts,
						reason: "maximum delivery attempts exceeded",
						deadLetteredAt: Date.now(),
					});
					changed = true;
					continue;
				}
				const target = this.#registrations.get(addressKey(entry.envelope.destination));
				if (
					!target ||
					generationOf(target.address) !== generationOf(entry.envelope.destination) ||
					!target.socket.writable
				)
					continue;
				target.socket.write(encodeWire({ type: "delivery", envelope: entry.envelope }));
				const updated: JournalEntry = {
					envelope: entry.envelope,
					attempts: entry.attempts + 1,
					nextAttemptAt: retryAt(entry, this.#limits),
				};
				this.#pending.set(id, updated);
				changed = true;
			}
			if (changed && this.#listening) {
				this.#journalWrite = this.#journalWrite.then(() =>
					enqueueJournalOperation(this.#journalPath, () =>
						compactJournal(this.#journalPath, [...this.#pending.values()]),
					),
				);
				await this.#journalWrite;
			}
			if (this.#pending.size > 0) this.#scheduleRetry();
		});
		await this.#redelivery;
	}

	async #deliverPendingFor(key: string): Promise<void> {
		const target = this.#registrations.get(key);
		if (!target || !target.socket.writable) return;
		const now = Date.now();
		let changed = false;
		for (const [id, entry] of this.#pending) {
			if (
				addressKey(entry.envelope.destination) !== key ||
				generationOf(entry.envelope.destination) !== generationOf(target.address) ||
				entry.attempts >= this.#limits.maxAttempts ||
				entry.nextAttemptAt > now
			)
				continue;
			target.socket.write(encodeWire({ type: "delivery", envelope: entry.envelope }));
			this.#pending.set(id, {
				envelope: entry.envelope,
				attempts: entry.attempts + 1,
				nextAttemptAt: retryAt(entry, this.#limits),
			});
			changed = true;
		}
		if (!changed) {
			this.#scheduleRetry();
			return;
		}
		this.#journalWrite = this.#journalWrite.then(() =>
			enqueueJournalOperation(this.#journalPath, () =>
				compactJournal(this.#journalPath, [...this.#pending.values()]),
			),
		);
		await this.#journalWrite;
		this.#scheduleRetry();
	}

	constructor(options: {
		readonly socketPath: string;
		readonly journalPath: string;
		readonly limits?: TransportLimits;
	}) {
		this.#socketPath = options.socketPath;
		this.#journalPath = options.journalPath;
		this.#deadLetterPath = `${options.journalPath}.dead-letter.jsonl`;
		this.#limits = limitsOf(options.limits);
		this.#server = net.createServer(socket => this.#accept(socket));
	}

	async listen(): Promise<void> {
		for (const entry of await readJournal(this.#journalPath)) {
			this.#pending.set(entry.envelope.id, entry);
			this.#journalBytes += Buffer.byteLength(journalLine(entry), "utf8");
			const key = addressKey(entry.envelope.destination);
			const seen = this.#seen.get(key) ?? new Set<string>();
			seen.add(entry.envelope.idempotencyKey);
			this.#seen.set(key, seen);
		}
		await fs.rm(this.#socketPath, { force: true });
		await fs.mkdir(path.dirname(this.#socketPath), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.#server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.#server.off("error", onError);
				this.#listening = true;
				resolve();
			};
			this.#server.once("error", onError);
			this.#server.once("listening", onListening);
			this.#server.listen(this.#socketPath);
		});
	}

	#accept(socket: net.Socket): void {
		this.#clients.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		const onClose = (): void => {
			this.#clients.delete(socket);
			for (const [key, registration] of this.#registrations)
				if (registration.socket === socket) this.#registrations.delete(key);
			for (const [id, origin] of this.#origins) if (origin === socket) this.#origins.delete(id);
		};
		socket.on("data", chunk => {
			buffer += String(chunk);
			if (Buffer.byteLength(buffer, "utf8") > this.#limits.maxEnvelopeBytes * 2) {
				socket.destroy(new Error("transport frame buffer exceeded limit"));
				return;
			}
			for (;;) {
				const split = buffer.indexOf("\n");
				if (split < 0) break;
				const line = buffer.slice(0, split);
				buffer = buffer.slice(split + 1);
				if (!line.trim()) continue;
				if (Buffer.byteLength(line, "utf8") > this.#limits.maxEnvelopeBytes + 4096) {
					socket.write(encodeWire({ type: "reject", reason: "frame exceeds limit" }));
					continue;
				}
				try {
					void this.#handle(socket, parseWire(JSON.parse(line)));
				} catch {
					socket.write(encodeWire({ type: "reject", reason: "invalid frame" }));
				}
			}
		});
		socket.once("close", onClose);
		socket.once("error", () => undefined);
	}

	async #handle(socket: net.Socket, message: WireMessage): Promise<void> {
		if (message.type === "register") {
			let address: SessionAddress;
			try {
				address = parseSessionAddress(message.address);
			} catch {
				socket.write(encodeWire({ type: "reject", reason: "invalid address" }));
				return;
			}
			const key = addressKey(address);
			const prior = this.#registrations.get(key);
			if (prior && prior.socket !== socket && generationOf(prior.address) >= generationOf(address)) {
				socket.write(
					encodeWire({
						type: "reject",
						reason: "recipient already registered",
						expected: generationOf(address),
						actual: generationOf(prior.address),
					}),
				);
				return;
			}
			if (prior && prior.socket !== socket) this.#registrations.delete(key);
			this.#registrations.set(key, { address, socket });
			await this.#deliverPendingFor(key);
			return;
		}
		if (message.type === "unregister") {
			try {
				const address = parseSessionAddress(message.address);
				const key = addressKey(address);
				const current = this.#registrations.get(key);
				if (current?.socket === socket && generationOf(current.address) === generationOf(address))
					this.#registrations.delete(key);
			} catch {
				/* Ignore an unregister for an invalid/old address. */
			}
			return;
		}
		if (message.type === "ack") {
			if (!this.#pending.delete(message.messageId)) return;
			this.#origins.get(message.messageId)?.write(encodeWire({ type: "accepted", messageId: message.messageId }));
			this.#origins.delete(message.messageId);
			this.#journalWrite = this.#journalWrite.then(() =>
				enqueueJournalOperation(this.#journalPath, () =>
					compactJournal(this.#journalPath, [...this.#pending.values()]),
				),
			);
			await this.#journalWrite;
			this.#scheduleRetry();
			return;
		}
		if (message.type !== "send") return;
		let envelope: MessageEnvelope;
		try {
			envelope = parseMessageEnvelope(message.envelope);
		} catch {
			socket.write(encodeWire({ type: "reject", reason: "invalid envelope" }));
			return;
		}
		const id = envelope.id;
		const size = serializedBytes(envelope);
		if (size > this.#limits.maxEnvelopeBytes) {
			socket.write(encodeWire({ type: "reject", messageId: id, reason: "envelope exceeds limit" }));
			return;
		}
		const key = addressKey(envelope.destination);
		const target = this.#registrations.get(key);
		if (target && generationOf(target.address) !== generationOf(envelope.destination)) {
			socket.write(
				encodeWire({
					type: "reject",
					messageId: id,
					reason: "stale generation",
					expected: generationOf(envelope.destination),
					actual: generationOf(target.address),
				}),
			);
			return;
		}
		const seen = this.#seen.get(key) ?? new Set<string>();
		if (seen.has(envelope.idempotencyKey) || this.#pending.has(id)) {
			socket.write(encodeWire({ type: "accepted", messageId: id }));
			return;
		}
		if (
			this.#journalBytes +
				Buffer.byteLength(journalLine({ envelope, attempts: 0, nextAttemptAt: Date.now() }), "utf8") >
			this.#limits.maxJournalBytes
		) {
			socket.write(encodeWire({ type: "reject", messageId: id, reason: "journal exceeds limit" }));
			return;
		}
		seen.add(envelope.idempotencyKey);
		if (seen.size > 4096) seen.delete(seen.values().next().value ?? envelope.idempotencyKey);
		this.#seen.set(key, seen);
		const entry: JournalEntry = { envelope, attempts: 0, nextAttemptAt: Date.now() };
		this.#pending.set(id, entry);
		this.#origins.set(id, socket);
		this.#journalBytes += Buffer.byteLength(journalLine(entry), "utf8");
		this.#journalWrite = this.#journalWrite.then(() =>
			enqueueJournalOperation(this.#journalPath, () => appendJournal(this.#journalPath, entry)),
		);
		await this.#journalWrite;
		if (target?.socket.writable && generationOf(target.address) === generationOf(envelope.destination))
			await this.#deliverPendingFor(key);
		socket.write(encodeWire({ type: "accepted", messageId: id }));
	}

	async close(): Promise<void> {
		if (!this.#listening) return;
		this.#listening = false;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		await this.#redelivery;
		await this.#journalWrite;
		for (const client of this.#clients) client.destroy();
		await new Promise<void>(resolve => this.#server.close(() => resolve()));
		await fs.rm(this.#socketPath, { force: true });
		this.#registrations.clear();
		this.#clients.clear();
	}
}
