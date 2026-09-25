import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../../async";
import { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import { descendantAgentIds, executeCancel } from "./jobs";

function sessionWith(registry: AgentRegistry): ToolSession {
	return { agentRegistry: registry } as ToolSession;
}

describe("frank cancel orphan", () => {
	test("descendantAgentIds includes registered children of a frank deep", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Deep", displayName: "Deep", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Pot", displayName: "Pot", kind: "sub", parentId: "Deep", session: null });
		expect(descendantAgentIds(registry, "Deep").sort()).toEqual(["Deep", "Pot"]);
	});

	test("cancelling a frank deep aborts its child job, not only the named job", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Deep", displayName: "Deep", kind: "sub", parentId: "Main", session: null, status: "running" });
		registry.register({ id: "Pot", displayName: "Pot", kind: "sub", parentId: "Deep", session: null, status: "running" });
		const manager = new AsyncJobManager({});
		const child = new Promise<void>(() => {});
		manager.register("task", "Deep", () => new Promise<string>(() => {}), { id: "Deep", ownerId: "Main", agentId: "Deep" });
		manager.register("task", "Pot", () => child.then(() => "still running"), { id: "Pot-job", ownerId: "Deep", agentId: "Pot" });

		const result = await executeCancel(sessionWith(registry), manager, "Main", ["Deep"]);
		const cancelled = result.details?.cancelled?.map(row => row.id) ?? [];

		expect(manager.getJob("Deep")?.status).toBe("cancelled");
		expect(manager.getJob("Pot-job")?.status).toBe("cancelled");
		expect(cancelled).toContain("Deep");
		expect(manager.getJob("Pot-job")?.abortController.signal.aborted).toBe(true);
	});
});
