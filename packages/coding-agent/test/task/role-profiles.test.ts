import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RoleProfileConfig } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { resolveToolCallLoopGuardSettings } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import { applyRoleProfile, findRoleProfile } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

type AppliedRoleProfileAgent = AgentDefinition & { restrictToolNames: boolean };

const leafProfile: RoleProfileConfig = {
	agents: ["explorer", "researcher"],
	tools: ["read", "grep", "glob"],
	model_role: "explorer",
	minimalPrompt: true,
	softRequestBudget: 8,
};

const managerProfile: RoleProfileConfig = {
	agents: ["manager"],
	tools: ["read", "task", "yield"],
	model_role: "@manager",
	minimalPrompt: false,
	softRequestBudget: 20,
};

const profiles: Record<string, RoleProfileConfig> = {
	leaf: leafProfile,
	manager: managerProfile,
};

const spawningAgent: AgentDefinition = {
	name: "explorer",
	description: "test agent",
	systemPrompt: "test",
	source: "bundled",
	tools: ["read", "write", "task"],
	spawns: ["scout"],
	model: ["anthropic/opus"],
};

describe("findRoleProfile", () => {
	it("returns the profile whose agents list includes the known agent", () => {
		expect(findRoleProfile(profiles, "explorer")).toBe(leafProfile);
		expect(findRoleProfile(profiles, "manager")).toBe(managerProfile);
	});

	it("returns undefined for an unknown agent", () => {
		expect(findRoleProfile(profiles, "unknown-agent")).toBeUndefined();
		expect(findRoleProfile(undefined, "explorer")).toBeUndefined();
		expect(findRoleProfile({}, "explorer")).toBeUndefined();
	});
});

describe("applyRoleProfile", () => {
	it("sets tools from the profile, not the agent definition", () => {
		const applied = applyRoleProfile(spawningAgent, leafProfile);
		expect(applied.tools).toEqual(["read", "grep", "glob"]);
		expect(applied.tools).not.toBe(leafProfile.tools);
	});

	it("clears spawns when task is not in profile.tools", () => {
		const applied = applyRoleProfile(spawningAgent, leafProfile);
		expect(leafProfile.tools.includes("task")).toBe(false);
		expect(applied.spawns).toBeUndefined();
	});

	it("preserves spawns when task is in profile.tools", () => {
		const applied = applyRoleProfile(spawningAgent, managerProfile);
		expect(managerProfile.tools.includes("task")).toBe(true);
		expect(applied.spawns).toEqual(["scout"]);
	});

	it("sets model from model_role as an @model reference", () => {
		expect(applyRoleProfile(spawningAgent, leafProfile).model).toEqual(["@explorer"]);
		expect(applyRoleProfile(spawningAgent, managerProfile).model).toEqual(["@manager"]);
	});

	it("passes restrictToolNames true through to the applied agent", () => {
		const restricted: RoleProfileConfig = { ...leafProfile, restrictToolNames: true };
		const applied = applyRoleProfile(spawningAgent, restricted) as AppliedRoleProfileAgent;
		expect(applied.restrictToolNames).toBe(true);
	});

	it("defaults omitted restrictToolNames to false on the applied agent", () => {
		expect(leafProfile.restrictToolNames).toBeUndefined();
		const omitted = applyRoleProfile(spawningAgent, leafProfile) as AppliedRoleProfileAgent;
		expect(omitted.restrictToolNames).toBe(false);
		const explicitFalse = applyRoleProfile(spawningAgent, {
			...leafProfile,
			restrictToolNames: false,
		}) as AppliedRoleProfileAgent;
		expect(explicitFalse.restrictToolNames).toBe(false);
	});
});

describe("resolveToolCallLoopGuardSettings", () => {
	it("reads the stamped threshold directly from settings", () => {
		const settings = Settings.isolated({
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
		});
		expect(resolveToolCallLoopGuardSettings(settings)).toEqual({
			enabled: true,
			threshold: 2,
			exemptTools: settings.get("model.toolCallLoopGuard.exemptTools"),
		});
	});
});
