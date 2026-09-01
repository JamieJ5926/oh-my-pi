import { describe, expect, it } from "bun:test";
import {
	HarnessDecoder,
	HarnessFrameError,
	decodeServerLine,
	encodeClientFrame,
	encodeServerFrame,
	SUPPORTED_EVENTS,
	SUPPORTED_REQUESTS,
	type HarnessEvent,
	type HarnessRequest,
	type HarnessServerFrame,
} from "../src/bridge/backends/jcode/harness-protocol";

function decodeAll(chunks: string[]): HarnessServerFrame[] {
	const decoder = new HarnessDecoder();
	return chunks.flatMap((chunk) => decoder.push(chunk));
}

describe("harness codec", () => {
	it("encodes hello as exact newline-terminated bytes", () => {
		expect(encodeClientFrame(1, { req: "hello", min_version: 1, max_version: 1, client: "omp-jcode-bridge/1" })).toBe(
			'{"v":1,"id":1,"req":"hello","min_version":1,"max_version":1,"client":"omp-jcode-bridge/1"}\n',
		);
	});

	it("encodes send_message as exact newline-terminated bytes", () => {
		expect(encodeClientFrame(3, { req: "send_message", session_id: "s1", content: "hi" })).toBe(
			'{"v":1,"id":3,"req":"send_message","session_id":"s1","content":"hi"}\n',
		);
	});

	it("encodes soft_interrupt with urgent defaulting omitted as exact bytes", () => {
		expect(encodeClientFrame(7, { req: "soft_interrupt", session_id: "s1", content: "nudge" })).toBe(
			'{"v":1,"id":7,"req":"soft_interrupt","session_id":"s1","content":"nudge"}\n',
		);
	});

	it("preserves absent versus empty allowed_tools exactly", () => {
		expect(encodeClientFrame(2, { req: "create_session", working_dir: "/tmp/w" })).toBe(
			'{"v":1,"id":2,"req":"create_session","working_dir":"/tmp/w"}\n',
		);
		// Empty allowlist means deny all; it must survive encoding.
		expect(encodeClientFrame(4, { req: "create_session", allowed_tools: [] })).toBe(
			'{"v":1,"id":4,"req":"create_session","allowed_tools":[]}\n',
		);
	});

	it("omits disabled_tools and host_tools when callers omit them", () => {
		const line = encodeClientFrame(5, { req: "create_session", working_dir: "/tmp/w" });
		expect(line).not.toContain("disabled_tools");
		expect(line).not.toContain("host_tools");
	});

	it("encodes host_tool_result terminal success and error frames as exact bytes", () => {
		expect(
			encodeClientFrame(9, {
				req: "host_tool_result",
				session_id: "s1",
				call_id: "c1",
				result: { ok: true },
				terminal: true,
			}),
		).toBe('{"v":1,"id":9,"req":"host_tool_result","session_id":"s1","call_id":"c1","result":{"ok":true},"terminal":true}\n');
		expect(encodeClientFrame(10, { req: "host_tool_result", session_id: "s1", call_id: "c2", error: "boom" })).toBe(
			'{"v":1,"id":10,"req":"host_tool_result","session_id":"s1","call_id":"c2","error":"boom"}\n',
		);
	});

	it("rejects a client frame id that is negative, fractional, or not a safe integer", () => {
		expect(() => encodeClientFrame(-1, { req: "ping" })).toThrow(HarnessFrameError);
		expect(() => encodeClientFrame(1.5, { req: "ping" })).toThrow(HarnessFrameError);
		expect(() => encodeClientFrame(Number.MAX_SAFE_INTEGER + 1, { req: "ping" })).toThrow(HarnessFrameError);
	});

	it("decodes a reply frame with reply correlation and omits absent optional fields", () => {
		const frame = decodeServerLine('{"v":1,"reply_to":1,"ev":"hello_ok","version":1,"server":"jcode/0.55.1"}');
		expect(frame).toEqual({ v: 1, reply_to: 1, ev: "hello_ok", version: 1, server: "jcode/0.55.1" });
		expect("capabilities" in frame).toBe(false);
	});

	it("throws on a present-but-malformed capabilities array and decodes a valid one", () => {
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","version":1,"server":"j","capabilities":"x"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","version":1,"server":"j","capabilities":[1]}')).toThrow(HarnessFrameError);
		const frame = decodeServerLine('{"v":1,"ev":"hello_ok","version":1,"server":"j","capabilities":["a","b"]}');
		expect(frame).toEqual({ v: 1, ev: "hello_ok", version: 1, server: "j", capabilities: ["a", "b"] });
	});

	it("requires hello_ok version to be a positive safe integer", () => {
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","version":0,"server":"j"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","version":-1,"server":"j"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","version":1.5,"server":"j"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"hello_ok","server":"j"}')).toThrow(HarnessFrameError);
	});

	it("round-trips streaming frames without reply_to", () => {
		const encoded = encodeServerFrame({ v: 1, ev: "text_delta", session_id: "s1", text: "hi" });
		expect(encoded).toBe('{"v":1,"ev":"text_delta","session_id":"s1","text":"hi"}\n');
		const decoded = decodeServerLine(encoded);
		expect(decoded).toEqual({ v: 1, ev: "text_delta", session_id: "s1", text: "hi" });
		expect("reply_to" in decoded).toBe(false);
	});

	it("decodes turn_done, host_tool_call, and token_usage streaming shapes", () => {
		expect(decodeServerLine('{"v":1,"ev":"turn_done","session_id":"s1"}')).toEqual({ v: 1, ev: "turn_done", session_id: "s1" });
		expect(decodeServerLine('{"v":1,"ev":"host_tool_call","session_id":"s1","call_id":"c1","name":"bash","arguments":{"cmd":"ls"}}')).toEqual({
			v: 1,
			ev: "host_tool_call",
			session_id: "s1",
			call_id: "c1",
			name: "bash",
			arguments: { cmd: "ls" },
		});
		expect(decodeServerLine('{"v":1,"ev":"token_usage","session_id":"s1","input":10,"output":5,"cache_read_input":2}')).toEqual({
			v: 1,
			ev: "token_usage",
			session_id: "s1",
			input: 10,
			output: 5,
			cache_read_input: 2,
		});
	});

	it("omits cache_read_input when the server omits it", () => {
		const frame = decodeServerLine('{"v":1,"ev":"token_usage","session_id":"s1","input":10,"output":5}');
		expect(frame).toEqual({ v: 1, ev: "token_usage", session_id: "s1", input: 10, output: 5 });
		expect("cache_read_input" in frame).toBe(false);
	});

	it("rejects token_usage counts that are negative, fractional, or not safe integers", () => {
		expect(() => decodeServerLine('{"v":1,"ev":"token_usage","session_id":"s1","input":-1,"output":5}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"token_usage","session_id":"s1","input":1.5,"output":5}')).toThrow(HarnessFrameError);
		expect(() =>
			decodeServerLine(`{"v":1,"ev":"token_usage","session_id":"s1","input":${Number.MAX_SAFE_INTEGER + 1},"output":5}`),
		).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"token_usage","session_id":"s1","input":"10","output":5}')).toThrow(HarnessFrameError);
	});

	it("throws on malformed required string fields instead of defaulting", () => {
		expect(() => decodeServerLine('{"v":1,"ev":"error","message":"m"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"text_delta","session_id":"s1","text":42}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"ev":"session_status","session_id":7,"status":"idle"}')).toThrow(HarnessFrameError);
	});

	it("omits tool_done error and model_info optional fields when absent", () => {
		const done = decodeServerLine('{"v":1,"ev":"tool_done","session_id":"s1","call_id":"c1","name":"bash","output":"ok"}');
		expect(done).toEqual({ v: 1, ev: "tool_done", session_id: "s1", call_id: "c1", name: "bash", output: "ok" });
		expect("error" in done).toBe(false);
		const model = decodeServerLine('{"v":1,"ev":"model_info","session_id":"s1"}');
		expect(model).toEqual({ v: 1, ev: "model_info", session_id: "s1" });
		expect("provider" in model).toBe(false);
		expect("model" in model).toBe(false);
		expect("reasoning_effort" in model).toBe(false);
	});

	it("maps unknown event kinds to an Unknown event retaining the raw record", () => {
		const raw = '{"v":1,"reply_to":3,"ev":"new_future_event","payload":{"x":1}}';
		expect(decodeServerLine(raw)).toEqual({
			v: 1,
			reply_to: 3,
			ev: "unknown",
			raw: { v: 1, reply_to: 3, ev: "new_future_event", payload: { x: 1 } },
		});
	});

	it("omits reply_to on unknown events when the wire frame omits it", () => {
		const frame = decodeServerLine('{"v":1,"ev":"new_future_event"}');
		expect("reply_to" in frame).toBe(false);
	});

	it("handles chunk splits, blank lines, and multiple lines while preserving order", () => {
		const frames = decodeAll([
			'{"v":1,"reply_to":2,"ev":"att',
			'ached","session":{"session_id":"s1","status":"idle"}}\n\n\n{"v":1,"ev":"text',
			'_delta","session_id":"s1"',
			',"text":"hi"}\n{"v":1,"ev":"turn_done","session_id":"s1"}\n{"v":1,"ev":"partial_without_newline',
		]);
		expect(frames.map((frame) => frame.ev)).toEqual(["attached", "text_delta", "turn_done"]);
		expect(frames[0]).toMatchObject({ reply_to: 2, session: { session_id: "s1", status: "idle" } });
		expect(frames[1]).toEqual({ v: 1, ev: "text_delta", session_id: "s1", text: "hi" });
	});

	it("throws HarnessFrameError on malformed frames", () => {
		expect(() => decodeServerLine("not json")).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":2,"ev":"ok"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"reply_to":"x","ev":"ok"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"reply_to":1.5,"ev":"ok"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1,"reply_to":-2,"ev":"ok"}')).toThrow(HarnessFrameError);
		expect(() => decodeServerLine('{"v":1}')).toThrow(HarnessFrameError);
	});

	it("lists every request and event branch used by OMP in the supported tag lists", () => {
		const requestTags: HarnessRequest["req"][] = [
			"hello",
			"create_session",
			"attach_session",
			"detach_session",
			"send_message",
			"cancel",
			"soft_interrupt",
			"cancel_soft_interrupts",
			"host_tool_result",
			"ping",
		];
		expect(SUPPORTED_REQUESTS).toEqual(requestTags);
		const eventTags: Exclude<HarnessEvent["ev"], "unknown">[] = [
			"hello_ok",
			"ok",
			"error",
			"attached",
			"message_accepted",
			"text_delta",
			"reasoning_delta",
			"tool_start",
			"tool_input_delta",
			"tool_exec",
			"tool_done",
			"host_tool_call",
			"token_usage",
			"turn_done",
			"session_status",
			"connection_phase",
			"model_info",
		];
		expect(SUPPORTED_EVENTS).toEqual(eventTags);
	});
});

describe("harness decoder line cap", () => {
	const cap = HarnessDecoder.MAX_BUFFERED_LINE_BYTES;

	it("accepts an unterminated line at exactly the 16 MiB cap", () => {
		const decoder = new HarnessDecoder();
		expect(() => decoder.push("x".repeat(cap))).not.toThrow();
	});

	it("rejects an unterminated line one byte over the cap and resets the buffer", () => {
		const decoder = new HarnessDecoder();
		expect(() => decoder.push("x".repeat(cap + 1))).toThrow(HarnessFrameError);
		// buffer reset: a subsequent valid frame still decodes
		const frames = decoder.push(encodeServerFrame({ v: 1, reply_to: 0, ev: "ok" }));
		expect(frames.map((f) => f.ev)).toEqual(["ok"]);
	});

	it("rejects overflow that accumulates across chunks before a newline arrives", () => {
		const decoder = new HarnessDecoder();
		expect(() => {
			decoder.push("x".repeat(cap));
			decoder.push("x");
		}).toThrow(HarnessFrameError);
	});

	it("decodes a frame whose line length equals the cap when newline-terminated", () => {
		const decoder = new HarnessDecoder();
		const prefix = '{"v":1,"ev":"future","padding":"';
		const suffix = '"}';
		const pad = cap - prefix.length - suffix.length;
		const frames = decoder.push(`${prefix}${"x".repeat(pad)}${suffix}\n`);
		expect(frames.map((f) => f.ev)).toEqual(["unknown"]);
	});
});
