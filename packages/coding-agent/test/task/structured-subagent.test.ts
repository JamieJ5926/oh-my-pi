import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ContextFileEntry } from "@oh-my-pi/pi-coding-agent/tools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		planMode?: boolean;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationMode?: "none" | "worktree";
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.enableLsp": true,
			...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
			...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");
		expect(discover).not.toHaveBeenCalled();
	});
	it("reloads model roles before resolving an agent added during the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-hot-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = {
			...session(),
			cwd: projectDir,
			settings: liveSettings,
		} as ToolSession;

		try {
			await Bun.write(path.join(projectDir, ".omp", "config.yml"), "modelRoles:\n  hot_worker: kimi-code/k3:max\n");
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				'---\nname: hot-worker\ndescription: Newly added worker.\nmodel: "@hot_worker"\n---\n\nInspect the assignment.\n',
			);

			const policy = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "hot-worker" }));

			expect(policy.modelRole).toBe("hot_worker");
			expect(policy.modelOverride).toEqual(["kimi-code/k3:max"]);
		} finally {
			liveSettings.cancelPendingSaves();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("does not treat a spawn handle as the HUD description", async () => {
		mockDiscovery();
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const handleOnly = await runStructuredSubagent(
			request({ identity: { id: "AuthLoader", label: "AuthLoader" }, retainArtifacts: true }),
		);
		expect(dispatched[0]?.description).toBeUndefined();
		expect(dispatched[0]?.id).toBe("AuthLoader");
		await fs.rm(handleOnly.artifactsDir, { recursive: true, force: true });

		dispatched.length = 0;
		const evalLabeled = await runStructuredSubagent(
			request({
				invocationKind: "eval",
				identity: { label: "Refactor the auth flow" },
				retainArtifacts: true,
			}),
		);
		expect(dispatched[0]?.description).toBe("Refactor the auth flow");
		await fs.rm(evalLabeled.artifactsDir, { recursive: true, force: true });
	});

	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		roleSession.settings.override("task.agentModelOverrides", { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		concreteOverrideSession.settings.override("task.agentModelOverrides", { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution could not be prepared: not a repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const preparedExtensions = [
			{
				path: extensionPaths[0]!,
				resolvedPath: extensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		] as NonNullable<ToolSession["preparedExtensions"]>;
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		let explicitRoot = "/plugins/explicit";
		const extensionRoots = () => ({
			explicit: [explicitRoot],
			mode: "explicit-only" as const,
			configured: ["/plugins/configured"],
			configuredLevel: "project" as const,
		});
		Object.assign(nonPlanSession, {
			mcpManager,
			extensionPaths,
			customToolPaths,
			preparedExtensions,
			effectiveExtensionRoots: extensionRoots,
		});
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedPreparedExtensions: preparedExtensions,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[1]?.extensionRoots?.()).toEqual(extensionRoots());
		explicitRoot = "/plugins/explicit-after-spawn";
		expect(options[1]?.extensionRoots?.().explicit).toEqual([explicitRoot]);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

describe("role profile inputs", () => {
	const ROLE_SKILLS: Skill[] = [
		{
			name: "poteto-mode",
			description: "Style",
			filePath: "/skills/poteto-mode/SKILL.md",
			baseDir: "/skills/poteto-mode",
			source: "user",
		},
		{
			name: "swarm",
			description: "Fanout",
			filePath: "/skills/swarm/SKILL.md",
			baseDir: "/skills/swarm",
			source: "user",
		},
	];
	const source = { provider: "test", providerName: "test", path: "/rules", level: "user" as const };
	const ROLE_RULES: Rule[] = [
		{
			name: "naming",
			path: "/rules/naming.md",
			content: "Use names.",
			_source: { ...source, path: "/rules/naming.md" },
		},
		{ name: "other", path: "/rules/other.md", content: "Other.", _source: { ...source, path: "/rules/other.md" } },
	];
	const ROLE_FILES: ContextFileEntry[] = [
		{ path: "/project/CONTEXT.md", content: "Context." },
		{ path: "/project/AGENTS.md", content: "Agents." },
	];
	const ROOTS: EffectiveExtensionRoots = {
		explicit: [],
		mode: "merge",
		configured: [],
		configuredLevel: "user",
	};

	function roleSession(): ToolSession {
		return {
			...session(),
			contextFiles: ROLE_FILES,
			rules: ROLE_RULES,
			skills: ROLE_SKILLS,
			extensionPaths: ["/ext/shared-hook.ts"],
			effectiveExtensionRoots: () => ROOTS,
		};
	}

	async function dispatch(
		agent: AgentDefinition,
		sessionOverride?: ToolSession,
	): Promise<executorModule.ExecutorOptions> {
		mockDiscovery(agent);
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});
		const settled = await runStructuredSubagent(
			request({ session: sessionOverride ?? roleSession(), retainArtifacts: true }),
		);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
		const options = dispatched[0];
		if (!options) throw new Error("Expected runSubprocess to be called");
		return options;
	}

	it("filters shared inputs through explicit selectors and records provenance", async () => {
		const options = await dispatch({
			...AGENT,
			instructions: ["CONTEXT.md"],
			skills: ["swarm"],
			autoloadSkills: ["swarm", "poteto-mode"],
		});

		expect(options.contextFiles?.map(file => file.path)).toEqual(["/project/CONTEXT.md"]);
		expect(options.rules).toEqual([]);
		expect(options.skills?.map(skill => skill.name)).toEqual(["swarm"]);
		expect(options.autoloadSkills?.map(skill => skill.name)).toEqual(["swarm"]);
		expect(options.roleProfile?.mode).toBe("full");
		expect(options.roleProfile?.sources.instructions).toEqual(["/project/CONTEXT.md"]);
		expect(options.roleProfile?.sources.skills).toEqual(["/skills/swarm/SKILL.md"]);
		expect(options.roleProfile?.sources.hooks).toEqual(["/ext/shared-hook.ts"]);
		expect(options.roleProfile?.sources.tools).toEqual(AGENT.tools);
		expect(options.roleProfile?.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("inherits every shared input when selectors are absent", async () => {
		const first = await dispatch(AGENT);
		expect(first.contextFiles?.map(file => file.path)).toEqual(["/project/CONTEXT.md"]);
		expect(first.rules?.map(rule => rule.name)).toEqual(["naming", "other"]);
		expect(first.skills?.map(skill => skill.name)).toEqual(["poteto-mode", "swarm"]);
		expect(first.autoloadSkills).toEqual([]);
		expect(first.roleProfile?.mode).toBe("full");

		const second = await dispatch(AGENT);
		expect(second.roleProfile?.contentHash).toBe(first.roleProfile?.contentHash);
	});

	it("treats explicit-empty selectors as no inputs", async () => {
		const options = await dispatch({ ...AGENT, instructions: [], skills: [] });
		expect(options.contextFiles).toEqual([]);
		expect(options.rules).toEqual([]);
		expect(options.skills).toEqual([]);
		expect(options.autoloadSkills).toEqual([]);
		expect(options.roleProfile?.sources.instructions).toEqual([]);
		expect(options.roleProfile?.sources.skills).toEqual([]);
	});

	it("marks minimal roles without changing full-mode selection", async () => {
		const minimal = await dispatch({ ...AGENT, minimalPrompt: true });
		expect(minimal.roleProfile?.mode).toBe("minimal");
		const full = await dispatch(AGENT);
		expect(full.roleProfile?.mode).toBe("full");
	});

	it("appends explicit role hooks without dropping shared extension paths", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-role-hooks-"));
		try {
			const filePath = path.join(root, "agent.md");
			await Bun.write(filePath, "---\nname: worker\ndescription: Test worker.\n---\n\nDo work.\n");
			const options = await dispatch({ ...AGENT, filePath, hooks: ["./hooks/role.ts"] });
			expect(options.roleProfile?.path).toBe(filePath);
			expect(options.preloadedExtensionPaths).toEqual(["/ext/shared-hook.ts", path.join(root, "hooks", "role.ts")]);
			expect(options.roleProfile?.sources.hooks).toEqual([
				"/ext/shared-hook.ts",
				path.join(root, "hooks", "role.ts"),
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("clears preloaded extensions in restricted mode", async () => {
		const options = await dispatch(AGENT, {
			...roleSession(),
			getPlanModeState: () => ({ enabled: true }),
		} as ToolSession);
		expect(options.restrictToolNames).toBe(true);
		expect(options.preloadedExtensionPaths).toEqual([]);
		expect(options.preloadedPreparedExtensions).toEqual([]);
	});

	it("keeps the persisted profile JSON-serializable", async () => {
		const options = await dispatch({ ...AGENT, instructions: ["CONTEXT.md"], skills: ["swarm"] });
		expect(JSON.parse(JSON.stringify(options.roleProfile))).toEqual(options.roleProfile);
	});

	it("hashes bundled agents without touching the synthetic embedded path", async () => {
		const bundled = { ...AGENT, filePath: "embedded:worker.md" };
		const options = await dispatch(bundled);
		const expected = createHash("sha256").update(JSON.stringify(bundled)).digest("hex");
		expect(options.roleProfile?.contentHash).toBe(expected);
		expect(options.roleProfile?.path).toBe("embedded:worker.md");
	});
});
