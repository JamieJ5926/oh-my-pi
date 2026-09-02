import { describe, expect, it, setSystemTime, vi } from "bun:test";
import {
	FileSessionDirectory,
	InMemorySessionDirectory,
	createMessageEnvelope,
	createSessionAddress,
	formatSessionAddress,
	parseMessageEnvelope,
	parseSessionAddress,
	sameSessionIdentity,
	transitionEnvelope,
	type MessageEnvelope,
} from "../src/bridge/index.js";

function address(process: string, generation = 1) {
	return createSessionAddress({ namespace: "omp", host: "localhost", process, backend: "pi", session: "contract", generation });
}

function envelope(generation = 1): MessageEnvelope {
	return createMessageEnvelope({ id: `core-${generation}`, source: address("sender"), destination: address("receiver", generation), body: { kind: "payload", payload: { ok: true } }, sequence: generation, idempotencyKey: `core-key-${generation}`, createdAt: 1 });
}

describe("bridge core contracts", () => {
	it("round-trips canonical addresses and rejects malformed input", () => {
		const original = address("worker", 7);
		const parsed = parseSessionAddress(formatSessionAddress(original));
		expect(parsed).toEqual(original);
		expect(sameSessionIdentity(parsed, address("worker", 1))).toBe(true);
		expect(() => parseSessionAddress("omp://localhost/worker/pi/contract#0")).toThrow();
		expect(() => parseSessionAddress("omp://localhost/worker/pi/contract with spaces#1")).toThrow();
		expect(() => parseSessionAddress({ namespace: "omp", host: "localhost", process: "worker", backend: "pi", session: "contract", generation: 1.5 })).toThrow();
	});

	it("enforces envelope delivery transitions and preserves parsed payloads", () => {
		const created = envelope();
		const queued = transitionEnvelope(created, { kind: "queued" });
		const delivered = transitionEnvelope(queued, { kind: "delivered", deliveredAt: 2 });
		const acknowledged = transitionEnvelope(delivered, { kind: "acknowledged", acknowledgedAt: 3 });
		expect(parseMessageEnvelope(acknowledged)).toEqual(acknowledged);
		expect(() => transitionEnvelope(created, { kind: "delivered", deliveredAt: 2 })).toThrow("Illegal delivery transition");
		expect(() => transitionEnvelope(acknowledged, { kind: "queued" })).toThrow("Illegal delivery transition");
		expect(() => parseMessageEnvelope({ ...created, version: 99 })).toThrow("Unsupported message envelope version");
	});

	it("keeps directory registration, generation CAS, tombstones, and expiry distinct", async () => {
		const directory = new InMemorySessionDirectory();
		const first = address("directory", 1);
		const second = address("directory", 2);
		const registered = await directory.register({ address: first, ttlMs: 10_000, revival: { backend: "pi", session: "native" } });
		expect(registered.ok).toBe(true);
		if (!registered.ok) return;
		const occupied = await directory.register({ address: first, ttlMs: 10_000 });
		expect(occupied.ok).toBe(false);
		if (occupied.ok) return;
		expect(occupied.reason).toBe("occupied");
		const conflict = await directory.heartbeat(second, 10_000);
		expect(conflict.ok).toBe(false);
		if (conflict.ok) return;
		expect(conflict.reason).toBe("generation-conflict");
		const replacement = { ...registered.record, address: second, lastHeartbeatAt: Date.now(), expiresAt: Date.now() + 10_000 };
		expect((await directory.compareAndSwap(first, 1, replacement)).ok).toBe(true);
		const staleHeartbeat = await directory.heartbeat(first, 10_000);
		expect(staleHeartbeat.ok).toBe(false);
		if (staleHeartbeat.ok) return;
		expect(staleHeartbeat.reason).toBe("generation-conflict");
		const tombstoned = await directory.tombstone(second, "contract complete");
		expect(tombstoned.ok).toBe(true);
		const alreadyTombstoned = await directory.tombstone(second, "again");
		expect(alreadyTombstoned.ok).toBe(false);
		if (alreadyTombstoned.ok) return;
		expect(alreadyTombstoned.reason).toBe("already-tombstoned");
		const expired = address("expired", 1);
		await directory.register({ address: expired, ttlMs: 1 });
		expect(await directory.purgeExpired(Date.now() + 2)).toBe(1);
		expect(await directory.lookup(expired)).toBeNull();
	});

	it("rejects expired heartbeats without reviving memory or file leases", async () => {
		const path = `/tmp/bridge-core-heartbeat-${crypto.randomUUID()}.json`;
		const directories = [new InMemorySessionDirectory(), new FileSessionDirectory(path)];
		vi.useFakeTimers();
		try {
			setSystemTime(1_000);
			for (const [index, directory] of directories.entries()) {
				setSystemTime(1_000);
				const active = address(`active-${index}`, 1);
				const registered = await directory.register({ address: active, ttlMs: 100 });
				expect(registered.ok).toBe(true);
				const renewed = await directory.heartbeat(active, 1_000);
				expect(renewed.ok).toBe(true);

				const expired = address(`expired-${index}`, 1);
				const expiring = await directory.register({ address: expired, ttlMs: 1 });
				expect(expiring.ok).toBe(true);
				setSystemTime(1_001);
				const heartbeat = await directory.heartbeat(expired, 10_000);
				expect(heartbeat).toEqual({ ok: false, reason: "not-found" });
				expect(await directory.purgeExpired(1_001)).toBe(1);
				expect(await directory.lookup(expired)).toBeNull();
			}
		} finally {
			vi.useRealTimers();
			await Bun.$`rm -f ${path} ${path}.generation ${path}.lock`;
		}
	});
	it("creates absent nested lock parents before the first file claim", async () => {
		const root = `/tmp/bridge-core-nested-${crypto.randomUUID()}`;
		const path = `${root}/missing/nested/directory.json`;
		try {
			const claimed = await new FileSessionDirectory(path).claimNext({ identity: address("nested"), ttlMs: 10_000 });
			expect(Number(claimed.address.generation)).toBe(1);
			expect(await Bun.file(path).exists()).toBe(true);
		} finally {
			await Bun.$`rm -rf ${root}`;
		}
	});

	it("allocates globally increasing generations in memory across purge", async () => {
		const allocator = new InMemorySessionDirectory();
		const first = await allocator.claimNext({ identity: address("a"), ttlMs: 10_000 });
		const second = await allocator.claimNext({ identity: address("b"), ttlMs: 10_000 });
		expect(Number(second.address.generation)).toBe(Number(first.address.generation) + 1);
		await allocator.purgeExpired(Date.now() + 20_000);
		const third = await allocator.claimNext({ identity: address("a"), ttlMs: 10_000 });
		expect(Number(third.address.generation)).toBe(Number(second.address.generation) + 1);
	});

	it("allocates atomically across file instances and persists sidecar", async () => {
		const path = `/tmp/bridge-core-contract-${crypto.randomUUID()}.json`;
		const left = new FileSessionDirectory(path);
		const right = new FileSessionDirectory(path);
		try {
			const results = await Promise.all([
				left.claimNext({ identity: address("a"), ttlMs: 10_000 }),
				right.claimNext({ identity: address("b"), ttlMs: 10_000 }),
				left.claimNext({ identity: address("c"), ttlMs: 10_000 }),
			]);
			const generations = results.map(result => result.address.generation).sort((a, b) => a - b);
			expect(generations.map(Number)).toEqual([1, 2, 3]);
		const fourth = await new FileSessionDirectory(path).claimNext({ identity: address("d"), ttlMs: 10_000 });
			expect(Number(fourth.address.generation)).toBe(4);
		} finally {
			await Bun.$`rm -f ${path} ${path}.generation ${path}.lock`;
		}
	});
});
