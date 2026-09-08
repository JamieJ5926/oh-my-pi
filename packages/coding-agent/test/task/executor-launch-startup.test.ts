import { afterEach, expect, it, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ResolvedRoleProfile } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) await authStorage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir[Symbol.dispose]();
});

it("overlaps registry refresh with session-file opening and session setup", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(() => refreshGate.promise);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const openGate = Promise.withResolvers<SessionManager>();
	const openStarted = Promise.withResolvers<void>();
	const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
		openStarted.resolve();
		return openGate.promise;
	});

	const sessionCreationStarted = Promise.withResolvers<void>();
	let sessionCreated = false;
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		sessionCreationStarted.resolve();
		sessionCreated = true;
		const result: CreateAgentSessionResult = {
			session,
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		return result;
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-launch-overlap",
		authStorage,
		enableLsp: false,
		enableIrc: false,
	});
	await openStarted.promise;

	expect(openSpy).toHaveBeenCalledTimes(1);
	expect(sessionCreated).toBe(false);

	openGate.resolve(sessionManager);
	await sessionCreationStarted.promise;
	expect(sessionCreated).toBe(true);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
});

function launchHarness(agent: AgentDefinition, enabledTools: string[]) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let sessionInit: Record<string, unknown> | undefined;
	let sessionOptions: CreateAgentSessionOptions | undefined;
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: (init: Record<string, unknown>) => {
				sessionInit = init;
			},
		},
		getActiveToolNames: () => enabledTools,
		getEnabledToolNames: () => enabledTools,
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		sessionOptions = options;
		return {
			session,
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return {
		sessionInit: () => sessionInit,
		sessionOptions: () => sessionOptions,
		run: (extra: Record<string, unknown> = {}) => {
			const tempDir = TempDir.createSync("@pi-task-minimal-");
			tempDirs.push(tempDir);
			return runSubprocess({
				cwd: tempDir.path(),
				artifactsDir: tempDir.path(),
				agent,
				task: "test",
				index: 0,
				id: "task-minimal-render",
				enableLsp: false,
				enableIrc: false,
				...extra,
			});
		},
	};
}

it("renders a minimal role prompt with no base prompt", async () => {
	const harness = launchHarness(
		{
			name: "recorder",
			description: "test",
			systemPrompt: "Record the target.",
			source: "bundled",
			minimalPrompt: true,
		},
		["read", "yield"],
	);
	expect((await harness.run()).exitCode).toBe(0);
	const systemPrompt = harness.sessionOptions()?.systemPrompt;
	expect(Array.isArray(systemPrompt)).toBe(true);
	expect(systemPrompt).toHaveLength(1);
	expect(systemPrompt?.[0]).toContain("Record the target.");
});

it("keeps the full render callback assembling around the default prompt", async () => {
	const harness = launchHarness(
		{ name: "worker", description: "test", systemPrompt: "Do the assigned work.", source: "bundled" },
		["read", "yield"],
	);
	expect((await harness.run()).exitCode).toBe(0);
	const systemPrompt = harness.sessionOptions()?.systemPrompt;
	expect(typeof systemPrompt).toBe("function");
	const rendered = typeof systemPrompt === "function" ? systemPrompt(["base-a", "base-b"]) : [];
	expect(rendered).toHaveLength(3);
	expect(rendered[0]).toBe("base-a");
	expect(rendered[2]).toBe("base-b");
	expect(rendered[1]).toContain("Do the assigned work.");
});

it("persists the role profile with synthetic write excluded", async () => {
	const profile: ResolvedRoleProfile = {
		contentHash: "abc",
		mode: "full",
		sources: { prompt: "test", instructions: [], skills: [], hooks: [], tools: ["read"] },
		contextFiles: [],
		rules: [],
		skills: [],
		extensionPaths: [],
	};
	const harness = launchHarness(
		{ name: "reader", description: "test", systemPrompt: "Read only.", source: "bundled", tools: ["read"] },
		["read", "write", "yield"],
	);
	expect((await harness.run({ roleProfile: profile })).exitCode).toBe(0);
	const init = harness.sessionInit() as unknown as { tools: string[]; roleProfile: ResolvedRoleProfile };
	expect(init.tools).toEqual(["read", "yield"]);
	expect(init.roleProfile.sources.tools).toEqual(["read", "yield"]);
	expect(init.roleProfile.mode).toBe("full");
	expect(init.roleProfile.contentHash).toBe("abc");
});
