import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { createSessionAddress } from "@oh-my-pi/pi-coding-agent/bridge/core/address";
import type { ClaimResult } from "@oh-my-pi/pi-coding-agent/bridge/core/directory";

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
describe("hub send tree-prefix resolution", () => {
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

	function sendText(result: { content: Array<{ type: string; text?: string }> }): string {
		const content = result.content[0];
		if (content?.type !== "text" || typeof content.text !== "string") throw new Error("Expected text result");
		return content.text;
	}

	it("errors naming both children when a bare lead name matches a live subtree", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const deliveredA: string[] = [];
		const deliveredB: string[] = [];
		const deliveredOther: string[] = [];
		registry.register({
			id: "DeepLanding.ChildA",
			displayName: "ChildADisplay",
			kind: "sub",
			session: liveSession(deliveredA),
			status: "idle",
		});
		registry.register({
			id: "DeepLanding.ChildB",
			displayName: "ChildBDisplay",
			kind: "sub",
			session: liveSession(deliveredB),
			status: "idle",
		});
		registry.register({
			id: "DeepLandingOther",
			displayName: "OtherDisplay",
			kind: "sub",
			session: liveSession(deliveredOther),
			status: "idle",
		});

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: "DeepLanding", message: "lead ping" },
		);

		expect(sent.isError).toBeTruthy();
		const text = sendText(sent);
		expect(text).toContain("DeepLanding.ChildA");
		expect(text).toContain("DeepLanding.ChildB");
		expect(deliveredA).toEqual([]);
		expect(deliveredB).toEqual([]);
		expect(deliveredOther).toEqual([]);
	});

	it("delivers to the only live child of a bare lead name", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const delivered: string[] = [];
		registry.register({
			id: "DeepLanding.ChildA",
			displayName: "ChildADisplay",
			kind: "sub",
			session: liveSession(delivered),
			status: "idle",
		});

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: "DeepLanding", message: "single child ping" },
		);

		expect(sent.isError).toBeFalsy();
		expect(sent.details?.to).toBe("DeepLanding.ChildA");
		expect(sent.details?.receipts).toEqual([{ to: "DeepLanding.ChildA", outcome: "injected" }]);
		expect(delivered).toEqual(["single child ping"]);
	});

	it("routes a remote session-uuid prefix to the remote leg instead of Unknown-agent", async () => {
		const registry = AgentRegistry.global();
		registerMain(registry);
		const record: ClaimResult = {
			kind: "active",
			address: createSessionAddress({
				namespace: "testns",
				host: "testhost",
				process: "4242",
				backend: "testbackend",
				session: "abcdef1234567890",
				generation: 1,
			}),
			registeredAt: 1,
			lastHeartbeatAt: 1,
			expiresAt: Date.now() + 60_000,
		};
		registry.listPublishedSessions = async () => [record];

		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: "abcdef12", message: "remote prefix ping" },
		);

		expect(sent.isError).toBeTruthy();
		const text = sendText(sent);
		expect(text).toContain("unreachable");
		expect(text).toContain("abcdef12");
		expect(text).not.toContain("Unknown agent");
	});
});
