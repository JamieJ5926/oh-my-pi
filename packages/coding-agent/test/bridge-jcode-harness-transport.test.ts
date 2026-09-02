import * as net from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import {
	encodeServerFrame,
	type HarnessEvent,
	type HarnessServerFrame,
} from "../src/bridge/backends/jcode/harness-protocol";
import { HarnessRequestError, HarnessSocketTransport } from "../src/bridge/backends/jcode/harness-transport";

interface ServerHarness {
	port: number;
	/** Bytes exactly as received by the server, concatenated in arrival order. */
	received: string;
	/** Write raw bytes to the connected client socket. */
	send(data: string): void;
	destroyClient(): void;
	accepted: Promise<void>;
	close(): Promise<void>;
}

function startServer(onConnection?: (socket: net.Socket) => void): Promise<ServerHarness> {
	return new Promise(resolveServer => {
		let clientSocket: net.Socket | undefined;
		let received = "";
		const { promise: accepted, resolve: resolveAccepted } = Promise.withResolvers<void>();
		const server = net.createServer(socket => {
			clientSocket = socket;
			resolveAccepted();
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				received += chunk;
			});
			onConnection?.(socket);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("no tcp address");
			resolveServer({
				port: address.port,
				accepted,
				get received() {
					return received;
				},
				send(data: string) {
					if (clientSocket === undefined) throw new Error("server has not accepted the client");
					clientSocket.write(data);
				},
				destroyClient() {
					if (clientSocket === undefined) throw new Error("server has not accepted the client");
					clientSocket.destroy();
				},
				close: () =>
					new Promise<void>(resolveClose => {
						clientSocket?.destroy();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}

const servers: ServerHarness[] = [];
afterEach(async () => {
	while (servers.length > 0) {
		await servers.pop()?.close();
	}
});

async function connect(): Promise<{ h: ServerHarness; t: HarnessSocketTransport }> {
	const h = await startServer();
	servers.push(h);
	const socket = net.connect(h.port, "127.0.0.1");
	await new Promise<void>(resolveConnect => socket.once("connect", resolveConnect));
	await h.accepted;
	return { h, t: new HarnessSocketTransport(socket) };
}

function sendBytes(h: ServerHarness, frame: HarnessServerFrame): void {
	h.send(encodeServerFrame(frame));
}

/** Await a promise that may reject, returning the value or the error. */
function settle(pending: Promise<unknown>): Promise<unknown> {
	return pending.then(
		value => value,
		(error: unknown) => error,
	);
}

describe("harness socket transport", () => {
	it("sends exact newline-terminated client bytes to the server", async () => {
		const { h, t } = await connect();
		const pending = t.request({ req: "ping" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		await pending;
		expect(h.received).toBe('{"v":1,"id":0,"req":"ping"}\n');
	});

	it("correlates out-of-order replies to the right requests", async () => {
		const { h, t } = await connect();
		const p0 = t.request({ req: "ping" });
		const p1 = t.request({ req: "ping" });
		const p2 = t.request({ req: "ping" });
		sendBytes(h, { v: 1, reply_to: 2, ev: "ok" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		sendBytes(h, { v: 1, reply_to: 1, ev: "ok" });
		const replies = await Promise.all([p0, p1, p2]);
		expect(replies.map(reply => (reply as HarnessServerFrame).reply_to)).toEqual([0, 1, 2]);
	});

	it("fans reply_to-less events to listeners in order while streaming interleaves with replies", async () => {
		const { h, t } = await connect();
		const events: HarnessEvent[] = [];
		t.onEvent(event => events.push(event));
		const pending = t.request({ req: "send_message", session_id: "s1", content: "hi" });
		sendBytes(h, { v: 1, ev: "text_delta", session_id: "s1", text: "he" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "message_accepted", session_id: "s1" });
		sendBytes(h, { v: 1, ev: "text_delta", session_id: "s1", text: "llo" });
		sendBytes(h, { v: 1, ev: "turn_done", session_id: "s1" });
		expect((await pending) as unknown).toEqual({ v: 1, reply_to: 0, ev: "message_accepted", session_id: "s1" });
		expect(events.map(e => e.ev)).toEqual(["text_delta", "text_delta", "turn_done"]);
		expect(events[0]).toMatchObject({ text: "he" });
	});

	it("delivers frames split across arbitrary socket chunks", async () => {
		const { h, t } = await connect();
		const pending = t.request({ req: "ping" });
		const line = encodeServerFrame({ v: 1, reply_to: 0, ev: "ok" });
		h.send(line.slice(0, 7));
		h.send(line.slice(7, 20));
		h.send(line.slice(20));
		expect((await pending) as unknown).toEqual({ v: 1, reply_to: 0, ev: "ok" });
	});

	it("converts correlated error replies into typed errors", async () => {
		const { h, t } = await connect();
		const rejectionPromise = t.request({ req: "attach_session", session_id: "missing" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "error", code: "unknown_session", message: "no such session" });
		const error = await settle(rejectionPromise);
		expect(error).toBeInstanceOf(HarnessRequestError);
		expect(error).toMatchObject({ code: "unknown_session", message: "no such session", reply_to: 0 });
	});

	it("leaves unsolicited error events observable to listeners instead of rejecting requests", async () => {
		const { h, t } = await connect();
		const events: HarnessEvent[] = [];
		t.onEvent(event => events.push(event));
		const pending = t.request({ req: "ping" });
		sendBytes(h, { v: 1, ev: "error", code: "internal", message: "unsolicited" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		await pending;
		expect(events as unknown).toEqual([{ v: 1, ev: "error", code: "internal", message: "unsolicited" }]);
	});

	it("delivers unknown event kinds as decoded unknown events", async () => {
		const { h, t } = await connect();
		const delivered = Promise.withResolvers<HarnessEvent>();
		t.onEvent(event => delivered.resolve(event));
		h.send('{"v":1,"ev":"future_thing","payload":{"x":1}}\n');
		expect((await delivered.promise) as unknown).toEqual({
			v: 1,
			ev: "unknown",
			raw: { v: 1, ev: "future_thing", payload: { x: 1 } },
		});
	});

	it("rejects pending requests once on socket death, fires onDeath exactly once, and rejects later requests", async () => {
		const { h, t } = await connect();
		const pending = t.request({ req: "ping" });
		const deaths: (Error | undefined)[] = [];
		t.onDeath(error => deaths.push(error));
		h.destroyClient();
		const rejection = await settle(pending);
		expect(rejection).toBeInstanceOf(Error);
		await Bun.sleep(20); // error/end/close all fire; duplicates must be collapsed
		expect(deaths.length).toBe(1);
		await expect(t.request({ req: "ping" })).rejects.toThrow("dead");
	});

	it("rejects pending requests and fires onDeath exactly once on explicit close", async () => {
		const { t } = await connect();
		const pending = t.request({ req: "ping" });
		const deaths: (Error | undefined)[] = [];
		t.onDeath(error => deaths.push(error));
		t.close();
		t.close(); // second close must be a no-op
		expect(await settle(pending)).toBeInstanceOf(Error);
		await Bun.sleep(20);
		expect(deaths.length).toBe(1);
		await expect(t.request({ req: "ping" })).rejects.toThrow("dead");
	});

	it("stops firing onDeath after the listener unsubscribes", async () => {
		const { t } = await connect();
		const deaths: (Error | undefined)[] = [];
		const unsubscribe = t.onDeath(error => deaths.push(error));
		unsubscribe();
		t.close();
		await Bun.sleep(20); // death fires on socket close; no exposed signal to await
		expect(deaths).toEqual([]);
	});
});

describe("harness request lifecycle", () => {
	it("rejects a request once on timeout and ignores a late reply", async () => {
		const { h, t } = await connect();
		const pending = t.request({ req: "ping" }, { timeoutMs: 20 });
		const settled = settle(pending);
		const rejection = await settled;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toContain("timed out");
		// late reply must not crash or resolve anything
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		await Bun.sleep(20);
	});

	it("rejects an already-aborted signal before sending anything", async () => {
		const { h, t } = await connect();
		const controller = new AbortController();
		controller.abort();
		const error = await settle(t.request({ req: "ping" }, { signal: controller.signal }));
		expect((error as Error).message).toContain("aborted");
		await h.accepted; // nothing was written; received stays empty
		expect(h.received).toBe("");
	});

	it("rejects on mid-flight abort, deletes pending state, and ignores the late reply", async () => {
		const { h, t } = await connect();
		const controller = new AbortController();
		const pending = t.request({ req: "ping" }, { signal: controller.signal });
		const settled = settle(pending);
		controller.abort();
		const rejection = await settled;
		expect((rejection as Error).message).toContain("aborted");
		// request bytes were still sent; the late reply is ignored
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		expect(await settle(pending)).toBe(rejection); // promise already settled once
	});

	it("rejects on abort and applies the default timeout to requests without options", async () => {
		const { h, t } = await connect();
		const controller = new AbortController();
		const pending = t.request({ req: "ping" });
		const aborted = t.request({ req: "ping" }, { signal: controller.signal });
		controller.abort();
		expect(((await settle(aborted)) as Error).message).toContain("aborted");
		// default timeout is finite: kill the server so the first request can never be replied to
		await h.close();
		expect(await settle(pending)).toBeInstanceOf(Error);
	});

	it("clears pending timers and abort listeners on connection death", async () => {
		const { h, t } = await connect();
		const controller = new AbortController();
		let abortHandled = false;
		// externally-observable listener: if the transport removed its handler, ours is the only one
		const pending = t.request({ req: "ping" }, { timeoutMs: 5, signal: controller.signal });
		controller.signal.addEventListener("abort", () => {
			abortHandled = true;
		});
		h.destroyClient();
		const rejection = await settle(pending);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).not.toContain("timed out");
		await Bun.sleep(50); // timer would have fired at 5ms if not cleared
		controller.abort();
		expect(abortHandled).toBe(true);
	});

	it("keeps correlation intact when options are passed", async () => {
		const { h, t } = await connect();
		const controller = new AbortController();
		const p0 = t.request({ req: "ping" }, { timeoutMs: 1000, signal: controller.signal });
		const p1 = t.request({ req: "ping" }, { timeoutMs: 1000 });
		sendBytes(h, { v: 1, reply_to: 1, ev: "ok" });
		sendBytes(h, { v: 1, reply_to: 0, ev: "ok" });
		const replies = await Promise.all([p0, p1]);
		expect(replies.map(reply => (reply as HarnessServerFrame).reply_to)).toEqual([0, 1]);
	});
});
