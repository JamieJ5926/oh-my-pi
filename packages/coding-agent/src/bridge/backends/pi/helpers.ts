export const DEFAULT_PI_COMMAND = "pi";
export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_EVENT_BUFFER = 512;

export interface AsyncQueue<T> {
	readonly values: AsyncIterable<T>;
	push(value: T): void;
	close(error?: Error): void;
	readonly size: number;
}

export function createAsyncQueue<T>(maxSize: number = DEFAULT_EVENT_BUFFER): AsyncQueue<T> {
	if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error("Queue size must be a positive integer");
	const pending: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
	const buffered: T[] = [];
	let closed = false;
	let failure: Error | undefined;
	const push = (value: T): void => {
		if (closed) return;
		const waiter = pending.shift();
		if (waiter) waiter.resolve({ done: false, value });
		else {
			if (buffered.length >= maxSize) buffered.shift();
			buffered.push(value);
		}
	};
	const close = (error?: Error): void => {
		if (closed) return;
		closed = true;
		failure = error;
		while (pending.length > 0) {
			const waiter = pending.shift();
			if (failure) waiter?.reject(failure);
			else waiter?.resolve({ done: true, value: undefined });
		}
	};
	const values: AsyncIterable<T> = {
		[Symbol.asyncIterator]: () => ({
			next: (): Promise<IteratorResult<T>> => {
				if (buffered.length > 0) return Promise.resolve({ done: false, value: buffered.shift()! });
				if (closed) return failure ? Promise.reject(failure) : Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<T>>((resolve, reject) => pending.push({ resolve, reject }));
			},
		}),
	};
	return { values, push, close, get size() { return buffered.length; } };
}

export function abortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Operation aborted");
}

export function onceAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
	if (!signal) return () => undefined;
	if (signal.aborted) callback();
	else signal.addEventListener("abort", callback, { once: true });
	return () => signal.removeEventListener("abort", callback);
}

export function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
