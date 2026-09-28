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

	test.each(["write", "edit", "bash"] as const)(
		"unregistered %s is refused without reaching the factory",
		async name => {
			const service = createFrankHostToolService({
				session: { toolRegistry: new Map() } as unknown as ToolSession,
				agentId: "frank-test",
				names: ["write", "edit", "bash"],
			});
			const result = await service.handle(name, { path: "x" });

			expect(result).toEqual({ ok: false, error: `host tool is not registered in the host session: ${name}` });
		},
	);

	test("coordinator work is blocked until dispatch unless the brief declares single-slice", async () => {
		let invoked = 0;
		const sessionWithRegistry = {
			toolRegistry: new Map([
				[
					"read",
					{
						execute: async () => {
							invoked++;
							return { content: [{ type: "text", text: "read" }] };
						},
					},
				],
			]),
		} as unknown as ToolSession;
		const service = createFrankHostToolService({
			session: sessionWithRegistry,
			agentId: "pot",
			names: ["read"],
			workerLane: { agent: "frank-poteto-agent", prompt: "Coordinate this work" },
		});
		expect(await service.handle("read", {})).toEqual({
			ok: false,
			error: "Delegation required: dispatch a task before calling `read`, or declare `single-slice: <reason>` in the worker brief.",
		});
		expect(invoked).toBe(0);
		const singleSlice = createFrankHostToolService({
			session: sessionWithRegistry,
			agentId: "solo",
			names: ["read"],
			workerLane: { agent: "frank-poteto-agent", prompt: "single-slice: this is indivisible" },
		});
		expect(await singleSlice.handle("read", {})).toEqual({ ok: true, content: "read" });
	});
	test("coordinator first bash, write, and edit are blocked before dispatch", async () => {
		const registry = new Map(
			["bash", "write", "edit"].map(name => [
				name,
				{ execute: async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }) },
			]),
		);
		const service = createFrankHostToolService({
			session: { toolRegistry: registry } as unknown as ToolSession,
			agentId: "pot",
			names: ["bash", "write", "edit"],
			workerLane: { agent: "frank-poteto-agent", prompt: "Coordinate work" },
		});
		for (const name of ["bash", "write", "edit"]) {
			expect(await service.handle(name, {})).toEqual({
				ok: false,
				error: `Delegation required: dispatch a task before calling \`${name}\`, or declare \`single-slice: <reason>\` in the worker brief.`,
			});
		}
	});

	test("coordinator child task without delegable declaration is blocked", async () => {
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async () =>
			({
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }),
			}) as never;
		try {
			const service = createFrankHostToolService({
				session: {} as ToolSession,
				agentId: "pot",
				workerLane: { agent: "frank-poteto-agent-deep", prompt: "Coordinate" },
			});
			expect(
				await service.handle("task", {
					tasks: [{ agent: "frank-poteto-agent", task: "Implement without delegation metadata" }],
				}),
			).toEqual({
				ok: false,
				error: "Delegation required: coordinator task item 1 must each declare their own `delegable: <scope>` or `single-slice: <reason>` in its task text.",
			});
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

	test("Frank explorer is not subject to coordinator dispatch guard", async () => {
		const service = createFrankHostToolService({
			session: {} as ToolSession,
			agentId: "explorer",
			names: ["read"],
			workerLane: { agent: "frank-explorer", prompt: "Inspect" },
		});
		const result = await service.handle("read", {});
		expect(result.ok).toBe(false);
		expect(result.error).not.toContain("Delegation required");
	});

	test("structured-only delegable scope is rejected until carried in child task text", async () => {
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async () =>
			({
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text" as const, text: "spawned" }] }),
			}) as never;
		try {
			const service = createFrankHostToolService({
				session: {} as ToolSession,
				agentId: "pot",
				workerLane: { agent: "frank-poteto-agent", prompt: "Coordinate" },
			});
			expect(
				await service.handle("task", {
					tasks: [{ agent: "frank-poteto-agent", task: "Inspect files", delegable: "inspect source only" }],
				}),
			).toEqual({
				ok: false,
				error: "Delegation required: coordinator task item 1 must each declare their own `delegable: <scope>` or `single-slice: <reason>` in its task text.",
			});
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

	test("aborting the bridge closes its tool service", async () => {
		const controller = new AbortController();
		const service = createFrankHostToolService({ session, agentId: "frank-test", signal: controller.signal });
		controller.abort();
		expect(service.closed).toBe(true);
		expect(await service.handle("hub", {})).toEqual({ ok: false, error: "host tool service is closed" });
	});

	test("coordinator batch requires each coordinator item to declare its own delegable scope", async () => {
		let invocations = 0;
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async () =>
			({
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => {
					invocations++;
					return { content: [{ type: "text", text: "spawned" }] };
				},
			}) as never;
		try {
			const service = createFrankHostToolService({
				session: {} as ToolSession,
				agentId: "pot",
				workerLane: { agent: "frank-poteto-agent-deep", prompt: "Coordinate" },
			});
			const rejected = await service.handle("task", {
				context: "delegable: shared scope",
				tasks: [
					{ agent: "frank-poteto-agent", task: "Implement A\ndelegable: source inspection" },
					{ agent: "frank-poteto-agent-deep", task: "Implement B" },
				],
			});
			expect(rejected).toEqual({
				ok: false,
				error: "Delegation required: coordinator task item 2 must each declare their own `delegable: <scope>` or `single-slice: <reason>` in its task text.",
			});
			expect(invocations).toBe(0);
			expect(
				await service.handle("task", {
					context: "Shared scope",
					tasks: [{ agent: "frank-poteto-agent", task: "single-slice: indivisible task" }],
				}),
			).toEqual({ ok: true, content: "spawned" });
			expect(invocations).toBe(1);
			const accepted = await service.handle("task", {
				context: "Shared scope",
				tasks: [
					{ agent: "frank-poteto-agent", task: "Implement A\ndelegable: source inspection" },
					{ agent: "frank-poteto-agent-deep", task: "Implement B\ndelegable: test review" },
				],
			});
			expect(accepted).toEqual({ ok: true, content: "spawned" });
			expect(invocations).toBe(2);
			const malformed = await service.handle("task", { task: "missing a batch" });
			expect(malformed).toEqual({
				ok: false,
				error: "Delegation required: coordinator task call must contain a non-empty tasks batch.",
			});
			const registeredRead = { execute: async () => ({ content: [{ type: "text", text: "read" }] }) };
			const unlockedService = createFrankHostToolService({
				session: { toolRegistry: new Map([["read", registeredRead]]) } as unknown as ToolSession,
				agentId: "pot",
				names: ["task", "read"],
				workerLane: { agent: "frank-poteto-agent-deep", prompt: "Coordinate" },
			});
			expect(
				await unlockedService.handle("task", {
					context: "Shared",
					tasks: [{ agent: "implementer", task: "child" }],
				}),
			).toEqual({ ok: true, content: "spawned" });
			expect(await unlockedService.handle("read", {})).toEqual({ ok: true, content: "read" });
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

	test("task bridge passes a 10-item batch through as one call", async () => {
		let capturedArgs: unknown;
		let invocations = 0;
		const original = BUILTIN_TOOLS.task;
		BUILTIN_TOOLS.task = async () =>
			({
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async (_toolCallId: string, args: unknown) => {
					invocations++;
					capturedArgs = args;
					return { content: [{ type: "text", text: "spawned" }] };
				},
			}) as never;
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

	// 2026-09-26: Frank leaves (frank-explorer, frank-reviewer-fast) spawned children because
	// every Frank lane got `task` and the host session's "*" spawn list.
	test("a Frank leaf without task in its names cannot dispatch children", async () => {
		const original = BUILTIN_TOOLS.task;
		let built = false;
		BUILTIN_TOOLS.task = async () => {
			built = true;
			return {
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "spawned" }] }),
			} as never;
		};
		try {
			const hostSession = {
				getAgentId: () => "Host",
				getToolContext: () => undefined,
				getSessionSpawns: () => "*",
			} as unknown as ToolSession;
			const service = createFrankHostToolService({
				session: hostSession,
				agentId: "Leaf",
				names: ["hub", "write", "edit", "bash"],
				spawns: "",
			});
			const result = await service.handle("task", { task: "child" });
			expect(result.ok).toBe(false);
			expect(built).toBe(false);
		} finally {
			BUILTIN_TOOLS.task = original;
		}
	});

	test("the task tool a Frank pot builds sees the pot's spawn list, not the host's", async () => {
		const original = BUILTIN_TOOLS.task;
		let seen: string | null | undefined;
		BUILTIN_TOOLS.task = async session => {
			seen = session.getSessionSpawns?.();
			return {
				name: "task",
				label: "Task",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "spawned" }] }),
			} as never;
		};
		try {
			const hostSession = {
				getAgentId: () => "Host",
				getToolContext: () => undefined,
				getSessionSpawns: () => "*",
			} as unknown as ToolSession;
			const service = createFrankHostToolService({
				session: hostSession,
				agentId: "Pot",
				names: ["task"],
				spawns: "frank-explorer,frank-implementer",
			});
			await service.handle("task", { task: "child" });
			expect(seen).toBe("frank-explorer,frank-implementer");
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
			toolRegistry: new Map([
				["task", { execute: async () => ({ content: [{ type: "text", text: "host-registry" }] }) }],
			]),
			wrapWithHooks: (tool: { name: string; execute: unknown }) => {
				wrapped.push(tool.name);
				return tool;
			},
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
			const result = await createFrankHostToolService({ session: hostSession, agentId: "FrankPot" }).handle("task", {
				task: "child",
			});
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
						if (args && typeof args === "object" && "path" in args && typeof args.path === "string")
							paths.push(args.path);
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
			const service = createFrankHostToolService({
				session: sessionWithRegistry,
				agentId: "frank-test",
				workerCwd: dir,
				names: ["edit"],
			});
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
		const service = createFrankHostToolService({
			session: sessionWithRegistry,
			agentId: "frank-test",
			workerCwd: "/tmp/frank-worker",
			names: ["edit"],
		});
		const result = await service.handle("edit", { path: "notes.txt", old: "before", new: "after" });
		expect(result.ok).toBe(true);
		expect(executed).toEqual([{ path: "/tmp/frank-worker/notes.txt", old_string: "before", new_string: "after" }]);
	});

	test("bash background job body is available through hub inbox", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		manager.register("bash", "Host", async () => "BASH_JOB_BODY", {
			id: "bash-job",
			agentId: "Host",
			ownerId: "Host",
		});
		await manager.getJob("bash-job")?.promise;
		const sessionWithRegistry = {
			asyncJobManager: manager,
			getAgentId: () => "Host",
			toolRegistry: new Map([
				[
					"bash",
					{
						execute: async () => ({
							content: [{ type: "text" as const, text: "started" }],
							details: { async: { state: "running", jobId: "bash-job" } },
						}),
					},
				],
				["hub", { execute: async () => ({ content: [{ type: "text" as const, text: "inbox" }] }) }],
			]),
		} as unknown as ToolSession;
		const service = createFrankHostToolService({
			session: sessionWithRegistry,
			agentId: "frank-test",
			names: ["bash", "hub"],
		});
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

	test("wait with ids returns on the first newly settled child", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		let finishFast: () => void = () => {};
		let finishSlow: () => void = () => {};
		let fastStarted!: () => void;
		let slowStarted!: () => void;
		const fastReady = new Promise<void>(resolve => {
			fastStarted = resolve;
		});
		const slowReady = new Promise<void>(resolve => {
			slowStarted = resolve;
		});
		manager.register(
			"task",
			"Fast",
			async () => {
				fastStarted();
				await new Promise<void>(resolve => {
					finishFast = resolve;
				});
				return "FAST_BODY";
			},
			{ id: "Fast", agentId: "Fast", ownerId: "Host" },
		);
		manager.register(
			"task",
			"Slow",
			async () => {
				slowStarted();
				await new Promise<void>(resolve => {
					finishSlow = resolve;
				});
				return "SLOW_BODY";
			},
			{ id: "Slow", agentId: "Slow", ownerId: "Host" },
		);
		await Promise.all([fastReady, slowReady]);
		const resultPromise = bridge(manager).handle("hub", { op: "wait", ids: ["Fast", "Slow"], timeoutMs: 5_000 });
		let returned = false;
		void resultPromise.then(() => {
			returned = true;
		});
		finishFast();
		await manager.getJob("Fast")?.promise;
		for (let i = 0; i < 5; i++) await Promise.resolve();
		const returnedAfterFirst = returned;
		finishSlow();
		const result = await resultPromise;
		expect(returnedAfterFirst).toBe(true);
		expect(result.content).toContain("FAST_BODY");
		expect(result.content).toContain("Still running: Slow");
		await manager.getJob("Slow")?.promise;
	});

	test("cancel bridge cancels only requested Frank-owned jobs", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		let signal: AbortSignal | undefined;
		let started!: () => void;
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		manager.register(
			"task",
			"CancelMe",
			async ctx => {
				signal = ctx.signal;
				started();
				await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
				return "cancelled";
			},
			{ id: "CancelMe", agentId: "CancelMe", ownerId: "frank-test" },
		);
		await ready;
		const session = { asyncJobManager: manager, getAgentId: () => "Host" } as unknown as ToolSession;
		const result = await createFrankHostToolService({ session, agentId: "frank-test" }).handle("hub", {
			op: "cancel",
			ids: ["CancelMe"],
		});
		expect(result.ok).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(result.content).toContain("CancelMe");
		await manager.getJob("CancelMe")?.promise;
	});
	test("zero timeout waits up to the native hub maximum when a child is pending", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 4 });
		let finish: () => void = () => {};
		let started!: () => void;
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		manager.register(
			"task",
			"WaitForever",
			async () => {
				started();
				await new Promise<void>(resolve => {
					finish = resolve;
				});
				return "DONE";
			},
			{ id: "WaitForever", agentId: "WaitForever", ownerId: "Host" },
		);
		await ready;
		const wait = bridge(manager).handle("hub", { op: "wait", ids: ["WaitForever"], timeoutMs: 0 });
		let returned = false;
		void wait.then(() => {
			returned = true;
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(returned).toBe(false);
		finish();
		const result = await wait;
		expect(result.content).toContain("DONE");
		await manager.getJob("WaitForever")?.promise;
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
	test("queued host mail is injected into the next non-hub tool result", async () => {
		const id = "SteerMailNonHubProbe";
		AgentRegistry.global().unregister(id);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		await IrcBus.global().send({ from: "Main", to: id, body: "steer before run" });
		const service = createFrankHostToolService({
			session: {
				toolRegistry: new Map([
					["read", { execute: async () => ({ content: [{ type: "text" as const, text: "file contents" }] }) }],
				]),
			} as unknown as ToolSession,
			agentId: id,
			names: ["read"],
		});
		const result = await service.handle("read", {});
		expect(result.content).toContain("steer before run");
		expect(result.content).toContain("file contents");
		expect(IrcBus.global().unreadCount(id)).toBe(0);
		AgentRegistry.global().unregister(id);
	});
	test("unregistered mutating tool refusal includes drained host mail", async () => {
		const id = "SteerMailUnregisteredProbe";
		AgentRegistry.global().unregister(id);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		await IrcBus.global().send({ from: "Main", to: id, body: "steer before refusal" });
		const service = createFrankHostToolService({
			session: { toolRegistry: new Map() } as unknown as ToolSession,
			agentId: id,
			names: ["write"],
		});

		const result = await service.handle("write", { path: "x" });

		expect(result).toEqual({
			ok: false,
			error: "Host messages:\n[hub from Main] steer before refusal\n\nhost tool is not registered in the host session: write",
		});
		expect(IrcBus.global().unreadCount(id)).toBe(0);
		AgentRegistry.global().unregister(id);
	});
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
	test("delivers to a retained Frank and queues its unsupported steer for inbox", async () => {
		const registry = AgentRegistry.global();
		const id = "SteerRetainedProbe";
		registry.unregister(id);
		registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		const remove = registry.registerRetainedDelivery(id, async message => message.body === "legacy" ? { kind: "unsupported" } : { kind: "delivered" });
		try {
			const delivered = await IrcBus.global().send({ from: "Main", to: id, body: "live" });
			expect(delivered.outcome).toBe("injected");
			expect(IrcBus.global().unreadCount(id)).toBe(0);
			const unsupported = await IrcBus.global().send({ from: "Main", to: id, body: "legacy" });
			expect(unsupported.outcome).toBe("queued");
			const service = createFrankHostToolService({ session: {} as ToolSession, agentId: id, names: ["hub"] });
			const inbox = await service.handle("hub", { op: "inbox" });
			expect(inbox.content ?? "").toContain("[hub from Main] legacy");
			expect(IrcBus.global().unreadCount(id)).toBe(0);
		} finally {
			remove();
		}
	});
	test("does not enqueue a retained message when steer acknowledgement times out", async () => {
		const registry = AgentRegistry.global();
		const id = "SteerRetainedTimeoutProbe";
		registry.unregister(id);
		registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		const remove = registry.registerRetainedDelivery(id, async () => ({ kind: "failed", error: "Frank steer acknowledgement timed out; delivery status is unknown" }));
		try {
			const receipt = await IrcBus.global().send({ from: "Main", to: id, body: "possibly delivered" });
			expect(receipt).toEqual({ to: id, outcome: "failed", error: "Frank steer acknowledgement timed out; delivery status is unknown" });
			expect(IrcBus.global().unreadCount(id)).toBe(0);
		} finally {
			remove();
			registry.unregister(id);
		}
	});
	test("does not enqueue a retained message when its delivery handler fails", async () => {
		const registry = AgentRegistry.global();
		const id = "SteerRetainedFailureProbe";
		registry.unregister(id);
		registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		const remove = registry.registerRetainedDelivery(id, async () => ({ kind: "failed", error: "boom" }));
		try {
			const receipt = await IrcBus.global().send({ from: "Main", to: id, body: "do not queue" });
			expect(receipt).toEqual({ to: id, outcome: "failed", error: "boom" });
			expect(IrcBus.global().unreadCount(id)).toBe(0);
		} finally {
			remove();
			registry.unregister(id);
		}
	});
	test("a bridged hub send reports queued next-turn delivery and drains on the lane's next call", async () => {
		const id = "SteerMailBridgedProbe";
		const registry = AgentRegistry.global();
		registry.unregister(id);
		registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
		const hostSession = {
			agentRegistry: registry,
			settings: { get: () => undefined },
			getAgentId: () => "Main",
		} as unknown as ToolSession;
		try {
			const sender = createFrankHostToolService({ session: hostSession, agentId: "Main", names: ["hub"] });
			const receipt = await sender.handle("hub", { op: "send", to: id, message: "bridged steering" });
			expect(receipt.ok).toBe(true);
			expect(receipt.content).toContain("Queued for 1 remote peer(s), delivered on next turn:");
			expect(receipt.content).toContain(`- ${id}: queued`);

			const lane = createFrankHostToolService({ session: hostSession, agentId: id, names: ["hub"] });
			const nextTurn = await lane.handle("hub", { op: "inbox" });
			expect(nextTurn.content).toContain("[hub from Main] bridged steering");
			expect(IrcBus.global().unreadCount(id)).toBe(0);
		} finally {
			registry.unregister(id);
		}
	});

	// 2026-09-26: FFExp02/03/07 could not report to Main: the bridge served the
	// host's own hub instance, so the lane's send carried the host identity and
	// tripped "Cannot send a message to yourself."
	test("a bridged hub send carries the Frank lane identity, so a report to Main is delivered", async () => {
		const registry = AgentRegistry.global();
		const leaf = "FrankLeafReport";
		registry.unregister(leaf);
		registry.register({ id: leaf, displayName: leaf, kind: "sub", session: null, status: "running" });
		let seen: string | null | undefined;
		const original = BUILTIN_TOOLS.hub;
		BUILTIN_TOOLS.hub = async session => {
			seen = session.getAgentId?.();
			return {
				name: "hub",
				label: "Hub",
				description: "",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "queued" }] }),
			} as never;
		};
		try {
			const hostHub = {
				execute: async () => ({ content: [{ type: "text" as const, text: "Cannot send a message to yourself." }] }),
			};
			const hostSession = {
				getAgentId: () => "Main",
				getToolContext: () => undefined,
				toolRegistry: new Map([["hub", hostHub]]),
			} as unknown as ToolSession;
			const service = createFrankHostToolService({ session: hostSession, agentId: leaf, names: ["hub"] });
			const result = await service.handle("hub", { op: "send", to: "Main", message: "report" });
			expect(seen).toBe(leaf);
			expect(result.content ?? "").not.toContain("Cannot send a message to yourself");
		} finally {
			BUILTIN_TOOLS.hub = original;
			registry.unregister(leaf);
		}
	});
});
