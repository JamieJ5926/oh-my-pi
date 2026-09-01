import { parseSessionAddress, type SessionAddress } from "./address";

export const MESSAGE_ENVELOPE_VERSION = 1 as const;
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

export interface ArtifactRef {
	readonly uri: string;
	readonly mediaType?: string;
	readonly byteLength?: number;
	readonly sha256?: string;
}

export type MessageBody =
	| { readonly kind: "payload"; readonly payload: unknown }
	| { readonly kind: "artifact"; readonly artifact: ArtifactRef };

export type DeliveryState =
	| { readonly kind: "created" }
	| { readonly kind: "queued" }
	| { readonly kind: "delivered"; readonly deliveredAt: number }
	| { readonly kind: "acknowledged"; readonly acknowledgedAt: number }
	| { readonly kind: "rejected"; readonly reason: string };

export interface MessageEnvelope {
	readonly version: typeof MESSAGE_ENVELOPE_VERSION;
	readonly id: string;
	readonly source: SessionAddress;
	readonly destination: SessionAddress;
	readonly body: MessageBody;
	readonly correlationId?: string;
	readonly sequence: number;
	readonly idempotencyKey: string;
	readonly delivery: DeliveryState;
	readonly createdAt: number;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Message envelope must be an object");
	return value as Record<string, unknown>;
}
function nonEmpty(value: unknown, name: string, max = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid message envelope ${name}`);
	return value;
}
function positiveInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid message envelope ${name}`);
	return value;
}
function timestamp(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid message envelope ${name}`);
	return value;
}
function parseArtifact(value: unknown): ArtifactRef {
	const r = record(value);
	const uri = nonEmpty(r.uri, "artifact uri", 2048);
	const mediaType = r.mediaType === undefined ? undefined : nonEmpty(r.mediaType, "artifact mediaType", 256);
	const byteLength = r.byteLength === undefined ? undefined : positiveInteger(r.byteLength, "artifact byteLength");
	const sha256 = r.sha256 === undefined ? undefined : nonEmpty(r.sha256, "artifact sha256", 128);
	return { uri, ...(mediaType === undefined ? {} : { mediaType }), ...(byteLength === undefined ? {} : { byteLength }), ...(sha256 === undefined ? {} : { sha256 }) };
}
function parseBody(value: unknown): MessageBody {
	const r = record(value);
	if (r.kind === "payload") return { kind: "payload", payload: r.payload };
	if (r.kind === "artifact") return { kind: "artifact", artifact: parseArtifact(r.artifact) };
	throw new Error("Invalid message envelope body");
}
export function createMessageEnvelope(input: Omit<MessageEnvelope, "version" | "delivery"> & { readonly delivery?: DeliveryState }): MessageEnvelope {
    const delivery: DeliveryState = input.delivery ?? { kind: "created" };
    const envelope: MessageEnvelope = Object.freeze({
        version: MESSAGE_ENVELOPE_VERSION,
        id: nonEmpty(input.id, "id"),
        source: parseSessionAddress(input.source),
        destination: parseSessionAddress(input.destination),
        body: parseBody(input.body),
        ...(input.correlationId === undefined ? {} : { correlationId: nonEmpty(input.correlationId, "correlationId") }),
        sequence: positiveInteger(input.sequence, "sequence"),
        idempotencyKey: nonEmpty(input.idempotencyKey, "idempotencyKey"),
        delivery,
        createdAt: timestamp(input.createdAt, "createdAt"),
    });
    return envelope;
}
export function parseMessageEnvelope(value: unknown): MessageEnvelope {
	const r = record(value);
	if (r.version !== MESSAGE_ENVELOPE_VERSION) throw new Error("Unsupported message envelope version");
	const deliveryValue = record(r.delivery);
	const deliveryKind = deliveryValue.kind;
	let delivery: DeliveryState;
	switch (deliveryKind) {
		case "created": delivery = { kind: "created" }; break;
		case "queued": delivery = { kind: "queued" }; break;
		case "delivered": delivery = { kind: "delivered", deliveredAt: timestamp(deliveryValue.deliveredAt, "deliveredAt") }; break;
		case "acknowledged": delivery = { kind: "acknowledged", acknowledgedAt: timestamp(deliveryValue.acknowledgedAt, "acknowledgedAt") }; break;
		case "rejected": delivery = { kind: "rejected", reason: nonEmpty(deliveryValue.reason, "rejection reason") }; break;
		default: throw new Error("Invalid message envelope delivery state");
	}
	return createMessageEnvelope({
		id: nonEmpty(r.id, "id"), source: parseSessionAddress(r.source), destination: parseSessionAddress(r.destination), body: parseBody(r.body),
		correlationId: r.correlationId === undefined ? undefined : nonEmpty(r.correlationId, "correlationId"), sequence: positiveInteger(r.sequence, "sequence"),
		idempotencyKey: nonEmpty(r.idempotencyKey, "idempotencyKey"), delivery, createdAt: timestamp(r.createdAt, "createdAt"),
	});
}
export function transitionEnvelope(envelope: MessageEnvelope, next: DeliveryState): MessageEnvelope {
	const current = envelope.delivery.kind;
	const target = next.kind;
	const legal = (current === "created" && target === "queued") || (current === "queued" && (target === "delivered" || target === "rejected")) || (current === "delivered" && target === "acknowledged");
	if (!legal) throw new Error(`Illegal delivery transition ${current} -> ${target}`);
	return Object.freeze({ ...envelope, delivery: next });
}
