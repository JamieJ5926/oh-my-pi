import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async";
import { BUILTIN_TOOLS } from "../tools";
import type { ToolSession } from "../tools";
import { createFrankHostToolService } from "./frank-host-tools";

describe("Frank host tool service", () => {
	const session = {} as ToolSession;

	test("disabled unknown tool name is refused by default", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test" });
		const result = await service.handle("missing-tool", {});

		expect(result).toEqual({ ok: false, error: "host tool is not enabled: missing-tool" });
	});

	test("enabled but unknown tool name is refused", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test", names: ["missing-tool"] });
		const result = await service.handle("missing-tool", {});

		expect(result).toEqual({ ok: false, error: "unknown host tool: missing-tool" });
	});

	test("tool outside the enabled names is refused and named in the error", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test", names: ["task"] });
		const result = await service.handle("hub", {});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("host tool is not enabled: hub");
	});

	test("task bridge runs the tool with the Frank parent identity", async () => {
		let factorySession: ToolSession | undefined;
		const hostSession = {
			getAgentId: () => "FrankParent",
			getToolContext: () => undefined,
		} as unknown as ToolSession;
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async session => {
			factorySession = session;
			return {
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "spawned" }] }),
			} as never;
		};
		try {
			const service = createFrankHostToolService({ session: hostSession, agentId: "FrankParent" });
			await service.handle("task", { task: "child" });
			expect(factorySession?.getAgentId?.()).toBe("FrankParent");
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

test("write paths resolve against the Frank worker cwd", async () => {
	let writtenPath: string | undefined;
	const sessionWithRegistry = {
		toolRegistry: {
			get: () => ({
				execute: async (_id: string, args: unknown) => {
					if (args && typeof args === "object" && "path" in args && typeof args.path === "string") {
						writtenPath = args.path;
					}
					expect(args).toMatchObject({ path: "/tmp/frank-worker/src/file.ts" });
					return { content: [{ type: "text" as const, text: "written" }] };
				},
			}),
		},
	} as unknown as ToolSession;
	const service = createFrankHostToolService({
		session: sessionWithRegistry,
		agentId: "frank-test",
		workerCwd: "/tmp/frank-worker",
		names: ["write"],
	});
	const result = await service.handle("write", { path: "src/file.ts", content: "body" });

	expect(result.ok).toBe(true);
	expect(writtenPath).toBe("/tmp/frank-worker/src/file.ts");
});
	test("bash bridge appends a drain note only for a running background result", async () => {
		const registeredTool = {
			execute: async () => ({
				content: [{ type: "text" as const, text: "started" }],
				details: { async: { state: "running", jobId: "job-1", type: "bash" } },
			}),
		};
		const service = createFrankHostToolService({
			session: { toolRegistry: { get: () => registeredTool } } as unknown as ToolSession,
			agentId: "frank-test",
			names: ["bash"],
		});

		const result = await service.handle("bash", { argv: ["sleep", "1"] });

		expect(result.content).toContain("started");
		expect(result.content).toContain("Bridge note:");
	});

	test("bash bridge omits the drain note for a settled result", async () => {
		const settledTool = {
			execute: async () => ({
				content: [{ type: "text" as const, text: "done" }],
				details: { async: { state: "completed", jobId: "job-2", type: "bash" } },
			}),
		};
		const service = createFrankHostToolService({
			session: { toolRegistry: { get: () => settledTool } } as unknown as ToolSession,
			agentId: "frank-test",
			names: ["bash"],
		});

		const result = await service.handle("bash", { argv: ["echo", "hi"] });

		expect(result.content).toContain("done");
		expect(result.content).not.toContain("Bridge note:");
	});
});

describe("Frank host tool service: child drain", () => {
	function bridge(manager: AsyncJobManager) {
		return createFrankHostToolService({
			session: { asyncJobManager: manager, getAgentId: () => "Host" } as unknown as ToolSession,
			agentId: "frank-test",
		});
	}

	test("a settled child's body reaches the worker after the host session consumed it", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("task", "ChildWake", async () => "PROBE_BODY_OK", {
			id: "ChildWake",
			agentId: "ChildWake",
			ownerId: "Host",
		});
		await manager.getJob("ChildWake")?.promise;
		// What the host session's async-result sink does the moment the child yields.
		manager.consumeJobResults(["ChildWake"]);

		const result = await bridge(manager).handle("hub", { op: "wait", to: "ChildWake", timeoutMs: 5_000 });

		expect(result.ok).toBe(true);
		expect(result.content).toContain("Background job ChildWake has completed");
		expect(result.content).toContain("PROBE_BODY_OK");
	});

	test("a wait returns the settled body and names the child still running", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("task", "ChildFast", async () => "FAST_BODY", {
			id: "ChildFast",
			agentId: "ChildFast",
			ownerId: "Host",
		});
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		manager.register(
			"task",
			"ChildSlow",
			async () => {
				await gate;
				return "SLOW_BODY";
			},
			{ id: "ChildSlow", agentId: "ChildSlow", ownerId: "Host" },
		);
		await manager.getJob("ChildFast")?.promise;

		const result = await bridge(manager).handle("hub", {
			op: "wait",
			ids: ["ChildFast", "ChildSlow"],
			timeoutMs: 50,
		});

		expect(result.content).toContain("FAST_BODY");
		expect(result.content).toContain("Still running: ChildSlow");
		release();
	});

	test("a body over the inline budget stays on the job row instead of being consumed", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("task", "ChildBig", async () => "x".repeat(13_000), {
			id: "ChildBig",
			agentId: "ChildBig",
			ownerId: "Host",
		});
		await manager.getJob("ChildBig")?.promise;

		const result = await bridge(manager).handle("hub", { op: "wait", to: "ChildBig", timeoutMs: 5_000 });

		expect(result.content).toContain("left intact on the job row: ChildBig");
		expect(manager.isJobResultConsumed("ChildBig")).toBe(false);
		expect(manager.getJob("ChildBig")?.resultText?.length).toBe(13_000);
	});

	test("a child owned by another session is never answered from this bridge", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("task", "Foreign", async () => "FOREIGN_BODY", {
			id: "Foreign",
			agentId: "Foreign",
			ownerId: "Other",
		});
		await manager.getJob("Foreign")?.promise;

		const result = await createFrankHostToolService({
			session: { asyncJobManager: manager, getAgentId: () => "Host" } as unknown as ToolSession,
			agentId: "frank-test",
		}).handle("hub", { op: "wait", to: "Foreign", timeoutMs: 5_000 });

		expect(result.content ?? "").not.toContain("FOREIGN_BODY");
	});

	test("a settled child owned by the Frank parent reaches the worker", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("task", "FrankChild", async () => "FRANK_CHILD_BODY", {
			id: "FrankChild",
			agentId: "FrankChild",
			ownerId: "frank-test",
		});
		await manager.getJob("FrankChild")?.promise;
		manager.consumeJobResults(["FrankChild"]);

		const result = await bridge(manager).handle("hub", { op: "wait", to: "FrankChild", timeoutMs: 5_000 });

		expect(result.ok).toBe(true);
		expect(result.content).toContain("FRANK_CHILD_BODY");
	});
});
