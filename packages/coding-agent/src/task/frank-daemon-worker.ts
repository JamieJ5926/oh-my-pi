import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { answerExitDecision, foldEventsToText } from "./frank-worker-fold";
import type { FrankControl, FrankEvent, FrankToolRequest, FrankToolResult, FrankWorkerResult, StartFrankWorkerOptions } from "./frank-worker";

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
function parseHostToolRequest(line: string): FrankToolRequest | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.type !== "tool_request" || value.version !== 1) return undefined;
		if (typeof value.call_id !== "number" || typeof value.turn_id !== "number" || typeof value.name !== "string" || !value.name || !("args" in value)) return undefined;
		return { call_id: value.call_id, turn_id: value.turn_id, name: value.name, args: value.args };
	} catch {
		return undefined;
	}
}


function writeHostToolResult(stream: NodeJS.WritableStream, callId: number, result: FrankToolResult): Promise<void> {
	const response = result.ok
		? { op: "tool_result", call_id: callId, ok: true, content: result.content ?? "" }
		: { op: "tool_result", call_id: callId, ok: false, error: result.error ?? "host tool failed" };
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	stream.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve());
	return promise;
}


function daemonEnvironment(options: DaemonOptions, daemonDir: string): NodeJS.ProcessEnv {
	const keyName = options.apiKeyEnv ?? "PI_TRACK_API_KEY";
	return {
		...process.env,
		FRANK_DAEMON_DIR: daemonDir,
		FRANK_DAEMON_ENDPOINT: options.endpoint,
		FRANK_DAEMON_MODEL: options.model,
		FRANK_DAEMON_KEY_ENV: keyName,
		FRANK_DAEMON_TOOL_CHOICE: "auto",
		FRANK_DAEMON_READ_ROOT: "any",
		...(options.hostTools?.length ? { FRANK_DAEMON_HOST_TOOLS: options.hostTools.join(",") } : {}),
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

function daemonSessionKey(artifactsDir: string, id: string): string {
	return createHash("sha1").update(`${artifactsDir}:${id}`).digest("hex").slice(0, 16);
}

export function daemonStateDir(): string {
	const override = process.env.FRANK_DAEMON_STATE_DIR?.trim();
	if (override) return override;
	return path.join("/tmp", "omp-frank-daemon", "host");
}

async function frankClientVersion(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const child = runCli(bin, ["--version"], { cwd, env });
	let stdout = "";
	child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
	try {
		const code = await waitForClose(child);
		if (code !== 0) return undefined;
		const version = stdout.trim();
		return version ? version : undefined;
	} catch {
		return undefined;
	}
}

function statusHasRunningSessions(stdout: string): boolean {
	const text = stdout.trim();
	if (!text) return false;
	try {
		const value: unknown = JSON.parse(text);
		if (Array.isArray(value)) return value.length > 0;
		if (isRecord(value)) {
			for (const key of ["sessions", "runs", "tasks", "jobs", "lanes"]) {
				if (Array.isArray(value[key])) return (value[key] as unknown[]).length > 0;
			}
			for (const key of ["running", "active", "session_count", "sessionCount"]) {
				if (typeof value[key] === "number") return (value[key] as number) > 0;
			}
		}
		return false;
	} catch {
		return false;
	}
}

async function ensureDaemonVersion(bin: string, cwd: string, env: NodeJS.ProcessEnv, stateDir: string, logPath: string): Promise<string | undefined> {
	const clientVersion = await frankClientVersion(bin, cwd, env);
	if (!clientVersion) return undefined;
	const versionFile = path.join(stateDir, "daemon-version");
	let recorded = "";
	try { recorded = (await readFile(versionFile, "utf8")).trim(); } catch { recorded = ""; }
	if (!recorded || recorded === clientVersion) return clientVersion;
	const probe = runCli(bin, ["daemon", "status", "--json"], { cwd, env });
	let statusOut = "";
	probe.stdout?.on("data", chunk => { statusOut += chunk.toString(); });
	try { await waitForClose(probe); } catch {}
	await appendFile(logPath, `[daemon-status] ${statusOut}`);
	if (statusHasRunningSessions(statusOut)) throw new Error(`Frank daemon version mismatch: daemon is ${recorded} but client is ${clientVersion} with running sessions; drain or stop the daemon before retrying`);
	await runLoggedCli(bin, ["daemon", "stop"], { cwd, env, logPath });
	try { await writeFile(versionFile, ""); } catch {}
	return clientVersion;
}


async function runLoggedCli(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; detached?: boolean }): Promise<number | null> {
	if (options.detached) {
		const child = runCli(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: "ignore" });
		child.unref();
		return null;
	}
	const child = runCli(executable, args, { cwd: options.cwd, env: options.env, detached: false });
	const writes: Promise<void>[] = [];
	for (const [stream, label] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
		stream?.on("data", chunk => { writes.push(appendFile(options.logPath, `[${label}] ${chunk.toString()}`)); });
	}
	const code = await waitForClose(child);
	await Promise.all(writes);
	return code;
}

async function admitRun(options: DaemonOptions, env: NodeJS.ProcessEnv, stateDir: string): Promise<void> {
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const logPath = path.join(stateDir, "cli.log");
	const startedVersion = await ensureDaemonVersion(bin, options.cwd, env, stateDir, logPath);
	const args = ["daemon", "start", "--task", options.text, "--session", daemonSessionKey(options.artifactsDir, options.id), "--allow", "all", "--key-env", options.apiKeyEnv ?? "PI_TRACK_API_KEY", "--cwd", options.cwd, "--endpoint", options.endpoint, "--model", options.model, "--max-tool-calls", String(options.budgets.maxToolCalls), "--wall-secs", String(options.budgets.wallSecs), ...(options.role ? ["--profile", options.role.name] : []), "--json"];
	const recordVersion = async () => {
		const version = startedVersion ?? await frankClientVersion(bin, options.cwd, env);
		if (version) await writeFile(path.join(stateDir, "daemon-version"), `${version}\n`);
	};
	const startCode = await runLoggedCli(bin, args, { cwd: options.cwd, env, logPath });
	if (startCode === 0) { await recordVersion(); return; }
	const existingStatus = await runLoggedCli(bin, ["daemon", "status"], { cwd: options.cwd, env, logPath });
	if (existingStatus === 0) throw new Error(`Frank daemon rejected run admission (exit code ${startCode}); see ${logPath}`);
	await runLoggedCli(bin, ["__daemon-run"], { cwd: options.cwd, env, logPath, detached: true });
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const status = await runLoggedCli(bin, ["daemon", "status"], { cwd: options.cwd, env, logPath });
		if (status === 0) break;
		await Bun.sleep(250);
	}
	if (Date.now() >= deadline) throw new Error(`Frank daemon did not start; see ${logPath}`);
	await recordVersion();
	const retry = await runLoggedCli(bin, args, { cwd: options.cwd, env, logPath });
	if (retry !== 0) throw new Error(`Frank daemon start failed with exit code ${retry}; see ${logPath}`);
}

export type DaemonWorkerAdmitOptions = Pick<DaemonOptions, "text" | "artifactsDir" | "id">;

export interface DaemonLaneHandle {
	artifactsDir: string;
	id: string;
}

/** Snapshot a daemon lane's routing so dispose can export it after the run settles. */
export function daemonLaneHandle(options: DaemonWorkerAdmitOptions): DaemonLaneHandle {
	return { artifactsDir: options.artifactsDir, id: options.id };
}

/**
 * Omp is exiting with a daemon lane still mid-turn: export the live
 * transcript mirror (`<id>.frank.jsonl`, already complete through
 * TerminalDone) to `<id>.frank-session.jsonl`. The shared daemon is never
 * stopped — sibling lanes keep running — so this is a file copy, not a
 * session teardown.
 */
export async function exportDaemonLaneSession(handle: DaemonLaneHandle): Promise<string> {
	const eventsPath = path.join(handle.artifactsDir, `${handle.id}.frank.jsonl`);
	const savePath = path.join(handle.artifactsDir, `${handle.id}.frank-session.jsonl`);
	const contents = await readFile(eventsPath, "utf8");
	await writeFile(savePath, contents.endsWith("\n") ? contents : `${contents}\n`);
	return savePath;
}

export async function spawnFrankDaemonWorker(options: DaemonOptions): Promise<FrankWorkerResult> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("Frank worker aborted");
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const daemonDir = path.join(options.artifactsDir, `${options.id}.frank-daemon`);
	const sessionKey = daemonSessionKey(options.artifactsDir, options.id);
	const stateDir = daemonStateDir();
	const eventsPath = options.eventsPath ?? path.join(options.artifactsDir, `${options.id}.frank.jsonl`);
	await mkdir(daemonDir, { recursive: true });
	await mkdir(stateDir, { recursive: true });
	await writeFile(path.join(daemonDir, "state-dir"), `${stateDir}\n`);
	await writeFile(path.join(daemonDir, "session-key"), `${sessionKey}\n`);
	const env = daemonEnvironment(options, stateDir);
	const abortListener = () => {
		const stop = runCli(bin, ["cancel", "--session", sessionKey, "--json"], { cwd: options.cwd, env, stdio: "ignore" });
		stop.once("error", () => {});
	};
	options.signal?.addEventListener("abort", abortListener, { once: true });
	try {
		await admitRun(options, env, stateDir);
		if (options.signal?.aborted) {
			const stop = runCli(bin, ["cancel", "--session", sessionKey, "--json"], { cwd: options.cwd, env, stdio: "ignore" });
			stop.once("error", () => {});
			throw options.signal.reason ?? new Error("Frank worker aborted");
		}
		const child = runCli(bin, ["attach", "--session", sessionKey, "--json"], { cwd: options.cwd, env });
		if (!child.stdout) throw new Error("Frank attach did not provide stdout");
		const events: FrankEvent[] = [];
		let envelopeText: string | undefined;
		let terminal: Extract<FrankControl, { kind: "terminal" }> | undefined;
		let chain = Promise.resolve();
		let streamError: Error | undefined;
		const output = createInterface({ input: child.stdout });
		output.on("line", line => {
			chain = chain.then(async () => {
				const toolRequest = parseHostToolRequest(line);
				if (toolRequest) {
					const result = options.onToolRequest ? await options.onToolRequest(toolRequest) : { ok: false, error: "host tools are not enabled for this worker" };
					if (child.stdin) await writeHostToolResult(child.stdin, toolRequest.call_id, result);
					return;
				}
				// The mirror is complete only when its writer sees TerminalDone; post-crash recovery attaches to the live daemon.
				await appendFile(eventsPath, `${line}\n`);
				const parsed = parseAttachLine(line);
				if (parsed?.kind === "event") {
					const event = eventFromAttach(parsed);
					events.push(event);
					terminal = terminalResult(parsed.event) ?? terminal;
					await options.onEvent(event);
					options.onMeter?.(event);
				} else if (parsed?.kind === "envelope") envelopeText = parsed.text;
			}).catch(error => { streamError = error instanceof Error ? error : new Error(String(error)); });
		});
		const code = await waitForClose(child);
		await chain;
		if (streamError) throw streamError;
		if (!terminal) throw new Error(`Frank daemon attach ended without TerminalDone (code ${code})`);
		const text = envelopeText ?? foldEventsToText(events);
		const exitCode = terminal.terminal === "Answer" ? 0 : 1;
		answerExitDecision(terminal.terminal, exitCode, text);
		return { terminal, exitCode, text };
	} finally {
		options.signal?.removeEventListener("abort", abortListener);
	}
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
	const markerDir = path.join(options.artifactsDir, `${options.id}.frank-daemon`);
	let stateDir = daemonStateDir();
	try { stateDir = (await readFile(path.join(markerDir, "state-dir"), "utf8")).trim() || stateDir; } catch {}
	let sessionKey: string;
	try { sessionKey = (await readFile(path.join(markerDir, "session-key"), "utf8")).trim() || daemonSessionKey(options.artifactsDir, options.id); } catch (error) { sessionKey = error instanceof Error && "code" in error && error.code === "ENOENT" ? options.id : daemonSessionKey(options.artifactsDir, options.id); }
	const env = { ...process.env, ...options.env, FRANK_DAEMON_DIR: stateDir };
	const bin = options.frankBin ?? process.env.FRANK_BIN?.trim() ?? "frank";
	const child = runCli(bin, ["attach", "--session", sessionKey, "--json"], { cwd: options.cwd, env });
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
			// Mirror recovery is complete only while the original writer saw TerminalDone; this reattach reads the live daemon.
			await appendFile(path.join(options.artifactsDir, `${options.id}.frank.jsonl`), `${JSON.stringify(parsed)}\n`);
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
