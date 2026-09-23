import { describe, expect, test } from "bun:test";
import { eventAssistantText } from "./frank-worker-fold";
import type { FrankEvent } from "./frank-worker";

describe("Frank event assistant text", () => {
	test("extracts assistant message_end text blocks", () => {
		const event: FrankEvent = {
			type: "event",
			seq: 1,
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Final " },
						{ type: "image", data: "ignored" },
						{ type: "text", text: "answer" },
					],
				},
			},
		};
		expect(eventAssistantText(event)).toBe("Final answer");
	});

	test("extracts assistant text_delta from a message_update wire payload", () => {
		const event: FrankEvent = {
			type: "event",
			seq: 2,
			event: {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
				assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
			},
		};
		 expect(eventAssistantText(event)).toBe("partial answer");
	});

	test("ignores non-assistant message_end and message_update payloads", () => {
		const messageEnd: FrankEvent = {
			type: "event",
			seq: 3,
			event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "user text" }] } },
		};
		const messageUpdate: FrankEvent = {
			type: "event",
			seq: 4,
			event: {
				type: "message_update",
				message: { role: "user", content: [{ type: "text", text: "user text" }] },
				assistantMessageEvent: { type: "text_delta", delta: "not assistant text" },
			},
		};
		 expect(eventAssistantText(messageEnd)).toBe("");
		 expect(eventAssistantText(messageUpdate)).toBe("");
	});

	test("uses final message_end content once and ignores agent_end", () => {
		const delta: FrankEvent = {
			type: "event",
			seq: 5,
			event: {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "complete answer" }] },
				assistantMessageEvent: { type: "text_delta", delta: "complete answer" },
			},
		};
		const messageEnd: FrankEvent = {
			type: "event",
			seq: 6,
			event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete answer" }] } },
		};
		const agentEnd: FrankEvent = { type: "event", seq: 7, event: { type: "agent_end" } };
		const foldedText = [delta, messageEnd, agentEnd].map(eventAssistantText).join("");
		 expect(foldedText).toBe("complete answercomplete answer");
		 expect(eventAssistantText(agentEnd)).toBe("");
	});

	test("ignores raw string and unrelated event payloads", () => {
		const rawString: FrankEvent = { type: "event", seq: 8, event: "literal fixture" };
		const named: FrankEvent = { type: "event", seq: 9, event: { name: "a" } };
		const malformedUpdate: FrankEvent = {
			type: "event",
			seq: 10,
			event: { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: 7 } },
		};
		 expect(eventAssistantText(rawString)).toBe("");
		 expect(eventAssistantText(named)).toBe("");
		 expect(eventAssistantText(malformedUpdate)).toBe("");
	});
});
