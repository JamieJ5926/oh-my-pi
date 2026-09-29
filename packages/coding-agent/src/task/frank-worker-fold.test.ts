import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { answerExitDecision, eventAssistantText, extractFrankYieldItems, foldEventsToText, FrankWorkerExitError } from "./frank-worker-fold";
import type { FrankEvent } from "./frank-worker";

const fixtureDirectory = "test/fixtures/frank-worker";

function readFixture(name: string): FrankEvent[] {
	return readFileSync(`${fixtureDirectory}/${name}.jsonl`, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FrankEvent);
}

function terminalKind(events: FrankEvent[]): string | undefined {
	for (const event of events) {
		const outer = event.event;
		if (typeof outer !== "object" || outer === null || !("kind" in outer)) continue;
		const kind = outer.kind;
		if (typeof kind === "object" && kind !== null && "Terminal" in kind && typeof kind.Terminal === "string") {
			return kind.Terminal;
		}
	}
	return undefined;
}

describe("Frank captured event wire", () => {
	test("folds only the last assistant round after AssistantDone boundaries", () => {
		const events: FrankEvent[] = [
			{ type: "event", seq: 1, event: { kind: { AssistantDelta: "Collected so far: C01" } } },
			{ type: "event", seq: 2, event: { kind: { ToolCall: { name: "hub" } } } },
			{ type: "event", seq: 3, event: { kind: { ToolResult: { content: "1" } } } },
			{ type: "event", seq: 4, event: { kind: "AssistantDone" } },
			{ type: "event", seq: 5, event: { kind: { AssistantDelta: "sum=20 children=20" } } },
			{ type: "event", seq: 6, event: { kind: "AssistantDone" } },
			{ type: "event", seq: 7, event: { kind: { TerminalDone: { outcome: "Answer", seq: 6 } } } },
		];
		expect(foldEventsToText(events)).toBe("sum=20 children=20");
	});

	test("keeps the last text when the final round made only tool calls", () => {
		const events: FrankEvent[] = [
			{ type: "event", seq: 1, event: { kind: { AssistantDelta: "answer=7" } } },
			{ type: "event", seq: 2, event: { kind: "AssistantDone" } },
			{ type: "event", seq: 3, event: { kind: { ToolCall: { name: "hub" } } } },
			{ type: "event", seq: 4, event: { kind: "AssistantDone" } },
		];
		expect(foldEventsToText(events)).toBe("answer=7");
	});

	test("parses a structured yield from the final round despite earlier progress text", () => {
		const events: FrankEvent[] = [
			{ type: "event", seq: 1, event: { kind: { AssistantDelta: "Collected so far: C01" } } },
			{ type: "event", seq: 2, event: { kind: "AssistantDone" } },
			{ type: "event", seq: 3, event: { kind: { AssistantDelta: '{"data":{"answer":42}}' } } },
			{ type: "event", seq: 4, event: { kind: "AssistantDone" } },
		];
		expect(extractFrankYieldItems(events)).toEqual([{ data: { answer: 42 } }]);
	});

	test("folds exact saved Answer AssistantDelta text", () => {
		const events = readFixture("answer");
		const deltas = events.map(eventAssistantText).filter((text) => text !== "");
		expect(deltas).toEqual(["fixture answer"]);
		expect(foldEventsToText(events)).toBe("fixture answer");
		expect(terminalKind(events)).toBe("Answer");
	});

	test("folds exact saved Error AssistantDelta text and preserves terminal", () => {
		const events = readFixture("error");
		const deltas = events.map(eventAssistantText).filter((text) => text !== "");
		expect(deltas).toEqual(["partial"]);
		expect(foldEventsToText(events)).toBe("partial");
		expect(terminalKind(events)).toBe("Error");
	});

	test("folds exact saved Cancelled AssistantDelta text and preserves terminal", () => {
		const events = readFixture("cancelled");
		const deltas = events.map(eventAssistantText).filter((text) => text !== "");
		expect(deltas).toEqual(["before cancel"]);
		expect(foldEventsToText(events)).toBe("before cancel");
		expect(terminalKind(events)).toBe("Cancelled");
	});
});

describe("Frank pure worker decisions", () => {
	test("allows Answer only with a zero worker exit", () => {
		expect(answerExitDecision("Answer", 0, "fixture answer")).toEqual({ exitCode: 0 });
	});

	test("returns typed error for nonzero Answer exit", () => {
		const decision = answerExitDecision("Answer", 7, "partial");
		expect(decision).toEqual({
			exitCode: 7,
			error: expect.any(FrankWorkerExitError),
		});
		expect(decision.error?.exitCode).toBe(7);
		expect(decision.error?.foldedText).toBe("partial");
	});

	test.each(["Error", "Cancelled", "BudgetExceeded"])('%s with zero exit remains successful passthrough', (terminal) => {
		expect(answerExitDecision(terminal, 0, "terminal detail")).toEqual({ exitCode: 0 });
	});

	test.each(["Error", "Cancelled", "BudgetExceeded"])('%s with nonzero exit preserves its exit code without Answer error conversion', (terminal) => {
		expect(answerExitDecision(terminal, 9, "terminal detail")).toEqual({ exitCode: 9 });
	});
});

describe("Frank structured yield extraction", () => {
	test("extracts a single yield object as one terminal item", () => {
		const events: FrankEvent[] = [{ type: "event", seq: 1, event: { kind: { Yield: { data: { answer: 42 } } } } }];
		expect(extractFrankYieldItems(events)).toEqual([{ data: { answer: 42 } }]);
	});

	test("preserves incremental yield sections in event order", () => {
		const events: FrankEvent[] = [
			{ type: "event", seq: 1, event: { kind: { Yield: { type: ["steps"], data: { steps: ["first"] } } } } },
			{ type: "event", seq: 2, event: { kind: { Yield: { type: ["steps"], data: { steps: ["second"] } } } } },
		];
		expect(extractFrankYieldItems(events)).toEqual([
			{ type: ["steps"], data: { steps: ["first"] } },
			{ type: ["steps"], data: { steps: ["second"] } },
		]);
	});

	test("extracts a terminal result envelope without nesting its data", () => {
		const events: FrankEvent[] = [{ type: "event", seq: 1, event: { kind: { Yield: { type: "result", data: { answer: 42 } } } } }];
		expect(extractFrankYieldItems(events)).toEqual([{ type: "result", data: { answer: 42 } }]);
	});
});
