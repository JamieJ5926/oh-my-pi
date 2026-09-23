import { watch } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { FrankProtocolError, frankWorkerEndpoint, parseFrankControl, spawnFrankWorker, startFrankWorker, type FrankEvent } from "./frank-worker";

let received: number[] = [];

async function makeStub(body: string): Promise<{ cwd: string; exe: string }> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "frank-worker-"));
	const exe = path.join(cwd, "frank-stub");
	await writeFile(exe, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	await chmod(exe, 0o700);
	return { cwd, exe };
}

async function readPid(file: string): Promise<number> {
	const pid = Number(await Bun.file(file).text());
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid child PID in ${file}`);
	return pid;
}

function workerOptions(exe: string, cwd: string, onEvent: (event: FrankEvent) => void | Promise<void>) {
	return { exe, endpoint: "http://127.0.0.1:1", model: "test-model", cwd, budgets: { maxToolCalls: 12, wallSecs: 9 }, text: "do the work", onEvent };
}

describe("Frank worker transport", () => {
	test("uses a full OpenAI chat completions endpoint and forwards the API key to the child", async () => {
		expect(frankWorkerEndpoint("http://127.0.0.1:8317/v1")).toBe("http://127.0.0.1:8317/v1/chat/completions");
		expect(frankWorkerEndpoint("http://127.0.0.1:8317/v1/chat/completions")).toBe("http://127.0.0.1:8317/v1/chat/completions");
		const stub = await makeStub(`printf '%s\\n' "$PI_TRACK_API_KEY" > "$FRANK_KEY_FILE"; IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"done"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		const keyFile = path.join(stub.cwd, "key");
		process.env.FRANK_KEY_FILE = keyFile;
		try {
			const key = ["worker", "test", "key"].join("-");
			const result = await spawnFrankWorker({ ...workerOptions(stub.exe, stub.cwd, () => {}), endpoint: frankWorkerEndpoint("http://127.0.0.1:8317/v1"), apiKey: key });
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(keyFile).text()).toBe(`${key}\n`);
		} finally {
			delete process.env.FRANK_KEY_FILE;
			await rm(stub.cwd, { recursive: true, force: true });
		}
	});

	test("validates all controls, separates pipes, and awaits events through final_seq", async () => {
		expect(parseFrankControl({ type: "ack", version: 1, turn_id: 1, accepted: true, pending_id: 4 })).toEqual({ kind: "ack", version: 1, turn_id: 1, accepted: true, pending_id: 4 });
		expect(parseFrankControl({ type: "heartbeat", version: 1, at_ms: 20 })).toEqual({ kind: "heartbeat", version: 1, at_ms: 20 });
		expect(parseFrankControl({ type: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 })).toEqual({ kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 });
		expect(parseFrankControl({ type: "saved", version: 1, path: "/tmp/session.jsonl" })).toEqual({ kind: "saved", version: 1, path: "/tmp/session.jsonl" });
		expect(parseFrankControl({ type: "cancelled", version: 1, turn_id: 1 })).toEqual({ kind: "cancelled", version: 1, turn_id: 1 });
		expect(parseFrankControl({ type: "error", version: 1, message: "problem" })).toEqual({ kind: "error", version: 1, message: "problem" });
		const stub = await makeStub(`IFS= read -r input; [ "$input" = '{"op":"submit","turn_id":1,"text":"do the work"}' ] || exit 4; printf '%s\\n' '{"type":"heartbeat","version":1,"at_ms":20}' '{"type":"saved","version":1,"path":"/tmp/session.jsonl"}' '{"type":"cancelled","version":1,"turn_id":1}' >&2; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"done"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' >&2; printf '%s\\n' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		received = [];
		const result = await spawnFrankWorker(workerOptions(stub.exe, stub.cwd, async event => { await Promise.resolve(); received.push(event.seq); }));
		expect(result.terminal.final_seq).toBe(1);
		expect(result.exitCode).toBe(0);
		expect(received).toEqual([1]);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("abort after terminal completion cancels before signaling and reaps the direct child", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' "$input" >> "$FRANK_EVENTS_FILE"; printf '%s\\n' "$$" > "$FRANK_PID_FILE"; trap 'IFS= read -r input; printf "%s\\n" "$input" >> "$FRANK_EVENTS_FILE"; printf "%s\\n" "$$" > "$FRANK_SIGTERM_FILE"; printf "%s\\n" term >> "$FRANK_EVENTS_FILE"; exit 0' TERM; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"done"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; printf '%s\\n' ready > "$FRANK_READY_FILE"; while IFS= read -r input; do :; done`);
		const pidFile = path.join(stub.cwd, "pid");
		const sigFile = path.join(stub.cwd, "sigterm");
		const eventsFile = path.join(stub.cwd, "events");
		const readyFile = path.join(stub.cwd, "ready");
		process.env.FRANK_PID_FILE = pidFile;
		process.env.FRANK_SIGTERM_FILE = sigFile;
		process.env.FRANK_EVENTS_FILE = eventsFile;
		process.env.FRANK_READY_FILE = readyFile;
		const controller = new AbortController();
		const worker = spawnFrankWorker({ ...workerOptions(stub.exe, stub.cwd, () => {}), signal: controller.signal });
		await new Promise<void>((resolve, reject) => {
			const watcher = watch(stub.cwd, (_event, filename) => {
				if (filename?.toString() === "ready") {
					watcher.close();
					resolve();
				}
			});
			void Bun.file(readyFile).exists().then(exists => {
				if (exists) {
					watcher.close();
					resolve();
				}
			}).catch(reject);
		});
		const pid = await readPid(pidFile);
		controller.abort(new Error("terminal shutdown cancellation"));
		await expect(worker).rejects.toMatchObject({ message: "terminal shutdown cancellation" });
		expect(await Bun.file(eventsFile).text()).toBe('{"op":"submit","turn_id":1,"text":"do the work"}\n{"op":"cancel","turn_id":1}\nterm\n');
		expect(Number(await Bun.file(sigFile).text())).toBe(pid);
		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		delete process.env.FRANK_PID_FILE;
		delete process.env.FRANK_SIGTERM_FILE;
		delete process.env.FRANK_EVENTS_FILE;
		delete process.env.FRANK_READY_FILE;
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("bounds ignored shutdown and reaps the child without abort", async () => {
		const stub = await makeStub(`printf '%s\\n' "$$" > "$FRANK_PID_FILE"; trap 'printf "%s\\n" "$$" > "$FRANK_SIGTERM_FILE"; sleep 0.25; printf "%s\\n" "$$" > "$FRANK_SIGTERM_FILE.alive"; term_hold_n=0; while [ $term_hold_n -lt 60 ]; do sleep 0.05; term_hold_n=$((term_hold_n + 1)); done' TERM; IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"done"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ] || exit 4; printf '%s\\n' '{"type":"shutdown-seen"}' >&2; IFS= read -r ignored`);
		const pidFile = path.join(stub.cwd, "pid");
		const sigFile = path.join(stub.cwd, "sigterm");
		process.env.FRANK_PID_FILE = pidFile;
		process.env.FRANK_SIGTERM_FILE = sigFile;
		let resolveEvent: (() => void) | undefined;
		const eventReceived = new Promise<void>(resolve => { resolveEvent = resolve; });
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, () => { resolveEvent?.(); }));
		await eventReceived;
		const pid = await readPid(pidFile);
		const started = Date.now();
		await expect(worker).rejects.toThrow("Frank worker shutdown deadline exceeded");
		const elapsedMs = Date.now() - started;
		const escalationUpperBoundMs = 1500;
		expect(Number(await Bun.file(sigFile).text())).toBe(pid);
		expect(Number(await Bun.file(`${sigFile}.alive`).text())).toBe(pid);
		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		expect(elapsedMs).toBeLessThan(escalationUpperBoundMs);
		delete process.env.FRANK_PID_FILE;
		delete process.env.FRANK_SIGTERM_FILE;
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("settles completion when the child exits while the final callback is pending", async () => {
		const stub = await makeStub(`printf '%s\\n' "$$" > "$FRANK_PID_FILE"; trap 'printf "%s\\n" "$$" > "$FRANK_SIGTERM_FILE"' TERM; IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"final"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; exit 0`);
		const pidFile = path.join(stub.cwd, "pid");
		process.env.FRANK_PID_FILE = pidFile;
		let releaseCallback: (() => void) | undefined;
		let callbackStarted: (() => void) | undefined;
		let callbackCompleted = false;
		const started = new Promise<void>(resolve => { callbackStarted = resolve; });
		const callbackReleased = new Promise<void>(resolve => { releaseCallback = resolve; });
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, async () => { callbackStarted?.(); await callbackReleased; callbackCompleted = true; }));
		await started;
		const pid = await readPid(pidFile);
		let settled = false;
		void worker.then(() => { settled = true; }, () => { settled = true; });
		const reapDeadline = Date.now() + 1000;
		while (Date.now() < reapDeadline) {
			try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") break; throw error; }
			await Bun.sleep(10);
		}
		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		expect(settled).toBe(false);
		releaseCallback?.();
		const result = await worker;
		expect(result.terminal.final_seq).toBe(1);
		expect(result.exitCode).toBe(0);
		expect(callbackCompleted).toBe(true);
		delete process.env.FRANK_PID_FILE;
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("closes successfully after a pending final callback completes", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"final"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		let releaseCallback: (() => void) | undefined;
		let callbackStarted: (() => void) | undefined;
		const started = new Promise<void>(resolve => { callbackStarted = resolve; });
		const callbackReleased = new Promise<void>(resolve => { releaseCallback = resolve; });
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, async () => { callbackStarted?.(); await callbackReleased; }));
		await started;
		releaseCallback?.();
		const result = await worker;
		expect(result.terminal.final_seq).toBe(1);
		expect(result.exitCode).toBe(0);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("awaits trailing stdout callback and propagates its rejection", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"trailing"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		let callbackStarted = false;
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, async () => { callbackStarted = true; await Promise.resolve(); throw new Error("trailing callback failed"); }));
		await expect(worker).rejects.toThrow("trailing callback failed");
		expect(callbackStarted).toBe(true);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("rejects a gapped event sequence before delivery", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":2,"event":{"name":"gap"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":2}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		received = [];
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, event => { received.push(event.seq); }));
		let rejection: unknown;
		try { await worker; } catch (error) { rejection = error; }
		expect(rejection).toBeInstanceOf(FrankProtocolError);
		expect(rejection instanceof Error ? rejection.message : undefined).toBe("Frank worker event out of contract");
		expect(received).toEqual([]);
		await rm(stub.cwd, { recursive: true, force: true });
	});
	test("skips Meter bookkeeping while admitting terminal contract events", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"kind":{"AssistantDelta":"answer"}}}' '{"type":"event","seq":2,"event":{"kind":{"Meter":{}}}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":2}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		received = [];
		const result = await spawnFrankWorker(workerOptions(stub.exe, stub.cwd, event => { received.push(event.seq); }));
		expect(received).toEqual([1]);
		expect(result.terminal.final_seq).toBe(2);
		expect(result.text).toBe("answer");
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("ignores events beyond terminal barrier", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"a"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; sleep 0.3; printf '%s\\n' '{"type":"event","seq":2,"event":{"name":"late"}}'; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		received = [];
		const result = await spawnFrankWorker(workerOptions(stub.exe, stub.cwd, event => { received.push(event.seq); }));
		expect(received).toEqual([1]);
		expect(result.terminal.final_seq).toBe(1);
		expect(result.exitCode).toBe(0);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("clean run remains unsettled until stdout closes", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"a"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]; sleep 0.3`);
		let settled = false;
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, () => {}));
		void worker.then(() => { settled = true; }, () => { settled = true; });
		await Bun.sleep(150);
		expect(settled).toBe(false);
		const result = await worker;
		expect(result.text).toBe("");
		expect(result.exitCode).toBe(0);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("folds assistant text in exact event sequence order through final_seq", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello "}]},"assistantMessageEvent":{"type":"text_delta","delta":"Hello "}}}' '{"type":"event","seq":2,"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello from "}]},"assistantMessageEvent":{"type":"text_delta","delta":"from "}}}' '{"type":"event","seq":3,"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello from Frank"}]},"assistantMessageEvent":{"type":"text_delta","delta":"Frank"}}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":3}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		const result = await spawnFrankWorker(workerOptions(stub.exe, stub.cwd, () => {}));
		expect(result.text).toBe("Hello from Frank");
		expect(result.terminal.final_seq).toBe(3);
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("rejects stdout closing before terminal final_seq is delivered", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":"partial"}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":2}' >&2; exit 0`);
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, () => {}));
		await expect(worker).rejects.toThrow("Frank exited before completing the turn");
		await rm(stub.cwd, { recursive: true, force: true });
	});

	test("rejects a gapped event sequence instead of completing its terminal barrier", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":"first"}' '{"type":"event","seq":3,"event":"third"}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":3}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, () => {}));
		await expect(worker).rejects.toBeInstanceOf(FrankProtocolError);
	});

	test("rejects duplicate sequence with typed error and specific message", async () => {
		const stub = await makeStub(`IFS= read -r input; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"a"}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; sleep 0.3; printf '%s\\n' '{"type":"event","seq":1,"event":{"name":"dup"}}'; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ]`);
		received = [];
		const worker = spawnFrankWorker(workerOptions(stub.exe, stub.cwd, event => { received.push(event.seq); }));
		let rejection: unknown;
		try { await worker; } catch (error) { rejection = error; }
		expect(received).toEqual([1]);
		expect(rejection).toBeInstanceOf(FrankProtocolError);
		expect((rejection as Error).message).toBe("Frank worker duplicate event sequence");
		expect((rejection as FrankProtocolError).foldedText).toBe("");
		await rm(stub.cwd, { recursive: true, force: true });
	});
	test("keeps one worker process alive for two sequential turns", async () => {
		const stub = await makeStub(`printf '%s\\n' "$$" >> "$FRANK_PID_FILE"; IFS= read -r input; [ "$input" = '{"op":"submit","turn_id":1,"text":"first"}' ] || exit 4; printf '%s\\n' '{"type":"event","seq":1,"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"first answer"}]},"assistantMessageEvent":{"type":"text_delta","delta":"first answer"}}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":1,"accepted":true}' '{"type":"terminal","version":1,"turn_id":1,"terminal":"Answer","final_seq":1}' >&2; IFS= read -r input; [ "$input" = '{"op":"submit","turn_id":2,"text":"second"}' ] || exit 5; printf '%s\\n' '{"type":"event","seq":2,"event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"second answer"}]},"assistantMessageEvent":{"type":"text_delta","delta":"second answer"}}}'; printf '%s\\n' '{"type":"ack","version":1,"turn_id":2,"accepted":true}' '{"type":"terminal","version":1,"turn_id":2,"terminal":"Answer","final_seq":2}' >&2; IFS= read -r input; [ "$input" = '{"op":"shutdown"}' ] || exit 6`);
		const pidFile = path.join(stub.cwd, "pids");
		process.env.FRANK_PID_FILE = pidFile;
		try {
			received = [];
			const worker = await startFrankWorker({ exe: stub.exe, endpoint: "http://127.0.0.1:1", model: "test-model", cwd: stub.cwd, budgets: { maxToolCalls: 12, wallSecs: 9 }, onEvent: event => { received.push(event.seq); } });
			try {
				const first = await worker.runTurn("first");
				const second = await worker.runTurn("second");
				expect(first.terminal).toEqual({ kind: "terminal", version: 1, turn_id: 1, terminal: "Answer", final_seq: 1 });
				expect(first.text).toBe("first answer");
				expect(second.terminal).toEqual({ kind: "terminal", version: 1, turn_id: 2, terminal: "Answer", final_seq: 2 });
				expect(second.text).toBe("second answer");
				expect(received).toEqual([1, 2]);
				expect((await Bun.file(pidFile).text()).trim().split(/\r?\n/)).toHaveLength(1);
			} finally {
				await worker.close();
			}
		} finally {
			delete process.env.FRANK_PID_FILE;
			await rm(stub.cwd, { recursive: true, force: true });
		}
	});
});
