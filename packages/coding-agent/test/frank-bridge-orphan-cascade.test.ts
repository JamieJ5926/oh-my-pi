import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async";
import { IrcBus } from "../src/irc/bus";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import { runFrankSubagent } from "../src/task/executor";
import { createFrankHostToolService } from "../src/task/frank-host-tools";
import { BUILTIN_TOOLS } from "../src/tools";
import type { ToolSession } from "../src/tools";

const dirs: string[] = [];
const originalTask = BUILTIN_TOOLS.task;

function untilAborted(signal: AbortSignal): Promise<string> {
	return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	BUILTIN_TOOLS.task = originalTask;
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("Frank pot terminal cascade", () => {
	test.each([
		["Answer", 0],
		["Error", 1],
		["BudgetExceeded", 1],
		["Cancelled", 1],
	] as const)("a pot that ends %s cancels the bridge child and its grandchild within 5 s", async (terminal, exitCode) => {
		const registry = AgentRegistry.global();
		const manager = new AsyncJobManager({ maxRunningJobs: 8 });
		const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "frank-orphan-"));
		dirs.push(artifactsDir);
		BUILTIN_TOOLS.task = async session =>
			({
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => {
					const owner = session.getAgentId?.() ?? undefined;
					registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: owner, session: null });
					registry.register({ id: "GrandChild", displayName: "GrandChild", kind: "sub", parentId: "Child", session: null });
					manager.register("task", "Child", ({ signal }) => untilAborted(signal), { id: "Child", ownerId: owner, agentId: "Child" });
					manager.register("task", "GrandChild", ({ signal }) => untilAborted(signal), {
						id: "GrandChild",
						ownerId: "Child",
						agentId: "GrandChild",
					});
					return { content: [{ type: "text" as const, text: "spawned Child" }], details: { async: { state: "running" } } };
				},
			}) as never;
		const hostSession = {
			asyncJobManager: manager,
			agentRegistry: registry,
			getAgentId: () => "Main",
			getToolContext: () => undefined,
			wrapWithHooks: (tool: unknown) => tool,
		} as unknown as ToolSession;
		const service = createFrankHostToolService({ session: hostSession, agentId: "Pot", names: ["task", "hub"] });
		try {
			await runFrankSubagent({
				id: "Pot",
				task: "spawn a child then stop",
				assignment: "spawn",
				index: 0,
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				cwd: process.cwd(),
				exe: "unused",
				endpoint: "http://127.0.0.1:1",
				model: "test-model",
				budgets: { maxToolCalls: 3, wallSecs: 5 },
				text: "request",
				artifactsDir,
				parentAgentId: "Main",
				hostToolService: service,
				runWorker: async options => {
					const spawned = await options.onToolRequest?.({ call_id: 1, turn_id: 1, name: "task", args: { task: "child" } });
					expect(spawned?.ok).toBe(true);
					return {
						terminal: {
							kind: "terminal",
							version: 1,
							turn_id: 1,
							terminal,
							final_seq: 0,
							...(terminal === "Answer" ? {} : { error: "http 401" }),
						},
						exitCode,
						text: "pot finished",
					};
				},
			});
			const deadline = Date.now() + 5_000;
			while (manager.getJob("GrandChild")?.status === "running" && Date.now() < deadline) await Bun.sleep(25);
			expect(manager.getJob("Child")?.status).toBe("cancelled");
			expect(manager.getJob("GrandChild")?.status).toBe("cancelled");
		} finally {
			manager.dispose();
		}
	});
});
