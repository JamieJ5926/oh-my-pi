import { afterEach, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentMessage, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createUserMessage } from "./helpers";

const originalMap = Array.prototype.map;
afterEach(() => {
	Array.prototype.map = originalMap;
});

it("keeps message snapshot traversal bounded by the streamed delta count", async () => {
	const blockCount = 400;
	const deltaCount = 500;
	const partial: AssistantMessage = {
		role: "assistant",
		content: Array.from({ length: blockCount }, (_, index) => ({ type: "text" as const, text: `block-${index}` })),
		api: "mock",
		provider: "mock",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const streamFn: StreamFn = () => {
		const source = new AssistantMessageEventStream();
		source.push({ type: "start", partial });
		for (let index = 0; index < deltaCount; index++)
			source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
		source.push({ type: "done", reason: "stop", message: partial });
		return source;
	};
	const model = createMockModel();
	const context: AgentContext = { systemPrompt: ["test"], messages: [], tools: [] };
	const convertToLlm = (messages: AgentMessage[]): Message[] =>
		messages.filter(
			message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		) as Message[];
	let visitedContentBlocks = 0;
	Array.prototype.map = function <T, U>(
		this: T[],
		callback: (value: T, index: number, array: T[]) => U,
		thisArg?: unknown,
	): U[] {
		if (this.length > 0 && this[0] && typeof this[0] === "object" && "type" in this[0])
			visitedContentBlocks += this.length;
		return originalMap.call(this, callback, thisArg);
	};
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		{ model: model.model, convertToLlm },
		undefined,
		streamFn,
	);
	for await (const _event of stream) {
		/* drain the synthetic provider updates */
	}
	await stream.result();
	expect(visitedContentBlocks).toBeLessThan(deltaCount * 10);
	expect(visitedContentBlocks).toBeGreaterThan(0);
});
