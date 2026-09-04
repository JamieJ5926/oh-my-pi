import { describe, expect, it, setSystemTime, vi } from "bun:test";
import { InMemorySessionDirectory, createSessionAddress } from "@oh-my-pi/pi-coding-agent/bridge/index";
import { addressSegment, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const base = createSessionAddress({
  namespace: "omp",
  host: "registry-test",
  process: "publication",
  backend: "coding-agent",
  session: "main",
  generation: 1,
});

function makeRegistry() {
  const directory = new InMemorySessionDirectory();
  return { directory, registry: new AgentRegistry({ directory, generationAllocator: directory, localAddress: base }) };
}

function input(id: string) {
  return { id, displayName: id, kind: "sub" as const, session: null, status: "running" as const };
}

  it("derives distinct bounded addresses for colliding sanitized ids", () => {
    const { registry } = makeRegistry();
    const slash = registry.register(input("a/b"));
    const hyphen = registry.register(input("a-b"));

    expect(slash.address.session).not.toBe(hyphen.address.session);
    expect(slash.address.session).toContain("main-a-b");
    expect(slash.address.session.length).toBeLessThanOrEqual(128);
    expect(hyphen.address.session.length).toBeLessThanOrEqual(128);
    expect(registry.register(input("a/b")).address.session).toBe(slash.address.session);
  });
  it("publishes the real session id for Main and derives subagent sessions from it", () => {
    const { registry } = makeRegistry();
    const sessionId = "0196c8d2-7a3f-7e11-9b4c-2f6d8a0c1e5b";
    const main = registry.register({
      ...input(MAIN_AGENT_ID),
      kind: "main" as const,
      address: { ...base, session: sessionId },
    });
    expect(main.address.session).toBe(sessionId);

    const sessionBase = createSessionAddress({
      namespace: "omp",
      host: "registry-test",
      process: "publication",
      backend: "coding-agent",
      session: sessionId,
      generation: 1,
    });
    const sessionRegistry = new AgentRegistry({ localAddress: sessionBase });
    const sub = sessionRegistry.register(input("worker"));
    // Pins the sdk subagent branch (sdk.ts registrationInput): the derived session is addressSegment(id, sessionId), not hand-built.
    expect(sub.address.session).toBe(addressSegment("worker", sessionId));
    expect(sub.address.session).not.toBe(sessionId);
    expect(sub.address.session).toContain(sessionId);
    expect(sub.address.session.length).toBeLessThanOrEqual(128);
  });

describe("AgentRegistry publication lifecycle", () => {
  it("claims and publishes only after the authoritative claim", async () => {
    const { directory, registry } = makeRegistry();
    const ref = await registry.registerPublished(input("worker"), { ttlMs: 10 });
    expect(Number(ref.address.generation)).toBe(1);
    expect(await directory.lookup(ref.address)).toMatchObject({ kind: "active", address: ref.address });
  });

  it("allocates distinct generations atomically across concurrent registries", async () => {
    const directory = new InMemorySessionDirectory();
    const firstRegistry = new AgentRegistry({ directory, generationAllocator: directory, localAddress: base });
    const secondRegistry = new AgentRegistry({ directory, generationAllocator: directory, localAddress: base });

    const [first, second] = await Promise.all([
      firstRegistry.registerPublished(input("worker"), { ttlMs: 1_000 }),
      secondRegistry.registerPublished(input("worker"), { ttlMs: 1_000 }),
    ]);

    expect(new Set([first.address.generation, second.address.generation]).size).toBe(2);
    expect(new Set([Number(first.address.generation), Number(second.address.generation)])).toEqual(new Set([1, 2]));
    expect(Number((await directory.lookup(second.address))?.address.generation)).toBe(2);
  });

  it("serializes same-identity publication and increments generations", async () => {
    const { directory, registry } = makeRegistry();
    const first = await registry.registerPublished(input("worker"), { ttlMs: 10 });
    expect(await registry.unregisterPublished("worker", first.address)).toBe(true);
    const second = await registry.registerPublished(input("worker"), { ttlMs: 10 });
    expect(Number(second.address.generation)).toBe(Number(first.address.generation) + 1);
    const record = await directory.lookup(second.address);
    expect(record?.kind).toBe("active");
  });

  it("rejects stale teardown and leaves replacement published", async () => {
    const { directory, registry } = makeRegistry();
    const first = await registry.registerPublished(input("worker"), { ttlMs: 10 });
    expect(await registry.unregisterPublished("worker", first.address)).toBe(true);
    const second = await registry.registerPublished(input("worker"), { ttlMs: 10 });
    expect(Number(second.address.generation)).toBe(Number(first.address.generation) + 1);
    expect(await registry.unregisterPublished("worker", first.address)).toBe(false);
    expect(await directory.lookup(second.address)).toMatchObject({ kind: "active", address: second.address });
  });

  it("renews a published reference and expires it after the renewed ttl", async () => {
    vi.useFakeTimers();
    try {
      setSystemTime(1_000);
      const { directory, registry } = makeRegistry();
      const ref = await registry.registerPublished(input("worker"), { ttlMs: 100 });

      setSystemTime(1_050);
      expect(await registry.heartbeatPublished("worker", ref.address, 200)).toBe(true);
      expect(await directory.lookup(ref.address)).toMatchObject({
        kind: "active",
        address: ref.address,
        lastHeartbeatAt: 1_050,
        expiresAt: 1_250,
      });

      setSystemTime(1_249);
      expect(await directory.lookup(ref.address)).toMatchObject({ kind: "active", address: ref.address });
      setSystemTime(1_250);
      expect(await directory.lookup(ref.address)).toBeNull();
    } finally {
      vi.useRealTimers();
      setSystemTime();
    }
  });

  it("rejects a stale expected address without disturbing the current publication", async () => {
    const { directory, registry } = makeRegistry();
    const first = await registry.registerPublished(input("worker"), { ttlMs: 1_000 });
    expect(await registry.unregisterPublished("worker", first.address)).toBe(true);
    const replacement = await registry.registerPublished(input("worker"), { ttlMs: 1_000 });

    expect(await registry.heartbeatPublished("worker", first.address, 1_000)).toBe(false);
    expect(await directory.lookup(replacement.address)).toMatchObject({ kind: "active", address: replacement.address });
  });

});

describe("AgentRegistry cross-process session resolution", () => {
  const sessionId = "0196c8d2-7a3f-7e11-9b4c-2f6d8a0c1e5e";

  function makePair() {
    const directory = new InMemorySessionDirectory();
    const localAddress = (process: string) => ({ ...base, host: "cross-process", process });
    const receiver = new AgentRegistry({ directory, generationAllocator: directory, localAddress: localAddress("receiver") });
    const sender = new AgentRegistry({ directory, generationAllocator: directory, localAddress: localAddress("sender") });
    return { directory, receiver, sender };
  }

  function publishedInput(address: { session: string }) {
    return { ...input("worker"), address: { ...base, host: "cross-process", process: "receiver", session: address.session } };
  }

  it("resolves another process's published session with its claimed generation", async () => {
    const { sender, receiver } = makePair();
    const ref = await receiver.registerPublished(publishedInput({ session: sessionId }), { ttlMs: 60_000 });
    expect(sender.getBySession(sessionId)).toBeUndefined();
    expect(await sender.findSessionAddress(sessionId)).toEqual(ref.address);
  });

  it("misses unknown sessions and directory-less registries", async () => {
    const { sender } = makePair();
    expect(await sender.findSessionAddress("no-such-session")).toBeUndefined();
    const bare = new AgentRegistry({ localAddress: base });
    expect(await bare.findSessionAddress(sessionId)).toBeUndefined();
  });

  it("never matches tombstoned or expired records", async () => {
    vi.useFakeTimers();
    try {
      setSystemTime(1_000);
      const { sender, receiver } = makePair();
      const ref = await receiver.registerPublished(publishedInput({ session: sessionId }), { ttlMs: 100 });
      expect(await sender.findSessionAddress(sessionId)).toEqual(ref.address);
      expect(await receiver.unregisterPublished("worker", ref.address)).toBe(true);
      expect(await sender.findSessionAddress(sessionId)).toBeUndefined();
      const revived = await receiver.registerPublished(publishedInput({ session: sessionId }), { ttlMs: 100 });
      expect(Number(revived.address.generation)).toBe(Number(ref.address.generation) + 1);
      expect(await sender.findSessionAddress(sessionId)).toEqual(revived.address);
      setSystemTime(1_101);
      expect(await sender.findSessionAddress(sessionId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
      setSystemTime();
    }
  });
});
