import { afterEach, describe, expect, it, vi } from "vitest";
import { routeOf, StartPacer } from "./start-pacer";

const pacing = { windowMs: 10_000, initial: 5, floor: 1, ceiling: 5 };

afterEach(() => {
  vi.useRealTimers();
  StartPacer.resetForTests();
});

describe("StartPacer", () => {
  it("grants starts in bounded rolling windows", async () => {
    vi.useFakeTimers();
    const pacer = new StartPacer(pacing);
    const settled = new Set<number>();
    const starts = Array.from({ length: 20 }, (_, i) =>
      pacer.acquire("route").then(() => { settled.add(i + 1); }),
    );
    await Promise.resolve();
    expect(settled.size).toBe(5);
    for (const count of [10, 15, 20]) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled.size).toBe(count);
    }
    await Promise.all(starts);
  });

  it("keeps routes independent", async () => {
    vi.useFakeTimers();
    const pacer = new StartPacer(pacing);
    let settled = 0;
    const starts = [
      ...Array.from({ length: 5 }, () => pacer.acquire("cli-proxy/codex").then(() => { settled++; })),
      ...Array.from({ length: 5 }, () => pacer.acquire("cli-proxy/openrouter").then(() => { settled++; })),
    ];
    await Promise.resolve();
    expect(settled).toBe(10);
    await Promise.all(starts);
  });

  it("uses the provider and family route", () => {
    expect(routeOf("cli-proxy/codex.gpt-5")).toBe("cli-proxy/codex");
    expect(routeOf("cli-proxy/openrouter.gpt")).toBe("cli-proxy/openrouter");
    expect(routeOf("openai/gpt-5")).toBe("openai/gpt-5");
    expect(routeOf(undefined)).toBe("unknown");
    expect(routeOf("")).toBe("unknown");
    expect(routeOf("noslash")).toBe("unknown");
  });

  it("does not let an aborted waiter consume a slot", async () => {
    vi.useFakeTimers();
    const pacer = new StartPacer(pacing);
    const initial = Array.from({ length: 5 }, () => pacer.acquire("route"));
    const controller = new AbortController();
    const aborted = pacer.acquire("route", controller.signal);
    const rejected = expect(aborted).rejects.toThrow();
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(10_000);
    let granted = false;
    const next = pacer.acquire("route").then(() => { granted = true; });
    await Promise.resolve();
    expect(granted).toBe(true);
    await Promise.all([...initial, next]);
  });

  it("backs off immediately and recovers after a clean window", async () => {
    vi.useFakeTimers();
    const pacer = new StartPacer({ windowMs: 10_000, initial: 4, floor: 1, ceiling: 30 });
    const route = "route";
    await Promise.all(Array.from({ length: 4 }, () => pacer.acquire(route)));
    pacer.penalize(route);
    const held: Promise<void>[] = [];
    let heldCount = 0;
    for (let n = 0; n < 4; n++) {
      held.push(pacer.acquire(route).then(() => { heldCount++; }));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heldCount).toBe(2);
    await Promise.all(held.slice(0, 2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heldCount).toBe(4);
    await Promise.all(held);
  });

  it("resets singleton state", async () => {
    vi.useFakeTimers();
    StartPacer.resetForTests();
    const first = StartPacer.instance();
    await Promise.all(Array.from({ length: 15 }, () => first.acquire("route")));
    const blocked = first.acquire("route");
    let firstWaiterGranted = false;
    void blocked.then(() => { firstWaiterGranted = true; });
    await Promise.resolve();
    expect(firstWaiterGranted).toBe(false);
    StartPacer.resetForTests();
    const second = StartPacer.instance();
    let secondGranted = false;
    await second.acquire("route").then(() => { secondGranted = true; });
    expect(secondGranted).toBe(true);
    expect(second).not.toBe(first);
  });
});
