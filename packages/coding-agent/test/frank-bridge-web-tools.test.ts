import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../src/tools";
import { createFrankHostToolService } from "../src/task/frank-host-tools";

type Call = { name: string; args: unknown };

function makeService(registered: string[], calls: Call[]) {
	const stub = (name: string) => ({
		name,
		execute: async (_id: string, args: unknown) => {
			calls.push({ name, args });
			return { content: [{ type: "text" as const, text: `${name} stub result` }] };
		},
	});
	return createFrankHostToolService({
		session: {
			cwd: "/",
			hasUI: false,
			skills: [],
			getAgentId: () => "FrankHost",
			getToolContext: () => undefined,
			getSessionFile: () => null,
			settings: { get: () => undefined },
			toolRegistry: new Map(registered.map(name => [name, stub(name)])),
		} as unknown as ToolSession,
		agentId: "FrankWorker",
		names: ["hub", "write", "edit", "bash"],
	});
}

describe("Frank bridge host web tools", () => {
	test("serves the host session's registered web_search with args passed through", async () => {
		const calls: Call[] = [];
		const result = await makeService(["web_search"], calls).handle("web_search", { query: "x" });
		expect(result).toEqual({ ok: true, content: "web_search stub result" });
		expect(calls).toEqual([{ name: "web_search", args: { query: "x" } }]);
	});

	test("serves the host session's registered github tool", async () => {
		const calls: Call[] = [];
		const args = { op: "repo_view", repo: "a/b" };
		const result = await makeService(["github"], calls).handle("github", args);
		expect(result).toEqual({ ok: true, content: "github stub result" });
		expect(calls).toEqual([{ name: "github", args }]);
	});

	test("refuses web_search when the host session does not register it", async () => {
		const calls: Call[] = [];
		const result = await makeService([], calls).handle("web_search", { query: "x" });
		expect(result).toEqual({ ok: false, error: "host tool is not enabled: web_search" });
		expect(calls).toEqual([]);
	});
});
