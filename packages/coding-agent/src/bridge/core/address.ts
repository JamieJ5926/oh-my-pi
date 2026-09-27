const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

export type SessionGeneration = number & { readonly __sessionGeneration: unique symbol };

export interface SessionAddress {
	readonly namespace: string;
	readonly host: string;
	readonly process: string;
	readonly backend: string;
	readonly session: string;
	readonly generation: SessionGeneration;
}

export interface SessionIdentity {
	readonly namespace: string;
	readonly host: string;
	readonly process: string;
	readonly backend: string;
	readonly session: string;
}

function assertSegment(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128 || !SEGMENT_PATTERN.test(value)) {
		throw new Error(`Invalid session address ${field}`);
	}
	return value;
}

function isSessionGeneration(value: unknown): value is SessionGeneration {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function generation(value: unknown): SessionGeneration {
	if (!isSessionGeneration(value)) throw new Error("Invalid session address generation");
	return value;
}

export function createSessionAddress(input: {
	readonly namespace: string;
	readonly host: string;
	readonly process: string;
	readonly backend: string;
	readonly session: string;
	readonly generation: number;
}): SessionAddress {
	return Object.freeze({
		namespace: assertSegment(input.namespace, "namespace"),
		host: assertSegment(input.host, "host"),
		process: assertSegment(input.process, "process"),
		backend: assertSegment(input.backend, "backend"),
		session: assertSegment(input.session, "session"),
		generation: generation(input.generation),
	});
}

export function formatSessionAddress(address: SessionAddress): string {
	const checked = createSessionAddress(address);
	return `${checked.namespace}://${checked.host}/${checked.process}/${checked.backend}/${checked.session}#${checked.generation}`;
}

export function parseSessionAddress(value: unknown): SessionAddress {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		if (!("namespace" in value) || !("host" in value) || !("process" in value) || !("backend" in value) || !("session" in value) || !("generation" in value)) {
			throw new Error("Invalid session address");
		}
		return createSessionAddress({
			namespace: assertSegment(value.namespace, "namespace"),
			host: assertSegment(value.host, "host"),
			process: assertSegment(value.process, "process"),
			backend: assertSegment(value.backend, "backend"),
			session: assertSegment(value.session, "session"),
			generation: generation(value.generation),
		});
	}
	if (typeof value !== "string" || value.length > 700) throw new Error("Invalid session address");
	const match = /^(?<namespace>[A-Za-z0-9._~-]+):\/\/(?<host>[A-Za-z0-9._~-]+)\/(?<process>[A-Za-z0-9._~-]+)\/(?<backend>[A-Za-z0-9._~-]+)\/(?<session>[A-Za-z0-9._~-]+)#(?<generation>[1-9][0-9]*)$/.exec(value);
	if (!match?.groups) throw new Error("Invalid session address format");
	const parsedGeneration = Number(match.groups.generation);
	return createSessionAddress({
		namespace: match.groups.namespace,
		host: match.groups.host,
		process: match.groups.process,
		backend: match.groups.backend,
		session: match.groups.session,
		generation: parsedGeneration,
	});
}

export function sessionIdentity(address: SessionAddress): SessionIdentity {
	const checked = createSessionAddress(address);
	return { namespace: checked.namespace, host: checked.host, process: checked.process, backend: checked.backend, session: checked.session };
}

export function formatSessionIdentity(identity: SessionIdentity): string {
	const checked = createSessionAddress({ ...identity, generation: 1 });
	return `${checked.namespace}://${checked.host}/${checked.process}/${checked.backend}/${checked.session}`;
}

export function sameSessionIdentity(left: SessionAddress | SessionIdentity, right: SessionAddress | SessionIdentity): boolean {
	return left.namespace === right.namespace && left.host === right.host && left.process === right.process && left.backend === right.backend && left.session === right.session;
}
