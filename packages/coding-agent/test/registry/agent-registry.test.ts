import { describe, expect, it, setSystemTime, vi } from "bun:test";
import { InMemorySessionDirectory, createSessionAddress } from "@oh-my-pi/pi-coding-agent/bridge/index";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

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
