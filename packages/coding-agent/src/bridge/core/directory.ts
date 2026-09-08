import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatSessionIdentity, formatSessionAddress, parseSessionAddress, createSessionAddress, sessionIdentity, type SessionAddress, type SessionIdentity } from "./address";

export interface RevivalDescriptor {
	readonly backend: string;
	readonly session: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface SessionRegistration {
	readonly address: SessionAddress;
	readonly ttlMs: number;
	readonly revival?: RevivalDescriptor;
}

export type SessionRecord =
	| {
			readonly kind: "active";
			readonly address: SessionAddress;
			readonly registeredAt: number;
			readonly lastHeartbeatAt: number;
			readonly expiresAt: number;
			readonly revival?: RevivalDescriptor;
	  }
	| {
			readonly kind: "tombstone";
			readonly address: SessionAddress;
			readonly registeredAt: number;
			readonly tombstonedAt: number;
			readonly reason: string;
			readonly revival?: RevivalDescriptor;
	  };

export interface SessionClaim {
	readonly identity: SessionIdentity;
	readonly ttlMs: number;
	readonly revival?: RevivalDescriptor;
}

export type ClaimResult = Extract<SessionRecord, { kind: "active" }>;

export interface SessionGenerationAllocator {
	claimNext(claim: SessionClaim): Promise<ClaimResult>;
}

export type RegisterResult =
	| { readonly ok: true; readonly record: Extract<SessionRecord, { kind: "active" }> }
	| { readonly ok: false; readonly reason: "occupied" | "generation-conflict"; readonly current: SessionRecord };
export type HeartbeatResult =
	| { readonly ok: true; readonly record: Extract<SessionRecord, { kind: "active" }> }
	| { readonly ok: false; readonly reason: "not-found" | "generation-conflict" | "tombstoned"; readonly current?: SessionRecord };
export type CasResult =
	| { readonly ok: true; readonly record: SessionRecord }
	| { readonly ok: false; readonly reason: "not-found" | "generation-conflict" | "tombstoned"; readonly current?: SessionRecord };
export type TombstoneResult =
	| { readonly ok: true; readonly record: Extract<SessionRecord, { kind: "tombstone" }> }
	| { readonly ok: false; readonly reason: "not-found" | "generation-conflict" | "already-tombstoned"; readonly current?: SessionRecord };

export interface SessionDirectory {
	register(registration: SessionRegistration): Promise<RegisterResult>;
	heartbeat(address: SessionAddress, ttlMs: number): Promise<HeartbeatResult>;
	lookup(address: SessionAddress | SessionIdentity): Promise<SessionRecord | null>;
	compareAndSwap(address: SessionAddress, expectedGeneration: number, replacement: SessionRecord): Promise<CasResult>;
	tombstone(address: SessionAddress, reason: string): Promise<TombstoneResult>;
	purgeExpired(now?: number): Promise<number>;
}

const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

function validateIdentity(identity: SessionIdentity): SessionIdentity {
	return sessionIdentity(createSessionAddress({ ...identity, generation: 1 }));
}

function validTtl(ttlMs: number): number {
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new Error("Invalid session directory TTL");
	return ttlMs;
}

function identityKey(address: SessionAddress | SessionIdentity): string {
	return formatSessionIdentity(address);
}

function validateAddress(address: SessionAddress): SessionAddress {
	return parseSessionAddress(formatSessionAddress(address));
}

function validateRevival(revival: RevivalDescriptor | undefined): RevivalDescriptor | undefined {
	if (!revival) return undefined;
	if (typeof revival.backend !== "string" || revival.backend.length === 0 || revival.backend.length > 128) throw new Error("Invalid revival backend");
	if (typeof revival.session !== "string" || revival.session.length === 0 || revival.session.length > 256) throw new Error("Invalid revival session");
	return revival;
}

function validateRecord(record: SessionRecord): SessionRecord {
	const address = validateAddress(record.address);
	if (record.kind === "active") {
		if (!Number.isFinite(record.registeredAt) || !Number.isFinite(record.lastHeartbeatAt) || !Number.isFinite(record.expiresAt) || record.expiresAt <= record.lastHeartbeatAt) throw new Error("Invalid active session record");
		return Object.freeze({ ...record, address, revival: validateRevival(record.revival) });
	}
	if (!Number.isFinite(record.registeredAt) || !Number.isFinite(record.tombstonedAt) || typeof record.reason !== "string" || record.reason.length === 0) throw new Error("Invalid tombstone record");
	return Object.freeze({ ...record, address, revival: validateRevival(record.revival) });
}

export class InMemorySessionDirectory implements SessionDirectory, SessionGenerationAllocator {
	readonly #records = new Map<string, SessionRecord>();
	#lastGeneration = 0;


	async register(registration: SessionRegistration): Promise<RegisterResult> {
		const address = validateAddress(registration.address);
		const ttlMs = validTtl(registration.ttlMs);
		const key = identityKey(address);
		const now = Date.now();
		const current = this.#records.get(key);
		if (current?.kind === "active" && current.expiresAt > now) return { ok: false, reason: "occupied", current };
		if (current && current.address.generation >= address.generation) return { ok: false, reason: "generation-conflict", current };
		const record: ClaimResult = Object.freeze({ kind: "active", address, registeredAt: now, lastHeartbeatAt: now, expiresAt: now + ttlMs, revival: validateRevival(registration.revival) });
		this.#records.set(key, record);
		this.#lastGeneration = Math.max(this.#lastGeneration, address.generation);
		return { ok: true, record };
	}


	async claimNext(claim: SessionClaim): Promise<ClaimResult> {
		const identity = validateIdentity(claim.identity);
		const ttlMs = validTtl(claim.ttlMs);
		const revival = validateRevival(claim.revival);
		const observed = highestGeneration(this.#records.values(), this.#lastGeneration);
		if (observed >= Number.MAX_SAFE_INTEGER) throw new Error("Session generation exhausted");
		const address = createSessionAddress({ ...identity, generation: observed + 1 });
		const now = Date.now();
		const record: ClaimResult = Object.freeze({ kind: "active", address, registeredAt: now, lastHeartbeatAt: now, expiresAt: now + ttlMs, revival });
		this.#records.set(identityKey(identity), record);
		this.#lastGeneration = address.generation;
		return record;
	}

	async listActive(): Promise<ClaimResult[]> {
		const now = Date.now();
		return [...this.#records.values()].filter((record): record is ClaimResult => record.kind === "active" && record.expiresAt > now);
	}

	async heartbeat(address: SessionAddress, ttlMs: number): Promise<HeartbeatResult> {
		const checked = validateAddress(address);
		const current = this.#records.get(identityKey(checked));
		if (!current) return { ok: false, reason: "not-found" };
		if (current.address.generation !== checked.generation) return { ok: false, reason: "generation-conflict", current };
		if (current.kind !== "active") return { ok: false, reason: "tombstoned", current };
		const now = Date.now();
		if (current.expiresAt <= now) return { ok: false, reason: "not-found" };
		const record: Extract<SessionRecord, { kind: "active" }> = Object.freeze({ ...current, lastHeartbeatAt: now, expiresAt: now + validTtl(ttlMs) });
		this.#records.set(identityKey(checked), record);
		return { ok: true, record };
	}

	async lookup(address: SessionAddress | SessionIdentity): Promise<SessionRecord | null> {
		const current = this.#records.get(identityKey(address));
		if (!current) return null;
		if (current.kind === "active" && current.expiresAt <= Date.now()) return null;
		return current;
	}

	async compareAndSwap(address: SessionAddress, expectedGeneration: number, replacement: SessionRecord): Promise<CasResult> {
		const checked = validateAddress(address);
		if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error("Invalid expected generation");
		const current = this.#records.get(identityKey(checked));
		if (!current) return { ok: false, reason: "not-found" };
		if (current.address.generation !== expectedGeneration) return { ok: false, reason: "generation-conflict", current };
		if (current.kind === "tombstone") return { ok: false, reason: "tombstoned", current };
		const next = validateRecord(replacement);
		if (!sameIdentity(next.address, checked)) throw new Error("CAS replacement identity mismatch");
		this.#records.set(identityKey(checked), next);
		return { ok: true, record: next };
	}

	async tombstone(address: SessionAddress, reason: string): Promise<TombstoneResult> {
		const checked = validateAddress(address);
		if (reason.length === 0 || reason.length > 512) throw new Error("Invalid tombstone reason");
		const current = this.#records.get(identityKey(checked));
		if (!current) return { ok: false, reason: "not-found" };
		if (current.address.generation !== checked.generation) return { ok: false, reason: "generation-conflict", current };
		if (current.kind === "tombstone") return { ok: false, reason: "already-tombstoned", current };
		const record: Extract<SessionRecord, { kind: "tombstone" }> = Object.freeze({ kind: "tombstone", address: checked, registeredAt: current.registeredAt, tombstonedAt: Date.now(), reason, revival: current.revival });
		this.#records.set(identityKey(checked), record);
		return { ok: true, record };
	}

	async purgeExpired(now = Date.now()): Promise<number> {
		let count = 0;
		for (const [key, record] of this.#records) {
			if (record.kind === "active" && record.expiresAt <= now) {
				this.#records.delete(key);
				count++;
			}
		}
		return count;
	}
}

function sameIdentity(left: SessionAddress, right: SessionAddress): boolean {
	return identityKey(left) === identityKey(right);
}

function serializableRecords(records: Map<string, SessionRecord>): Record<string, SessionRecord> {
	return Object.fromEntries(records.entries());
}

function parseStored(value: unknown): Map<string, SessionRecord> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid session directory state");
	const records = new Map<string, SessionRecord>();
	for (const [key, raw] of Object.entries(value)) {
		const record = validateRecord(raw as SessionRecord);
		if (identityKey(record.address) !== key) throw new Error("Session directory identity mismatch");
		records.set(key, record);
	}
	return records;
}

function highestGeneration(records: Iterable<SessionRecord>, initial = 0): number {
	let highest = initial;
	for (const record of records) highest = Math.max(highest, record.address.generation);
	return highest;
}

interface GenerationState {
	readonly version: 1;
	readonly lastGeneration: number;
}

function parseGenerationState(value: unknown): GenerationState {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value) || !("lastGeneration" in value) || value.version !== 1 || typeof value.lastGeneration !== "number" || !Number.isSafeInteger(value.lastGeneration) || value.lastGeneration < 0) {
		throw new Error("Invalid session generation state");
	}
	return { version: 1, lastGeneration: value.lastGeneration };
}


type LockedChange<T> = { readonly result: T; readonly changed: boolean; readonly generation?: number };

export class FileSessionDirectory implements SessionDirectory, SessionGenerationAllocator {
 	readonly #path: string;
 	readonly #lockPath: string;
 	readonly #lockTimeoutMs: number;
	readonly #generationPath: string;

 	constructor(filePath: string, options: { readonly lockTimeoutMs?: number } = {}) {
 		if (!filePath) throw new Error("Session directory path is required");
 		this.#path = filePath;
 		this.#lockPath = `${filePath}.lock`;
		this.#generationPath = `${filePath}.generation`;
 		this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
 	}

	async #read(): Promise<Map<string, SessionRecord>> {
		try {
			const bytes = await readFile(this.#path);
			if (bytes.byteLength > MAX_DIRECTORY_BYTES) throw new Error("Session directory state exceeds byte limit");
			return parseStored(JSON.parse(bytes.toString("utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			throw error;
		}
	}

	async #write(records: Map<string, SessionRecord>): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const temp = join(dirname(this.#path), `.${this.#path.split("/").pop() ?? "directory"}.${randomUUID()}.tmp`);
		const bytes = Buffer.from(JSON.stringify(serializableRecords(records)));
		if (bytes.byteLength > MAX_DIRECTORY_BYTES) throw new Error("Session directory state exceeds byte limit");
		try {
			await writeFile(temp, bytes, { flag: "wx" });
			await rename(temp, this.#path);
		} finally {
			await rm(temp, { force: true });
		}
	}

	async #readGeneration(records: Map<string, SessionRecord>): Promise<GenerationState> {
		try {
			const bytes = await readFile(this.#generationPath);
			if (bytes.byteLength > 1024) throw new Error("Session generation state exceeds byte limit");
			return parseGenerationState(JSON.parse(bytes.toString("utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, lastGeneration: highestGeneration(records.values()) };
			throw error;
		}
	}

	async #writeGeneration(state: GenerationState): Promise<void> {
		await mkdir(dirname(this.#generationPath), { recursive: true });
		const temp = join(dirname(this.#generationPath), `.${this.#generationPath.split("/").pop() ?? "generation"}.${randomUUID()}.tmp`);
		const bytes = Buffer.from(JSON.stringify(state));
		try {
			await writeFile(temp, bytes, { flag: "wx" });
			await rename(temp, this.#generationPath);
		} finally {
			await rm(temp, { force: true });
		}
	}

	async #locked<T>(operation: (records: Map<string, SessionRecord>, lastGeneration: number) => Promise<LockedChange<T>>): Promise<T> {
		await mkdir(dirname(this.#lockPath), { recursive: true });
		const started = Date.now();
		while (true) {
			try {
				await mkdir(this.#lockPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - started > this.#lockTimeoutMs) throw error;
				await Bun.sleep(10);
			}
		}
		try {
			const records = await this.#read();
			const generation = await this.#readGeneration(records);
			const { result, changed, generation: nextGeneration } = await operation(records, generation.lastGeneration);
			if (nextGeneration !== undefined && nextGeneration > generation.lastGeneration) await this.#writeGeneration({ version: 1, lastGeneration: nextGeneration });
			if (changed) await this.#write(records);
			return result;
		} finally {
			await rm(this.#lockPath, { recursive: true, force: true });
		}
	}

	async register(registration: SessionRegistration): Promise<RegisterResult> {
		return this.#locked<RegisterResult>(async (records, lastGeneration): Promise<LockedChange<RegisterResult>> => {
			const result = await new InMemorySessionDirectory().register(registration);
			const current = records.get(identityKey(registration.address));
			if (!result.ok) return { result, changed: false };
			if (current?.kind === "active" && current.expiresAt > Date.now()) return { result: { ok: false, reason: "occupied", current }, changed: false };
			if (current && current.address.generation >= registration.address.generation) return { result: { ok: false, reason: "generation-conflict", current }, changed: false };
			records.set(identityKey(result.record.address), result.record);
			return { result, changed: true, generation: Math.max(lastGeneration, registration.address.generation) };
		});
	}

	async claimNext(claim: SessionClaim): Promise<ClaimResult> {
		const identity = validateIdentity(claim.identity);
		const ttlMs = validTtl(claim.ttlMs);
		const revival = validateRevival(claim.revival);
		return this.#locked<ClaimResult>(async (records, lastGeneration): Promise<LockedChange<ClaimResult>> => {
			const observed = highestGeneration(records.values(), lastGeneration);
			if (observed >= Number.MAX_SAFE_INTEGER) throw new Error("Session generation exhausted");
			const address = createSessionAddress({ ...identity, generation: observed + 1 });
			const now = Date.now();
			const record: ClaimResult = Object.freeze({ kind: "active", address, registeredAt: now, lastHeartbeatAt: now, expiresAt: now + ttlMs, revival });
			records.set(identityKey(identity), record);
			return { result: record, changed: true, generation: address.generation };
		});
	}

	async heartbeat(address: SessionAddress, ttlMs: number): Promise<HeartbeatResult> {
		return this.#locked<HeartbeatResult>(async records => {
			const current = records.get(identityKey(address));
			if (!current) return { result: { ok: false, reason: "not-found" }, changed: false };
			if (current.address.generation !== address.generation) return { result: { ok: false, reason: "generation-conflict", current }, changed: false };
			if (current.kind !== "active") return { result: { ok: false, reason: "tombstoned", current }, changed: false };
			const now = Date.now();
			if (current.expiresAt <= now) return { result: { ok: false, reason: "not-found" }, changed: false };
			const next: Extract<SessionRecord, { kind: "active" }> = { ...current, lastHeartbeatAt: now, expiresAt: now + validTtl(ttlMs) };
			records.set(identityKey(address), next);
			return { result: { ok: true, record: next }, changed: true };
		});
	}

	async lookup(address: SessionAddress | SessionIdentity): Promise<SessionRecord | null> {
		const records = await this.#read();
		const current = records.get(identityKey(address));
		return current?.kind === "active" && current.expiresAt <= Date.now() ? null : current ?? null;
	}

	async listActive(): Promise<ClaimResult[]> {
		const now = Date.now();
		return [...(await this.#read()).values()].filter((record): record is ClaimResult => record.kind === "active" && record.expiresAt > now);
	}

	async compareAndSwap(address: SessionAddress, expectedGeneration: number, replacement: SessionRecord): Promise<CasResult> {
		return this.#locked<CasResult>(async records => {
			const current = records.get(identityKey(address));
			if (!current) return { result: { ok: false, reason: "not-found" }, changed: false };
			if (current.address.generation !== expectedGeneration) return { result: { ok: false, reason: "generation-conflict", current }, changed: false };
			if (current.kind === "tombstone") return { result: { ok: false, reason: "tombstoned", current }, changed: false };
			const next = validateRecord(replacement);
			if (!sameIdentity(next.address, address)) throw new Error("CAS replacement identity mismatch");
			records.set(identityKey(address), next);
			return { result: { ok: true, record: next }, changed: true };
		});
	}

	async tombstone(address: SessionAddress, reason: string): Promise<TombstoneResult> {
		return this.#locked<TombstoneResult>(async records => {
			const current = records.get(identityKey(address));
			if (!current) return { result: { ok: false, reason: "not-found" }, changed: false };
			if (current.address.generation !== address.generation) return { result: { ok: false, reason: "generation-conflict", current }, changed: false };
			if (current.kind === "tombstone") return { result: { ok: false, reason: "already-tombstoned", current }, changed: false };
			const record: Extract<SessionRecord, { kind: "tombstone" }> = { kind: "tombstone", address, registeredAt: current.registeredAt, tombstonedAt: Date.now(), reason, revival: current.revival };
			records.set(identityKey(address), record);
			return { result: { ok: true, record }, changed: true };
		});
	}

	async purgeExpired(now = Date.now()): Promise<number> {
		return this.#locked<number>(async records => {
			let count = 0;
			for (const [key, record] of records) {
				if (record.kind === "active" && record.expiresAt <= now) {
					records.delete(key);
					count++;
				}
			}
			return { result: count, changed: count > 0 };
		});
	}
}
