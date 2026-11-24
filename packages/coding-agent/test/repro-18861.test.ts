import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatHashlineHeader } from "@oh-my-pi/pi-coding-agent/tools/hashline-format";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const MODEL = "openai/gpt-5.6";

function makeSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => MODEL,
		enableLsp: false,
		settings,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-18861-"));
	await fs.mkdir(path.join(tempDir, "agent"), { recursive: true });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

async function applyIssueEdit(name: string, source: string, body: string): Promise<{ outcome: string; text: string }> {
	const settings = await Settings.loadIsolated({
		cwd: tempDir,
		agentDir: path.join(tempDir, "agent"),
		inMemory: true,
		overrides: { "edit.enforceSeenLines": false },
	});
	const session = makeSession(tempDir, settings);
	const absolutePath = path.join(tempDir, name);
	await Bun.write(absolutePath, source);
	const tag = getEditStore(session).recordSnapshot(absolutePath, source, undefined);
	const outcome = await new EditTool(session, "hashline")
		.execute("repro", { input: `${formatHashlineHeader(name, tag)}\n${body}` })
		.then(
			() => "applied",
			(error: unknown) => `rejected: ${String(error)}`,
		);
	return { outcome, text: await Bun.file(absolutePath).text() };
}

test("issue 18861 case 1: a one-row PUT restating the line above is not duplicated", async () => {
	const { outcome, text } = await applyIssueEdit(
		"rollup.ts",
		"let rollupUsd = 0;\nlet unattributedUsd = 0;\nlet totalUsd = 0;\n",
		"PUT 3.=3:\n+let unattributedUsd = 0;\n+let copiedUsd = 0;",
	);
	console.log(`CASE1 OUTCOME: ${outcome}\nCASE1 FILE:\n${text}`);
	expect(text.split("let unattributedUsd = 0;").length - 1).toBe(1);
});

test("issue 18861 case 2: a PUT restating both neighbours is not duplicated", async () => {
	const { outcome, text } = await applyIssueEdit("calls.ts", "a();\nb();\nc();\n", "PUT 2.=2:\n+a();\n+c();");
	console.log(`CASE2 OUTCOME: ${outcome}\nCASE2 FILE:\n${text}`);
	expect(text.split("a();").length - 1).toBe(1);
	expect(text.split("c();").length - 1).toBe(1);
});
