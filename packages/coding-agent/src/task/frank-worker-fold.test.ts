import { describe, expect, test } from "bun:test";
import { answerExitDecision, eventAssistantText, foldEventsToText, FrankWorkerExitError } from "./frank-worker-fold";
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
		expect(foldEventsToText([delta, messageEnd, agentEnd])).toBe("complete answer");
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

describe("Frank pure worker decisions", () => {
	test("uses final message_end content when there are no deltas", () => {
		const messageEnd: FrankEvent = {
			type: "event",
			seq: 1,
			event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
		};
		expect(foldEventsToText([messageEnd])).toBe("final answer");
	});

	test("allows an Answer only with a zero worker exit", () => {
		expect(answerExitDecision("Answer", 0, "literal answer")).toEqual({ exitCode: 0 });
	});

	test("returns a typed error with exit code and folded text for nonzero exit", () => {
		const decision = answerExitDecision("Answer", 7, "partial literal answer");
		expect(decision.exitCode).toBe(7);
		expect(decision.error).toBeInstanceOf(FrankWorkerExitError);
		expect(decision.error?.exitCode).toBe(7);
		expect(decision.error?.foldedText).toBe("partial literal answer");
	});
});
