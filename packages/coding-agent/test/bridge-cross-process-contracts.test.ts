import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import {
	BrokerBackedTransportAdapter,
	BrokerTransportServer,
	createMessageEnvelope,
	createSessionAddress,
	type MessageEnvelope,
} from "../src/bridge/index.js";

function makeAddress(process: string, generation = 1) {
	return createSessionAddress({ namespace: "omp", host: "localhost", process, backend: "pi", session: "cross", generation });
}

function makeEnvelope(id: string, destination = makeAddress("receiver"), idempotencyKey = id): MessageEnvelope {
	return createMessageEnvelope({
		id,
		source: makeAddress("sender"),
		destination,
		body: { kind: "payload", payload: { id } },
		sequence: 1,
		idempotencyKey,
		createdAt: Date.now(),
	});
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for bridge delivery");
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!(await check())) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for bridge state");
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

function payloadId(message: MessageEnvelope): string | undefined {
	if (message.body.kind !== "payload" || typeof message.body.payload !== "object" || message.body.payload === null) return undefined;
	const payload = message.body.payload;
	return "id" in payload && typeof payload.id === "string" ? payload.id : undefined;
}

describe("bridge cross-process transport contracts", () => {
	it("delivers through the broker, ACKs, deduplicates, and isolates owned registrations", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-contract-"));
		const socketPath = path.join(dir, "broker.sock");
		const server = new BrokerTransportServer({ socketPath, journalPath: path.join(dir, "broker.jsonl") });
		const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(dir, "sender.jsonl") });
		const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(dir, "receiver.jsonl") });
		const other = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(dir, "other.jsonl") });
		const received: string[] = [];
		try {
			await server.listen();
			await receiver.register(makeAddress("receiver"), message => {
				const id = payloadId(message);
				if (id) received.push(id);
			});
			const first = makeEnvelope("one");
			const firstState = await sender.send(first);
			const duplicateState = await sender.send(makeEnvelope("two", makeAddress("receiver"), first.idempotencyKey));
			expect(["queued", "delivered"]).toContain(firstState.kind);
			expect(["queued", "delivered"]).toContain(duplicateState.kind);
			await waitFor(() => received.length >= 1);
			expect(received).toEqual(["one"]);
			await expect(other.register(makeAddress("receiver"), () => undefined)).resolves.toBeUndefined();
			await sender.send(makeEnvelope("three"));
			await waitFor(() => received.includes("three"));
			expect(received).toContain("three");
		} finally {
			await Promise.all([sender.close(), receiver.close(), other.close(), server.close()]);
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("queues offline, drains after registration, rejects stale generations, and enforces bounds", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-contract-"));
		const socketPath = path.join(dir, "broker.sock");
		const senderJournal = path.join(dir, "sender.jsonl");
		const limits = { maxEnvelopeBytes: 512, maxJournalBytes: 10_000, retryBaseMs: 10 };
		const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: senderJournal, limits });
		const server = new BrokerTransportServer({ socketPath, journalPath: path.join(dir, "broker.jsonl"), limits });
		const received: string[] = [];
		try {
			await server.listen();
			const offlineEnvelope = makeEnvelope("offline");
			const staleEnvelope = makeEnvelope("stale", makeAddress("receiver", 2));
			const hugeEnvelope = createMessageEnvelope({ ...makeEnvelope("huge"), body: { kind: "payload", payload: "x".repeat(2_000) } });
			const ordinaryBytes = Buffer.byteLength(JSON.stringify(offlineEnvelope), "utf8");
			const staleBytes = Buffer.byteLength(JSON.stringify(staleEnvelope), "utf8");
			const hugeBytes = Buffer.byteLength(JSON.stringify(hugeEnvelope), "utf8");
			expect(ordinaryBytes).toBeLessThanOrEqual(limits.maxEnvelopeBytes);
			expect(staleBytes).toBeLessThanOrEqual(limits.maxEnvelopeBytes);
			expect(hugeBytes).toBeGreaterThan(limits.maxEnvelopeBytes);
			const offline = await sender.send(offlineEnvelope);
			expect(offline.kind).toBe("queued");
			const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(dir, "receiver.jsonl") });
			try {
				await receiver.register(makeAddress("receiver"), message => {
					const id = payloadId(message);
					if (id) received.push(id);
				});
				await waitFor(() => received.includes("offline"));
				const stale = await sender.send(staleEnvelope);
				expect(stale.kind).toBe("queued");
				await waitForAsync(async () => {
					const journal = Bun.file(senderJournal);
					return !(await journal.exists()) || (await journal.text()).trim() === "";
				});
				expect(await Bun.file(senderJournal).exists()).toBe(false);
				expect(received).not.toContain("stale");
				expect((await sender.send(hugeEnvelope)).kind).toBe("backpressure");
			} finally {
				await receiver.close();
			}
		} finally {
			await sender.close();
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

  it("persists a sender-before-broker queue across spawned processes and receiver restart", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-process-smoke-"));
		const socketPath = path.join(dir, "broker.sock");
		const senderJournal = path.join(dir, "sender.jsonl");
		const brokerJournal = path.join(dir, "broker.jsonl");
		const brokerReadyMarker = path.join(dir, "broker-ready");
		const queuedMarker = path.join(dir, "queued");
		const readyMarker = path.join(dir, "receiver-ready");
		const deliveredMarker = path.join(dir, "delivered");
		const sourceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/bridge/index.ts")).href;
		const child = (mode: "sender" | "receiver", hold = false) => {
			const script = `
				import { BrokerBackedTransportAdapter, createMessageEnvelope, createSessionAddress } from ${JSON.stringify(sourceUrl)};
				import { writeFile } from "node:fs/promises";
				const mode = ${JSON.stringify(mode)};
				const hold = ${JSON.stringify(hold)};
				const socketPath = ${JSON.stringify(socketPath)};
				const senderJournal = ${JSON.stringify(senderJournal)};
				const queuedMarker = ${JSON.stringify(queuedMarker)};
				const readyMarker = ${JSON.stringify(readyMarker)};
				const deliveredMarker = ${JSON.stringify(deliveredMarker)};
				const address = createSessionAddress({ namespace: "omp", host: "localhost", process: "receiver", backend: "pi", session: "cross", generation: 1 });
				if (mode === "sender") {
					const transport = new BrokerBackedTransportAdapter({ socketPath, journalPath: senderJournal, limits: { maxEnvelopeBytes: 512, retryBaseMs: 10 } });
					if (!(await Bun.file(queuedMarker).exists())) {
						const envelope = createMessageEnvelope({ id: "process-offline", source: createSessionAddress({ namespace: "omp", host: "localhost", process: "sender", backend: "pi", session: "cross", generation: 1 }), destination: address, body: { kind: "payload", payload: { id: "process-offline" } }, sequence: 1, idempotencyKey: "process-offline", createdAt: Date.now() });
						const state = await transport.send(envelope);
						if (state.kind !== "queued") throw new Error(\`expected queued, got \${state.kind}\`);
						await writeFile(queuedMarker, "queued");
					}
					if (hold) while ((await Bun.file(deliveredMarker).text().catch(() => "")) !== "delivered") await new Promise<void>(resolve => setImmediate(resolve));
					await transport.close();
					process.exit(0);
				}
				const transport = new BrokerBackedTransportAdapter({ socketPath, journalPath: hold ? senderJournal.replace("sender.jsonl", "receiver-hold.jsonl") : senderJournal.replace("sender.jsonl", "receiver-restart.jsonl") });
				const delivered = Promise.withResolvers<void>();
				await transport.register(address, async () => {
					if (hold) await new Promise<void>(() => undefined);
					await writeFile(deliveredMarker, "delivered");
					delivered.resolve();
				});
				await writeFile(readyMarker, hold ? "hold" : "restart");
				if (hold) await new Promise<void>(() => undefined);
				else {
					await delivered.promise;
					await transport.close();
				}
			`;
			return Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
		};
		let sender: ReturnType<typeof child> | undefined;
		let receiver: ReturnType<typeof child> | undefined;
		let replacement: ReturnType<typeof child> | undefined;
		let server: ReturnType<typeof child> | undefined;
		try {
			sender = child("sender");
			await waitForAsync(async () => (await Bun.file(queuedMarker).text().catch(() => "")) === "queued");
			expect(await sender.exited).toBe(0);
			server = Bun.spawn([
				process.execPath,
				"--eval",
				`import { BrokerTransportServer } from ${JSON.stringify(sourceUrl)}; import { writeFile } from "node:fs/promises"; const server = new BrokerTransportServer({ socketPath: ${JSON.stringify(socketPath)}, journalPath: ${JSON.stringify(brokerJournal)}, limits: { maxEnvelopeBytes: 512, maxJournalBytes: 10_000 } }); await server.listen(); await writeFile(${JSON.stringify(brokerReadyMarker)}, "ready"); await new Promise(() => undefined);`,
			],
				{ stdout: "pipe", stderr: "pipe" },
			);
			await waitForAsync(async () => (await Bun.file(brokerReadyMarker).text().catch(() => "")) === "ready");
			receiver = child("receiver", true);
			await waitForAsync(async () => (await Bun.file(readyMarker).text().catch(() => "")) === "hold");
			receiver.kill();
			expect(await receiver.exited).not.toBe(0);
			replacement = child("receiver");
			sender = child("sender", true);
			await waitForAsync(async () => (await Bun.file(deliveredMarker).text().catch(() => "")) === "delivered");
			expect(await Bun.file(deliveredMarker).text()).toBe("delivered");
			expect(await replacement.exited).toBe(0);
		} finally {
			sender?.kill();
			receiver?.kill();
			replacement?.kill();
			server?.kill();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
