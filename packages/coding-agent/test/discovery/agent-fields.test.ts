import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("parseAgentFields", () => {
	test("parses blocking from boolean frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: true,
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(true);
	});

	test("parses blocking from string frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "false",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(false);
	});

	test("ignores invalid blocking values", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "sometimes",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBeUndefined();
	});
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});
	test("accepts the auto thinking selector", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "auto",
		});

		expect(fields?.thinkingLevel).toBe(AUTO_THINKING);
	});

	test("rejects unknown thinking selectors", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "turbo",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("lowercases tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Search"],
		});

		expect(fields?.tools).toEqual(["read", "grep", "yield"]);
	});
	test("keeps an explicitly empty tools list distinct from an absent one", () => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: [] })?.tools).toEqual(["yield"]);
		expect(parseAgentFields({ name: "quiet", description: "desc" })?.tools).toBeUndefined();
	});

	test("maps legacy search and find tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Find", "Glob", "Search", "Grep"],
		});

		expect(fields?.tools).toEqual(["glob", "grep", "yield"]);
	});

	test("parses autoloadSkills from array frontmatter", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: ["user-created-skill-a", "user-created-skill-b"],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("parses autoloadSkills from CSV string", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: "user-created-skill-a, user-created-skill-b",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("returns undefined autoloadSkills when field absent", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("returns undefined autoloadSkills for empty array", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: [],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("parses readSummarize from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: false })?.readSummarize).toBe(false);
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: true })?.readSummarize).toBe(true);
	});

	test("parses readSummarize from string frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: "false" })?.readSummarize).toBe(
			false,
		);
	});

	test("ignores invalid readSummarize values", () => {
		expect(
			parseAgentFields({ name: "scout", description: "desc", readSummarize: "nope" })?.readSummarize,
		).toBeUndefined();
	});

	test("returns undefined readSummarize when field absent", () => {
		expect(parseAgentFields({ name: "scout", description: "desc" })?.readSummarize).toBeUndefined();
	});
	test("parses prewalk from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: true })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: false })?.prewalk).toBe(false);
	});

	test("parses prewalk boolean strings as booleans", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "true" })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "false" })?.prewalk).toBe(false);
	});

	test("parses prewalk model pattern strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: " @smol " })?.prewalk).toBe("@smol");
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "openai/gpt-5-mini" })?.prewalk).toBe(
			"openai/gpt-5-mini",
		);
	});

	test("ignores empty and absent prewalk values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "  " })?.prewalk).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.prewalk).toBeUndefined();
	});
	test("parses advisor from boolean frontmatter and boolean strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: true })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: false })?.advisor).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "true" })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "false" })?.advisor).toBe(false);
	});

	test("parses advisor model pattern strings and ignores empty/absent values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: " moonshot/k3 " })?.advisor).toBe(
			"moonshot/k3",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "@smol:high" })?.advisor).toBe(
			"@smol:high",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "  " })?.advisor).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.advisor).toBeUndefined();
	});
	test("parses minimalPrompt from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", minimalPrompt: true })?.minimalPrompt).toBe(
			true,
		);
		expect(parseAgentFields({ name: "worker", description: "desc", minimalPrompt: false })?.minimalPrompt).toBe(
			false,
		);
		expect(parseAgentFields({ name: "worker", description: "desc" })?.minimalPrompt).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc", minimalPrompt: "yes" })?.minimalPrompt).toBe(
			undefined,
		);
	});

	test("parses input selectors as shared, list, or CSV", () => {
		for (const field of ["instructions", "skills", "hooks"] as const) {
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: "shared" })?.[field]).toBe(
				"shared",
			);
			expect(
				parseAgentFields({ name: "worker", description: "desc", [field]: ["b", " a ", "b"] })?.[field],
			).toEqual(["b", "a"]);
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: "a, b" })?.[field]).toEqual([
				"a",
				"b",
			]);
		}
	});
	test("normalizes single-element shared selectors to the sentinel", () => {
		for (const field of ["instructions", "skills", "hooks"] as const) {
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: ["shared"] })?.[field]).toBe(
				"shared",
			);
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: [" shared "] })?.[field]).toBe(
				"shared",
			);
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: " shared " })?.[field]).toBe(
				"shared",
			);
		}
	});


	test("keeps explicit-empty selectors distinct from absent ones", () => {
		for (const field of ["instructions", "skills", "hooks"] as const) {
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: [] })?.[field]).toEqual([]);
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: "" })?.[field]).toEqual([]);
			expect(parseAgentFields({ name: "worker", description: "desc" })?.[field]).toBeUndefined();
			expect(parseAgentFields({ name: "worker", description: "desc", [field]: null })?.[field]).toBeUndefined();
		}
	});

	test("rejects mistyped selectors instead of silently inheriting", () => {
		for (const field of ["instructions", "skills", "hooks"] as const) {
			expect(() => parseAgentFields({ name: "worker", description: "desc", [field]: 5 })).toThrow(
				"Agent input selectors must be shared, a string, or a string array",
			);
			expect(() => parseAgentFields({ name: "worker", description: "desc", [field]: ["a", 5] })).toThrow(
				"Agent input selectors must be shared, a string, or a string array",
			);
			expect(() => parseAgentFields({ name: "worker", description: "desc", [field]: true })).toThrow(
				"Agent input selectors must be shared, a string, or a string array",
			);
		}
	});
});
