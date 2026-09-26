import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveFrankAcceptExe } from "./structured-subagent";

afterEach(() => {
	delete process.env.FRANK_ACCEPT_BIN;
	delete process.env.FRANK_ACCEPT_ALLOW_REPO_BUILD;
});

describe("Frank accept executable resolution", () => {
	test("prefers explicit binary, opted-in repo build, then user install", async () => {
		const cwd = await mkdtemp(path.join(homedir(), ".frank-accept-test-"));
		const repoBuild = path.join(cwd, "target", "debug", "frank_accept");
		const userInstall = path.join(homedir(), ".local", "bin", "frank_accept");
		try {
			process.env.FRANK_ACCEPT_BIN = "/explicit/frank_accept";
			expect(await resolveFrankAcceptExe(cwd)).toBe("/explicit/frank_accept");
			delete process.env.FRANK_ACCEPT_BIN;
			expect(await resolveFrankAcceptExe(cwd)).toBe(userInstall);
			await mkdir(path.dirname(repoBuild), { recursive: true });
			await writeFile(repoBuild, "#!/bin/sh\nexit 0\n");
			await chmod(repoBuild, 0o700);
			process.env.FRANK_ACCEPT_ALLOW_REPO_BUILD = "1";
			expect(await resolveFrankAcceptExe(cwd)).toBe(repoBuild);
			delete process.env.FRANK_ACCEPT_ALLOW_REPO_BUILD;
			expect(await resolveFrankAcceptExe(cwd)).toBe(userInstall);
		} finally {
			delete process.env.FRANK_ACCEPT_BIN;
			delete process.env.FRANK_ACCEPT_ALLOW_REPO_BUILD;
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
