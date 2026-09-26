import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { spawnFrankWorker, type FrankEvent } from "./frank-worker";

async function makeStub(body: string): Promise<{ cwd: string; exe: string }> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "frank-host-tools-"));
	const exe = path.join(cwd, "frank-stub");
	await writeFile(exe, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	await chmod(exe, 0o700);
	return { cwd, exe };
}

function workerOptions(exe: string, cwd: string, onEvent: (event: FrankEvent) => void) {
	return { exe, endpoint: "http://127.0.0.1:1", model: "test-model", cwd, budgets: { maxToolCalls: 12, wallSecs: 9 }, text: "delegate", onEvent };
}

describe("Frank daemon host tools", () => {
	test("forwards task and hub requests and their results", async () => {
		const stub = await makeStub(`printf '%s\\n' "$@" >> "$FRANK_ARGV_FILE"; printf '\\n' >> "$FRANK_ARGV_FILE"; printf '%s\\n' "$FRANK_DAEMON_HOST_TOOLS" >> "$FRANK_HOST_TOOLS_FILE"; case " $* " in *" daemon start "*) exit 0;; *" daemon status "*|*" __daemon-run "*) exit 0;; *" attach "*) printf '%s\\n' '{"type":"tool_request","version":1,"call_id":1,"turn_id":1,"name":"task","args":{"name":"child-marker"}}' '{"type":"tool_request","version":1,"call_id":2,"turn_id":1,"name":"hub","args":{"op":"send","to":"peer","message":"bridge-note"}}'; IFS= read -r first; printf '%s\\n' "$first" >> "$FRANK_TOOL_RESULT_FILE"; IFS= read -r second; printf '%s\\n' "$second" >> "$FRANK_TOOL_RESULT_FILE"; printf '%s\\n' '{"kind":{"TerminalDone":{"outcome":"Answer","seq":1}},"seq":1}' '{"details":"delegated"}'; exit 0;; esac; exit 0`);
		const argvFile = path.join(stub.cwd, "argv");
		const resultFile = path.join(stub.cwd, "tool-results");
		const hostToolsFile = path.join(stub.cwd, "host-tools");
		process.env.FRANK_HOST_TOOLS_FILE = hostToolsFile;
		process.env.FRANK_ARGV_FILE = argvFile;
		process.env.FRANK_TOOL_RESULT_FILE = resultFile;
		try {
			const calls: Array<{ name: string; args: unknown }> = [];
			const result = await spawnFrankWorker({ ...workerOptions(stub.exe, stub.cwd, () => {}), transport: "daemon", frankBin: stub.exe, hostTools: ["task", "hub"], onToolRequest: async request => { calls.push({ name: request.name, args: request.args }); return { ok: true, content: request.name === "task" ? "child-spawned" : "delivered" }; }, eventsPath: path.join(stub.cwd, "lane-1.frank.jsonl"), sessionId: "lane-1" });
			expect(calls).toEqual([
				{ name: "task", args: { name: "child-marker" } },
				{ name: "hub", args: { op: "send", to: "peer", message: "bridge-note" } },
			]);
			const results = await Bun.file(resultFile).text();
			expect(results).toContain('{"op":"tool_result","call_id":1,"ok":true,"content":"child-spawned"}');
			expect(results).toContain('{"op":"tool_result","call_id":2,"ok":true,"content":"delivered"}');
			const hostTools = await Bun.file(hostToolsFile).text();
			expect(hostTools).toContain("task,hub");
			expect(result.text).toBe("delegated");
			expect(result.exitCode).toBe(0);
		} finally {
			delete process.env.FRANK_ARGV_FILE;
			delete process.env.FRANK_HOST_TOOLS_FILE;
			delete process.env.FRANK_TOOL_RESULT_FILE;
			await rm(stub.cwd, { recursive: true, force: true });
		}
	});
});
