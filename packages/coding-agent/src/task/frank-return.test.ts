import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import { EventBus } from "../utils/event-bus";
import type { AgentSessionEvent } from "../session/agent-session";
import { runFrankSubagent } from "./executor";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentEventPayload, type SubagentLifecyclePayload } from "./types";

const artifactDirs: string[] = [];

afterEach(async () => {
	await Promise.all(artifactDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
	AgentRegistry.resetGlobalForTests();
});

describe("Frank task return integration", () => {
	test("maps the terminal result, emits events and lifecycle frames, and records outputPath", async () => {
		const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "frank-return-"));
		artifactDirs.push(artifactsDir);
		AgentRegistry.resetGlobalForTests();
		const bus = new EventBus();
		const id = "FrankReturn";
		const event: AgentSessionEvent = { type: "agent_start" };
		const eventFrames: SubagentEventPayload[] = [];
		const lifecycleStatuses: string[] = [];
		bus.on(TASK_SUBAGENT_EVENT_CHANNEL, payload => {
			if (typeof payload === "object" && payload !== null && "id" in payload && payload.id === id && "event" in payload && payload.event === event) {
				eventFrames.push({ id, event });
			}
		});
		bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			if (typeof payload === "object" && payload !== null && "id" in payload && payload.id === id && "status" in payload && typeof payload.status === "string") {
				lifecycleStatuses.push(payload.status);
			}
		});
		const result = await runFrankSubagent({
			id,
			task: "return a literal answer",
			assignment: "answer precisely",
			index: 0,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			cwd: process.cwd(),
			exe: "unused",
			endpoint: "http://127.0.0.1:1",
			model: "test-model",
			budgets: { maxToolCalls: 3, wallSecs: 5 },
			text: "request",
			artifactsDir,
			eventBus: bus,
			runWorker: async options => {
				await options.onEvent({ type: "event", seq: 1, event });
				return {
					terminal: { kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 },
					exitCode: 0,
					text: "literal Frank output",
				};
			},
		});
		const outputPath = path.join(artifactsDir, `${id}.md`);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("literal Frank output");
		expect(result.outputPath).toBe(outputPath);
		expect(await readFile(outputPath, "utf8")).toBe("literal Frank output");
		expect(eventFrames).toEqual([{ id, event }]);
		expect(lifecycleStatuses).toEqual(["started", "completed"]);
		expect(AgentRegistry.global().get(id)?.history?.outputPath).toBe(outputPath);
	});
});
