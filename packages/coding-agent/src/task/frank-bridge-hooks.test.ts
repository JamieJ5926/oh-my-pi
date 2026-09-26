import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createFrankHostToolService } from "@oh-my-pi/pi-coding-agent/task/frank-host-tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	tempDir = TempDir.createSync("@frank-bridge-hooks-");
	authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
	modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

function makeWrappedTool(toolName: string, handler: (...args: unknown[]) => Promise<unknown>, executed: unknown[]): AgentTool {
	const recording: AgentTool = {
		name: toolName,
		label: toolName,
		description: `Test ${toolName} tool`,
		parameters: {} as AgentTool["parameters"],
		strict: true,
		execute: async (_id, params) => {
			executed.push(params);
			return { content: [{ type: "text", text: `${toolName} accepted` }] };
		},
	};
	const extension = {
		path: "test-extension",
		resolvedPath: "/test/test-extension.ts",
		handlers: new Map([["tool_call", [handler]]]),
		tools: new Map(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} satisfies Extension;
	const runner = new ExtensionRunner(
		[extension],
		{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
		process.cwd(),
		SessionManager.inMemory(),
		modelRegistry,
	);
	return new ExtensionToolWrapper(recording, runner);
}

function makeWrappedTask(handler: (...args: unknown[]) => Promise<unknown>, executed: unknown[]): AgentTool {
	return makeWrappedTool("task", handler, executed);
}

function makeService(wrapped: AgentTool) {
	return createFrankHostToolService({
		session: {
			asyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
			getAgentId: () => "Host",
			toolRegistry: new Map([["task", wrapped]]),
		} as unknown as ToolSession,
		agentId: "frank-test",
	});
}

function makeMutateService(toolName: string, wrapped: AgentTool) {
	return createFrankHostToolService({
		session: {
			asyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
			getAgentId: () => "Host",
			toolRegistry: new Map([[toolName, wrapped]]),
		} as unknown as ToolSession,
		agentId: "frank-test",
		names: ["task", "hub", "write", "edit", "bash"],
	});
}

function toolCallIdFrom(args: unknown[]): string | undefined {
	const event = args[0];
	if (typeof event !== "object" || event === null || !("toolCallId" in event)) return undefined;
	return typeof event.toolCallId === "string" ? event.toolCallId : undefined;
}

describe("Frank bridged hook parity", () => {
	test("a blocking extension hook refuses the bridged call", async () => {
		const executed: unknown[] = [];
		const toolCallIds: string[] = [];
		const wrapped = makeWrappedTask(async (...args) => {
			const toolCallId = toolCallIdFrom(args);
			if (toolCallId !== undefined) toolCallIds.push(toolCallId);
			return { block: true, reason: "nope" };
		}, executed);

		const result = await makeService(wrapped).handle("task", { task: "x" }, "call-1");

		expect(result).toEqual({ ok: false, error: "nope" });
		expect(executed).toEqual([]);
		expect(toolCallIds).toEqual(["call-1"]);
	});

	test("an allowed extension hook preserves the bridged tool result", async () => {
		const executed: unknown[] = [];
		const wrapped = makeWrappedTask(async () => undefined, executed);

		const result = await makeService(wrapped).handle("task", { task: "x" }, "call-2");

		expect(result).toEqual({ ok: true, content: "task accepted" });
		expect(executed).toEqual([{ task: "x" }]);
	});
});

describe("Frank bridged mutating tools", () => {
	for (const toolName of ["write", "edit", "bash"]) {
		test(`a blocking hook refuses the bridged ${toolName} call`, async () => {
			const executed: unknown[] = [];
			const toolCallIds: string[] = [];
			const wrapped = makeWrappedTool(toolName, async (...args) => {
				const toolCallId = toolCallIdFrom(args);
				if (toolCallId !== undefined) toolCallIds.push(toolCallId);
				return { block: true, reason: "nope" };
			}, executed);

			const result = await makeMutateService(toolName, wrapped).handle(toolName, toolName === "edit" ? { path: "x", old: "a", new: "b" } : { path: "x" }, "call-mutate");

			expect(result).toEqual({ ok: false, error: "nope" });
			expect(executed).toEqual([]);
			expect(toolCallIds).toEqual(["call-mutate"]);
		});
	}

	test("the default names stay task and hub", () => {
		expect(makeService(makeWrappedTask(async () => undefined, [])).toolNames()).toEqual(["task", "hub"]);
	});

	test("an unlisted tool is rejected", async () => {
		const executed: unknown[] = [];
		const wrapped = makeWrappedTask(async () => undefined, executed);

		const result = await makeService(wrapped).handle("write", { path: "x" }, "call-denied");

		expect(result).toEqual({ ok: false, error: "host tool is not enabled: write" });
		expect(executed).toEqual([]);
	});
});
describe("Frank bridged hook lane scope", () => {
	const workerPrompt = "Complete assignment thoroughly:\n\nROLE_MARK:frank-implementer";

	function firstUserText(ctx: unknown): string | undefined {
		if (typeof ctx !== "object" || ctx === null || !("sessionManager" in ctx)) return undefined;
		const manager = ctx.sessionManager;
		if (typeof manager !== "object" || manager === null || !("getEntries" in manager)) return undefined;
		if (typeof manager.getEntries !== "function") return undefined;
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const part = entry.message.content[0];
			return typeof part === "object" && part.type === "text" ? part.text : undefined;
		}
		return undefined;
	}

	function serviceWithLane(wrapped: AgentTool, lane: { workerLane?: { prompt: string; agent: string } }) {
		const host = SessionManager.inMemory();
		host.appendMessage({ role: "user", content: [{ type: "text", text: "root prompt" }], timestamp: Date.now() });
		return createFrankHostToolService({
			session: {
				asyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
				getAgentId: () => "Host",
				cwd: "/host/checkout",
				toolRegistry: new Map([["write", wrapped]]),
				getToolContext: () => ({ sessionManager: host }),
			} as unknown as ToolSession,
			agentId: "frank-test",
			names: ["write"],
			workerCwd: "/lane/worktree",
			...lane,
		});
	}

	test("a lane-keyed hook sees the worker prompt, keeps the host cwd, and refuses the bridged write", async () => {
		const executed: unknown[] = [];
		const seen: { prompt?: string; cwd?: unknown }[] = [];
		const wrapped = makeWrappedTool("write", async (_event, ctx) => {
			const prompt = firstUserText(ctx);
			seen.push({ prompt, cwd: typeof ctx === "object" && ctx !== null && "cwd" in ctx ? ctx.cwd : undefined });
			return prompt?.startsWith("Complete assignment thoroughly")
				? { block: true, reason: "main-checkout write denied" }
				: undefined;
		}, executed);

		const result = await serviceWithLane(wrapped, { workerLane: { prompt: workerPrompt, agent: "implementer" } }).handle("write", { path: "/host/checkout/x", content: "y" }, "call-lane");

		expect(result).toEqual({ ok: false, error: "main-checkout write denied" });
		expect(executed).toEqual([]);
		expect(seen).toEqual([{ prompt: workerPrompt, cwd: process.cwd() }]);
	});

	test("without a worker prompt the hook keeps the runner's own session and the write runs", async () => {
		const executed: unknown[] = [];
		const seen: (string | undefined)[] = [];
		const wrapped = makeWrappedTool("write", async (_event, ctx) => {
			seen.push(firstUserText(ctx));
			return undefined;
		}, executed);

		const result = await serviceWithLane(wrapped, {}).handle("write", { path: "/host/checkout/x", content: "y" }, "call-host");

		expect(result).toEqual({ ok: true, content: "write accepted" });
		expect(seen).toEqual([undefined]);
	});
});
describe("Frank bridged mutating argument translation", () => {
	test("write preserves Frank path and content", async () => {
		const executed: unknown[] = [];
		const wrapped = makeWrappedTool("write", async () => undefined, executed);
		const result = await makeMutateService("write", wrapped).handle("write", { path: "notes.txt", content: "hello" });

		expect(result.ok).toBe(true);
		expect(executed).toEqual([{ path: `${process.cwd()}/notes.txt`, content: "hello" }]);
	});

	test("edit maps Frank old and new to replace-mode names", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frank-edit-"));
		try {
			await Bun.write(path.join(dir, "notes.txt"), "before");
			const wrapped = makeWrappedTool("edit", async () => undefined, []);
			const replaceSession = {
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
			} as unknown as ToolSession;
			const service = createFrankHostToolService({
				session: {
					asyncJobManager: new AsyncJobManager({ maxRunningJobs: 4 }),
					getAgentId: () => "Host",
					toolRegistry: new Map([["edit", wrapped]]),
					getEditReplaceTool: () => new EditTool(replaceSession, "replace"),
					settings: { get: () => false },
					getToolContext: () => undefined,
					getSessionId: () => "test-session",
					getSessionFile: () => null,
					cwd: dir,
					enableLsp: false,
				} as unknown as ToolSession,
				agentId: "frank-test",
				names: ["task", "hub", "write", "edit", "bash"],
				workerCwd: dir,
			});
			const result = await service.handle("edit", { path: "notes.txt", old: "before", new: "after" });

			expect(result.ok).toBe(true);
			expect(await Bun.file(path.join(dir, "notes.txt")).text()).toBe("after");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("bash quotes each argv token and maps cwd and timeout", async () => {
		const executed: unknown[] = [];
		const wrapped = makeWrappedTool("bash", async () => undefined, executed);
		const result = await makeMutateService("bash", wrapped).handle("bash", {
			argv: ["printf", "%s", "it's safe"],
			cwd: ".",
			timeout_ms: 2500,
		});

		expect(result.ok).toBe(true);
		expect(executed).toEqual([
			{
				command: "'printf' '%s' 'it'\\''s safe'",
				cwd: `${process.cwd()}/.`,
				timeout: 2.5,
			},
		]);
	});
});
