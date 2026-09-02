import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	BrokerBackedTransportAdapter,
	BrokerTransportServer,
	createMessageEnvelope,
	createSessionAddress,
} from "../src/bridge/index.js";

function addresses() {
	const destination = createSessionAddress({ namespace: "omp", host: "localhost", process: "receiver", backend: "pi", session: "session", generation: 1 });
	const source = createSessionAddress({ namespace: "omp", host: "localhost", process: "sender", backend: "pi", session: "session", generation: 1 });
	return { destination, source };
}

function envelope(sequence: number) {
	const { destination, source } = addresses();
	return createMessageEnvelope({
		id: `message-${sequence}`,
		source,
		destination,
		body: { kind: "payload", payload: { sequence } },
		sequence,
		idempotencyKey: `idempotency-${sequence}`,
		createdAt: Date.now(),
	});
}

	describe("BrokerTransportServer client lifecycle", () => {
		it("delivers through registered clients, removes disconnected registrations, and closes clients", async () => {
			const directory = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-transport-"));
			const socketPath = path.join(directory, "broker.sock");
			const server = new BrokerTransportServer({ socketPath, journalPath: path.join(directory, "journal.jsonl") });
			const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "receiver.jsonl") });
			const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "sender.jsonl") });
			const { destination } = addresses();
			const received: number[] = [];
			const firstDelivery = Promise.withResolvers<void>();

			let rawClient: net.Socket | undefined;
			let rawClientClosed: Promise<unknown> | undefined;

			try {
				await server.listen();
				rawClient = net.createConnection(socketPath);
				await once(rawClient, "connect");
				rawClientClosed = once(rawClient, "close").catch(() => undefined);
				await receiver.register(destination, message => {
					const payload = message.body.kind === "payload" ? message.body.payload : undefined;
					if (payload && typeof payload === "object" && payload !== null && "sequence" in payload && typeof payload.sequence === "number") {
						received.push(payload.sequence);
						if (payload.sequence === 1) firstDelivery.resolve();
					}
				});
				await sender.send(envelope(1));
				await firstDelivery.promise;

				await receiver.close();

				const replacement = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "replacement.jsonl") });
				const secondDelivery = Promise.withResolvers<void>();
				try {
					await replacement.register(destination, message => {
						const payload = message.body.kind === "payload" ? message.body.payload : undefined;
						if (payload && typeof payload === "object" && payload !== null && "sequence" in payload && typeof payload.sequence === "number") {
							received.push(payload.sequence);
							if (payload.sequence === 2) secondDelivery.resolve();
						}
					});
					await sender.send(envelope(2));
					await secondDelivery.promise;
					expect(received).toEqual([1, 2]);
				} finally {
					await replacement.close();
				}
			} finally {
				await sender.close();
				await server.close();
				await rawClientClosed;
				rawClient?.destroy();
				await rm(directory, { recursive: true, force: true });
			}
		});
	});

	describe("BrokerTransportServer unacked delivery retry", () => {
		it("redelivers a transiently rejected handler without reconnecting", async () => {
			const directory = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-retry-"));
			const socketPath = path.join(directory, "broker.sock");
			const server = new BrokerTransportServer({ socketPath, journalPath: path.join(directory, "broker.jsonl"), limits: { retryBaseMs: 10, retryMaxMs: 20, maxAttempts: 4 } });
			const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "receiver.jsonl") });
			const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "sender.jsonl") });
			const { destination } = addresses();
			let attempts = 0;
			const succeeded = Promise.withResolvers<void>();
			try {
				await server.listen();
				await receiver.register(destination, () => {
					attempts += 1;
					if (attempts === 2) succeeded.resolve();
					if (attempts === 1) return Promise.reject(new Error("transient"));
				});
				await sender.send(envelope(3));
				await Promise.race([succeeded.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redelivery timeout")), 500))]);
				expect(attempts).toBe(2);
			} finally {
				await sender.close();
				await receiver.close();
				await server.close();
				await rm(directory, { recursive: true, force: true });
			}
		});
	});

	it("keeps a successful final delivery out of the dead-letter journal", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-final-ack-"));
		const socketPath = path.join(directory, "broker.sock");
		const journalPath = path.join(directory, "broker.jsonl");
		const deadLetterPath = `${journalPath}.dead-letter.jsonl`;
		const server = new BrokerTransportServer({ socketPath, journalPath, limits: { retryBaseMs: 20, retryMaxMs: 20, maxAttempts: 3 } });
		const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "receiver.jsonl") });
		const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "sender.jsonl") });
		const { destination } = addresses();
		const thirdAttempt = Promise.withResolvers<void>();
		let count = 0;
		try {
			await server.listen();
			await receiver.register(destination, async () => {
				count += 1;
				if (count < 3) throw new Error("transient");
				// Integration timing is intentional: the final ACK must beat the retry deadline.
				await new Promise<void>(resolve => setTimeout(resolve, 5));
				thirdAttempt.resolve();
			});
			await sender.send(envelope(5));
			await Promise.race([thirdAttempt.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("final ACK timeout")), 500))]);
			await Promise.race([
				(async (): Promise<void> => {
					while ((await Bun.file(journalPath).text().catch(() => "")).trim() !== "") await new Promise<void>(resolve => setImmediate(resolve));
				})(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("journal clear timeout")), 500)),
			]);
			expect(count).toBe(3);
			expect(await Bun.file(deadLetterPath).exists()).toBe(false);
		} finally {
			await sender.close();
			await receiver.close();
			await server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("dead-letters a permanently rejected delivery after bounded attempts", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-dead-letter-"));
		const socketPath = path.join(directory, "broker.sock");
		const journalPath = path.join(directory, "broker.jsonl");
		const deadLetterPath = `${journalPath}.dead-letter.jsonl`;
		const server = new BrokerTransportServer({ socketPath, journalPath, limits: { retryBaseMs: 5, retryMaxMs: 5, maxAttempts: 3 } });
		const receiver = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "receiver.jsonl") });
		const sender = new BrokerBackedTransportAdapter({ socketPath, journalPath: path.join(directory, "sender.jsonl") });
		const { destination } = addresses();
		const attempts = Promise.withResolvers<void>();
		let count = 0;
		try {
			await server.listen();
			await receiver.register(destination, () => {
				count += 1;
				if (count === 3) attempts.resolve();
				return Promise.reject(new Error("permanent"));
			});
			await sender.send(envelope(4));
			await Promise.race([attempts.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dead-letter timeout")), 500))]);
			const persistence = (async (): Promise<void> => {
				while (!(await Bun.file(deadLetterPath).exists()) || await Bun.file(journalPath).exists()) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
			})();
			await Promise.race([persistence, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dead-letter persistence timeout")), 500))]);
			await receiver.close();
			const deadLetter = await Bun.file(deadLetterPath).text();
			expect(count).toBe(3);
			expect(deadLetter).toContain("maximum delivery attempts exceeded");
		} finally {
			await sender.close();
			await receiver.close();
			await server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
