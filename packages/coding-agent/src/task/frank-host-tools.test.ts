import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../async";
import { EditTool } from "../edit";
import { BUILTIN_TOOLS } from "../tools";
import type { ToolSession } from "../tools";
import { createFrankHostToolService } from "./frank-host-tools";
import { AgentRegistry } from "../registry/agent-registry";
import { IrcBus } from "../irc/bus";

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

	test.each(["write", "edit", "bash"] as const)("unregistered %s is refused without reaching the factory", async name => {
		const service = createFrankHostToolService({
			session: { toolRegistry: new Map() } as unknown as ToolSession,
			agentId: "frank-test",
			names: ["write", "edit", "bash"],
		});
		const result = await service.handle(name, { path: "x" });

		expect(result).toEqual({ ok: false, error: `host tool is not registered in the host session: ${name}` });
	});

	test("task bridge passes a 10-item batch through as one call", async () => {
		let capturedArgs: unknown;
		let invocations = 0;
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async () => ({
			name: "task",
			label: "Task",
			description: "",
			parameters: {},
			execute: async (_toolCallId: string, args: unknown) => {
				invocations++;
				capturedArgs = args;
				return { content: [{ type: "text", text: "spawned" }] };
			},
		} as never);
		const args = {
			context: "delegable: implementer slices",
			tasks: Array.from({ length: 10 }, (_, index) => ({
				name: `slice-${index + 1}`,
				agent: "implementer",
				task: `Implement slice ${index + 1}`,
			})),
		};
		try {
			const service = createFrankHostToolService({ session: {} as ToolSession, agentId: "frank-test" });
			await service.handle("task", args);
			expect(capturedArgs).toEqual(args);
			expect(invocations).toBe(1);
		} finally {
			BUILTIN_TOOLS.task = original;
		}
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

	test("task bridge with session hooks builds the tool for the Frank worker and wraps it", async () => {
		let factorySession: ToolSession | undefined;
		const wrapped: string[] = [];
		const hostSession = {
			getAgentId: () => "Host",
			getToolContext: () => undefined,
			toolRegistry: new Map([["task", { execute: async () => ({ content: [{ type: "text", text: "host-registry" }] }) }]]),
			wrapWithHooks: (tool: { name: string; execute: unknown }) => {
				wrapped.push(tool.name);
				return tool;
			},
		} as unknown as ToolSession;
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async session => {
			factorySession = session;
			return { name: "task", label: "Task", description: "", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "spawned" }] }) } as never;
		};
		try {
			const result = await createFrankHostToolService({ session: hostSession, agentId: "FrankPot" }).handle("task", { task: "child" });
			expect(result).toEqual({ ok: true, content: "spawned" });
			expect(factorySession?.getAgentId?.()).toBe("FrankPot");
			expect(wrapped).toEqual(["task"]);
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

	test("write paths resolve against the Frank worker cwd and preserve special paths", async () => {
		const paths: string[] = [];
		const sessionWithRegistry = {
			toolRegistry: {
				get: () => ({
					execute: async (_id: string, args: unknown) => {
						if (args && typeof args === "object" && "path" in args && typeof args.path === "string") paths.push(args.path);
						return { content: [{ type: "text" as const, text: "written" }] };
					},
				}),
			},
		} as unknown as ToolSession;
		const service = createFrankHostToolService({ session: sessionWithRegistry, agentId: "frank-test", workerCwd: "/tmp/frank-worker", names: ["write"] });
		for (const path of ["src/file.ts", "~/notes.md", "local://notes.md", "vault://notes.md"]) {
			await service.handle("write", { path, content: "body" });
		}
		expect(paths).toEqual(["/tmp/frank-worker/src/file.ts", "~/notes.md", "local://notes.md", "vault://notes.md"]);
	});

test("edit bridge applies old_string/new_string with replace semantics", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frank-edit-"));
	try {
		await Bun.write(path.join(dir, "file.txt"), "before");
		const replaceTool = new EditTool(
			{
				settings: { get: () => false },
				getToolContext: () => undefined,
				getAgentId: () => "Host",
				getSessionId: () => "test-session",
				getSessionFile: () => null,
				sessionManager: {
					getSessionId: () => "test-session",
					getSessionFile: () => null,
					getCwd: () => dir,
				},
				cwd: dir,
				enableLsp: false,
			} as unknown as ToolSession,
			"replace",
		);
		const sessionWithRegistry = {
			settings: { get: () => false },
			toolRegistry: new Map([["edit", { name: "edit" }]]),
			getEditReplaceTool: () => replaceTool,
			getToolContext: () => undefined,
			getAgentId: () => "Host",
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			cwd: dir,
			enableLsp: false,
		} as unknown as ToolSession;
		const service = createFrankHostToolService({ session: sessionWithRegistry, agentId: "frank-test", workerCwd: dir, names: ["edit"] });
		const result = await service.handle("edit", { path: "file.txt", old: "before", new: "after" });
		expect(result.ok).toBe(true);
		expect(await Bun.file(path.join(dir, "file.txt")).text()).toBe("after");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("edit bridge without a replace-tool accessor still applies through the registry tool", async () => {
	const executed: unknown[] = [];
	const sessionWithRegistry = {
		toolRegistry: {
			get: () => ({
				execute: async (_id: string, args: unknown) => {
					executed.push(args);
					return { content: [{ type: "text" as const, text: "edited" }] };
				},
			}),
		},
	} as unknown as ToolSession;
	const service = createFrankHostToolService({ session: sessionWithRegistry, agentId: "frank-test", workerCwd: "/tmp/frank-worker", names: ["edit"] });
	const result = await service.handle("edit", { path: "notes.txt", old: "before", new: "after" });
	expect(result.ok).toBe(true);
	expect(executed).toEqual([{ path: "/tmp/frank-worker/notes.txt", old_string: "before", new_string: "after" }]);
});

	test("bash background job body is available through hub inbox", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("bash", "Host", async () => "BASH_JOB_BODY", { id: "bash-job", agentId: "Host", ownerId: "Host" });
		await manager.getJob("bash-job")?.promise;
		const sessionWithRegistry = {
			asyncJobManager: manager,
			getAgentId: () => "Host",
			toolRegistry: new Map([["bash", { execute: async () => ({ content: [{ type: "text" as const, text: "started" }], details: { async: { state: "running", jobId: "bash-job" } } }) }], ["hub", { execute: async () => ({ content: [{ type: "text" as const, text: "inbox" }] }) }]]),
		} as unknown as ToolSession;
		const service = createFrankHostToolService({ session: sessionWithRegistry, agentId: "frank-test", names: ["bash", "hub"] });
		await service.handle("bash", { argv: ["sleep", "1"] });
		const result = await service.handle("hub", { op: "inbox" });
		expect(result.content).toContain("BASH_JOB_BODY");
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

describe("Frank hub send mailbox", () => {
	test("a running frank seat with a null session accepts hub send and the next hub call returns the body", async () => {
		const id = "SteerMailProbe";
		AgentRegistry.global().unregister(id);
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: null,
			status: "running",
		});
		const receipt = await IrcBus.global().send({ from: "Main", to: id, body: "steer this lane" });
		expect(receipt.outcome).toBe("queued");
		expect(receipt.error ?? "").not.toContain("no live session");
		const service = createFrankHostToolService({
			session: {} as ToolSession,
			agentId: id,
			names: ["hub"],
		});
		const drained = await service.handle("hub", { op: "list" });
		expect(drained.content ?? "").toContain("steer this lane");
		expect(IrcBus.global().unreadCount(id)).toBe(0);
		AgentRegistry.global().unregister(id);
	});
});
