import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnFrankDaemonWorker } from "./frank-daemon-worker";

describe("Frank daemon lane cancellation", () => {
	test("aborting one lane cancels only that lane's session", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "frank-daemon-cancel-"));
		const bin = path.join(directory, "frank");
		const argvFile = path.join(directory, "argv");
		const artifactsDir = path.join(directory, "artifacts");
		const cwd = directory;
		await mkdir(artifactsDir, { recursive: true });
		await writeFile(bin, `#!/bin/sh
if [ "$1" = "daemon" ]; then printf '%s\\n' "$*" >> "$FRANK_ARGV_FILE"; exit 0; fi
if [ "$1" = "__daemon-run" ]; then exit 0; fi
if [ "$1" = "cancel" ]; then printf '%s\\n' "$*" >> "$FRANK_ARGV_FILE"; exit 0; fi
if [ "$1" = "attach" ]; then printf '%s\\n' "$*" >> "$FRANK_ARGV_FILE"; printf '%s\\n' '{"seq":1,"kind":{"AssistantDelta":"daemon answer"}}' '{"seq":2,"kind":{"TerminalDone":{"seq":2,"outcome":"Answer"}}}' '{"details":"daemon answer"}'; exit 0; fi
exit 9
`, { mode: 0o700 });
		const previousArgvFile = process.env.FRANK_ARGV_FILE;
		process.env.FRANK_ARGV_FILE = argvFile;
		try {
			const base = { exe: bin, frankBin: bin, cwd, role: undefined, model: "model", endpoint: "http://127.0.0.1:1", budgets: { maxToolCalls: 4, wallSecs: 9 }, text: "inspect", artifactsDir, onEvent: () => {} };
			const controller = new AbortController();
			const lane1 = spawnFrankDaemonWorker({ ...base, id: "lane-1", signal: controller.signal });
			controller.abort();
			await expect(lane1).rejects.toThrow();
			await spawnFrankDaemonWorker({ ...base, id: "lane-2" });
			const key1 = (await readFile(path.join(artifactsDir, "lane-1.frank-daemon", "session-key"), "utf8")).trim();
			const key2 = (await readFile(path.join(artifactsDir, "lane-2.frank-daemon", "session-key"), "utf8")).trim();
			const argv = await readFile(argvFile, "utf8");
			expect(argv).toContain(`cancel --session ${key1} --json`);
			expect(argv).not.toContain("daemon stop");
			expect(argv).toContain(`attach --session ${key2} --json`);
		} finally {
			if (previousArgvFile === undefined) delete process.env.FRANK_ARGV_FILE;
			else process.env.FRANK_ARGV_FILE = previousArgvFile;
			await Promise.all([rm(directory, { recursive: true, force: true }), rm(argvFile, { force: true })]);
		}
	});
});
