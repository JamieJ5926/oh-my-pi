// net.Socket transport for the explicit harness NDJSON codec. Correlates
// replies by `reply_to`, fans reply_to-less events out in arrival order, and
// lifecycle policy (retries, handshakes) belongs to callers.
import * as net from "node:net";
import { HarnessDecoder, encodeClientFrame, type HarnessEvent, type HarnessRequest, type HarnessServerFrame } from "./harness-protocol";

/** Typed error for correlated harness error replies. */
export class HarnessRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly reply_to: number,
	) {
		super(message);
		this.name = "HarnessRequestError";
	}
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HarnessRequestOptions {
	/** Reject the request if no reply arrives within this many milliseconds. */
	readonly timeoutMs?: number;
	/** Abort the request; removes the pending entry and rejects once. */
	readonly signal?: AbortSignal;
}

export interface HarnessConnection {
	/** Send a request; resolves with the reply event or rejects on error reply / timeout / abort / death / close. */
	request(req: HarnessRequest, options?: HarnessRequestOptions): Promise<HarnessEvent>;
	onEvent(listener: (event: HarnessEvent) => void): () => void;
	/** Fired exactly once when the connection dies (socket error/end/close or explicit close). */
	onDeath(listener: (error?: Error) => void): () => void;
	close(): void;
}

interface PendingRequest {
	resolve: (event: HarnessEvent) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
	signal: AbortSignal | undefined;
	abortHandler: (() => void) | undefined;
}

export class HarnessSocketTransport implements HarnessConnection {
	readonly #socket: net.Socket;
	readonly #decoder = new HarnessDecoder();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #eventListeners = new Set<(event: HarnessEvent) => void>();
	readonly #deathListeners = new Set<(error?: Error) => void>();
	#nextId = 0;
	#dead = false;
	#socketDestroyed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#onData(chunk));
		socket.on("error", (error: Error) => this.#die(error));
		socket.on("end", () => this.#die());
		socket.on("close", () => this.#die());
	}

	#onData(chunk: string): void {
		for (const frame of this.#decoder.push(chunk)) {
			this.#dispatch(frame);
		}
	}

	#dispatch(frame: HarnessServerFrame): void {
		if (frame.reply_to !== undefined) {
			const pending = this.#pending.get(frame.reply_to);
			if (pending === undefined) return; // stale reply for an already-settled request
			if (frame.ev === "error") {
				this.#settle(frame.reply_to, pending, new HarnessRequestError(frame.code, frame.message, frame.reply_to));
			} else {
				this.#settle(frame.reply_to, pending, undefined, frame);
			}
			return;
		}
		for (const listener of this.#eventListeners) {
			listener(frame);
		}
	}

	/** Remove pending state (timer, abort listener, map entry), then settle the promise exactly once. */
	#settle(id: number, pending: PendingRequest, error?: Error, event?: HarnessServerFrame): void {
		if (this.#pending.get(id) !== pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal !== undefined && pending.abortHandler !== undefined) {
			pending.signal.removeEventListener("abort", pending.abortHandler);
		}
		if (error === undefined) {
			pending.resolve(event as HarnessEvent);
		} else {
			pending.reject(error);
		}
	}

	request(req: HarnessRequest, options?: HarnessRequestOptions): Promise<HarnessEvent> {
		if (this.#dead || this.#nextId >= Number.MAX_SAFE_INTEGER) {
			return Promise.reject(new Error(this.#dead ? "harness connection is dead" : "harness request id exhausted"));
		}
		const signal = options?.signal;
		if (signal?.aborted) {
			return Promise.reject(new Error("harness request aborted before send"));
		}
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<HarnessEvent>();
		const pending: PendingRequest = { resolve, reject, timer: undefined, signal, abortHandler: undefined };
		const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		pending.timer = setTimeout(
			() => this.#settle(id, pending, new Error(`harness request timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		pending.timer.unref?.();
		if (signal !== undefined) {
			pending.abortHandler = () => this.#settle(id, pending, new Error("harness request aborted"));
			signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		this.#pending.set(id, pending);
		try {
			this.#socket.write(encodeClientFrame(id, req));
		} catch (error) {
			this.#settle(id, pending, error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onDeath(listener: (error?: Error) => void): () => void {
		if (this.#dead) {
			listener();
			return () => undefined;
		}
		this.#deathListeners.add(listener);
		return () => this.#deathListeners.delete(listener);
	}

	close(): void {
		this.#die();
	}

	#die(error?: Error): void {
		if (this.#dead) return;
		this.#dead = true;
		if (!this.#socketDestroyed) {
			this.#socketDestroyed = true;
			this.#socket.destroy();
		}
		const failure = error ?? new Error("harness connection closed");
		const entries = [...this.#pending.entries()];
		for (const [id, entry] of entries) {
			this.#settle(id, entry, failure);
		}
		const listeners = [...this.#deathListeners];
		this.#deathListeners.clear();
		for (const listener of listeners) {
			listener(error);
		}
	}
}
