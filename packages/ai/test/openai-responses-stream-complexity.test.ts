import { afterEach, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const originalIndexOf = Array.prototype.indexOf;

afterEach(() => {
	Array.prototype.indexOf = originalIndexOf;
});

it("keeps streamed block-index lookup work linear in the number of blocks", async () => {
	const blockCount = 5_000;
	const events: unknown[] = [{ type: "response.created", response: { id: "resp_complexity" } }];
	for (let index = 0; index < blockCount; index++) {
		const id = `msg_${index}`;
		events.push(
			{
				type: "response.output_item.added",
				output_index: index,
				item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: index,
				item_id: id,
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_text.delta", output_index: index, item_id: id, delta: "x" },
			{
				type: "response.output_item.done",
				output_index: index,
				item: {
					type: "message",
					id,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "x" }],
				},
			},
		);
	}
	events.push({
		type: "response.completed",
		response: {
			id: "resp_complexity",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: blockCount, total_tokens: blockCount + 1 },
		},
	});
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const fetchImpl = (async () =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl;
	let visitedContentSlots = 0;
	Array.prototype.indexOf = function (this: unknown[], searchElement: unknown, fromIndex?: number): number {
		if (Array.isArray(this) && this.length > 0 && this[0] && typeof this[0] === "object" && "type" in this[0]) {
			visitedContentSlots += this.length;
		}
		return originalIndexOf.call(this, searchElement, fromIndex);
	};

	const stream = streamOpenAIResponses(
		model,
		{ systemPrompt: ["test"], messages: [{ role: "user", content: "stream many blocks", timestamp: 1 }] },
		{ apiKey: "test-key", fetch: fetchImpl },
	);
	const result = await stream.result();
	if (result.stopReason === "error") throw new Error(JSON.stringify(result));
	expect(result.stopReason).toBe("stop");

	expect(result.content).toHaveLength(blockCount);
	expect(visitedContentSlots).toBeLessThan(blockCount * 20);
});
