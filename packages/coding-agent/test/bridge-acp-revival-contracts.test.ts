import { describe, expect, it } from "bun:test";
import { createJCodeBackend, type JCodeBackendOptions, type JCodeHarnessConnection } from "../src/bridge/index.js";
import { HARNESS_PROTOCOL_VERSION, type HarnessEvent, type HarnessRequest } from "../src/bridge/backends/jcode/harness-protocol";

class StructuredConnection implements JCodeHarnessConnection {
	readonly requests: HarnessRequest[] = [];
	readonly #listeners = new Set<(event: HarnessEvent) => void>();
	#nextSession = 0;

	async request(request: HarnessRequest): Promise<HarnessEvent> {
		this.requests.push(request);
		switch (request.req) {
			case "hello":
				return { ev: "hello_ok", version: HARNESS_PROTOCOL_VERSION, server: "test" };
			case "create_session":
				return { ev: "attached", session: { session_id: `harness-${++this.#nextSession}`, status: "ready" } };
			case "attach_session":
				return { ev: "attached", session: { session_id: request.session_id, status: "ready" } };
			case "send_message":
				if (request.content !== "long-running") {
					this.emit({ ev: "text_delta", session_id: request.session_id, text: `reply-${request.session_id}` });
					this.emit({ ev: "token_usage", session_id: request.session_id, input: 2, output: 3 });
					this.emit({ ev: "turn_done", session_id: request.session_id });
				}
				return { ev: "message_accepted", session_id: request.session_id };
			case "cancel":
				this.emit({ ev: "turn_done", session_id: request.session_id });
				return { ev: "ok" };
			default:
				return { ev: "ok" };
		}
	}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onDeath(): () => void { return () => undefined; }
	close(): void {}

	private emit(event: HarnessEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function options(connection: StructuredConnection): JCodeBackendOptions {
	return { cwd: process.cwd(), provider: "provider-a", model: "model-a", connectionFactory: async () => connection };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) result.push(item);
	return result;
}

describe("bridge harness revival contracts", () => {
	it("keeps per-address sessions isolated and attributes structured events", async () => {
		const connection = new StructuredConnection();
		const backend = createJCodeBackend(options(connection));
		const left = await backend.start({ provider: "provider-left", model: "model-left" });
		const right = await backend.start({ provider: "provider-right", model: "model-right" });
		expect(left.address.sessionId).not.toBe(right.address.sessionId);
		expect(left.address.generation).toBe(right.address.generation);
		const [leftResult, rightResult] = await Promise.all([left.prompt("left"), right.prompt("right")]);
		expect(leftResult.output).toBe(`reply-${left.address.sessionId}`);
		expect(rightResult.output).toBe(`reply-${right.address.sessionId}`);
		expect(leftResult.requestedProvider).toBe("provider-left");
		expect(rightResult.requestedModel).toBe("model-right");
		const leftEvents = await collect(left.events);
		expect(leftEvents.map(event => event.kind)).toEqual(["text-delta", "usage", "terminal"]);
		await backend.close();
	});

	it("cancels and reattaches one harness session without affecting its sibling", async () => {
		const connection = new StructuredConnection();
		const backend = createJCodeBackend(options(connection));
		const cancelled = await backend.start({ sessionId: "resume-me", resume: true });
		const sibling = await backend.start({ sessionId: "stay-running", resume: true });
		const pending = cancelled.prompt("long-running");
		await cancelled.cancel();
		expect((await pending).stopReason).toBe("cancelled");
		expect(connection.requests.some(request => request.req === "cancel" && request.session_id === "resume-me")).toBe(true);
		await cancelled.resume();
		expect(connection.requests.some(request => request.req === "attach_session" && request.session_id === "resume-me")).toBe(true);
		expect(sibling.state.kind).toBe("running");
		await cancelled.dispose();
		await sibling.dispose();
		await backend.close();
	});
});
