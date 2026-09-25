import { describe, expect, test } from "bun:test";
import { filterTaskAgentRoster, renderDescription } from "./index.ts";
import { resolveSpawnPolicy } from "./spawn-policy.ts";

const agents = [
	{ name: "explorer", description: "Reads the tree.", systemPrompt: "x", source: "bundled" as const, tools: ["read"] },
	{ name: "implementer", description: "Edits one file.", systemPrompt: "x", source: "bundled" as const, tools: ["edit"] },
	{ name: "reviewer", description: "Grades a frozen diff.", systemPrompt: "x", source: "bundled" as const, tools: ["read"] },
];

function description(parentSpawns: string) {
	return renderDescription({
		agents,
		isolationEnabled: false,
		applyIsolatedChanges: false,
		disabledAgents: [],
		batchEnabled: true,
		effortEnabled: false,
		asyncEnabled: false,
		ircEnabled: false,
		parentSpawns,
	});
}

describe("renderDescription agent roster", () => {
	test("omits the roster when spawning is disabled", () => {
		const result = description("");
		expect(result).not.toContain("# Available Agents");
		expect(result).not.toContain("Grades a frozen diff.");
	});

	test("includes and marks all agents for unrestricted spawning", () => {
		const result = description("*");
		expect(result).toContain("# Available Agents");
		expect(result).toContain("Reads the tree.");
		expect(result).toContain("Edits one file.");
		expect(result).toContain("Grades a frozen diff.");
		expect(result).toContain("### explorer (READ-ONLY)");
		expect(result).toContain("### reviewer (READ-ONLY)");
		expect(result).toContain("### implementer\n");
		expect(result).not.toContain("### implementer (READ-ONLY)");
	});

	test("limits the roster to the parent allowlist", () => {
		const result = description("implementer");
		expect(result).toContain("# Available Agents");
		expect(result).toContain("Edits one file.");
		expect(result).not.toContain("Reads the tree.");
		expect(result).not.toContain("Grades a frozen diff.");
	});

	test("filters a roster using the resolved spawn policy", () => {
		const roster = agents.map(agent => ({
			name: agent.name,
			description: agent.description,
			readOnly: agent.name !== "implementer",
			blocking: false,
		}));
		const result = filterTaskAgentRoster(roster, resolveSpawnPolicy("implementer"));
		expect(result).toContain("Edits one file.");
		expect(result).not.toContain("Grades a frozen diff.");
	});
});
