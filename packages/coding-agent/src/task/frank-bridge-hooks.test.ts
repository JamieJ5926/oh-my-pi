import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
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

function makeWrappedTask(handler: (...args: unknown[]) => Promise<unknown>, executed: unknown[]): AgentTool {
	const recording: AgentTool = {
		name: "task",
		label: "Task",
		description: "Test task tool",
		parameters: {} as AgentTool["parameters"],
		strict: true,
		execute: async (_id, params) => {
			executed.push(params);
			return { content: [{ type: "text", text: "task accepted" }] };
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
