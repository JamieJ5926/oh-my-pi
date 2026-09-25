export interface StartPacing { windowMs: number; initial: number; floor: number; ceiling: number }

export const DEFAULT_START_PACING: StartPacing = { windowMs: 10_000, initial: 15, floor: 1, ceiling: 30 };

export function routeOf(selector: string | undefined): string {
	if (!selector) return "unknown";
	const segments = selector.split("/");
	if (segments.length < 2 || !segments[0] || !segments[1]) return "unknown";
	return `${segments[0]}/${segments[1].split(".")[0]}`;
}

type RouteState = { rate: number; lastPenaltyAt?: number; lastClimbAt: number; nextAt?: number };

export class StartPacer {
	static #instance: StartPacer | undefined;
	static instance(): StartPacer {
		return (this.#instance ??= new StartPacer(DEFAULT_START_PACING));
	}
	static resetForTests(): void {
		this.#instance = undefined;
	}

	#pacing: StartPacing;
	#now: () => number;
	#wait: (ms: number, signal?: AbortSignal) => Promise<void>;
	#grants = new Map<string, number[]>();
	#pending = new Map<string, Promise<void>>();
	#routes = new Map<string, RouteState>();

	constructor(pacing: StartPacing, now: () => number = Date.now, wait?: (ms: number) => Promise<void>) {
		this.#pacing = { ...pacing };
		this.#now = now;
		this.#wait = wait ?? (async (ms, signal) => {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Aborted")); }, { once: true });
			});
		});
	}

	apply(pacing: StartPacing): void {
		this.#pacing = { ...pacing };
	}

	penalize(route: string): void {
		const now = this.#now();
		const state = this.#state(route, now);
		state.rate = Math.max(this.#pacing.floor, Math.floor(state.rate / 2));
		state.lastPenaltyAt = now;
		state.lastClimbAt = now;
	}

	acquire(route: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		const state = this.#state(route);
		const now = this.#now();
		const recent = (this.#grants.get(route) ?? []).filter(time => time > now - this.#pacing.windowMs);
		if (recent.length < state.rate) {
			this.#record(route, state, now);
			return Promise.resolve();
		}
		return this.#enqueue(route, signal);
	}

	#enqueue(route: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = () => reject(new Error("Aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const turn = (this.#pending.get(route) ?? Promise.resolve()).then(() => this.#acquireTurn(route, signal));
		turn.then(() => resolve(), reject);
		const settled = turn.then(() => undefined, () => undefined);
		this.#pending.set(route, settled);
		settled.then(() => {
			signal?.removeEventListener("abort", onAbort);
			if (this.#pending.get(route) === settled) this.#pending.delete(route);
		});
		return promise;
	}

	async #acquireTurn(route: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Aborted");
		const state = this.#state(route);
		const now = this.#now();
		const recent = (this.#grants.get(route) ?? []).filter(time => time > now - this.#pacing.windowMs);
		if (recent.length < state.rate) {
			this.#record(route, state, now);
			return;
		}
		const ordered = [...recent].sort((a, b) => a - b);
		const releaseAt = ordered[ordered.length - state.rate]! + this.#pacing.windowMs;
		if (signal?.aborted) throw new Error("Aborted");
		this.#record(route, state, releaseAt);
		try {
			await this.#wait(Math.max(1, releaseAt - now), signal);
		} catch (error) {
			this.#unrecord(route, releaseAt);
			throw error;
		}
		if (signal?.aborted) {
			this.#unrecord(route, releaseAt);
			throw new Error("Aborted");
		}
	}

	#record(route: string, state: RouteState, grantedAt: number): void {
		const slot = state.rate <= 0 ? 0 : Math.max(1, Math.floor(this.#pacing.windowMs / state.rate));
		state.nextAt = grantedAt + slot;
		const grants = [...(this.#grants.get(route) ?? [])];
		grants.push(grantedAt);
		this.#grants.set(route, grants);
		if (grantedAt - Math.max(state.lastPenaltyAt ?? -Infinity, state.lastClimbAt) >= this.#pacing.windowMs && grants.length < state.rate) {
			state.rate = Math.min(this.#pacing.ceiling, state.rate + 2);
			state.lastClimbAt = grantedAt;
		}
	}

	#unrecord(route: string, grantedAt: number): void {
		const grants = [...(this.#grants.get(route) ?? [])];
		const index = grants.indexOf(grantedAt);
		if (index >= 0) grants.splice(index, 1);
		this.#grants.set(route, grants);
	}

	#state(route: string, now = this.#now()): RouteState {
		let state = this.#routes.get(route);
		if (!state) {
			state = { rate: this.#pacing.initial, lastClimbAt: now };
			this.#routes.set(route, state);
		}
		return state;
	}

}
