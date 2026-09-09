// Regression test: cross-process sends journaled as "queued" forever when no
// daemon broker runs in the scope (idle roots never create a daemon client,
// so nothing spawns the broker hosting the bridge transport server).
// ensureProjectDaemonBroker (called from main.ts IRC init) must bring up a
// broker through which two adapters then deliver. Real broker subprocess via
// the worker spawn fallback, same as production.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	BrokerBackedTransportAdapter,
	createMessageEnvelope,
	createSessionAddress,
} from "../../src/bridge/index";
import { createDaemonBrokerClient, ensureProjectDaemonBroker } from "../../src/launch/client";
import { daemonBridgeTransportEndpoint } from "../../src/launch/paths";

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

describe("bridge broker ensure", () => {
	it("brings up the scope broker so a queued send delivers", async () => {
		using tempDir = TempDir.createSync("@omp-bridge-ensure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		const endpoint = daemonBridgeTransportEndpoint(projectDir, runtimeDir);

		// Mechanism receipt: with no broker, there is no bridge socket, and a
		// send through it stays queued with zero delivery attempts.
		expect(await pathExists(endpoint)).toBe(false);
		const strandedJournal = path.join(tempDir.path(), "stranded.jsonl");
		const stranded = new BrokerBackedTransportAdapter({ socketPath: endpoint, journalPath: strandedJournal });
		const destination = createSessionAddress({
			namespace: "omp",
			host: "localhost",
			process: "receiver",
			backend: "pi",
			session: "ensure",
			generation: 1,
		});
		const source = createSessionAddress({
			namespace: "omp",
			host: "localhost",
			process: "sender",
			backend: "pi",
			session: "ensure",
			generation: 1,
		});
		const strandedState = await stranded.send(
			createMessageEnvelope({
				id: "stranded",
				source,
				destination,
				body: { kind: "payload", payload: { id: "stranded" } },
				sequence: 1,
				idempotencyKey: "stranded",
				createdAt: Date.now(),
			}),
		);
		expect(strandedState.kind).toBe("queued");
		await stranded.close();

		// The repair: ensure the broker, then the same shape delivers.
		await ensureProjectDaemonBroker(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		expect(await pathExists(endpoint)).toBe(true);
		const receiver = new BrokerBackedTransportAdapter({
			socketPath: endpoint,
			journalPath: path.join(tempDir.path(), "receiver.jsonl"),
		});
		const sender = new BrokerBackedTransportAdapter({
			socketPath: endpoint,
			journalPath: path.join(tempDir.path(), "sender.jsonl"),
		});
		const delivered = Promise.withResolvers<void>();
		try {
			await receiver.register(destination, received => {
				if (received.id === "live") delivered.resolve();
			});
			const state = await sender.send(
				createMessageEnvelope({
					id: "live",
					source,
					destination,
					body: { kind: "payload", payload: { id: "live" } },
					sequence: 1,
					idempotencyKey: "live",
					createdAt: Date.now(),
				}),
			);
			expect(["queued", "delivered"]).toContain(state.kind);
			await Promise.race([
				delivered.promise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timed out waiting for bridge delivery")), 10_000),
				),
			]);
		} finally {
			await Promise.all([sender.close(), receiver.close()]);
			const shutdownClient = await createDaemonBrokerClient(projectDir, { runtimeDir });
			try {
				await shutdownClient.request({ op: "shutdown" });
			} finally {
				shutdownClient.close();
			}
		}
	}, 60_000);
});
