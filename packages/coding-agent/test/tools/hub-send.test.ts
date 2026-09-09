import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

const PEER_ID = "DeepBugs.Owned30Lead";
const PEER_DISPLAY_NAME = "HealthSkillJudgment";

function liveSession(delivered: string[]) {
	return {
		isStreaming: false,
		deliverIrcMessage: async (msg: { body: string }) => {
			delivered.push(msg.body);
			return "injected";
		},
	} as unknown as AgentSession;
}

function registerMain(registry: AgentRegistry): void {
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: null,
		status: "running",
	});
}

describe("hub send identity", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("delivers to a live in-process peer addressed by its unique displayName", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const delivered: string[] = [];
		registry.register({
			id: PEER_ID,
			displayName: PEER_DISPLAY_NAME,
			kind: "sub",
			session: liveSession(delivered),
			status: "idle",
		});

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: PEER_DISPLAY_NAME, message: "ping by display name" },
		);

		expect(sent.isError).toBeFalsy();
		expect(sent.details?.receipts).toEqual([{ to: PEER_ID, outcome: "injected" }]);
		expect(delivered).toEqual(["ping by display name"]);
	});

	it("keeps an ambiguous displayName an Unknown-agent failure (no misdelivery)", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const deliveredA: string[] = [];
		const deliveredB: string[] = [];
		registry.register({
			id: "WorkerA",
			displayName: "task",
			kind: "sub",
			session: liveSession(deliveredA),
			status: "idle",
		});
		registry.register({
			id: "WorkerB",
			displayName: "task",
			kind: "sub",
			session: liveSession(deliveredB),
			status: "idle",
		});

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: "task", message: "ambiguous ping" },
		);

		expect(sent.isError).toBeTruthy();
		expect(deliveredA).toEqual([]);
		expect(deliveredB).toEqual([]);
	});

	it("still delivers to an exact id", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const delivered: string[] = [];
		registry.register({
			id: PEER_ID,
			displayName: PEER_DISPLAY_NAME,
			kind: "sub",
			session: liveSession(delivered),
			status: "idle",
		});

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: PEER_ID, message: "ping by id" },
		);

		expect(sent.isError).toBeFalsy();
		expect(sent.details?.receipts).toEqual([{ to: PEER_ID, outcome: "injected" }]);
		expect(delivered).toEqual(["ping by id"]);
	});
});
