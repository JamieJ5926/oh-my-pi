export interface StartPacing { windowMs: number; initial: number; floor: number; ceiling: number }

export const DEFAULT_START_PACING: StartPacing = { windowMs: 10_000, initial: 15, floor: 1, ceiling: 30 };

export function routeOf(selector: string | undefined): string {
	if (!selector) return "unknown";
	const segments = selector.split("/");
	if (segments.length < 2 || !segments[0] || !segments[1]) return "unknown";
	return `${segments[0]}/${segments[1].split(".")[0]}`;
}

type Waiter = { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void };
type RouteState = { rate: number; lastPenaltyAt?: number; lastClimbAt: number };

export class StartPacer {
	static #instance: StartPacer | undefined;
	static instance(): StartPacer {
		return (this.#instance ??= new StartPacer(DEFAULT_START_PACING));
	}
	static resetForTests(): void {
		this.#instance?.#clearTimers();
		this.#instance?.#waiters.clear();
		this.#instance = undefined;
	}

	#pacing: StartPacing;
	#now: () => number;
	#grants = new Map<string, number[]>();
	#waiters = new Map<string, Waiter[]>();
	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#routes = new Map<string, RouteState>();

	constructor(pacing: StartPacing, now: () => number = Date.now) {
		this.#pacing = { ...pacing };
		this.#now = now;
	}

	apply(pacing: StartPacing): void {
		this.#pacing = { ...pacing };
		for (const route of this.#waiters.keys()) this.#schedule(route);
	}

	penalize(route: string): void {
		const now = this.#now();
		const state = this.#state(route, now);
		state.rate = Math.max(this.#pacing.floor, Math.floor(state.rate / 2));
		state.lastPenaltyAt = now;
		state.lastClimbAt = now;
		this.#schedule(route);
	}

	acquire(route: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		if (this.#grant(route)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			waiter.abort = () => {
				const queue = this.#waiters.get(route);
				if (queue) {
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
					if (!queue.length) this.#waiters.delete(route);
				}
				signal?.removeEventListener("abort", waiter.abort!);
				reject(new Error("Aborted"));
				this.#schedule(route);
			};
			if (signal) signal.addEventListener("abort", waiter.abort, { once: true });
			const queue = this.#waiters.get(route) ?? [];
			queue.push(waiter);
			this.#waiters.set(route, queue);
			this.#schedule(route);
		});
	}

	#state(route: string, now = this.#now()): RouteState {
		let state = this.#routes.get(route);
		if (!state) {
			state = { rate: this.#pacing.initial, lastClimbAt: now };
			this.#routes.set(route, state);
		}
		return state;
	}

	#grant(route: string): boolean {
		const now = this.#now();
		const state = this.#state(route, now);
		if (state.rate <= 0) return true;
		const grants = (this.#grants.get(route) ?? []).filter(time => time > now - this.#pacing.windowMs && time <= now);
		if (grants.length >= state.rate) {
			this.#grants.set(route, grants);
			return false;
		}
		grants.push(now);
		this.#grants.set(route, grants);
		return true;
	}

	#schedule(route: string): void {
		const old = this.#timers.get(route);
		if (old) globalThis.clearTimeout(old);
		this.#timers.delete(route);
		const queue = this.#waiters.get(route);
		if (!queue?.length) return;
		const now = this.#now();
		const state = this.#state(route, now);
		const grants = (this.#grants.get(route) ?? []).filter(time => time > now - this.#pacing.windowMs && time <= now);
		this.#grants.set(route, grants);
		const cleanSince = Math.max(state.lastPenaltyAt ?? -Infinity, state.lastClimbAt);
		const climbAt = cleanSince + this.#pacing.windowMs;
		const delay = state.rate > 0 && grants.length >= state.rate
			? Math.max(0, Math.min(grants[0]! + this.#pacing.windowMs - now, climbAt - now))
			: Math.max(0, climbAt - now);
		const timer = globalThis.setTimeout(() => {
			if (StartPacer.#instance !== undefined && StartPacer.#instance !== this) return;
			this.#timers.delete(route);
			const tick = this.#now();
			const routeState = this.#state(route, tick);
			const shouldClimb = tick - Math.max(routeState.lastPenaltyAt ?? -Infinity, routeState.lastClimbAt) >= this.#pacing.windowMs;
			const waiting = this.#waiters.get(route) ?? [];
			while (waiting.length && (routeState.rate <= 0 || this.#grant(route))) {
				const waiter = waiting.shift()!;
				waiter.signal?.removeEventListener("abort", waiter.abort!);
				waiter.resolve();
			}
			if (!waiting.length) this.#waiters.delete(route);
			if (shouldClimb) {
				routeState.rate = Math.min(this.#pacing.ceiling, routeState.rate + 2);
				routeState.lastClimbAt = tick;
			}
			this.#schedule(route);
		}, delay);
		this.#timers.set(route, timer);
	}

	#clearTimers(): void {
		for (const timer of this.#timers.values()) globalThis.clearTimeout(timer);
		this.#timers.clear();
	}
}
