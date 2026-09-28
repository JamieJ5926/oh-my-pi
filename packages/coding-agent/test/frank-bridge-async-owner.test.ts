import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async";
import { BUILTIN_TOOLS } from "../src/tools";
import type { ToolSession } from "../src/tools";
import { createFrankHostToolService } from "../src/task/frank-host-tools";

describe("Frank bridge async bash ownership", () => {
	test("registers and delivers a worker bash result only to the worker", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		const gate = Promise.withResolvers<string>();
		const parentResults: string[] = [];
		const unregisterParent = manager.registerDeliverySink("ParentSession", (_jobId, text) => {
			parentResults.push(text);
		});
		const originalBash = BUILTIN_TOOLS.bash;
		BUILTIN_TOOLS.bash = async workerSession =>
			({
				name: "bash",
				label: "Bash",
				description: "",
				parameters: {},
				execute: async () => {
					const ownerId = workerSession.getAgentId?.() ?? undefined;
					manager.register("bash", "Frank worker", () => gate.promise, {
						id: "bridge-owner-job",
						agentId: ownerId,
						ownerId,
					});
					return {
						content: [{ type: "text" as const, text: "started" }],
						details: { async: { state: "running", jobId: "bridge-owner-job" } },
					};
				},
			}) as never;
		try {
			const hostSession = {
				asyncJobManager: manager,
				getAgentId: () => "ParentSession",
				toolRegistry: new Map([
					["bash", { execute: async () => ({ content: [{ type: "text" as const, text: "parent tool" }] }) }],
				]),
				wrapWithHooks: (tool: { name: string; execute: unknown }) => tool,
			} as unknown as ToolSession;
			const service = createFrankHostToolService({
				session: hostSession,
				agentId: "FrankWorker",
				names: ["bash", "hub"],
			});

			const started = await service.handle("bash", { argv: ["echo", "worker"] });
			expect(started.ok).toBe(true);
			expect(manager.getJob("bridge-owner-job")?.ownerId).toBe("FrankWorker");

			gate.resolve("FRANK_WORKER_DELIVERY");
			await manager.waitForOwnerJobs("FrankWorker");
			const drained = await service.handle("hub", { op: "inbox" });

			expect(drained.content).toContain("FRANK_WORKER_DELIVERY");
			expect(parentResults).toEqual([]);
		} finally {
			unregisterParent();
			manager.dispose();
			BUILTIN_TOOLS.bash = originalBash;
		}
	});
});
