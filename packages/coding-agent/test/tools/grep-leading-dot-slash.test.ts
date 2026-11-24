import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

describe("grep glob with a leading ./", () => {
	let cwd: string;
	let tool: GrepTool;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-leading-dot-slash-"));
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new GrepTool(session);
		for (const name of ["package.json", "src/data.json", "src/nested/deep.json", "src/a.ts"]) {
			await Bun.write(path.join(cwd, name), "needle\n");
		}
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	const files = async (glob: string) =>
		(await tool.execute("glob", { pattern: "needle", path: glob })).details?.files ?? [];

	it("matches the same files for ./*.json as for *.json", async () => {
		const bare = await files("*.json");
		expect(bare).toEqual(["package.json", "src/data.json", "src/nested/deep.json"]);
		expect(await files("./*.json")).toEqual(bare);
	});
});
