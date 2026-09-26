import { describe, expect, test } from "bun:test";
import { parseAgent } from "./agents";
import type { AgentDefinition } from "./types";

function parseRuntime(runtime?: string): AgentDefinition {
	const runtimeLine = runtime === undefined ? "" : `runtime: ${runtime}\n`;
	return parseAgent(
		"selector-test.md",
		`---\nname: selector-test\ndescription: Selector behavior test\n${runtimeLine}---\nTest prompt.\n`,
		"user",
	);
}

describe("agent runtime selector", () => {
	test("absent runtime stays on the in-process route", () => {
		const agent = parseRuntime();
		expect(agent.runtime).toBeUndefined();
		expect(agent.runtime === "frank" ? "Frank" : "in-process").toBe("in-process");
	});

	test("runtime frank selects the Frank route", () => {
		const agent = parseRuntime("frank");
		expect(agent.runtime).toBe("frank");
		expect(agent.runtime === "frank" ? "Frank" : "in-process").toBe("Frank");
	});

	test("unknown and non-string runtime values are rejected", () => {
		expect(() => parseRuntime("other")).toThrow("Unknown agent runtime: other");
		expect(() => parseAgent(
			"selector-test.md",
			"---\nname: selector-test\ndescription: Selector behavior test\nruntime: 7\n---\nTest prompt.\n",
			"user",
		)).toThrow("Unknown agent runtime: 7");
	});
});
