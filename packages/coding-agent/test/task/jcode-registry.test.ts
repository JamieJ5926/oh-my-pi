import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RoleProfileConfig } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ExecutionBackendFactory } from "../../src/bridge/runtime";
import {
	createCallerScopedJcodeRegistry,
	jcodeExecutionRouteKey,
} from "@oh-my-pi/pi-coding-agent/task";
import { resolveEffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const worker: AgentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
	tools: ["read"],
};

describe("jcode caller-scoped registry", () => {
	it("reuses one factory for the same route and separates different routes", async () => {
		let created = 0;
		const closed: string[] = [];
		const scoped = createCallerScopedJcodeRegistry(routeKey => {
			created += 1;
			const factory: ExecutionBackendFactory = {
				backend: "jcode",
				start: async () => {
					throw new Error("unused");
				},
				close: async () => {
					closed.push(routeKey);
				},
			};
			return factory;
		});
		const a = jcodeExecutionRouteKey({
			providerProfile: "qwen-local",
			model: "qwen",
			toolPolicyFingerprint: "open",
			generationOwner: "owner-1",
		});
		const b = jcodeExecutionRouteKey({
			providerProfile: "glm",
			model: "qwen",
			toolPolicyFingerprint: "open",
			generationOwner: "owner-1",
		});
		const first = scoped.registryFor(a).get("jcode");
		const again = scoped.registryFor(a).get("jcode");
		const other = scoped.registryFor(b).get("jcode");
		expect(first).toBe(again);
		expect(other).not.toBe(first);
		expect(created).toBe(2);
		expect(scoped.reuseCount()).toBe(2);
		await scoped.close();
		expect(closed).toEqual([a, b]);
	});
});

describe("roleProfiles execution_backend", () => {
	it("defaults omitted execution_backend to local", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.mode": "none",
				roleProfiles: {
					leaf: {
						agents: ["worker"],
						tools: ["read"],
						model_role: "explorer",
						minimalPrompt: true,
						softRequestBudget: 4,
					} satisfies RoleProfileConfig,
				},
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "x",
			agent: "worker",
		});
		expect(policy.executionBackend).toBe("local");
	});

	it("selects jcode from a configured role profile", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.mode": "none",
				roleProfiles: {
					leaf: {
						agents: ["worker"],
						tools: ["read"],
						model_role: "explorer",
						minimalPrompt: true,
						softRequestBudget: 4,
						execution_backend: "jcode",
						jcode_provider_profile: "qwen-local",
					} satisfies RoleProfileConfig,
				},
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "x",
			agent: "worker",
		});
		expect(policy.executionBackend).toBe("jcode");
		expect(policy.jcodeProviderProfile).toBe("qwen-local");
	});
});
