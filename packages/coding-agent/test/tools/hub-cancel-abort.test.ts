import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { executeCancel } from "@oh-my-pi/pi-coding-agent/tools/hub/jobs";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSession(onAbort: () => Promise<void>): AgentSession {
	return { abort: onAbort, dispose: async () => {} } as unknown as AgentSession;
}

describe("hub cancel under abort", () => {
	test("an aborted bulk cancel still reports the ids it already cancelled and logs each outcome", async () => {
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-cancel-abort-"));
		dirs.push(artifactsDir);
		const controller = new AbortController();
		const registry = new AgentRegistry();
		registry.register({
			id: "LaneA",
			displayName: "LaneA",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: fakeSession(async () => {}),
		});
		registry.register({
			id: "LaneB",
			displayName: "LaneB",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: fakeSession(() => {
				controller.abort();
				return new Promise<void>(() => {});
			}),
		});
		registry.register({
			id: "LaneC",
			displayName: "LaneC",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: fakeSession(async () => {}),
		});
		const session = { agentRegistry: registry, getArtifactsDir: () => artifactsDir } as unknown as ToolSession;

		const result = await Promise.race([
			executeCancel(session, new AsyncJobManager({}), "Main", ["LaneA", "LaneB", "LaneC"], controller.signal),
			Bun.sleep(2000).then(() => "hung" as const),
		]);

		expect(result).not.toBe("hung");
		if (result === "hung") return;
		expect(result.details?.cancelled).toEqual([{ id: "LaneA", status: "cancelled" }]);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("Cancelled agent LaneA");
		expect(text).toContain("Interrupted before: LaneB, LaneC");
		expect(registry.get("LaneC")).toBeDefined();
		const logged = fs
			.readFileSync(path.join(artifactsDir, "hub.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { op: string; id?: string; status: string; unconfirmed?: string[] });
		expect(logged.map(({ op, id, status, unconfirmed }) => ({ op, id, status, unconfirmed }))).toEqual([
			{ op: "cancel", id: "LaneA", status: "cancelled", unconfirmed: undefined },
			{ op: "cancel", id: undefined, status: "interrupted", unconfirmed: ["LaneB", "LaneC"] },
		]);
	});
});
