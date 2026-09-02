// Integration test — real timers are required (ts-no-test-timers exception): this drives the actual
// cross-process daemon broker running a real child process, and the bug is a missing idle-shutdown
// rearm in #settle. Fake timers cannot control the OS process-exit promise or the unix-socket RPC,
// and shutdown is observed by awaiting the broker's own run() promise — its resolution IS the signal
// (no polling, no fixed sleep). A regression leaves the broker alive, so the test's own timeout
// surfaces the failure.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BrokerBackedTransportAdapter,
	createMessageEnvelope,
	createSessionAddress,
} from "../../src/bridge/index";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBridgeTransportEndpoint } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function waitForAsync(check: () => Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

function bridgeAddress(processName: string, session: string) {
	return createSessionAddress({
		namespace: "omp",
		host: "localhost",
		process: processName,
		backend: "pi",
		session,
		generation: 1,
	});
}

async function exerciseBridge(endpoint: string, directory: string, session: string): Promise<void> {
	const destination = bridgeAddress("receiver", session);
	const source = bridgeAddress("sender", session);
	const receiverJournal = path.join(directory, `${session}-receiver.jsonl`);
	const senderJournal = path.join(directory, `${session}-sender.jsonl`);
	const receiver = new BrokerBackedTransportAdapter({ socketPath: endpoint, journalPath: receiverJournal });
	const sender = new BrokerBackedTransportAdapter({ socketPath: endpoint, journalPath: senderJournal });
	const message = createMessageEnvelope({
		id: `${session}-message`,
		source,
		destination,
		body: { kind: "payload", payload: { session } },
		sequence: 1,
		idempotencyKey: `${session}-message`,
		createdAt: Date.now(),
	});
	const delivered = Promise.withResolvers<void>();
	try {
		await receiver.register(destination, received => {
			if (received.id === message.id) delivered.resolve();
		});
		const state = await sender.send(message);
		expect(["queued", "delivered"]).toContain(state.kind);
		await Promise.race([
			delivered.promise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for bridge delivery")), 5_000)),
		]);
	} finally {
		await Promise.all([sender.close(), receiver.close()]);
	}
}

function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

describe("daemon broker idle shutdown", () => {
	it("shuts down after its last persistent daemon exits with no clients", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

 
		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 100 });
		const broker = startBroker(projectDir, runtimeDir, 100);
		try {
			// A persistent daemon that outlives the first idle-shutdown timer (100ms) and then
			// self-exits (~300ms). restart:"no" so its exit is terminal.
			const started = await client.request({
				op: "start",
				spec: {
					name: "persistent-temp",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 300)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			// Disconnect the final client. The broker keeps the persistent daemon alive, so the
			// idle timer this arms fires while the daemon is still live and returns without rearming.
			client.close();

			// When the daemon self-exits, terminal settlement must rearm idle shutdown; the broker
			// then releases its lease and run() resolves. Awaiting the broker promise IS the shutdown
			// signal. Before the fix nothing rearmed, so this await never resolved and the test timed
			// out — the regression this guards.
			await broker;
		} finally {
			process.title = previousTitle;
		}
	}, 30_000);

	it("starts a usable bridge, removes it on shutdown, rebinds on restart, and tolerates repeated shutdown", async () => {
		using tempDir = TempDir.createSync("@omp-launch-bridge-lifecycle-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const endpoint = daemonBridgeTransportEndpoint(projectDir, runtimeDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir, 5_000);
		try {
			await client.request({ op: "ping" });
			await waitForAsync(() => pathExists(endpoint), "bridge transport endpoint");
			await exerciseBridge(endpoint, tempDir.path(), "first");
			const firstShutdowns = await Promise.all([client.request({ op: "shutdown" }), client.request({ op: "shutdown" })]);
			expect(firstShutdowns.map(result => result.op)).toEqual(["shutdown", "shutdown"]);
			await firstBroker;
			expect(await pathExists(endpoint)).toBe(false);
			client.close();

			const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const secondBroker = startBroker(projectDir, runtimeDir, 5_000);
			try {
				await secondClient.request({ op: "ping" });
				await waitForAsync(() => pathExists(endpoint), "rebound bridge transport endpoint");
				await exerciseBridge(endpoint, tempDir.path(), "second");
				const secondShutdowns = await Promise.all([secondClient.request({ op: "shutdown" }), secondClient.request({ op: "shutdown" })]);
				expect(secondShutdowns.map(result => result.op)).toEqual(["shutdown", "shutdown"]);
				await secondBroker;
				expect(await pathExists(endpoint)).toBe(false);
			} finally {
				secondClient.close();
			}
		} finally {
			client.close();
			await firstBroker.catch(() => undefined);
		}
	}, 30_000);
});
