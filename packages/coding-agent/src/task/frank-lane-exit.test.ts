import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { runFrankSubagent, saveRunningFrankLanes } from "./executor";

const dirs: string[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

test("dispose with one running Frank lane saves its session and records the lane", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "frank-lane-exit-"));
	dirs.push(root);
	const laneCwd = path.join(root, "lane-wt");
	const sessionArtifacts = path.join(root, "session");
	await Bun.write(path.join(laneCwd, ".keep"), "");
	await Bun.write(path.join(sessionArtifacts, ".keep"), "");
	const inputs = path.join(root, "inputs");
	const exe = path.join(root, "frank-stub");
	await writeFile(
		exe,
		`#!/bin/sh
while IFS= read -r input; do
  printf '%s\\n' "$input" >> "$FRANK_INPUTS"
  case "$input" in
    *'"op":"submit"'*) printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' >&2 ;;
    *'"op":"cancel"'*) printf '%s\\n' '{"type":"event","seq":1,"event":{"type":"agent_start"}}'; printf '%s\\n' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Cancelled","final_seq":1}' >&2 ;;
    *'"op":"save"'*) : > "$FRANK_SAVE_PATH"; printf '{"type":"saved","version":1,"path":"%s"}\\n' "$FRANK_SAVE_PATH" >&2 ;;
    *'"op":"shutdown"'*) exit 0 ;;
  esac
done
`,
		{ mode: 0o700 },
	);
	await chmod(exe, 0o700);
	const id = "RateRetry";
	const savePath = path.join(sessionArtifacts, `${id}.frank-session.jsonl`);
	process.env.FRANK_INPUTS = inputs;
	process.env.FRANK_SAVE_PATH = savePath;
	try {
		const run = runFrankSubagent({
			id,
			task: "retry the rate limiter",
			assignment: "retry the rate limiter",
			index: 0,
			agent: { name: "frank-implementer", description: "test", systemPrompt: "", source: "bundled" },
			cwd: laneCwd,
			exe,
			endpoint: "http://127.0.0.1:1",
			model: "test-model",
			budgets: { maxToolCalls: 3, wallSecs: 5 },
			text: "retry the rate limiter",
			artifactsDir: sessionArtifacts,
			keepAlive: true,
		});
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && !(await Bun.file(inputs).exists())) await Bun.sleep(20);

		const lanes = await saveRunningFrankLanes(sessionArtifacts);

		const exitFile = path.join(sessionArtifacts, "frank-lanes-at-exit.json");
		expect(JSON.parse(await readFile(exitFile, "utf8"))).toEqual([
			{
				id,
				agent: "frank-implementer",
				cwd: laneCwd,
				savedSessionPath: savePath,
				task: "retry the rate limiter",
			},
		]);
		expect(lanes.map(lane => lane.id)).toEqual([id]);
		expect(await readFile(inputs, "utf8")).toContain(`{"op":"save","path":"${savePath}"}`);
		expect(await Bun.file(savePath).exists()).toBe(true);
		const result = await run;
		expect(result.aborted).toBe(true);
	} finally {
		delete process.env.FRANK_INPUTS;
		delete process.env.FRANK_SAVE_PATH;
	}
});
