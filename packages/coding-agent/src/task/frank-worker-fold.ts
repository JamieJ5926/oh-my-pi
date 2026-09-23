import type { FrankEvent } from "./frank-worker";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMessageText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	let text = "";
	for (const block of message.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

export function eventAssistantText(event: FrankEvent): string {
	const value = event.event;
	if (!isRecord(value) || (value.type !== "message_update" && value.type !== "message_end")) return "";
	const message = value.message;
	if (!isRecord(message) || message.role !== "assistant") return "";
	if (value.type === "message_end") return extractMessageText(message);
	const assistantEvent = value.assistantMessageEvent;
	if (isRecord(assistantEvent) && assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
		return assistantEvent.delta;
	}
	return "";
}
