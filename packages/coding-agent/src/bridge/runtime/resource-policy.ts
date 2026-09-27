import { utf8ByteLength } from "./contracts";

export interface ResourcePolicy {
	readonly maxInferenceWorkers: number;
	readonly maxQueuedExecutions: number;
	readonly maxQueuedBytes: number;
	readonly maxResultBytes: number;
	readonly maxEventBytes: number;
	readonly maxEventsPerExecution: number;
	readonly maxRssBytes?: number;
}

export interface ResourceSnapshot {
	readonly runningWorkers: number;
	readonly queuedExecutions: number;
	readonly admittedExecutions: number;
	readonly queuedBytes: number;
	readonly resultBytes: number;
	readonly rssBytes?: number;
	readonly overflowedExecutions: number;
}

export type ResourceAdmission =
	| { readonly kind: "admitted"; readonly reservationId: string }
	| { readonly kind: "queued"; readonly reservationId: string; readonly position: number }
	| { readonly kind: "rejected"; readonly reason: "queue-full" | "queue-bytes" | "rss-limit" | "invalid-request" };

export type ResourceTransition =
	| { readonly kind: "queued"; readonly id: string; readonly bytes: number }
	| { readonly kind: "admitted"; readonly id: string }
	| { readonly kind: "running"; readonly id: string }
	| { readonly kind: "terminal"; readonly id: string; readonly resultBytes: number }
	| { readonly kind: "cancelled"; readonly id: string }
	| { readonly kind: "overflow"; readonly id: string; readonly droppedBytes: number };

interface Entry {
	readonly id: string;
	readonly bytes: number;
	state: "queued" | "admitted" | "running" | "terminal" | "cancelled" | "overflow";
}

function positiveInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

export class ResourceAdmissionController {
	readonly #policy: ResourcePolicy;
	readonly #entries = new Map<string, Entry>();
	#runningWorkers = 0;
	#queuedBytes = 0;
	#resultBytes = 0;
	#rssBytes: number | undefined;

	constructor(policy: ResourcePolicy) {
		this.#policy = {
			...policy,
			maxInferenceWorkers: positiveInteger("maxInferenceWorkers", policy.maxInferenceWorkers),
			maxQueuedExecutions: positiveInteger("maxQueuedExecutions", policy.maxQueuedExecutions),
			maxQueuedBytes: positiveInteger("maxQueuedBytes", policy.maxQueuedBytes),
			maxResultBytes: positiveInteger("maxResultBytes", policy.maxResultBytes),
			maxEventBytes: positiveInteger("maxEventBytes", policy.maxEventBytes),
			maxEventsPerExecution: positiveInteger("maxEventsPerExecution", policy.maxEventsPerExecution),
		};
	}

	get policy(): ResourcePolicy { return this.#policy; }
	setRssBytes(rssBytes: number | undefined): void {
		if (rssBytes !== undefined && (!Number.isSafeInteger(rssBytes) || rssBytes < 0)) throw new Error("rssBytes must be a non-negative integer");
		this.#rssBytes = rssBytes;
	}

	snapshot(): ResourceSnapshot {
		let queuedExecutions = 0;
		let admittedExecutions = 0;
		let overflowedExecutions = 0;
		for (const entry of this.#entries.values()) {
			if (entry.state === "queued") queuedExecutions++;
			if (entry.state === "admitted" || entry.state === "running") admittedExecutions++;
			if (entry.state === "overflow") overflowedExecutions++;
		}
		return { runningWorkers: this.#runningWorkers, queuedExecutions, admittedExecutions, queuedBytes: this.#queuedBytes, resultBytes: this.#resultBytes, rssBytes: this.#rssBytes, overflowedExecutions };
	}

	admit(id: string, requestBytes: number): ResourceAdmission {
		if (!id || this.#entries.has(id) || !Number.isSafeInteger(requestBytes) || requestBytes < 0) return { kind: "rejected", reason: "invalid-request" };
		if (this.#policy.maxRssBytes !== undefined && this.#rssBytes !== undefined && this.#rssBytes > this.#policy.maxRssBytes) return { kind: "rejected", reason: "rss-limit" };
		const queued = [...this.#entries.values()].filter(entry => entry.state === "queued");
		if (this.#runningWorkers < this.#policy.maxInferenceWorkers) {
			this.#entries.set(id, { id, bytes: requestBytes, state: "admitted" });
			return { kind: "admitted", reservationId: id };
		}
		if (queued.length >= this.#policy.maxQueuedExecutions) return { kind: "rejected", reason: "queue-full" };
		if (this.#queuedBytes + requestBytes > this.#policy.maxQueuedBytes) return { kind: "rejected", reason: "queue-bytes" };
		this.#entries.set(id, { id, bytes: requestBytes, state: "queued" });
		this.#queuedBytes += requestBytes;
		return { kind: "queued", reservationId: id, position: queued.length };
	}

	transition(transition: ResourceTransition): void {
		const entry = this.#entries.get(transition.id);
		if (!entry) throw new Error(`Unknown resource reservation: ${transition.id}`);
		switch (transition.kind) {
			case "queued":
				if (entry.state !== "queued") throw new Error("Only a queued reservation can be queued");
				break;
			case "admitted":
				if (entry.state !== "queued" && entry.state !== "admitted") throw new Error("Invalid admitted transition");
				if (entry.state === "queued") this.#queuedBytes -= entry.bytes;
				entry.state = "admitted";
				break;
			case "running":
				if (entry.state !== "admitted") throw new Error("Only admitted work can run");
				if (this.#runningWorkers >= this.#policy.maxInferenceWorkers) throw new Error("Inference worker limit exceeded");
				entry.state = "running";
				this.#runningWorkers++;
				break;
			case "terminal":
				if (entry.state === "running") this.#runningWorkers--;
				if (entry.state === "queued") this.#queuedBytes -= entry.bytes;
				if (!Number.isSafeInteger(transition.resultBytes) || transition.resultBytes < 0) throw new Error("Invalid result byte count");
				this.#resultBytes += Math.min(transition.resultBytes, this.#policy.maxResultBytes);
				entry.state = "terminal";
				break;
			case "cancelled":
				if (entry.state === "running") this.#runningWorkers--;
				if (entry.state === "queued") this.#queuedBytes -= entry.bytes;
				entry.state = "cancelled";
				break;
			case "overflow":
				if (entry.state === "running") this.#runningWorkers--;
				if (entry.state === "queued") this.#queuedBytes -= entry.bytes;
				entry.state = "overflow";
				break;
			default: { const exhaustive: never = transition; return exhaustive; }
		}
	}

	boundResult(value: string): { readonly output: string; readonly bytes: number; readonly overflow: boolean } {
		const bytes = utf8ByteLength(value);
		if (bytes <= this.#policy.maxResultBytes) return { output: value, bytes, overflow: false };
		let output = "";
		for (const character of value) {
			const next = output + character;
			if (utf8ByteLength(next) > this.#policy.maxResultBytes) break;
			output = next;
		}
		return { output, bytes: utf8ByteLength(output), overflow: true };
	}
}
