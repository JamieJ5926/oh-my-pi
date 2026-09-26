import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnFrankDaemonWorker } from "./frank-daemon-worker";

describe("Frank daemon lane admission", () => {
	test("passes each lane's cwd and profile to daemon admission", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "frank-admit-cwd-"));
		const cwdA = await mkdtemp(path.join(os.tmpdir(), "frank-lane-a-"));
		const cwdB = await mkdtemp(path.join(os.tmpdir(), "frank-lane-b-"));
		const bin = path.join(directory, "frank");
		const argvFile = path.join(directory, "argv");
		const artifactsDir = path.join(directory, "artifacts");
		await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "frank test-stub"; exit 0; fi\nif [ "$1" = "daemon" ]; then printf '%s\\n' "$*" >> '${argvFile}'; exit 0; fi\nif [ "$1" = "attach" ]; then printf '%s\\n' '{"seq":1,"kind":{"TerminalDone":{"outcome":"Answer","seq":1}}}' '{"details":"daemon answer"}'; exit 0; fi\nexit 1\n`);
		await chmod(bin, 0o755);
		try {
			for (const [id, cwd, name, model, maxToolCalls, wallSecs] of [
				["lane-a", cwdA, "reviewer", "model-a", 4, 9],
				["lane-b", cwdB, "implementer", "model-b", 8, 11],
			] as const) {
				await spawnFrankDaemonWorker({ exe: bin, frankBin: bin, cwd, role: { root: "/tmp/profiles", name }, model, endpoint: "http://127.0.0.1:1", budgets: { maxToolCalls, wallSecs }, text: "inspect", id, artifactsDir, onEvent: () => {} });
			}
			const argv = await readFile(argvFile, "utf8");
			expect(cwdA).not.toBe(cwdB);
			expect(argv).toContain(`--cwd ${cwdA}`);
			expect(argv).toContain("--profile reviewer");
			expect(argv).toContain("--model model-a");
			expect(argv).toContain("--max-tool-calls 4 --wall-secs 9");
			expect(argv).not.toContain("--budgets");
			expect(argv).toContain(`--cwd ${cwdB}`);
			expect(argv).toContain("--profile implementer");
			expect(argv).toContain("--model model-b");
		} finally {
			await Promise.all([rm(directory, { recursive: true, force: true }), rm(cwdA, { recursive: true, force: true }), rm(cwdB, { recursive: true, force: true })]);
		}
	});
});

describe("Frank daemon version gate", () => {
	async function makeVersionedBin(version: string, statusJson: string): Promise<{ directory: string; bin: string; stopFile: string; artifactsDir: string }> {
		const directory = await mkdtemp(path.join(os.tmpdir(), "frank-daemon-version-"));
		const bin = path.join(directory, "frank");
		const stopFile = path.join(directory, "stops");
		const artifactsDir = path.join(directory, "artifacts");
		await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "daemon" ] && [ "$2" = "stop" ]; then echo stop >> "${stopFile}"; exit 0; fi\nif [ "$1" = "daemon" ] && [ "$2" = "status" ]; then printf '%s\\n' '${statusJson}'; exit 0; fi\nif [ "$1" = "daemon" ]; then exit 0; fi\nif [ "$1" = "attach" ]; then printf '%s\\n' '{"seq":1,"kind":{"TerminalDone":{"outcome":"Answer","seq":1}}}' '{"details":"daemon answer"}'; exit 0; fi\nexit 1\n`);
		await chmod(bin, 0o755);
		return { directory, bin, stopFile, artifactsDir };
	}
	test("restarts an idle daemon when the client version changes", async () => {
		const stateDir = await mkdtemp(path.join(os.tmpdir(), "frank-daemon-state-"));
		process.env.FRANK_DAEMON_STATE_DIR = stateDir;
		try {
			const first = await makeVersionedBin("frank X", "[]");
			const second = await makeVersionedBin("frank Y", "[]");
			const lane = (bin: string, artifactsDir: string) => spawnFrankDaemonWorker({ exe: bin, frankBin: bin, cwd: stateDir, endpoint: "http://127.0.0.1:1", model: "m", budgets: { maxToolCalls: 1, wallSecs: 1 }, text: "inspect", id: "lane-v", artifactsDir, onEvent: () => {} });
			try {
				await lane(first.bin, first.artifactsDir);
				expect(await readFile(path.join(stateDir, "daemon-version"), "utf8")).toContain("frank X");
				await lane(second.bin, second.artifactsDir);
				expect(await readFile(path.join(stateDir, "daemon-version"), "utf8")).toContain("frank Y");
				expect(await readFile(second.stopFile, "utf8")).toContain("stop");
			} finally {
				await Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })]);
			}
		} finally {
			delete process.env.FRANK_DAEMON_STATE_DIR;
			await rm(stateDir, { recursive: true, force: true });
		}
	});
	test("refuses when sessions run under a different daemon version", async () => {
		const stateDir = await mkdtemp(path.join(os.tmpdir(), "frank-daemon-state-"));
		process.env.FRANK_DAEMON_STATE_DIR = stateDir;
		try {
			const first = await makeVersionedBin("frank X", "[]");
			const second = await makeVersionedBin("frank Y", '[{"session":"abc"}]');
			const lane = (bin: string, artifactsDir: string) => spawnFrankDaemonWorker({ exe: bin, frankBin: bin, cwd: stateDir, endpoint: "http://127.0.0.1:1", model: "m", budgets: { maxToolCalls: 1, wallSecs: 1 }, text: "inspect", id: "lane-v", artifactsDir, onEvent: () => {} });
			try {
				await lane(first.bin, first.artifactsDir);
				const error = await lane(second.bin, second.artifactsDir).catch(error => error);
				expect(String(error?.message ?? error)).toContain("frank X");
				expect(String(error?.message ?? error)).toContain("frank Y");
			} finally {
				await Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })]);
			}
		} finally {
			delete process.env.FRANK_DAEMON_STATE_DIR;
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
