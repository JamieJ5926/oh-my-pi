import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createSessionAddress } from "@oh-my-pi/pi-coding-agent/bridge/core/address";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface SessionStub { session: AgentSession; disposeCalls: () => number; }
function makeSessionStub(): SessionStub { let calls = 0; return { session: { dispose: async () => { calls++; } } as unknown as AgentSession, disposeCalls: () => calls }; }
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function flushAsync(): Promise<void> { for (let i = 0; i < 5; i++) await Promise.resolve(); }
const TTL = 20;

describe("AgentLifecycleManager", () => {
 let registry: AgentRegistry; let lifecycle: AgentLifecycleManager;
 beforeEach(() => { AgentRegistry.resetGlobalForTests(); AgentLifecycleManager.resetGlobalForTests(); registry = AgentRegistry.global(); lifecycle = AgentLifecycleManager.global(); });
 afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); AgentLifecycleManager.resetGlobalForTests(); AgentRegistry.resetGlobalForTests(); });
 function registerPersistedOwner(factory: Parameters<AgentLifecycleManager["registerPersistedSubagentReviverOwner"]>[0]["factory"], idleTtlMs: number) { return lifecycle.registerPersistedSubagentReviverOwner({ address: createSessionAddress({ namespace: "omp", host: "test", process: "lifecycle-test", backend: "coding-agent", session: "main", generation: 1 }), ownerAgentId: MAIN_AGENT_ID, factory, idleTtlMs, scope: "global" }); }
 function registerIdleSub(id: string, session: AgentSession | null, sessionFile: string | null = `/tmp/${id}.jsonl`) { return registry.register({ id, displayName: "task", kind: "sub", session, sessionFile, status: "idle" }); }
 it("adopt parks and revives", async () => { vi.useFakeTimers(); const stub = makeSessionStub(); registerIdleSub("1-Sub", stub.session); lifecycle.adopt("1-Sub", { idleTtlMs: TTL }); vi.advanceTimersByTime(TTL); await flushAsync(); expect(registry.get("1-Sub")?.status).toBe("parked"); const revived = makeSessionStub(); lifecycle.adopt("1-Sub", { idleTtlMs: 0, revive: async () => revived.session }); expect(await lifecycle.ensureLive("1-Sub")).toBe(revived.session); });
 it("reclaims dead corpse", async () => { const ref = registry.register({ id: "Corpse-Sub", displayName: "task", kind: "sub", session: null, sessionFile: "/tmp/Corpse.jsonl", status: "parked" }); expect(await lifecycle.reclaimDeadCorpse("Corpse-Sub", ref)).toBe(true); });
 it("cold revives through owner", async () => { const revived = makeSessionStub(); const ref = registry.register({ id: "Cold-Sub", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null, sessionFile: "/tmp/Cold.jsonl", status: "parked" }); let calls = 0; registerPersistedOwner(async expected => { calls++; expect(expected).toBe(ref); return async () => revived.session; }, 0); expect(await lifecycle.ensureLive("Cold-Sub")).toBe(revived.session); expect(calls).toBe(1); });
 it("coalesces revive", async () => { const gate = deferred(); const revived = makeSessionStub(); registry.register({ id: "4-Sub", displayName: "task", kind: "sub", session: null, status: "parked" }); lifecycle.adopt("4-Sub", { idleTtlMs: 0, revive: async () => { await gate.promise; return revived.session; } }); const a = lifecycle.ensureLive("4-Sub"); const b = lifecycle.ensureLive("4-Sub"); gate.resolve(); expect(await a).toBe(revived.session); expect(await b).toBe(revived.session); });
 	it("rejects revival when its persisted owner is disposed during factory", async () => {
 		const gate = deferred();
 		const revived = makeSessionStub();
 		const ref = registry.register({ id: "Disposed-Owner-Sub", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null, sessionFile: "/tmp/Disposed-Owner.jsonl", status: "parked" });
 		const unregister = registerPersistedOwner(async expected => {
 			expect(expected).toBe(ref);
 			await gate.promise;
 			return async () => revived.session;
 		}, 0);
 		const revival = lifecycle.ensureLive("Disposed-Owner-Sub");
 		await flushAsync();
 		await unregister();
 		gate.resolve();
 		await expect(revival).rejects.toThrow(/persisted session owner was disposed/);
 		expect(registry.get("Disposed-Owner-Sub")).toBe(ref);
 		expect(ref.status).toBe("parked");
 		expect(lifecycle.has("Disposed-Owner-Sub")).toBe(false);
 	});
 	it("retires cold-adopted children on owner replacement without stale unregister", async () => {
 		const gen1Session = makeSessionStub();
 		const gen2Session = makeSessionStub();
 		const firstRef = registry.register({ id: "Gen1-Sub", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null, sessionFile: "/tmp/Gen1.jsonl", status: "parked" });
 		const address = (generation: number) => createSessionAddress({ namespace: "omp", host: "test", process: "lifecycle-test", backend: "coding-agent", session: "main", generation });
 		const unregisterGen1 = lifecycle.registerPersistedSubagentReviverOwner({ address: address(1), ownerAgentId: MAIN_AGENT_ID, factory: async expected => { expect(expected).toBe(firstRef); return async () => gen1Session.session; }, idleTtlMs: 0, scope: "global" });
 		expect(await lifecycle.ensureLive(firstRef.id)).toBe(gen1Session.session);
 		const unregisterGen2 = lifecycle.registerPersistedSubagentReviverOwner({ address: address(2), ownerAgentId: MAIN_AGENT_ID, factory: async () => async () => gen2Session.session, idleTtlMs: 0, scope: "global" });
 		await flushAsync();
 		expect(gen1Session.disposeCalls()).toBe(1);
 		expect(registry.get(firstRef.id)).toBeUndefined();
 		await unregisterGen1();
 		const secondRef = registry.register({ id: "Gen2-Sub", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null, sessionFile: "/tmp/Gen2.jsonl", status: "parked" });
 		expect(await lifecycle.ensureLive(secondRef.id)).toBe(gen2Session.session);
 		await unregisterGen2();
 	});
 it("rejects stale owner generation", async () => { const ref = registry.register({ id: "Stale-Sub", displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: null, sessionFile: "/tmp/Stale.jsonl", status: "parked" }); const address = createSessionAddress({ namespace: "omp", host: "test", process: "lifecycle-test", backend: "coding-agent", session: "main", generation: 1 }); registerPersistedOwner(async () => async () => makeSessionStub().session, 0); await expect(lifecycle.ensureLive("Stale-Sub", { ownerAddress: createSessionAddress({ ...address, generation: 2 }) })).rejects.toThrow(/stale|no active/); expect(ref.status).toBe("parked"); });
});
