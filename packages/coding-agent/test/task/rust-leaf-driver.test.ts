/**
 * Rust leaf driver regression suite: changed-contract tests for the two
 * confirmed defects plus the two added defects, including live-abort.
 * Replay cases run through the real exported `replayLeafFixture` mapping
 * plus the real argv/selection/binary helpers; the live-abort case drives
 * the minimal execution boundary (`runSubprocess` leaf branch) against a
 * local delay script with the caller signal live. Full live-spawn drives
 * (all-off + subrole) stay with the Acceptance gate at /tmp/rust-leaf-omp-gate.ts.
 * Real Task forced-write (a write attempt against the read-only leaf) is
 * gate-required and not suite-proven: the suite pins only the denial-literal
 * failure mapping below.
 *
 * Grounding (all paths under packages/coding-agent/src/task/):
 * - Mandatory flag: rust-leaf-driver.ts:336-337 ("Read-only driver:
 *   without this the leaf defaults to allow_all", `argv.push("--read-only")`);
 *   R consumption: pi_track_accept agent_mode.rs:90-91, CLI boundary
 *   main.rs:187.
 * - Failure mapping: rust-leaf-driver.ts:395-396 (terminalFailed excludes
 *   only Answer/Cancelled), :410-413 (failed on nonzero exit or failed
 *   terminal; Error/BudgetExceeded surfaced as exit 1), :415-423 (error
 *   literals), :443-444 (Cancelled sets aborted).
 * - Salvage: rust-leaf-driver.ts:405-409 (assistant text after latest User
 *   seq; textless new turn stays empty).
 * - Fixture replay purity: rust-leaf-driver.ts:448-465.
 * - Line shapes: rust-leaf-driver.ts:209-232 (event/AssistantDelta,
 *   terminal/final_seq/error).
 * - Binary precedence + fail-closed: rust-leaf-driver.ts:268-282.
 * - Submit turn: rust-leaf-driver.ts:288-290 (turn_id 1).
 * - Revival restriction: rust-leaf-driver.ts:594-624,
 *   LEAF_REVIVAL_UNSUPPORTED, mark/isLeafRunId :573-592.
 * - Monitor signal wiring: executor.ts:3191 (`signal: leafMonitor.abortSignal`),
 *   wall-clock timeout executor.ts:1288-1298, timeout literal :1313-1316.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	LEAF_REVIVAL_UNSUPPORTED,
	buildLeafSelectionArgv,
	buildLeafToolChoiceArgv,
	isLeafRunId,
	leafRevivalUnsupportedResult,
	markLeafRunId,
	replayLeafFixture,
	resolveLeafEventsPath,
	selectLeafBinary,
	submitLeafLines,
} from "@oh-my-pi/pi-coding-agent/task/rust-leaf-driver";
import type {
	RustLeafFixture,
	RustLeafFixtureIdentity,
} from "@oh-my-pi/pi-coding-agent/task/rust-leaf-driver";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function identity(): RustLeafFixtureIdentity {
	return {
		index: 0,
		id: "leaf-regress-1",
		agentName: "rust-leaf-regress",
		agentSource: "project",
		task: "Probe task.",
		model: "gate-local/gate-model",
	};
}

function delta(seq: number, text: string): string {
	return JSON.stringify({ type: "event", seq, event: { kind: { AssistantDelta: text } } });
}

function user(seq: number, text: string): string {
	return JSON.stringify({ type: "event", seq, event: { kind: { User: text } } });
}

function terminal(kind: string, finalSeq: number, error?: string): string {
	return JSON.stringify({
		type: "terminal",
		version: 1,
		turn_id: 1,
		terminal: kind,
		final_seq: finalSeq,
		...(error !== undefined ? { error } : {}),
	});
}

function fixtureOf(outcome: Partial<RustLeafFixture>): RustLeafFixture {
	return {
		binary: "/tmp/rust-leaf-gate-target/debug/pi_track_accept",
		argv: ["agent", "--endpoint", "http://127.0.0.1:9/unused", "--model", "gate-local/gate-model", "--cwd", "/tmp", "--read-only"],
		stdinLines: [],
		stdoutLines: [],
		stderrLines: [],
		exitCode: 0,
		durationMs: 5,
		...outcome,
	};
}

describe("rust-leaf-driver regressions", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("bug 1: every recorded leaf argv carries the mandatory --read-only flag", () => {
		const recorded = fixtureOf({}).argv;
		expect(recorded).toContain("--read-only");
		const withoutFlag = recorded.filter(arg => arg !== "--read-only");
		expect(withoutFlag).not.toContain("--read-only");
	});

	it("bug 1: all-off selection argv keeps every layer explicitly off", () => {
		expect(
			buildLeafSelectionArgv({
				system: { enabled: false, name: "default", shared: [] },
				role: { enabled: false, name: "probe-role", shared: [] },
				subrole: { enabled: false, name: "probe-subrole", shared: [] },
			}),
		).toEqual([
			"--instructions-system",
			"off",
			"--instructions-role",
			"probe-role",
			"--no-instructions-role-enabled",
			"--instructions-subrole",
			"probe-subrole",
			"--no-instructions-subrole-enabled",
		]);
	});

	it("bug 2: terminal Error with fixture exit 0 finalizes as failure, partial text salvaged", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "part 1 "), delta(3, "part 2")],
				stderrLines: [terminal("Error", 3, "boom")],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toBe("part 1 part 2");
		expect(outcome.error).toBe("leaf terminal Error: boom");
	});

	it("bug 2: terminal BudgetExceeded with fixture exit 0 finalizes as failure", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "partial ")],
				stderrLines: [terminal("BudgetExceeded", 2)],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toBe("partial ");
		expect(outcome.error).toBe("leaf exited 1");
	});

	it("bug 2: terminal Answer stays success with the completed payload", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "done")],
				stderrLines: [terminal("Answer", 2)],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.output).toBe("done");
		expect(outcome.error).toBeUndefined();
	});

	it("bug 2: Cancelled keeps partial text and names the cancellation", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "half")],
				stderrLines: [terminal("Cancelled", 2)],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.aborted).toBe(true);
		expect(outcome.output).toBe("half");
		expect(outcome.error).toBe("leaf turn cancelled; salvaged 4 chars of partial assistant text");
	});

	it("added defect: a new empty turn yields no stale output", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [user(1, "old task"), delta(2, "stale"), user(5, "new task")],
				stderrLines: [terminal("Answer", 5)],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.output).toBe("");
		expect(outcome.error).toBeUndefined();
	});

	it("added defect: abort surfacing stays a Cancelled turn, never success", () => {
		const outcome = replayLeafFixture(
			fixtureOf({ stderrLines: [terminal("Cancelled", 0)], exitCode: 0 }),
			identity(),
		);
		expect(outcome.aborted).toBe(true);
		expect(outcome.abortReason).toBe("cancelled");
	});

	it.skipIf(process.platform === "win32")("live-abort: monitor wall-clock stops the leaf drive with caller signal live", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rust-leaf-abort-"));
		const authStorage = createInMemoryAuthStorage();
		try {
			const delayBin = join(dir, "delay-leaf.sh");
			writeFileSync(delayBin, '#!/bin/sh\nprintf "%s\\n" "$$" > "${0%/*}/shell.pid"\nsleep 30 &\nprintf "%s\\n" "$!" > "${0%/*}/child.pid"\nwait\n');
			chmodSync(delayBin, 0o755);
			const modelRegistry = new ModelRegistry(authStorage);
			// Fail-closed migration: the abort probe resolves its model through
			// the registry like every leaf run, so `--model` wires the native id.
			modelRegistry.registerProvider("leaf-abort-local", {
				api: "openai-completions",
				apiKey: "dummy-abort-key",
				baseUrl: "http://127.0.0.1:9/unused",
				models: [
					{
						id: "leaf-abort-model",
						name: "Leaf Abort Fixture",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
			const agent: AgentDefinition = {
				name: "rust-leaf-regress",
				description: "leaf abort probe",
				systemPrompt: "Probe.",
				source: "project",
				leaf: {
					runtime: "rust",
					endpoint: "http://127.0.0.1:9/unused",
					binaryPath: delayBin,
					selection: {
						system: { enabled: false, name: "default", shared: [] },
						role: { enabled: false, name: "probe-role", shared: [] },
						subrole: { enabled: false, name: "probe-subrole", shared: [] },
					},
				},
			};
			const caller = new AbortController();
			const result = await runSubprocess({
				cwd: dir,
				agent,
				task: "Probe task.",
				index: 0,
				id: "leaf-regress-abort-1",
				description: "leaf abort probe",
				settings: Settings.isolated(),
				modelRegistry,
				modelOverride: "leaf-abort-local/leaf-abort-model",
				maxRuntimeMs: 500,
				signal: caller.signal,
				enableLsp: false,
			});
			expect(caller.signal.aborted).toBe(false);
			expect(result.aborted).toBe(true);
			expect(result.abortReason).toBe("Subagent runtime limit exceeded (task.maxRuntimeMs=500)");
			expect(result.exitCode).toBe(1);
			expect(result.output).toBe("");
			for (const name of ["shell", "child"]) {
				const pid = Number(readFileSync(join(dir, `${name}.pid`), "utf8").trim());
				expect(Number.isInteger(pid) && pid > 0).toBe(true);
				expect(() => process.kill(pid, 0)).toThrow("ESRCH");
				console.log(`REAP_PASS ${name} pid=${pid} ESRCH`);
			}
		} finally {
			authStorage.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denial literal maps a refused write turn to failure", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "part ")],
				stderrLines: [terminal("Error", 2, "tool denied by allowlist: tool_write")],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.error).toBe("leaf terminal Error: tool denied by allowlist: tool_write");
		expect(outcome.output).toBe("part ");
	});

	it("provider error preserves model and endpoint identity in the failure", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "part ")],
				stderrLines: [terminal("Error", 2, "[openai-compat] canned http://127.0.0.1:9/unused: unreachable endpoint")],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.error).toBe("leaf terminal Error: [openai-compat] canned http://127.0.0.1:9/unused: unreachable endpoint");
		expect(outcome.error ?? "").toContain("canned");
		expect(outcome.error ?? "").toContain("http://127.0.0.1:9/unused");
	});

	it("budget preservation: BudgetExceeded keeps every partial and still fails", () => {
		const outcome = replayLeafFixture(
			fixtureOf({
				stdoutLines: [delta(2, "part 1 "), delta(3, "part 2")],
				stderrLines: [terminal("BudgetExceeded", 3)],
				exitCode: 0,
			}),
			identity(),
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toBe("part 1 part 2");
		expect(outcome.error).toBe("leaf exited 1");
	});

	it("missing registry fails closed before any drive", async () => {
		await expect(
			runSubprocess({
				cwd: "/tmp",
				agent: {
					name: "rust-leaf-regress",
					description: "leaf missing-registry probe",
					systemPrompt: "Probe.",
					source: "project",
					leaf: {
						runtime: "rust",
						endpoint: "http://127.0.0.1:9/unused",
						selection: {
							system: { enabled: false, name: "default", shared: [] },
							role: { enabled: false, name: "probe-role", shared: [] },
							subrole: { enabled: false, name: "probe-subrole", shared: [] },
						},
					},
				},
				task: "Probe task.",
				index: 0,
				id: "leaf-regress-no-registry-1",
				settings: Settings.isolated(),
				enableLsp: false,
			}),
		).rejects.toThrow("options.modelRegistry is missing");
	});

	it("leaf run ids round-trip and revival stays unsupported", () => {
		markLeafRunId("leaf-regress-1");
		expect(isLeafRunId("leaf-regress-1")).toBe(true);
		expect(isLeafRunId("some-host-run")).toBe(false);
		const result = leafRevivalUnsupportedResult({
			index: 0,
			id: "leaf-regress-1",
			agentName: "rust-leaf-regress",
			agentSource: "project",
		});
		expect(result.error ?? "").toContain(LEAF_REVIVAL_UNSUPPORTED);
	});

	it("binary selection: explicit path wins, otherwise fail closed", () => {
		expect(
			selectLeafBinary({ explicitPath: "/b/leaf", configuredPath: "/c/leaf", envPath: "/e/leaf" }),
		).toBe("/b/leaf");
		expect(
			selectLeafBinary({ explicitPath: undefined, configuredPath: "/c/leaf", envPath: undefined }),
		).toBe("/c/leaf");
		expect(() =>
			selectLeafBinary({ explicitPath: undefined, configuredPath: undefined, envPath: undefined }),
		).toThrow(/no binary is configured/);
	});

	it("submit payload uses turn_id 1 and explicit eventsPath wins", () => {
		expect(submitLeafLines("hi")).toEqual([JSON.stringify({ op: "submit", turn_id: 1, text: "hi" })]);
		expect(
			resolveLeafEventsPath(
				{
					runtime: "rust",
					endpoint: "http://127.0.0.1:9/unused",
					selection: {
						system: { enabled: false, name: "default", shared: [] },
						role: { enabled: false, name: "r", shared: [] },
						subrole: { enabled: false, name: "s", shared: [] },
					},
					eventsPath: "/tmp/custom.jsonl",
				},
				"leaf-regress-1",
			),
		).toBe("/tmp/custom.jsonl");
	});
	it("tool-choice argv: false emits auto, true and absent omit (required preserved)", () => {
		expect(buildLeafToolChoiceArgv(false)).toEqual(["--tool-choice", "auto"]);
		expect(buildLeafToolChoiceArgv(true)).toEqual([]);
		expect(buildLeafToolChoiceArgv(undefined)).toEqual([]);
	});
});
