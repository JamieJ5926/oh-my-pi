import "@oh-my-pi/pi-coding-agent/tools/yield";
import { afterEach, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

it.each(["terminal", "stale", "sections"] as const)("classifies a cancelled %s yield", async kind => {
	const controller = new AbortController();
	const payload = { status: "PASS", findings: ["recorded before cancellation"] };
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session: Partial<AgentSession> = {
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: callback => {
			listener = callback;
			return () => {};
		},
		prompt: async () => {
			listener?.({
				type: "tool_execution_end",
				toolCallId: "submitted-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: payload, ...(kind === "sections" ? { type: ["findings"] } : {}) },
				},
				isError: false,
			});
			if (kind === "stale") {
				listener?.({
					type: "message_start",
					message: {
						role: "custom",
						customType: "async-result",
						content: "Background job completed after the yield.",
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
					},
				});
			}
			controller.abort("Cancelled by caller");
			return true;
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => kind === "stale",
		abort: async () => {},
		dispose: async () => {},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: session as AgentSession,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	});
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "submit findings",
		index: 0,
		id: "cancelled-yield-regression",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		settings: Settings.isolated({ "task.maxRuntimeMs": 0 }),
		signal: controller.signal,
	});
	expect(result.extractedToolData?.yield).toEqual([
		{ status: "success", data: payload, ...(kind === "sections" ? { type: ["findings"] } : {}) },
	]);
	expect(result.aborted).toBe(kind !== "terminal");
	if (kind === "terminal") {
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual(payload);
	} else {
		expect(result.abortReason).toContain("Cancelled by caller");
	}
});
