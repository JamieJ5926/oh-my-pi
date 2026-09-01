import { describe, expect, it } from "bun:test";
import { createPiBackend, type PiRpcProcess } from "../src/bridge/backends/pi";
import { encodePiCommand, parsePiFrame } from "../src/bridge/backends/pi/protocol";

describe("Pi structured backend protocol", () => {
	it("encodes request ids and parses typed response/session/events", () => {
		expect(encodePiCommand({ type: "prompt", message: "hello", id: 7 })).toBe('{"type":"prompt","message":"hello","id":7}\n');
		expect(parsePiFrame('{"type":"response","command":"prompt","success":true,"id":7}')).toEqual({ type: "response", command: "prompt", success: true, id: 7 });
		expect(parsePiFrame('{"type":"session","id":"session-1","version":3}')).toEqual({ type: "session", id: "session-1", version: 3 });
		expect(parsePiFrame('{"type":"extension_ui_request","id":"ui-1","method":"notify","message":"hello"}')).toMatchObject({ type: "extension_ui_request", id: "ui-1", method: "notify" });
	});
	it("rejects malformed and unbounded frames", () => {
		expect(() => parsePiFrame("[]")).toThrow("must be a JSON object");
		expect(() => parsePiFrame('{"type":"unknown"}')).toThrow("Unknown Pi RPC event type");
		expect(() => parsePiFrame(`{"type":"message_update","delta":"${"x".repeat(2 * 1024 * 1024)}"}`)).toThrow("exceeds 2 MiB");
	});
});
it("accepts installed Pi event shapes and normalizes nested fields", async () => {
	const output = [
		'{"type":"response","command":"prompt","success":true,"id":1}',
		'{"type":"message_start","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.6-sol"}}',
		'{"type":"message_update","usage":{"input":2,"output":1},"assistantMessageEvent":{"type":"text_delta","delta":"OK"}}',
		'{"type":"message_update","usage":{"input":2,"output":1},"assistantMessageEvent":{"type":"text_delta","delta":"OK"}}',
		'{"type":"agent_end","messages":[]}',
	].join("\n") + "\n";
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
	const session = await createPiBackend({ spawn: (): PiRpcProcess => ({ stdin: { write: () => { controller.enqueue(new TextEncoder().encode(output)); } }, stdout: stream, exited: Promise.resolve(0), kill: () => undefined }) }).start();
	const result = await session.prompt("hello");
	expect(result.text).toBe("OKOK");
	expect(result.model).toMatchObject({ resolvedProvider: "openai-codex", resolvedModel: "gpt-5.6-sol", fallback: "yes" });
});

describe("Pi RPC backend", () => {
	it("starts with a readable events iterator before any process output", async () => {
		let killed = false;
		const stream = new ReadableStream<Uint8Array>({});
		const session = await createPiBackend({
			command: "fake-pi",
			spawn: (): PiRpcProcess => ({
				stdin: { write: () => undefined },
				stdout: stream,
				exited: Promise.resolve(0),
				kill: () => { killed = true; },
			}),
		}).start();

		expect(session.events[Symbol.asyncIterator]).toBeFunction();
		await session.dispose();
		expect(killed).toBe(true);
	});
	it("constructs with a fake process and supports cancel", async () => {
		const writes: string[] = [];
		let killed = false;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; controller.enqueue(encoder.encode('{"type":"session","id":"fake-session"}\n')); } });
		const session = await createPiBackend({ command: "fake-pi", cancelTimeoutMs: 20, spawn: (): PiRpcProcess => ({ stdin: { write: data => { writes.push(data); const command = JSON.parse(data) as { type: string; id?: number }; if (command.type === "abort") controller.enqueue(encoder.encode(`{"type":"response","command":"abort","success":true,"id":${command.id}}\n`)); } }, stdout: stream, exited: Promise.resolve(0), kill: () => { killed = true; } }) }).start();
		const event = await session.events[Symbol.asyncIterator]().next();
		await session.cancel("test-cancel");
		expect(writes).toContain('{"type":"abort","id":1}\n');
		expect(event.value?.event).toMatchObject({ type: "session", id: "fake-session" });
		await session.dispose();
		expect(killed).toBe(true);
	});
});
