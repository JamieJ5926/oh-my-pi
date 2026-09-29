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
		expect(registry.get("Pot")).toBeUndefined();
		expect(registry.get("Deep")).toBeUndefined();
	});

	// CancelWhy4: the root cancelled a parked pot and its children in one call;
	// dropping the pot registration first broke the chain, so each child came
	// back "Agent GuardRevA2 was not spawned by you and cannot be cancelled".
	test("root cancels a grandchild named after the parked pot it came through", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Pot", displayName: "Pot", kind: "sub", parentId: "Main", session: null, status: "parked" });
		registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Pot", session: null, status: "running" });
		const manager = new AsyncJobManager({});
		manager.register("task", "Child", () => new Promise<string>(() => {}), { id: "Child", ownerId: "Pot", agentId: "Child" });

		const result = await executeCancel(sessionWith(registry), manager, "Main", ["Pot", "Child"]);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");

		expect(text).not.toContain("not spawned by you");
		expect(manager.getJob("Child")?.status).toBe("cancelled");
		expect(registry.get("Child")).toBeUndefined();
	});

	test("root cancels a grandchild whose pot registration is gone but whose pot job row remains", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Pot", session: null, status: "running" });
		const manager = new AsyncJobManager({});
		manager.register("task", "Pot", () => new Promise<string>(() => {}), { id: "Pot", ownerId: "Main", agentId: "Pot" });
		manager.register("task", "Child", () => new Promise<string>(() => {}), { id: "Child", ownerId: "Pot", agentId: "Child" });

		const result = await executeCancel(sessionWith(registry), manager, "Main", ["Child"]);

		expect(result.details?.cancelled?.map(row => row.status)).toEqual(["cancelled"]);
		expect(manager.getJob("Child")?.status).toBe("cancelled");
		expect(manager.getJob("Pot")?.status).toBe("running");
	});
});
