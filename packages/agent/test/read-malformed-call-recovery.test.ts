import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: unknown[]): unknown[] {
	return (messages as Array<{ role: string }>).filter(
		m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	);
}

describe("malformed read({}) tool call recovery", () => {
	it("returns an isError tool result when read is called with empty arguments, then the model retries", async () => {
		const readSchema = type({ path: "string" });
		const executions: string[] = [];
		const tool: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read files",
			parameters: readSchema,
			async execute(_id, params) {
				executions.push(params.path);
				return { content: [{ type: "text" as const, text: `contents of ${params.path}` }] };
			},
		};

		const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				// Turn 1: model sends read with empty args (the Gemini bug)
				{
					content: [
						{ type: "toolCall", id: "tc-1", name: "read", arguments: {} },
					],
				},
				// Turn 2: model retries with correct args after receiving error
				{
					content: [
						{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "src/main.ts" } },
					],
				},
				// Turn 3: model responds with final answer
				{ content: ["Done reading the file."] },
			],
		});

		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter as AgentLoopConfig["convertToLlm"] };
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("read src/main.ts")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		// The first call should have produced a validation error (isError: true)
		const toolEnds = events.filter(e => e.type === "tool_execution_end");
		expect(toolEnds.length).toBe(2);

		const firstEnd = toolEnds[0];
		if (firstEnd.type !== "tool_execution_end") throw new Error("unexpected");
		expect(firstEnd.isError).toBe(true);

		const errorContent = firstEnd.result.content;
		const errorText = errorContent
			.filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { type: "text"; text: string }) => c.text)
			.join("\n");
		expect(errorText).toContain("path");

		// The second call should succeed
		const secondEnd = toolEnds[1];
		if (secondEnd.type !== "tool_execution_end") throw new Error("unexpected");
		expect(secondEnd.isError).toBe(false);
		const successContent = secondEnd.result.content;
		const successText = successContent
			.filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { type: "text"; text: string }) => c.text)
			.join("\n");
		expect(successText).toContain("contents of src/main.ts");

		// execute was called only once (the valid call), not for the malformed one
		expect(executions).toEqual(["src/main.ts"]);

		// The model got a third turn to produce the final answer
		const messages = await stream.result();
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.role).toBe("assistant");
		if (lastMsg.role === "assistant") {
			const finalText = (lastMsg.content as Array<{ type: string; text?: string }>)
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			expect(finalText).toBe("Done reading the file.");
		}
	});
});
