import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionDirectory, InMemorySessionDirectory } from "../src/bridge/core/directory";
import { createSessionAddress, formatSessionAddress } from "../src/bridge/core/address";
import { AgentRegistry } from "../src/registry/agent-registry";
import { executeList, executeSend, executeMessageWait } from "../src/tools/hub/messaging";
import { Settings } from "../src/config/settings";

const identity = { namespace: "omp", host: "localhost", process: String(process.pid), backend: "pi" };

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
});
