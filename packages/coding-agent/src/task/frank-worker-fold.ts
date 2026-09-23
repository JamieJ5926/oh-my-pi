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
	if (!isRecord(value)) return "";
	const kind = value.kind;
	if (isRecord(kind) && typeof kind.AssistantDelta === "string") return kind.AssistantDelta;
	if (isRecord(kind) && isRecord(kind.AssistantDelta) && typeof kind.AssistantDelta.value === "string") {
		return kind.AssistantDelta.value;
	}
	if (value.type !== "message_update" && value.type !== "message_end") return "";
	const message = value.message;
	if (!isRecord(message) || message.role !== "assistant") return "";
	if (value.type === "message_end") return extractMessageText(message);
	const assistantEvent = value.assistantMessageEvent;
	if (isRecord(assistantEvent) && assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
		return assistantEvent.delta;
	}
	return "";
}

export function foldEventsToText(events: FrankEvent[]): string {
	const deltas: string[] = [];
	let finalText = "";
	let hasDeltas = false;
	for (const event of events) {
		const value = event.event;
		if (!isRecord(value)) continue;
		const text = eventAssistantText(event);
		if (text === "") continue;
		if (value.type === "message_end") finalText = text;
		else {
			deltas.push(text);
			hasDeltas = true;
		}
	}
	return hasDeltas ? deltas.join("") : finalText;
}

export class FrankWorkerExitError extends Error {
	constructor(readonly exitCode: number, readonly foldedText: string) {
		super(`Frank worker exited with code ${exitCode}`);
		this.name = "FrankWorkerExitError";
	}
}

export function answerExitDecision(terminal: string, workerExitCode: number, foldedText: string): { exitCode: number; error?: FrankWorkerExitError } {
	if (terminal !== "Answer" || workerExitCode === 0) return { exitCode: workerExitCode };
	return { exitCode: workerExitCode, error: new FrankWorkerExitError(workerExitCode, foldedText) };
}
