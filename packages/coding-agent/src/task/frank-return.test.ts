import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import { EventBus } from "../utils/event-bus";
import type { AgentSessionEvent } from "../session/agent-session";
import { runFrankSubagent, runSubagentFollowUpTurn } from "./executor";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentEventPayload, type SubagentLifecyclePayload } from "./types";

const artifactDirs: string[] = [];

async function makeWorkerStub(body: string): Promise<{ cwd: string; exe: string }> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "frank-return-worker-"));
	artifactDirs.push(cwd);
	const exe = path.join(cwd, "frank-stub");
	await writeFile(exe, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	await chmod(exe, 0o700);
	return { cwd, exe };
}

function workerEvents(answer: string, seq: number, turnId: number): string {
	return `printf '%s\\n' '{"type":"event","seq":${seq},"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"${answer}"}]},"assistantMessageEvent":{"type":"text_delta","delta":"${answer}"}}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":${turnId},"accepted":true}' '{"type":"terminal","version":1,"turn_id":${turnId},"terminal":"Answer","final_seq":${seq}}' >&2`;
}

function workerOptions(id: string, exe: string, cwd: string, artifactsDir: string) {
	return {
		id,
		task: "return an answer",
		assignment: "answer precisely",
		index: 0,
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" as const },
		cwd,
		exe,
		endpoint: "http://127.0.0.1:1",
		model: "test-model",
		budgets: { maxToolCalls: 3, wallSecs: 5 },
		text: "first turn",
		artifactsDir,
		keepAlive: true,
	};
}

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
	test("folds a Frank worker yield into extractedToolData and validates it against the output schema", async () => {
		AgentRegistry.resetGlobalForTests();
		const id = "FrankStructuredReturn";
		const data = { answer: "forty two" };
		const result = await runFrankSubagent({
			id,
			task: "return a structured answer",
			assignment: "answer precisely",
			index: 0,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			cwd: process.cwd(),
			exe: "unused",
			endpoint: "http://127.0.0.1:1",
			model: "test-model",
			budgets: { maxToolCalls: 3, wallSecs: 5 },
			text: "request",
			outputSchema: {
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
				additionalProperties: false,
			},
			outputSchemaMode: "strict",
			outputSchemaSource: "caller",
			runWorker: async options => {
				await options.onEvent({
					type: "event",
					seq: 1,
					event: { type: "tool_call", name: "yield", input: { data, status: "success" } },
				});
				return {
					terminal: { kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 },
					exitCode: 0,
					text: "worker final text",
				};
			},
		});
		expect(result.extractedToolData?.yield).toEqual([{ data, status: "success" }]);
		expect(result.structuredOutput).toEqual({ source: "caller", mode: "strict", status: "valid", data });
		expect(result.output).toContain(JSON.stringify(data, null, 2));
	});

	test("rejects a Frank worker yield that violates the strict output schema", async () => {
		AgentRegistry.resetGlobalForTests();
		const id = "FrankStructuredReturnInvalid";
		const data = { answer: 42 };
		const result = await runFrankSubagent({
			id,
			task: "return a structured answer",
			assignment: "answer precisely",
			index: 0,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			cwd: process.cwd(),
			exe: "unused",
			endpoint: "http://127.0.0.1:1",
			model: "test-model",
			budgets: { maxToolCalls: 3, wallSecs: 5 },
			text: "request",
			outputSchema: {
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
				additionalProperties: false,
			},
			outputSchemaMode: "strict",
			outputSchemaSource: "caller",
			runWorker: async options => {
				await options.onEvent({
					type: "event",
					seq: 1,
					event: { type: "tool_call", name: "yield", input: { data, status: "success" } },
				});
				return {
					terminal: { kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 },
					exitCode: 0,
					text: "worker final text",
				};
			},
		});
		expect(result.extractedToolData?.yield).toEqual([{ data, status: "success" }]);
		expect(result.structuredOutput?.status).toBe("invalid");
		expect(result.structuredOutput?.data).toEqual(data);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("schema_violation");
	});

	test("preserves a nonzero worker exit after Answer as a typed error with folded text", async () => {
		AgentRegistry.resetGlobalForTests();
		const id = "FrankReturnNonzero";
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
			runWorker: async () => ({
				terminal: { kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 0 },
				exitCode: 7,
				text: "folded answer text",
			}),
		});
		expect(result.exitCode).toBe(7);
		expect(result.error).toContain("Frank worker exited with code 7");
		expect(result.output).toBe("folded answer text");
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		expect(AgentRegistry.global().listVisibleTo("Main").find(ref => ref.id === id)).toBeUndefined();
	});

	test("registry visibility hides parked completed and failed statuses", async () => {
		AgentRegistry.resetGlobalForTests();
		const completedId = "FrankReturnCompleted";
		const failedId = "FrankReturnFailed";
		const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "frank-return-status-"));
		artifactDirs.push(artifactsDir);
		const run = (id: string, exitCode: number) => runFrankSubagent({
			id,
			task: "return an answer",
			assignment: "answer",
			index: 0,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			cwd: process.cwd(),
			exe: "unused",
			artifactsDir,
			endpoint: "http://127.0.0.1:1",
			model: "test-model",
			budgets: { maxToolCalls: 3, wallSecs: 5 },
			text: "request",
			runWorker: async () => ({
				terminal: { kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 0 },
				exitCode,
				text: "answer",
			}),
		});
		await run(completedId, 0);
		await run(failedId, 9);
		const visible = AgentRegistry.global().listVisibleTo("Main");
		expect(AgentRegistry.global().get(completedId)?.status).toBe("parked");
		expect(AgentRegistry.global().get(failedId)?.status).toBe("parked");
		expect(AgentRegistry.global().get(completedId)?.history?.outputPath).toBe(path.join(artifactsDir, `${completedId}.md`));
		expect(AgentRegistry.global().get(failedId)?.history?.outputPath).toBe(path.join(artifactsDir, `${failedId}.md`));
		expect(visible.map(ref => ref.id)).not.toContain(completedId);
		expect(visible.map(ref => ref.id)).not.toContain(failedId);
	});
	test("keeps the real worker for a same-id follow-up and closes it on abort", async () => {
		AgentRegistry.resetGlobalForTests();
		const id = "FrankReturnRetained";
		const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "frank-return-retained-"));
		artifactDirs.push(artifactsDir);
		const stub = await makeWorkerStub(`printf '%s\\n' "$$" >> "$FRANK_PID_FILE"; turn=1; while IFS= read -r input; do case "$input" in *shutdown*) exit 0;; esac; printf '%s\\n' "$input" >> "$FRANK_TURNS_FILE"; case "$turn" in 1) ${workerEvents("first answer", 1, 1)};; 2) ${workerEvents("second answer", 2, 2)};; *) exit 7;; esac; turn=$((turn + 1)); done`);
		const pidFile = path.join(stub.cwd, "pids");
		const turnsFile = path.join(stub.cwd, "turns");
		process.env.FRANK_PID_FILE = pidFile;
		process.env.FRANK_TURNS_FILE = turnsFile;
		try {
			const first = await runFrankSubagent({ ...workerOptions(id, stub.exe, stub.cwd, artifactsDir), text: "first turn" });
			const second = await runSubagentFollowUpTurn({ id, agent: workerOptions(id, stub.exe, stub.cwd, artifactsDir).agent, message: "unused", followUpMessage: "second turn", keepAlive: true, artifactsDir });
			expect(first.output).toBe("first answer");
			expect(second.output).toBe("second answer");
			expect(await readFile(turnsFile, "utf8")).toContain('"turn_id":2,"text":"second turn"');
			expect((await readFile(pidFile, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
			const controller = new AbortController();
			controller.abort(new Error("close retained worker"));
			const aborted = await runSubagentFollowUpTurn({ id, agent: workerOptions(id, stub.exe, stub.cwd, artifactsDir).agent, message: "unused", followUpMessage: "aborted turn", keepAlive: true, signal: controller.signal, artifactsDir });
			expect(aborted.aborted).toBe(true);
			const firstPid = Number((await readFile(pidFile, "utf8")).trim().split(/\r?\n/)[0]);
			let processIsClosed = false;
			try {
				process.kill(firstPid, 0);
			} catch {
				processIsClosed = true;
			}
			expect(processIsClosed).toBe(true);
		} finally {
			delete process.env.FRANK_PID_FILE;
			delete process.env.FRANK_TURNS_FILE;
		}
	});

	test("spawns a fresh process after an aborted retained follow-up", async () => {
		AgentRegistry.resetGlobalForTests();
		const id = "FrankReturnAbortFresh";
		const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "frank-return-abort-"));
		artifactDirs.push(artifactsDir);
		const stub = await makeWorkerStub(`printf '%s\\n' "$$" >> "$FRANK_PID_FILE"; IFS= read -r input; case "$input" in *shutdown*) exit 0;; esac; case "$input" in *fresh\\ turn*) ${workerEvents("fresh answer", 1, 1)};; *) ${workerEvents("first answer", 1, 1)};; esac; while IFS= read -r input; do case "$input" in *shutdown*) exit 0;; esac; done`);
		const pidFile = path.join(stub.cwd, "pids");
		process.env.FRANK_PID_FILE = pidFile;
		try {
			const initial = await runFrankSubagent({ ...workerOptions(id, stub.exe, stub.cwd, artifactsDir), text: "first turn" });
			expect(initial.output).toBe("first answer");
			const controller = new AbortController();
			controller.abort(new Error("cancel follow-up"));
			const cancelled = await runSubagentFollowUpTurn({ id, agent: workerOptions(id, stub.exe, stub.cwd, artifactsDir).agent, message: "unused", followUpMessage: "cancelled turn", keepAlive: true, signal: controller.signal, artifactsDir });
			expect(cancelled.aborted).toBe(true);
			const fresh = await runFrankSubagent({ ...workerOptions(id, stub.exe, stub.cwd, artifactsDir), text: "fresh turn" });
			expect(fresh.output).toBe("fresh answer");
			expect((await readFile(pidFile, "utf8")).trim().split(/\r?\n/)).toHaveLength(2);
		} finally {
			delete process.env.FRANK_PID_FILE;
		}
	});
});
