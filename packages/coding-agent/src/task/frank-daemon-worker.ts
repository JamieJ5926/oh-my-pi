import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { answerExitDecision, foldEventsToText } from "./frank-worker-fold";
import type { FrankControl, FrankEvent, FrankWorkerResult, StartFrankWorkerOptions } from "./frank-worker";

type DaemonOptions = StartFrankWorkerOptions & { text: string; artifactsDir: string; id: string };
type TerminalName = Extract<FrankControl, { kind: "terminal" }>['terminal'];
type AttachLine = { kind: "event"; seq: number; run_id?: unknown; event: unknown } | { kind: "envelope"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachLine(line: string): AttachLine | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) return undefined;
		if (typeof value.seq === "number" && "kind" in value) return { kind: "event", seq: value.seq, run_id: value.run_id, event: value.kind };
		if (typeof value.details === "string") return { kind: "envelope", text: value.details };
		return undefined;
	} catch {
		return undefined;
	}
}

function terminalResult(event: unknown): Extract<FrankControl, { kind: "terminal" }> | undefined {
	if (!isRecord(event) || !isRecord(event.TerminalDone)) return undefined;
	const done = event.TerminalDone;
	const terminal: TerminalName | undefined = done.outcome === "Answer" || done.outcome === "Error" || done.outcome === "Cancelled" || done.outcome === "BudgetExceeded" ? done.outcome : undefined;
	if (!terminal) return undefined;
	return { kind: "terminal", version: 1, turn_id: 1, terminal, final_seq: typeof done.seq === "number" ? done.seq : 0 };
}

function eventFromAttach(value: Extract<AttachLine, { kind: "event" }>): FrankEvent {
	return { type: "event", seq: value.seq, event: { kind: value.event, run_id: value.run_id, seq: value.seq } };
}

function daemonEnvironment(options: DaemonOptions, daemonDir: string): NodeJS.ProcessEnv {
	const keyName = options.apiKeyEnv ?? "PI_TRACK_API_KEY";
	return {
		...process.env,
		FRANK_DAEMON_DIR: daemonDir,
		FRANK_DAEMON_ENDPOINT: options.endpoint,
		FRANK_DAEMON_MODEL: options.model,
		FRANK_DAEMON_KEY_ENV: keyName,
		...(options.apiKey && options.apiKey !== "N/A" ? { [keyName]: options.apiKey } : {}),
		FRANK_DAEMON_WALL_SECS: String(options.budgets.wallSecs),
		FRANK_DAEMON_MAX_TOOL_CALLS: String(options.budgets.maxToolCalls),
		...(options.role ? { FRANK_PROFILES_ROOT: options.role.root, FRANK_PROFILE_ROLE: options.role.name, FRANK_PROFILE_SYSTEM: "off" } : {}),
		WEBFETCH_POLICY: "on",
	};
}

function runCli(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean; stdio?: "ignore" | "pipe" }) {
	return spawn(executable, args, { cwd: options.cwd, env: options.env, detached: options.detached, stdio: options.stdio ?? "pipe" });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", code => resolve(code));
	});
}

async function admitRun(options: DaemonOptions, env: NodeJS.ProcessEnv): Promise<void> {
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const args = ["daemon", "start", "--task", options.text, "--session", options.id, "--allow", "all", "--json"];
	const first = runCli(bin, args, { cwd: options.cwd, env, stdio: "ignore" });
	if (await waitForClose(first) === 0) return;
	const daemon = runCli(bin, ["__daemon-run"], { cwd: options.cwd, env, detached: true, stdio: "ignore" });
	daemon.unref();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const status = runCli(bin, ["daemon", "status"], { cwd: options.cwd, env, stdio: "ignore" });
		if (await waitForClose(status) === 0) break;
		await Bun.sleep(100);
	}
	if (Date.now() >= deadline) throw new Error("Frank daemon did not start");
	const retry = runCli(bin, args, { cwd: options.cwd, env, stdio: "ignore" });
	const retryCode = await waitForClose(retry);
	if (retryCode !== 0) throw new Error(`Frank daemon start failed with exit code ${retryCode}`);
}

export async function spawnFrankDaemonWorker(options: DaemonOptions): Promise<FrankWorkerResult> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("Frank worker aborted");
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const daemonDir = path.join(options.artifactsDir, `${options.id}.frank-daemon`);
	const eventsPath = options.eventsPath ?? path.join(options.artifactsDir, `${options.id}.frank.jsonl`);
	await mkdir(daemonDir, { recursive: true });
	const env = daemonEnvironment(options, daemonDir);
	await admitRun(options, env);
	const child = runCli(bin, ["attach", "--session", options.id, "--json"], { cwd: options.cwd, env });
	if (!child.stdout) throw new Error("Frank attach did not provide stdout");
	const events: FrankEvent[] = [];
	let envelopeText: string | undefined;
	let terminal: Extract<FrankControl, { kind: "terminal" }> | undefined;
	let chain = Promise.resolve();
	let streamError: Error | undefined;
	const output = createInterface({ input: child.stdout });
	output.on("line", line => {
		chain = chain.then(async () => {
			await appendFile(eventsPath, `${line}\n`);
			const parsed = parseAttachLine(line);
			if (parsed?.kind === "event") {
				const event = eventFromAttach(parsed);
				events.push(event);
				terminal = terminalResult(parsed.event) ?? terminal;
				await options.onEvent(event);
			} else if (parsed?.kind === "envelope") envelopeText = parsed.text;
		}).catch(error => { streamError = error instanceof Error ? error : new Error(String(error)); });
	});
	const abortListener = () => {
		const stop = runCli(bin, ["daemon", "stop", "--json"], { cwd: options.cwd, env, stdio: "ignore" });
		stop.once("error", () => {});
	};
	options.signal?.addEventListener("abort", abortListener, { once: true });
	const code = await waitForClose(child);
	options.signal?.removeEventListener("abort", abortListener);
	await chain;
	if (!terminal) throw new Error(`Frank daemon attach ended without TerminalDone (code ${code})`);
	const text = envelopeText ?? foldEventsToText(events);
	const exitCode = terminal.terminal === "Answer" ? 0 : 1;
	answerExitDecision(terminal.terminal, exitCode, text);
	return { terminal, exitCode, text };
}

export async function readFrankLaneResult(artifactsDir: string, id: string, options?: { cwd?: string; frankBin?: string }): Promise<FrankWorkerResult> {
	const eventsPath = path.join(artifactsDir, `${id}.frank.jsonl`);
	let contents = "";
	try { contents = await readFile(eventsPath, "utf8"); } catch (error) {
		if (!options?.cwd) throw error;
	}
	const events: FrankEvent[] = [];
	let envelopeText: string | undefined;
	let terminal: Extract<FrankControl, { kind: "terminal" }> | undefined;
	for (const line of contents.split(/\r?\n/)) {
		if (!line) continue;
		const parsed = parseAttachLine(line);
		if (parsed?.kind === "event") {
			const event = eventFromAttach(parsed);
			events.push(event);
			terminal = terminalResult(parsed.event) ?? terminal;
		} else if (parsed?.kind === "envelope") envelopeText = parsed.text;
	}
	if ((!terminal || !envelopeText) && options?.cwd) return attachFrankDaemonLane({ artifactsDir, id, cwd: options.cwd, frankBin: options.frankBin });
	if (!terminal) throw new Error(`Frank lane ${id} has no TerminalDone event`);
	const text = envelopeText ?? foldEventsToText(events);
	const decision = answerExitDecision(terminal.terminal, terminal.terminal === "Answer" ? 0 : 1, text);
	return { terminal, exitCode: decision.exitCode, text };
}

export async function attachFrankDaemonLane(options: { artifactsDir: string; id: string; cwd: string; frankBin?: string; env?: NodeJS.ProcessEnv }): Promise<FrankWorkerResult> {
	const daemonDir = path.join(options.artifactsDir, `${options.id}.frank-daemon`);
	const env = { ...process.env, ...options.env, FRANK_DAEMON_DIR: daemonDir };
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const child = runCli(bin, ["attach", "--session", options.id, "--json"], { cwd: options.cwd, env });
	if (!child.stdout) throw new Error("Frank attach did not provide stdout");
	const events: FrankEvent[] = [];
	let envelopeText: string | undefined;
	let terminal: Extract<FrankControl, { kind: "terminal" }> | undefined;
	const closed = waitForClose(child);
	const output = createInterface({ input: child.stdout });
	for await (const line of output) {
		const parsed = parseAttachLine(line);
		if (!parsed) continue;
		if (parsed.kind === "envelope") envelopeText = parsed.text;
		else {
			const event = eventFromAttach(parsed);
			events.push(event);
			terminal = terminalResult(parsed.event) ?? terminal;
			if (terminal) output.close();
		}
	}
	const code = await closed;
	await appendFile(path.join(options.artifactsDir, `${options.id}.frank.jsonl`), `${JSON.stringify({ details: envelopeText ?? foldEventsToText(events) })}\n`);
	if (code !== 0) throw new Error(`Frank attach failed with exit code ${code}`);
	if (!terminal) throw new Error(`Frank daemon attach ended without TerminalDone (code ${code})`);
	const text = envelopeText ?? foldEventsToText(events);
	const decision = answerExitDecision(terminal.terminal, terminal.terminal === "Answer" ? 0 : 1, text);
	return { terminal, exitCode: decision.exitCode, text };
}
