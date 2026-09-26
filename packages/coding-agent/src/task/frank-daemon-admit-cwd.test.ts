import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		await writeFile(bin, `#!/bin/sh\nif [ "$1" = "daemon" ]; then printf '%s\\n' "$*" >> '${argvFile}'; exit 0; fi\nif [ "$1" = "attach" ]; then printf '%s\\n' '{"seq":1,"kind":{"TerminalDone":{"outcome":"Answer","seq":1}}}' '{"details":"daemon answer"}'; exit 0; fi\nexit 1\n`);
		await import("node:fs/promises").then(fs => fs.chmod(bin, 0o755));
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
