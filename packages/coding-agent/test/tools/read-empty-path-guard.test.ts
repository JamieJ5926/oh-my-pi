import { beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		settings: Settings.isolated(),
	};
}

describe("ReadTool.execute empty/missing path guard", () => {
	let tool: ReadTool;

	beforeEach(() => {
		tool = new ReadTool(makeSession(os.tmpdir()));
	});

	it("rejects undefined path", async () => {
		await expect(tool.execute("t1", {} as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});

	it("rejects empty string path", async () => {
		await expect(tool.execute("t2", { path: "" } as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});

	it("rejects whitespace-only path", async () => {
		await expect(tool.execute("t3", { path: "   " } as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});

	it("rejects tab/newline path", async () => {
		await expect(tool.execute("t4", { path: "\t\n" } as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});

	it("rejects null path", async () => {
		await expect(tool.execute("t5", { path: null } as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});

	it("rejects numeric path", async () => {
		await expect(tool.execute("t6", { path: 42 } as unknown as Parameters<typeof tool.execute>[1])).rejects.toThrow(
			"Missing required parameter 'path'",
		);
	});
});
