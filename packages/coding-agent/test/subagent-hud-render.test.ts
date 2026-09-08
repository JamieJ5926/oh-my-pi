import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { unlink } from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120): string {
	const sections = renderSubagentHudLines(sessions, columns);
	return Bun.stripANSI([...sections.completed, ...sections.subagents].join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expect(out).toContain("AuthLoader: Refactoring the auth flow");
		expect(out).toContain("SchemaMigrator: Migrating the users table");
	});

	it("shows a non-default role badge and hides descriptions that only echo the id", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("AuthLoader");
		expect(withRole).toContain("scout");
		expect(withRole).toContain("Refactor the auth flow");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain("AuthLoader");
		expect(echoed).toContain("scout");
		expect(echoed).not.toContain("AuthLoader: AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toContain("scout");
		expect(collision).not.toContain("AuthLoader-3: AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expect(mixedCase).not.toContain("AuthLoader-3: authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expect(defaultWorker).toContain("SchemaMigrator: Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("retains current-run terminal rows while idle", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		for (const status of finishedStates) expect(render(sessions)).toContain(`Done-${status}`);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("StillRunning: live work");
		expect(out).toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("uses progress descriptions but never previews task prompts", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(fromProgressDesc).toContain("Worker: From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(fromTask).toContain("Worker · 0 tok");
		expect(fromTask).not.toContain("Investigate flaky CI on macOS");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain("ReviewShell");
		expect(multiLineTask).not.toContain("Complete assignment thoroughly");
		expect(multiLineTask).toContain("scout");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expect(multiLineDesc).toContain("First line ↵ Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual({ completed: [], subagents: [] });

		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expect(out).toContain("BackgroundSpawn: detached work");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});

	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("Detached: background work");
		expect(out).toContain("FromProgress: background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("Anna>Bob:");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every top-level parent without a global cap", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);

		for (const session of active) {
			expect(out).toContain(`${session.id}: ${session.description}`);
		}
		expect(out).not.toContain("more running");
	});
	it("keeps staggered terminal siblings compact with child tags and own usage", () => {
		const parent = makeSession({ id: "Lead", progress: makeProgress({ id: "Lead", tokens: 7 }) });
		const members = Array.from({ length: 6 }, (_, index) =>
			makeSession({
				id: `Lead.Child${index}`,
				agent: "explorer",
				status: index === 0 ? "active" : index === 4 ? "failed" : index === 5 ? "aborted" : "completed",
				progress: makeProgress({ id: `Lead.Child${index}`, tokens: index }),
			}),
		);
		const ancestry = members.map(member => ({ id: member.id, parentId: "Lead" }));
		for (const count of [1, 3, 6]) {
			const selected = members.slice(0, count);
			const frame = renderSubagentHudLines([parent, ...selected], 160, ancestry).subagents.join("\n");
			const out = Bun.stripANSI(frame);
			expect(out).toContain(`explorer x${count}`);
			expect(out).toContain(
				`${Math.min(count, 4) - 1} done · 1 running · ${count === 6 ? 1 : 0} failed · ${count === 6 ? 1 : 0} cancelled`,
			);
			expect(out).toContain("Lead · 7 tok");
			expect(out).toContain(selected.map(member => `● ${member.id.split(".").pop()}`).join("  "));
			for (const member of selected) {
				const color =
					member.status === "active"
						? "warning"
						: member.status === "failed"
							? "error"
							: member.status === "aborted"
								? "muted"
								: "success";
				expect(frame).toContain(`${theme.styledSymbol("status.enabled", color)} ${member.id.split(".").pop()}`);
			}
		}
		parent.status = "completed";
		const out = Bun.stripANSI(renderSubagentHudLines([parent, ...members], 160, ancestry).subagents.join("\n"));
		expect(out).toContain("Lead · 7 tok");
		expect(out).toContain("15 tok");
		expect(out).toContain("1 cancelled");
		expect(out).toContain("1 failed");
		const narrow = renderSubagentHudLines([parent, ...members, makeSession({ id: "DeepWork" })], 42, [
			...ancestry,
			{ id: "DeepWork", parentId: members[0].id },
		]).subagents;
		for (const line of narrow) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(42);
		expect(Bun.stripANSI(narrow.join("\n"))).toContain("Child0");
		for (let index = 1; index < 6; index++) expect(Bun.stripANSI(narrow.join("\n"))).not.toContain(`Child${index}`);
		expect(Bun.stripANSI(narrow.join("\n"))).toContain("DeepWork");
	});
	it("keeps nested Poteto parents full and explicit worker thresholds intact", () => {
		for (const role of ["poteto-agent", "poteto-agent-deep"]) {
			const sessions = [
				makeSession({ id: "Root" }),
				makeSession({ id: "Root.Lead", agent: role, description: "Parent detail" }),
				makeSession({ id: "Root.Lead.Worker", agent: "explorer" }),
			];
			const ancestry = [
				{ id: "Root.Lead", parentId: "Root" },
				{ id: "Root.Lead.Worker", parentId: "Root.Lead" },
			];
			const out = Bun.stripANSI(renderSubagentHudLines(sessions, 160, ancestry).subagents.join("\n"));
			expect(out).toMatch(new RegExp(`Lead.*${role}.*Parent detail`));
			expect(out).not.toContain(`${role} x1`);
			expect(out).toContain("explorer x1");
			expect(out).toContain("● Worker");
			const expanded = Bun.stripANSI(renderSubagentHudLines(sessions, 160, ancestry, 4).subagents.join("\n"));
			expect(expanded).not.toContain("explorer x1");
			expect(expanded).toMatch(/Worker.*explorer.*0 tok/);
		}
	});
	it("draws branches and continuing guides through nested rows to the next parent", () => {
		const sessions = [makeSession({ id: "Lead" }), makeSession({ id: "Lead.Child" }), makeSession({ id: "Peer" })];
		const out = Bun.stripANSI(
			renderSubagentHudLines(sessions, 120, [{ id: "Lead.Child", parentId: "Lead" }]).subagents.join("\n"),
		);
		expect(out).toContain("├─ ● Lead");
		expect(out).toContain("│  └─ ● task x1");
		expect(out).toContain("│     └─ ● Child");
		expect(out).toContain("└─ ● Peer");
		const children = Array.from({ length: 6 }, (_, index) =>
			makeSession({ id: `Lead.Child${index}`, agent: "explorer" }),
		);
		const frame = Bun.stripANSI(
			renderSubagentHudLines(
				[sessions[0], ...children, makeSession({ id: "DemoPeer" })],
				160,
				children.map(child => ({ id: child.id, parentId: "Lead" })),
			).subagents.join("\n"),
		);
		expect(frame).toContain("│  └─ ● explorer x6");
		expect(frame).toContain("│     └─ ● Child0");
		if (process.env.SUBAGENT_HUD_FRAME) console.log(frame);
	});
	it("accounts cycle-broken roots independently for outcomes and active descendants", () => {
		const a = makeSession({ id: "A", status: "completed", progress: makeProgress({ id: "A", tokens: 7 }) });
		const b = makeSession({ id: "B", status: "failed", progress: makeProgress({ id: "B", tokens: 11 }) });
		const ancestry = [
			{ id: "A", parentId: "B" },
			{ id: "B", parentId: "A" },
		];
		const settled = renderSubagentHudLines([a, b], 160, ancestry);
		const text = Bun.stripANSI(settled.completed.join("\n"));
		expect(text).toBe("● A -> ● B");
		expect(settled.completed).toHaveLength(1);
		expect(settled.subagents).toEqual([]);
		b.status = "active";
		const active = renderSubagentHudLines([a, b], 160, ancestry);
		expect(Bun.stripANSI(active.completed.join("\n"))).toContain("● A");
		expect(Bun.stripANSI(active.subagents.join("\n"))).not.toContain("● A");
		expect(Bun.stripANSI(active.subagents.join("\n"))).toContain("● B");
		b.detached = false;
		const hidden = renderSubagentHudLines([a, b], 160, ancestry);
		expect(hidden.subagents).toEqual([]);
		expect(Bun.stripANSI(hidden.completed.join("\n"))).toBe("● A");
	});

	it("omits settled child groups and only chains the top-level parent without altering rows", () => {
		const parent = makeSession({ id: "Lead", progress: makeProgress({ id: "Lead", tokens: 7 }) });
		const children = [
			makeSession({
				id: "Lead.One",
				agent: "explorer",
				status: "completed",
				progress: makeProgress({ id: "Lead.One", tokens: 11 }),
			}),
			makeSession({
				id: "Lead.Two",
				agent: "explorer",
				status: "failed",
				progress: makeProgress({ id: "Lead.Two", tokens: 13 }),
			}),
			makeSession({
				id: "Lead.Three",
				agent: "explorer",
				status: "aborted",
				progress: makeProgress({ id: "Lead.Three", tokens: 17 }),
			}),
		];
		const ancestry = children.map(child => ({ id: child.id, parentId: parent.id }));
		const split = renderSubagentHudLines([parent, ...children], 160, ancestry);
		const completed = Bun.stripANSI(split.completed.join("\n"));
		expect(Bun.stripANSI(split.subagents.join("\n"))).toContain("Lead · 7 tok");
		expect(completed).toBe("");
		parent.status = "completed";
		const settled = renderSubagentHudLines([parent, ...children], 160, ancestry);
		expect(settled.subagents).toEqual([]);
		const summary = Bun.stripANSI(settled.completed.join("\n"));
		expect(summary).toBe("● Lead");
		expect(settled.completed).toHaveLength(1);
		expect(children.map(child => child.progress?.tokens)).toEqual([11, 13, 17]);
		expect(children.map(child => child.status)).toEqual(["completed", "failed", "aborted"]);
		for (const status of ["failed", "aborted"] as const) {
			parent.status = status;
			const narrow = renderSubagentHudLines([parent, ...children], 32, ancestry);
			const text = Bun.stripANSI(narrow.completed.join("\n"));
			expect(text).toBe("● Lead");
			expect(narrow.completed[0]).toContain(
				theme.styledSymbol("status.enabled", status === "failed" ? "error" : "muted"),
			);
			for (const line of narrow.completed) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(32);
		}
	});

	it("reopens a terminal parent for a late transitive child including hidden synchronous work", () => {
		const parent = makeSession({ id: "Lead", status: "completed" });
		const middle = makeSession({ id: "Lead.Middle", agent: "poteto-agent", status: "completed" });
		const child = makeSession({ id: "Lead.Middle.Child", detached: false, status: "active" });
		const ancestry = [
			{ id: middle.id, parentId: parent.id },
			{ id: child.id, parentId: middle.id },
		];
		expect(renderSubagentHudLines([parent, middle], 120, ancestry).subagents).toEqual([]);
		for (const detached of [false, true]) {
			child.detached = detached;
			const reopened = renderSubagentHudLines([parent, middle, child], 120, ancestry);
			expect(reopened.completed).toEqual([]);
			const text = Bun.stripANSI(reopened.subagents.join("\n"));
			expect(text).toContain("Lead");
			expect(text).toContain("Middle");
			expect(text).toContain("1 active below");
			expect(reopened.subagents.join("\n")).toContain(
				`${theme.styledSymbol("status.enabled", "success")} ${theme.bold("Lead")}`,
			);
			if (!detached) expect(text).not.toContain("Child");
		}
		child.status = "failed";
		child.detached = false;
		const resettled = renderSubagentHudLines([parent, middle, child], 120, ancestry);
		expect(resettled.subagents).toEqual([]);
		expect(Bun.stripANSI(resettled.completed.join("\n"))).toBe("● Lead");
		expect(renderSubagentHudLines([], 120, ancestry)).toEqual({ completed: [], subagents: [] });
	});

	it("keeps an actual delegator named while a hidden descendant is active", () => {
		const sessions = [
			makeSession({ id: "Lead" }),
			makeSession({ id: "Lead.Worker", status: "completed", agent: "explorer" }),
			makeSession({ id: "Deep", detached: false }),
		];
		const ancestry = [
			{ id: "Lead.Worker", parentId: "Lead" },
			{ id: "Deep", parentId: "Lead.Worker" },
		];
		const sections = renderSubagentHudLines(sessions, 120, ancestry);
		expect(sections.completed).toEqual([]);
		const text = Bun.stripANSI(sections.subagents.join("\n"));
		expect(text).toMatch(/Worker.*explorer.*0 tok/);
		expect(text).not.toContain("explorer x1");
		expect(text).toContain("1 active below");
		expect(text).not.toContain("Deep");
	});
	it("chains completed roots in task order rather than settlement order on one narrow line", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
		for (const [id, index] of [
			["Third", 2],
			["First", 0],
			["Second", 1],
		] as const) {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, index, "prompt must not appear", true));
		}
		for (const [id, index, status] of [
			["Third", 2, "failed"],
			["Second", 1, "aborted"],
			["First", 0, "completed"],
		] as const) {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				...makeLifecycle(id, index, "prompt must not appear", true),
				status,
			});
		}
		const before = structuredClone(registry.getSessions());
		const full = renderSubagentHudLines(registry.getSessions(), 120);
		expect(full.completed).toHaveLength(1);
		expect(Bun.stripANSI(full.completed[0])).toBe("● First -> ● Second -> ● Third");
		for (const width of [0, 1, 12, 20]) {
			const narrow = renderSubagentHudLines(registry.getSessions(), width);
			expect(narrow.completed).toHaveLength(1);
			expect(narrow.completed).toEqual(full.completed);
			expect(narrow.completed[0]).not.toContain("\n");
		}
		expect(registry.getSessions()).toEqual(before);
		registry.dispose();
	});

	it("abbreviates direct and grouped HUD token displays without changing usage", () => {
		for (const [value, expected] of [
			[0, "0"],
			[999, "999"],
			[1000, "1k"],
			[1234, "1.2k"],
			[10500, "10.5k"],
			[100000, "100k"],
			[1000000, "1m"],
			[12340000, "12.3m"],
			[1000000000, "1b"],
			[1250000000, "1.3b"],
		] as const) {
			const parent = makeSession({ id: "Lead", progress: makeProgress({ id: "Lead", tokens: value }) });
			const child = makeSession({
				id: "Lead.Child",
				agent: "explorer",
				progress: makeProgress({ id: "Lead.Child", tokens: value }),
			});
			const text = Bun.stripANSI(
				renderSubagentHudLines([parent, child], 160, [{ id: child.id, parentId: parent.id }]).subagents.join("\n"),
			);
			expect(text).toContain(`Lead · ${expected} tok`);
			expect(text).toContain(`0 cancelled · ${expected} tok`);
			expect(parent.progress?.tokens).toBe(value);
			expect(child.progress?.tokens).toBe(value);
		}
	});

	it("renders an arbitrary actual parent directly while its leaf peers remain compact", () => {
		const sessions = [
			makeSession({ id: "Root" }),
			makeSession({ id: "Delegator", agent: "custom-role", description: "Direct parent detail" }),
			makeSession({ id: "LeafPeer", agent: "custom-role" }),
			makeSession({ id: "Child", agent: "explorer" }),
		];
		const ancestry = [
			{ id: "Delegator", parentId: "Root" },
			{ id: "LeafPeer", parentId: "Root" },
			{ id: "Child", parentId: "Delegator" },
		];
		const text = Bun.stripANSI(renderSubagentHudLines(sessions, 160, ancestry).subagents.join("\n"));
		expect(text).toMatch(/Delegator.*custom-role.*Direct parent detail/);
		expect(text.match(/Delegator/g)).toHaveLength(1);
		expect(text).toContain("custom-role x1");
		expect(text).not.toContain("custom-role x2");
		expect(text).toContain("explorer x1");
	});

	it("names delegating roles before their first child and keeps explorers inline even when they can delegate", () => {
		const sessions = [
			makeSession({ id: "Root" }),
			makeSession({ id: "Owner", agent: "owner", canDelegate: true, description: "Before child" }),
			makeSession({ id: "ExA", agent: "explorer", canDelegate: true }),
			makeSession({ id: "ExB", agent: "explorer", canDelegate: true }),
			makeSession({ id: "ExC", agent: "explorer" }),
		];
		const ancestry = sessions.slice(1).map(session => ({ id: session.id, parentId: "Root" }));
		const text = Bun.stripANSI(renderSubagentHudLines(sessions, 160, ancestry).subagents.join("\n"));
		expect(text).toMatch(/Owner.*owner.*Before child/);
		expect(text.match(/Owner/g)).toHaveLength(1);
		expect(text).toContain("explorer x3");
		expect(text).toContain("● ExA  ● ExB  ● ExC");
		expect(text).not.toContain("ExA ⟦");
	});

	it("preserves resolved delegation capability through lifecycle and progress resync", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Delegate", 0, "Before child", true),
			canDelegate: true,
		});
		expect(registry.getSession("Delegate")?.canDelegate).toBe(true);
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Delegate", 0, "Resynced", true));
		expect(registry.getSession("Delegate")?.canDelegate).toBe(true);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Delegate", 0, "Resynced", true),
			status: "completed",
		});
		expect(registry.getSession("Delegate")?.canDelegate).toBe(true);
		const payload = makeProgressPayload("ProgressOnly", 1, "From progress", true);
		payload.progress.canDelegate = true;
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		expect(registry.getSession("ProgressOnly")?.canDelegate).toBe(true);
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, { ...payload, progress: { ...payload.progress, canDelegate: false } });
		expect(registry.getSession("ProgressOnly")?.canDelegate).toBe(false);
		registry.resetSessions();
		expect(registry.getSessions().filter(session => session.kind === "subagent")).toEqual([]);
		registry.dispose();
	});

	it("clears current rows at observer reset without showing registry history", () => {
		const bus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Current", 0, "current work", true));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Current", 0, "current work", true),
			status: "completed",
		});
		expect(render(registry.getSessions())).toContain("Current");
		registry.resetSessions();
		expect(renderSubagentHudLines(registry.getSessions(), 120, [{ id: "Stale" }])).toEqual({
			completed: [],
			subagents: [],
		});
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Current", 0, "old work", true),
			status: "completed",
		});
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Current", 0, "old work", true));
		expect(render(registry.getSessions())).toBe("");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("FreshTerminal", 0, "fresh work", true),
			status: "completed",
		});
		expect(render(registry.getSessions())).toContain("FreshTerminal");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Current", 0, "new generation", true),
			parentToolCallId: "new-tool-call",
		});
		expect(render(registry.getSessions())).toContain("new generation");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Current", 0, "old overwrite", true),
			status: "completed",
		});
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Current", 0, "old overwrite", true));
		expect(registry.getSession("Current")?.status).toBe("active");
		expect(registry.getSession("Current")?.parentToolCallId).toBe("new-tool-call");
		expect(render(registry.getSessions())).not.toContain("old overwrite");
		registry.dispose();
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("composes Completed before Todo and Subagents and clears both on reset", async () => {
		const composition = vi.spyOn(mode.composer, "setRuntimeChildren");
		await mode.init({ suppressWelcomeIntro: true });
		const children = composition.mock.calls.at(-1)?.[0];
		expect(children).toBeDefined();
		if (!children) throw new Error("Expected runtime children");
		expect(children.indexOf(mode.completedContainer)).toBeLessThan(children.indexOf(mode.todoContainer));
		expect(children.indexOf(mode.todoContainer)).toBeLessThan(children.indexOf(mode.subagentContainer));
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Done", 0, "finished work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Done", 0, "finished work", true),
			status: "completed",
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Live", 1, "active work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(200);
		expect(Bun.stripANSI(mode.completedContainer.render(120).join("\n"))).toContain("Done");
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("Live");
		expect(mode.subagentContainer.render(120).join("\n")).not.toContain("Done");
		mode.resetObserverRegistry();
		await Promise.resolve();
		vi.advanceTimersByTime(200);
		expect(mode.completedContainer.render(120)).toEqual([]);
		expect(mode.subagentContainer.render(120)).toEqual([]);
	});

	it("keeps Completed single-line through shrink and expansion without observer events", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		for (const [index, id] of ["FirstCompleted", "SecondCompleted", "ThirdCompleted"].entries()) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				...makeLifecycle(id, index, "done", true),
				status: "completed",
			});
		}
		await Promise.resolve();
		vi.advanceTimersByTime(200);
		const wide = mode.completedContainer.render(120);
		expect(wide).toHaveLength(2);
		expect(Bun.stripANSI(wide[0]).trim()).toBe("Completed");
		expect(Bun.stripANSI(wide[1])).toContain("ThirdCompleted");
		const narrow = mode.completedContainer.render(20);
		expect(narrow).toHaveLength(2);
		expect(Bun.stripANSI(narrow[0]).trim()).toBe("Completed");
		for (const line of narrow) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
		expect(mode.completedContainer.render(120)).toEqual(wide);
	});

	it("preserves same-session guest progress and idle rows but retires a changed host session", async () => {
		vi.useFakeTimers();
		await mode.init({ suppressWelcomeIntro: true });
		installInMemoryRelay();
		const roomId = `hud-${crypto.randomUUID()}`;
		const roomKey = generateRoomKey();
		const host = new CollabSocket({
			wsUrl: `ws://localhost:8788/r/${roomId}`,
			role: "host",
			key: await importRoomKey(roomKey),
		});
		const opened = Promise.withResolvers<void>();
		host.onOpen = () => opened.resolve();
		const welcome = (id: string): CollabFrame => ({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id, timestamp: new Date().toISOString(), cwd: tempDir.path() },
			state: { isStreaming: false, queuedMessageCount: 0, cwd: tempDir.path(), participants: [] },
			agents: [],
			entryCount: 0,
		});
		host.onFrame = frame => {
			if (frame.t === "hello") host.send(welcome("host-a"));
		};
		const guest = new CollabGuestLink(mode);
		const resume = vi.spyOn(mode, "handleResumeSession");
		const observedSessions = vi.spyOn(SessionObserverRegistry.prototype, "getSessions");
		const reset = vi.spyOn(mode, "resetObserverRegistry");
		const status = vi.spyOn(mode, "showStatus");
		const hud = () =>
			Bun.stripANSI([...mode.completedContainer.render(120), ...mode.subagentContainer.render(120)].join("\n"));
		let replicaPath: string | undefined;
		const send = async (frame: CollabFrame) => {
			const applied = Promise.withResolvers<void>();
			const unsubscribe = eventBus.on("hud-test-barrier", () => applied.resolve());
			try {
				host.send(frame);
				host.send({ t: "bus", channel: "hud-test-barrier", data: {} });
				await applied.promise;
				vi.advanceTimersByTime(200);
				await Promise.resolve();
			} finally {
				unsubscribe();
			}
		};
		const lifecycle = { ...makeLifecycle("LiveChild", 0, "live work", true), sessionFile: "/host/child.jsonl" };
		try {
			host.connect();
			await opened.promise;
			await guest.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
			replicaPath = session.sessionManager.getSessionFile() ?? undefined;
			expect(session.sessionManager.getSessionId()).toBe("host-a");
			expect(reset).toHaveBeenCalledTimes(1);
			await send({ t: "bus", channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL, data: lifecycle });
			expect(hud()).toContain("LiveChild");
			await send(welcome("host-a"));
			expect(status.mock.calls.some(([message]) => message.startsWith("Reconnected"))).toBe(true);
			expect(reset).toHaveBeenCalledTimes(1);
			expect(hud()).toContain("LiveChild");
			await send({
				t: "bus",
				channel: TASK_SUBAGENT_PROGRESS_CHANNEL,
				data: {
					...makeProgressPayload("LiveChild", 0, "recovered progress", true),
					sessionFile: lifecycle.sessionFile,
				},
			});
			expect(hud()).toContain("recovered progress");
			await send({
				t: "bus",
				channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				data: { ...lifecycle, status: "completed" },
			});
			await send(welcome("host-a"));
			expect(reset).toHaveBeenCalledTimes(1);
			expect(hud()).toContain("LiveChild");
			expect(mode.completedContainer.render(120).join("\n")).toContain(
				`${theme.styledSymbol("status.enabled", "success")} ${theme.bold("LiveChild")}`,
			);
			const observed = observedSessions.mock.results.at(-1);
			if (observed?.type !== "return") throw new Error("Expected rendered observer sessions");
			expect(observed.value.find(row => row.id === "LiveChild")?.status).toBe("completed");
			await send(welcome("host-b"));
			expect(session.sessionManager.getSessionId()).toBe("host-b");
			expect(reset).toHaveBeenCalledTimes(2);
			expect(hud()).not.toContain("LiveChild");
			await send({
				t: "bus",
				channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				data: { ...lifecycle, status: "completed" },
			});
			await send({
				t: "bus",
				channel: TASK_SUBAGENT_PROGRESS_CHANNEL,
				data: {
					...makeProgressPayload("LiveChild", 0, "stale progress", true),
					sessionFile: lifecycle.sessionFile,
				},
			});
			expect(hud()).not.toContain("LiveChild");
			await send({
				t: "bus",
				channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				data: {
					...lifecycle,
					parentToolCallId: "host-b-call",
					sessionFile: "/host/b-child.jsonl",
					description: "new generation",
				},
			});
			expect(hud()).toContain("new generation");
		} finally {
			host.close();
			try {
				await guest.leave("test cleanup");
				for (const result of resume.mock.results) {
					if (result.type === "return") await result.value;
				}
			} finally {
				uninstallInMemoryRelay();
				if (replicaPath) await unlink(replicaPath);
				vi.useRealTimers();
			}
		}
	}, 20000);

	it("clears A only after the actual picker successfully adopts B", async () => {
		// The real picker combines filesystem discovery with UI timers; retain the standalone repro's platform-clock polling.
		await mode.init({ suppressWelcomeIntro: true });
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendMessage({ role: "user", content: "PickerTargetB", timestamp: Date.now() });
		await target.ensureOnDisk();
		await target.flush();
		const targetPath = target.getSessionFile();
		await target.close();
		if (!targetPath) throw new Error("Expected persisted picker target");
		const lifecycle = (id: string, status: SubagentLifecyclePayload["status"]) =>
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...makeLifecycle(id, 0, `${id} work`, true), status });
		const hud = () =>
			Bun.stripANSI([...mode.completedContainer.render(120), ...mode.subagentContainer.render(120)].join("\n"));
		lifecycle("SessionAChild", "started");
		lifecycle("SessionAChild", "completed");
		await Bun.sleep(200);
		expect(hud()).toContain("SessionAChild");
		const overlay = vi.spyOn(mode.ui, "showOverlay");
		const openPicker = async () => {
			overlay.mockClear();
			mode.showSessionSelector();
			for (let i = 0; i < 100 && !overlay.mock.calls.length; i++) await Bun.sleep(20);
			const picker = overlay.mock.calls.at(-1)?.[0];
			if (!picker?.handleInput) throw new Error("Expected actual session picker");
			picker.handleInput("PickerTargetB");
			return picker;
		};
		const switchSession = vi.spyOn(session, "switchSession");
		const cancelled = await openPicker();
		cancelled.handleInput?.("\u001b");
		expect(switchSession).not.toHaveBeenCalled();
		expect(hud()).toContain("SessionAChild");
		for (const outcome of ["cancelled", "failed", "unchanged"] as const) {
			if (outcome === "failed") switchSession.mockRejectedValueOnce(new Error("expected switch failure"));
			else switchSession.mockResolvedValueOnce(outcome === "unchanged");
			const calls = switchSession.mock.calls.length;
			(await openPicker()).handleInput?.("\r");
			for (let i = 0; i < 100 && switchSession.mock.calls.length === calls; i++) await Bun.sleep(20);
			await Bun.sleep(200);
			expect(switchSession.mock.calls.length).toBe(calls + 1);
			expect(hud()).toContain("SessionAChild");
		}
		switchSession.mockRestore();
		(await openPicker()).handleInput?.("\r");
		for (let i = 0; i < 100 && session.sessionManager.getSessionFile() !== targetPath; i++) await Bun.sleep(20);
		await Bun.sleep(300);
		expect(session.sessionManager.getSessionFile()).toBe(targetPath);
		expect(hud()).not.toContain("SessionAChild");
		lifecycle("SessionBChild", "started");
		await Bun.sleep(200);
		expect(hud()).toContain("SessionBChild");
		expect(hud()).not.toContain("SessionAChild");
	}, 20000);

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("BurstAgent0: Burst job 0");
		expect(hud).toContain("BurstAgent5: Burst job 5");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
