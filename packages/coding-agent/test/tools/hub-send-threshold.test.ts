import { beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { executeSend, HUB_SEND_ALL_THRESHOLD } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

const SENDER = "H5Sender";

function makeFakeSession() {
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: true,
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		waitForIrcAutoReplies: async () => {},
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	};
	return { session: session as unknown as AgentSession, delivered };
}

/** Fill the global registry with live peers carrying fake sessions, so the bus can deliver. */
function addLivePeers(prefix: string, count: number, status: "running" | "idle" = "running"): void {
	const registry = AgentRegistry.global();
	for (let i = 0; i < count; i++) {
		registry.register({
			id: `${prefix}-${i}`,
			displayName: `${prefix}-${i}`,
			kind: "sub",
			session: makeFakeSession().session,
			status,
		});
	}
}

function deps() {
	return { registry: AgentRegistry.global(), senderId: SENDER, settings: Settings.isolated() };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	if (content?.type !== "text" || typeof content.text !== "string") throw new Error("Expected text result");
	return content.text;
}

describe("hub send to:all threshold", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentRegistry.global().register({ id: SENDER, displayName: SENDER, kind: "sub", session: null, status: "running" });
	});

	it("denies a bare to:all at 11 running peers", async () => {
		expect(HUB_SEND_ALL_THRESHOLD).toBe(10);
		addLivePeers("run", 11);
		const result = await executeSend(deps(), { to: "all", message: "hello all" });
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("hub send to:all refused: 11 running peers exceed threshold 10");
		expect(text).toContain("allowBroadcast:true");
	});

	it("allows a bare to:all at exactly 10 running peers", async () => {
		addLivePeers("run", 10);
		const result = await executeSend(deps(), { to: "all", message: "hello ten" });
		expect(result.isError).toBe(false);
		expect(textOf(result)).not.toContain("refused");
	});

	it("allows a bare to:all below threshold", async () => {
		addLivePeers("run", 2, "running");
		addLivePeers("idle", 1, "idle");
		const result = await executeSend(deps(), { to: "all", message: "hello few" });
		expect(result.isError).toBe(false);
		expect(textOf(result)).not.toContain("refused");
	});

	it("allows any count with literal allowBroadcast:true", async () => {
		addLivePeers("run", 25);
		const result = await executeSend(deps(), {
			to: "all",
			message: "confirmed broadcast",
			allowBroadcast: true,
		});
		expect(result.isError).toBe(false);
		expect(textOf(result)).not.toContain("refused");
	});

	it.each(["true", 1, false, undefined] as const)(
		"still denies to:all at 11 peers when allowBroadcast is %p",
		async flag => {
			addLivePeers("run", 11);
			const result = await executeSend(deps(), {
				to: "all",
				message: "unconfirmed",
				allowBroadcast: flag as unknown as boolean,
			});
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("exceed threshold 10");
		},
	);

	it("lets named sends bypass at any count", async () => {
		addLivePeers("run", 25);
		const named = makeFakeSession();
		AgentRegistry.global().register({ id: "Named", displayName: "Named", kind: "sub", session: named.session });
		const result = await executeSend(deps(), { to: "Named", message: "direct" });
		expect(result.isError).toBe(false);
		expect(textOf(result)).not.toContain("exceed threshold 10");
		expect(named.delivered.map(msg => msg.body)).toEqual(["direct"]);
	});

	it("still refuses await plus to:all", async () => {
		addLivePeers("run", 11);
		const result = await executeSend(deps(), { to: "all", message: "x", await: true });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('`await` is invalid with to:"all"');
	});

	it("denies fail-closed when the registry is unreadable", async () => {
		const broken = {
			listVisibleTo: () => {
				throw new Error("boom");
			},
		} as unknown as AgentRegistry;
		const result = await executeSend(
			{ registry: broken, senderId: SENDER, settings: Settings.isolated() },
			{ to: "all", message: "hello" },
		);
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("hub send to:all refused: peer count unreadable");
		expect(text).toContain("allowBroadcast:true");
	});

	it("excludes parked refs from the running-peer count", async () => {
		const registry = AgentRegistry.global();
		// 10 running + 5 parked: parked refs are not live peers, so this is allowed.
		addLivePeers("run", 10);
		for (let i = 0; i < 5; i++) {
			registry.register({
				id: `parked-${i}`,
				displayName: `parked-${i}`,
				kind: "sub",
				session: null,
				status: "parked",
				sessionFile: `/tmp/h5-parked-${i}.jsonl`,
			});
		}
		const allowed = await executeSend(deps(), { to: "all", message: "hello" });
		expect(allowed.isError).toBe(false);
		// One more running peer tips the count to 11; the reason names 11, proving parked refs are excluded.
		registry.register({
			id: "run-10",
			displayName: "run-10",
			kind: "sub",
			session: makeFakeSession().session,
			status: "running",
		});
		const denied = await executeSend(deps(), { to: "all", message: "hello" });
		expect(denied.isError).toBe(true);
		expect(textOf(denied)).toContain("11 running peers exceed threshold 10");
	});

	it("sends a flagged broadcast through HubTool.execute op send", async () => {
		addLivePeers("run", 15);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			agentRegistry: AgentRegistry.global(),
			getAgentId: () => SENDER,
		} as unknown as ToolSession;
		const tool = new HubTool(session);
		const result = await tool.execute("h5-flagged", {
			op: "send",
			to: "all",
			message: "flagged via hub",
			allowBroadcast: true,
		});
		expect(result.isError).toBe(false);
		expect(textOf(result)).not.toContain("refused");
	});
});
