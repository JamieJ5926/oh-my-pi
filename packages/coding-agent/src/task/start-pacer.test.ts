import { afterEach, describe, expect, it, vi } from "bun:test";
import { routeOf, StartPacer } from "./start-pacer";

const pacing = { windowMs: 10_000, initial: 5, floor: 1, ceiling: 5 };

afterEach(() => {
	StartPacer.resetForTests();
	vi.useRealTimers();
});

async function flush(): Promise<void> {
	for (let step = 0; step < 32; step++) await Promise.resolve();
}

async function advanceSlots(slots: number): Promise<void> {
	for (let step = 0; step < slots; step++) {
		vi.advanceTimersByTime(2_000);
		await flush();
	}
}
async function advanceWindow(): Promise<void> {
	await advanceSlots(5);
}

describe("StartPacer", () => {
	  it("grants starts in bounded rolling windows", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const pacer = new StartPacer(pacing);
		const settled = new Set<number>();
		const starts = Array.from({ length: 20 }, (_, i) =>
			pacer.acquire("route").then(() => { settled.add(i + 1); }),
		);
		await flush();
		expect(settled.size).toBe(5);
		await advanceSlots(5);
		expect(settled.size).toBe(10);
		await advanceSlots(5);
		expect(settled.size).toBe(15);
		await advanceSlots(5);
		expect(settled.size).toBe(20);
		await Promise.all(starts);
	});

  it("keeps routes independent", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const pacer = new StartPacer(pacing);
    let settled = 0;
    const starts = [
      ...Array.from({ length: 5 }, () => pacer.acquire("cli-proxy/codex").then(() => { settled++; })),
      ...Array.from({ length: 5 }, () => pacer.acquire("cli-proxy/openrouter").then(() => { settled++; })),
    ];
    await flush();
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
    vi.useFakeTimers({ now: 1_000_000 });
    const pacer = new StartPacer(pacing);
    const initial = Array.from({ length: 5 }, () => pacer.acquire("route"));
    const controller = new AbortController();
    const aborted = pacer.acquire("route", controller.signal);
    controller.abort();
    await flush();
    let threw = false;
    try { await aborted; } catch { threw = true; }
    expect(threw).toBe(true);
		await advanceWindow();
    let granted = false;
    const next = pacer.acquire("route").then(() => { granted = true; });
    await flush();
    expect(granted).toBe(true);
    await Promise.all([...initial, next]);
  });

  it("backs off immediately and recovers after a clean window", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const pacer = new StartPacer({ windowMs: 10_000, initial: 4, floor: 1, ceiling: 30 });
    const route = "route";
    await Promise.all(Array.from({ length: 4 }, () => pacer.acquire(route)));
    pacer.penalize(route);
    const held: Promise<void>[] = [];
    let heldCount = 0;
    for (let n = 0; n < 4; n++) {
      held.push(pacer.acquire(route).then(() => { heldCount++; }));
    }
		vi.advanceTimersByTime(10_000);
		await flush();
    expect(heldCount).toBe(2);
    await Promise.all(held.slice(0, 2));
		vi.advanceTimersByTime(10_000);
		await flush();
    expect(heldCount).toBe(4);
    await Promise.all(held);
  });

  it("resets singleton state", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
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
