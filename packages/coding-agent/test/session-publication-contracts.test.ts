import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionDirectory, InMemorySessionDirectory } from "../src/bridge/core/directory";
import { createSessionAddress, formatSessionAddress } from "../src/bridge/core/address";
import { AgentRegistry } from "../src/registry/agent-registry";
import { executeList, executeSend, executeMessageWait, messagingRenderResult } from "../src/tools/hub/messaging";
import { Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { LocalTransportAdapter, BrokerBackedTransportAdapter } from "../src/bridge/transport/transport";
import { initTheme, theme } from "../src/modes/theme/theme";

const identity = { namespace: "omp", host: "localhost", process: String(process.pid), backend: "pi" };

it("evicts rejected heartbeats and keeps local messaging independent of directory faults", async () => {
	const observed = Promise.withResolvers<void>();
	class RejectedHeartbeat extends InMemorySessionDirectory {
		override async heartbeat() {
			observed.resolve();
			return { ok: false, reason: "not-found" } as const;
		}
	}
	const directory = new RejectedHeartbeat();
	const registry = new AgentRegistry();
	registry.configurePublication(directory, identity, 30);
	const ref = registry.register({ id: "Main", displayName: "main", kind: "main", session: Object.create(null) });
	const publication = await registry.publishSession(ref, "evicted");
	await observed.promise;
	await Promise.resolve();
	expect(() => registry.configurePublication(directory, identity)).not.toThrow();
	await publication?.close();
	IrcBus.resetGlobalForTests();
	const globalRegistry = AgentRegistry.global();
	globalRegistry.configurePublication(directory, identity);
	const local = globalRegistry.register({ id: "publication-local", displayName: "local", kind: "sub", session: null });
	directory.listActive = async () => { throw new Error("damaged directory"); };
	const incoming = IrcBus.global().wait(local.id, {}, 1000);
	const result = await executeSend({ registry: globalRegistry, senderId: "Main", settings: Settings.isolated() }, { to: local.id, message: "local still works" });
	expect(result.isError).toBe(false);
	expect((await incoming)?.body).toBe("local still works");
});

it("returns tool errors for ambiguous published session IDs", async () => {
	const directory = new InMemorySessionDirectory();
	const registry = new AgentRegistry();
	registry.configurePublication(directory, { ...identity, process: "other" });
	const first = createSessionAddress({ ...identity, session: "duplicate", generation: 1 });
	const second = createSessionAddress({ ...identity, process: String(process.ppid), session: "duplicate", generation: 2 });
	await directory.register({ address: first, ttlMs: 10_000 });
	await directory.register({ address: second, ttlMs: 10_000 });
	const deps = { registry, senderId: "Main", settings: Settings.isolated() };
	expect(JSON.stringify((await executeSend(deps, { to: "duplicate", message: "hello" })).content)).toContain("Ambiguous remote session");
	expect(JSON.stringify((await executeMessageWait(deps, { from: "duplicate" })).content)).toContain("Ambiguous remote session");
});

describe("production session publication", () => {
	it("publishes a live session, renews it and tombstones on close", async () => {
		const root = await mkdtemp(join(tmpdir(), "publication-"));
		let renewed: () => void = () => {};
		const renewal = new Promise<void>(resolve => { renewed = resolve; });
		class ObservedDirectory extends FileSessionDirectory {
			override async heartbeat(...args: Parameters<FileSessionDirectory["heartbeat"]>) {
				const result = await super.heartbeat(...args);
				renewed();
				return result;
			}
		}
		const directory = new ObservedDirectory(join(root, "sessions.json"));
		const registry = new AgentRegistry();
		registry.configurePublication(directory, identity, 90);
		const ref = registry.register({ id: "Main", displayName: "main", kind: "main", session: null });
		// The publication boundary only observes attachment identity, not session methods.
		const session = Object.create(null);
		registry.attachSession("Main", session);
		try {
			const publication = await registry.publishSession(ref, "root-session");
			expect(publication).toBeDefined();
			if (!publication) throw new Error("missing publication");
			const before = await directory.lookup(publication.address);
			await renewal;
			const after = await directory.lookup(publication.address);
			expect(before?.kind).toBe("active");
			expect(after?.kind).toBe("active");
			if (before?.kind === "active" && after?.kind === "active") expect(after.lastHeartbeatAt).toBeGreaterThan(before.lastHeartbeatAt);
			await Promise.all([publication.close(), publication.close()]);
			expect((await directory.lookup(publication.address))?.kind).toBe("tombstone");
			expect(await directory.listActive()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never presents a published remote as delivered or locally revivable", async () => {
		const directory = new InMemorySessionDirectory();
		const registry = new AgentRegistry();
		registry.configurePublication(directory, { ...identity, process: "other-process" });
		const address = createSessionAddress({ ...identity, session: "remote-root", generation: 1 });
		await directory.register({ address, ttlMs: 10_000 });
		const settings = Settings.isolated();
		const list = await executeList(registry, "Main");
		expect(JSON.stringify(list.content)).toContain("remote · unreachable");
		expect(list.details?.publishedPeers[0]?.address.process).toBe(String(process.pid));
		expect(list.details?.publishedPeers[0]?.reachable).toBe(false);
		expect(registry.list()).toEqual([]);
		expect((await registry.findPublishedSession(formatSessionAddress(address)))?.address).toEqual(address);
		const sent = await executeSend({ registry, senderId: "Main", settings }, { to: "remote-root", message: "hello" });
		expect(sent.isError).toBe(true);
		expect(JSON.stringify(sent.content)).toContain("unreachable");
		expect(JSON.stringify(sent.content)).not.toContain("Delivered");
		const waited = await executeMessageWait({ registry, senderId: "Main", settings }, { from: "remote-root" });
		expect(waited.isError).toBe(true);
		expect(JSON.stringify(waited.content)).toContain("unreachable");
		await directory.tombstone(address, "closed");
		expect(await registry.findPublishedSession("remote-root")).toBeUndefined();
	});

	it("releases publication ownership after failed close and permits retry", async () => {
		class RejectOnce extends InMemorySessionDirectory {
			attempts = 0;
			override async tombstone(...args: Parameters<InMemorySessionDirectory["tombstone"]>) {
				if (++this.attempts === 1) throw new Error("disk failure");
				return super.tombstone(...args);
			}
		}
		const directory = new RejectOnce();
		const registry = new AgentRegistry();
		registry.configurePublication(directory, identity);
		const ref = registry.register({ id: "Main", displayName: "main", kind: "main", session: Object.create(null) });
		const publication = await registry.publishSession(ref, "retry");
		if (!publication) throw new Error("missing publication");
		await expect(publication.close()).rejects.toThrow("disk failure");
		expect(() => registry.configurePublication(directory, identity)).not.toThrow();
		await publication.close();
		expect(directory.attempts).toBe(2);
	});

	it("reaps retained tombstones and abandoned ownerless locks", async () => {
		const root = await mkdtemp(join(tmpdir(), "publication-lock-"));
		const file = join(root, "sessions.json");
		try {
			await mkdir(`${file}.lock`);
			await utimes(`${file}.lock`, new Date(0), new Date(0));
			const directory = new FileSessionDirectory(file);
			const first = await directory.claimNext({ identity: { ...identity, session: "retained" }, ttlMs: 10_000 });
			await directory.tombstone(first.address, "closed");
			expect(await directory.purgeExpired()).toBe(0);
			expect(await directory.purgeExpired(Date.now() + 86_400_001)).toBe(1);
			const second = await directory.claimNext({ identity: { ...identity, session: "retained" }, ttlMs: 10_000 });
			expect(second.address.generation).toBeGreaterThan(first.address.generation);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("keeps remote rows visible when local slots are full and isolates directory damage", async () => {
		const directory = new InMemorySessionDirectory();
		const registry = new AgentRegistry();
		registry.configurePublication(directory, { ...identity, process: "other-process" });
		registry.register({ id: "local", displayName: "local", kind: "sub", session: null });
		await directory.claimNext({ identity: { ...identity, session: "remote-one" }, ttlMs: 10_000 });
		await directory.claimNext({ identity: { ...identity, session: "remote-two" }, ttlMs: 10_000 });
		const listed = await executeList(registry, "Main", { limit: 1 });
		await initTheme(false);
		const rendered = messagingRenderResult(listed, { expanded: true }, theme, { op: "list" }).render(500).join("\n");
		expect(rendered).toContain("Remote sessions");
		expect(rendered).toContain("remote-one");
		expect(listed.details?.publishedPeers.length).toBe(2);
		expect(JSON.stringify(listed.content)).toContain("1 remote sessions truncated");
		directory.listActive = async () => { throw new Error("corrupt directory"); };
		expect((await executeList(registry, "Main")).details?.peers?.length).toBe(1);
	});

	it("routes published exact addresses and preserves reply identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "publication-transport-"));
		const directory = new InMemorySessionDirectory();
		const left = new AgentRegistry();
		const right = new AgentRegistry();
		left.configurePublication(directory, { ...identity, process: "left" });
		right.configurePublication(directory, { ...identity, process: "right" });
		const leftAddress = createSessionAddress({ ...identity, session: "left", generation: 1 });
		const rightAddress = createSessionAddress({ ...identity, session: "right", generation: 2 });
		await directory.register({ address: leftAddress, ttlMs: 10_000 });
		await directory.register({ address: rightAddress, ttlMs: 10_000 });
		left.register({ id: "Main", displayName: "main", kind: "main", session: null });
		right.register({ id: "Main", displayName: "main", kind: "main", session: null });
		const a = new IrcBus(left);
		const b = new IrcBus(right);
		const ta = new LocalTransportAdapter({ journalPath: join(root, "a.jsonl") });
		const tb = new LocalTransportAdapter({ journalPath: join(root, "b.jsonl") });
		a.attachTransport(ta);
		b.attachTransport(tb);
		const closeA = await a.registerPublished("Main", leftAddress);
		const closeB = await b.registerPublished("Main", rightAddress);
		try {
			const incoming = b.wait("Main", { from: formatSessionAddress(leftAddress) }, 1000);
			expect((await a.send({ from: "Main", to: formatSessionAddress(rightAddress), body: "hello" })).outcome).toBe("injected");
			const message = await incoming;
			if (!message) throw new Error("missing message");
			expect(message.from).toBe(formatSessionAddress(leftAddress));
			const reply = a.wait("Main", { from: formatSessionAddress(rightAddress) }, 1000);
			await b.send({ from: "Main", to: message.from, body: "reply", replyTo: message.id });
			expect((await reply)?.replyTo).toBe(message.id);
		} finally {
			await closeA?.(); await closeB?.(); await ta.close(); await tb.close();
			await rm(root, { recursive: true, force: true });
		}
	});
	it("reports disconnected broker sends as queued, never delivered", async () => {
		const root = await mkdtemp(join(tmpdir(), "publication-queued-"));
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const directory = new InMemorySessionDirectory();
		registry.configurePublication(directory, { ...identity, process: "sender" });
		const source = createSessionAddress({ ...identity, session: "source", generation: 1 });
		const destination = createSessionAddress({ ...identity, session: "queued-destination", generation: 2 });
		await directory.register({ address: destination, ttlMs: 10_000 });
		const transport = new BrokerBackedTransportAdapter({ socketPath: join(root, "absent.sock"), journalPath: join(root, "client.jsonl") });
		const bus = IrcBus.global();
		bus.attachTransport(transport);
		const unregister = await bus.registerPublished("Main", source);
		try {
			const result = await executeSend({ registry, senderId: "Main", settings: Settings.isolated() }, { to: formatSessionAddress(destination), message: "queued" });
			expect(result.details?.receipts?.[0]?.outcome).toBe("queued");
			expect(JSON.stringify(result.content)).toContain("Queued for 1 remote peer(s), not yet delivered");
			expect(JSON.stringify(result.content)).not.toContain("Delivered to");
		} finally {
			await unregister?.(); await transport.close();
			IrcBus.resetGlobalForTests();
			await rm(root, { recursive: true, force: true });
		}
	});
});

it("tombstones the live publication when its agent is unregistered", async () => {
	const directory = new InMemorySessionDirectory();
	const registry = new AgentRegistry();
	registry.configurePublication(directory, identity, 30);
	const ref = registry.register({ id: "Main", displayName: "main", kind: "main", session: Object.create(null) });
	const publication = await registry.publishSession(ref, "unregister-close");
	const address = publication.address;
	expect((await directory.lookup(address))?.kind).toBe("active");
	expect(registry.unregister("Main")).toBe(true);
	let observed: string | undefined;
	for (let i = 0; i < 100; i++) {
		observed = (await directory.lookup(address))?.kind;
		if (observed === "tombstone") break;
		await Promise.resolve();
	}
	expect(observed).toBe("tombstone");
	expect(await directory.listActive()).toEqual([]);
	expect(() => registry.configurePublication(directory, identity)).not.toThrow();
});

it("prunes expired actives and retained tombstones in InMemory claimNext", async () => {
	const directory = new InMemorySessionDirectory();
	const realNow = Date.now;
	try {
		let now = 1_700_000_000_000;
		Date.now = () => now;
		const expiring = await directory.claimNext({ identity: { ...identity, session: "prune-expiring" }, ttlMs: 1000 });
		const retained = await directory.claimNext({ identity: { ...identity, session: "prune-retained" }, ttlMs: 1000 });
		await directory.tombstone(retained.address, "closed");
		now += 86_400_002;
		await directory.claimNext({ identity: { ...identity, session: "prune-fresh" }, ttlMs: 10_000 });
		expect(await directory.lookup(expiring.address)).toBeNull();
		expect(await directory.lookup(retained.address)).toBeNull();
	} finally {
		Date.now = realNow;
	}
});
