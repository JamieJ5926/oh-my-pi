import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { startFrankWorker } from "./frank-worker";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "frank-spawn-failure-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function expectSpawnFailure(exe: string, cwd: string, missing: "executable" | "cwd"): Promise<void> {
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", listener);
	try {
		let rejection: unknown;
		try {
			await startFrankWorker({
				exe,
				endpoint: "http://127.0.0.1:1",
				model: "test-model",
				cwd,
				budgets: { maxToolCalls: 1, wallSecs: 1 },
			});
		} catch (error) {
			rejection = error;
		}
		await new Promise<void>(resolve => process.nextTick(resolve));
		const description = rejection instanceof Error ? rejection.message : String(rejection);
		expect(rejection).toBeInstanceOf(Error);
		expect(description).toContain(exe);
		expect(description).toContain(cwd);
		expect(description).toContain(`missing ${missing}`);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", listener);
	}
}

describe("Frank worker spawn failures", () => {
	test("rejects with executable and nonexistent cwd details without an unhandled rejection", async () => {
		const root = await temporaryDirectory();
		await expectSpawnFailure(path.join(root, "frank_accept"), path.join(root, "missing-cwd"), "cwd");
	});

	test("rejects with nonexistent executable and cwd details without an unhandled rejection", async () => {
		const cwd = await temporaryDirectory();
		await expectSpawnFailure(path.join(cwd, "missing-frank_accept"), cwd, "executable");
	});
});
