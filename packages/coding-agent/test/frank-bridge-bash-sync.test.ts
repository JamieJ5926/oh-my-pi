import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_TOOLS } from "../src/tools";
import type { ToolSession } from "../src/tools";
import { createFrankHostToolService } from "../src/task/frank-host-tools";

function makeService(dir: string) {
	return createFrankHostToolService({
				session: {
					cwd: dir,
					hasUI: false,
					skills: [],
					getAgentId: () => "FrankHost",
					getToolContext: () => undefined,
					getSessionId: () => "frank-bash-sync-test",
					getSessionFile: () => null,
					getClientBridge: () => undefined,
					settings: {
						get(key: string) {
							if (
								key === "async.enabled" ||
								key === "bash.autoBackground.enabled" ||
								key === "bashInterceptor.enabled" ||
								key === "astGrep.enabled" ||
								key === "astEdit.enabled" ||
								key === "grep.enabled" ||
								key === "glob.enabled"
							)
								return false;
							if (key === "bash.autoBackground.thresholdMs") return 60_000;
							return undefined;
						},
						getBashInterceptorRules: () => [],
					},
					toolRegistry: new Map([
						[
							"bash",
							{ execute: async () => ({ content: [{ type: "text" as const, text: "unused host bash" }] }) },
						],
					]),
					wrapWithHooks: (tool: { name: string; execute: unknown }) => tool,
				} as unknown as ToolSession,
				agentId: "FrankWorker",
				workerCwd: dir,
				names: ["bash"],
			});
}

describe("Frank bridge synchronous bash", () => {
	test("runs a shell-string command sent with an empty argv", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frank-bash-cmd-"));
		const originalBash = BUILTIN_TOOLS.bash;
		try {
			const result = await makeService(dir).handle("bash", {
				argv: [],
				command: "echo hi | tr a-z A-Z",
				cwd: "/",
				timeout_ms: 20_000,
			});
			if (!result.ok) throw new Error(result.error);
			expect(result.content).toContain("HI");
			expect(result.content).not.toContain("(no output)");
		} finally {
			BUILTIN_TOOLS.bash = originalBash;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("refuses a bash call with neither argv nor command", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frank-bash-empty-"));
		const originalBash = BUILTIN_TOOLS.bash;
		try {
			const result = await makeService(dir).handle("bash", { argv: [] });
			expect(result.ok).toBe(false);
			expect(result.error).toBe("bash requires a non-empty argv or a command string");
		} finally {
			BUILTIN_TOOLS.bash = originalBash;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("returns completed bash output and leaves redirected files on disk", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frank-bash-sync-"));
		const outputPath = path.join(dir, "gate.log");
		const originalBash = BUILTIN_TOOLS.bash;

		try {
			const service = makeService(dir);
			const command = `printf 'FRANK_SYNC_OUTPUT\\n' > ${JSON.stringify(outputPath)}; cat ${JSON.stringify(outputPath)}`;

			const result = await service.handle("bash", { argv: ["bash", "-c", command] });

			if (!result.ok) throw new Error(result.error);
			expect(result.ok).toBe(true);
			expect(result.content).toContain("FRANK_SYNC_OUTPUT");
			expect(result.content).not.toContain("(no output)");
			expect(result.content).not.toContain("job-");
			expect(await fs.readFile(outputPath, "utf8")).toBe("FRANK_SYNC_OUTPUT\n");
		} finally {
			BUILTIN_TOOLS.bash = originalBash;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
