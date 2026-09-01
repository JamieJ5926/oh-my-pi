import { describe, expect, it, vi } from "bun:test";
import {
	InMemorySessionDirectory,
	createSessionAddress,
	type ClaimResult,
	type SessionAddress,
	type SessionClaim,
	type TombstoneResult,
} from "@oh-my-pi/pi-coding-agent/bridge/index";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const base = createSessionAddress({
	namespace: "omp",
	host: "registry-order-test",
	process: "publication",
	backend: "coding-agent",
	session: "main",
	generation: 1,
});

function input(id: string) {
	return { id, displayName: id, kind: "sub" as const, session: null, status: "running" as const };
}

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(resolver => {
		resolve = resolver;
	});
	return { promise, resolve };
}

class OrderedDirectory extends InMemorySessionDirectory {
	readonly events: string[] = [];
	readonly firstClaimStarted = gate();
	readonly releaseFirstClaim = gate();
	readonly tombstoneStarted = gate();
	readonly releaseTombstone = gate();
	readonly tombstoneCompleted = gate();
	readonly secondClaimStarted = gate();
	readonly releaseSecondClaim = gate();
	#claimCount = 0;

	override async claimNext(claim: SessionClaim): Promise<ClaimResult> {
		const claimNumber = ++this.#claimCount;
		this.events.push(`claim-start-${claimNumber}`);
		if (claimNumber === 1) {
			this.firstClaimStarted.resolve();
			await this.releaseFirstClaim.promise;
		}
		if (claimNumber === 2) {
			this.secondClaimStarted.resolve();
			await this.releaseSecondClaim.promise;
		}
		const result = await super.claimNext(claim);
		this.events.push(`claim-complete-${result.address.generation}`);
		return result;
	}

	override async tombstone(address: SessionAddress, reason: string): Promise<TombstoneResult> {
		this.events.push(`tombstone-start-${address.generation}`);
		this.tombstoneStarted.resolve();
		await this.releaseTombstone.promise;
		const result = await super.tombstone(address, reason);
		this.events.push(`tombstone-complete-${address.generation}`);
		this.tombstoneCompleted.resolve();
		return result;
	}
}

describe("AgentRegistry publication ordering", () => {
	it("orders delayed teardown before replacement claim without an active ghost", async () => {
		const directory = new OrderedDirectory();
		const registry = new AgentRegistry({ directory, generationAllocator: directory, localAddress: base });
		const firstPublished = registry.registerPublished(input("worker"), { ttlMs: 1_000 });
		await directory.firstClaimStarted.promise;

		directory.releaseFirstClaim.resolve();
		const first = await firstPublished;
		const staleTeardown = registry.unregisterPublished("worker", first.address);
		const replacement = registry.registerPublished(input("worker"), { ttlMs: 1_000 });
		await directory.tombstoneStarted.promise;
		expect(directory.events).toEqual(["claim-start-1", "claim-complete-1", "tombstone-start-1"]);

		directory.releaseTombstone.resolve();
		await directory.tombstoneCompleted.promise;
		await directory.secondClaimStarted.promise;
		expect(await staleTeardown).toBe(true);
		expect(directory.events).toEqual([
			"claim-start-1",
			"claim-complete-1",
			"tombstone-start-1",
			"tombstone-complete-1",
			"claim-start-2",
		]);
		expect(await directory.lookup(first.address)).toMatchObject({ kind: "tombstone", address: first.address });
		expect(registry.get("worker")).toBeUndefined();

		directory.releaseSecondClaim.resolve();
		const second = await replacement;
		expect(Number(second.address.generation)).toBe(Number(first.address.generation) + 1);
		expect(directory.events).toEqual([
			"claim-start-1",
			"claim-complete-1",
			"tombstone-start-1",
			"tombstone-complete-1",
			"claim-start-2",
			"claim-complete-2",
		]);
		expect(await directory.lookup(second.address)).toMatchObject({ kind: "active", address: second.address });
	});

	it("keeps synchronous local registration and teardown directory-free", () => {
		const directory = new InMemorySessionDirectory();
		const register = vi.spyOn(directory, "register");
		const tombstone = vi.spyOn(directory, "tombstone");
		try {
			const registry = new AgentRegistry({ directory, generationAllocator: directory, localAddress: base });
			const ref = registry.register({ id: "local", displayName: "local", kind: "sub", session: null, status: "idle" });
			expect(registry.unregister("local", ref)).toBe(true);
			expect(registry.get("local")).toBeUndefined();
			expect(register).not.toHaveBeenCalled();
			expect(tombstone).not.toHaveBeenCalled();
		} finally {
			register.mockRestore();
			tombstone.mockRestore();
		}
	});
});
