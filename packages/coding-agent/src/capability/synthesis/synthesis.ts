import { createHash } from "node:crypto";

import type { EvidencePacket, EvidenceReference, Finding, Uncertainty } from "../contracts/evidence";
import {
	createSynthesisNodeId,
	type EvidencePacketId,
	type ManifestEntryId,
	type SynthesisNodeId,
} from "../contracts/ids";

export interface Contradiction {
	readonly summary: string;
	readonly claims: readonly string[];
	readonly evidence: readonly EvidenceReference[];
}

export interface SynthesisPacket {
	readonly synthesisNodeId: SynthesisNodeId;
	readonly sourcePacketIds: readonly EvidencePacketId[];
	readonly findings: readonly Finding[];
	readonly contradictions: readonly Contradiction[];
	readonly uncertainties: readonly Uncertainty[];
	readonly childNodeIds: readonly SynthesisNodeId[];
}

export interface SynthesisPolicy {
	readonly maxFanIn: number;
	readonly singleStepThreshold: number;
	readonly regionForPacket: (packet: EvidencePacket) => string;
}

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function evidenceKey(reference: EvidenceReference): string {
	return `${reference.manifestEntryId}:${reference.path}:${reference.symbol ?? ""}:${reference.lineRange?.join("-") ?? ""}`;
}

function mergePackets(
	nodeKey: string,
	packets: readonly EvidencePacket[],
	childNodeIds: readonly SynthesisNodeId[] = [],
): SynthesisPacket {
	const findingsBySummary = new Map<string, EvidenceReference[]>();
	const uncertaintyBySummary = new Map<string, EvidenceReference[]>();
	for (const packet of packets) {
		for (const finding of packet.findings) {
			if (finding.evidence.length === 0) throw new Error(`Unsupported finding: ${finding.summary}`);
			const existing = findingsBySummary.get(finding.summary) ?? [];
			for (const reference of finding.evidence)
				if (!existing.some(item => evidenceKey(item) === evidenceKey(reference))) existing.push(reference);
			findingsBySummary.set(finding.summary, existing);
		}
		for (const uncertainty of packet.uncertainties) {
			const existing = uncertaintyBySummary.get(uncertainty.summary) ?? [];
			for (const reference of uncertainty.evidence ?? [])
				if (!existing.some(item => evidenceKey(item) === evidenceKey(reference))) existing.push(reference);
			uncertaintyBySummary.set(uncertainty.summary, existing);
		}
	}
	const findings = [...findingsBySummary.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([summary, evidence]) => {
			const [first, ...rest] = evidence;
			if (!first) throw new Error(`Unsupported finding: ${summary}`);
			return { summary, evidence: [first, ...rest] as const };
		});
	const contradictions: Contradiction[] = [];
	for (let left = 0; left < findings.length; left += 1) {
		for (let right = left + 1; right < findings.length; right += 1) {
			const a = findings[left]!;
			const b = findings[right]!;
			const normalizedA = a.summary
				.replace(/\bnot\b/gi, "")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase();
			const normalizedB = b.summary
				.replace(/\bnot\b/gi, "")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase();
			if (normalizedA === normalizedB && /\bnot\b/i.test(a.summary) !== /\bnot\b/i.test(b.summary)) {
				contradictions.push({
					summary: `Contradictory claims: ${normalizedA}`,
					claims: [a.summary, b.summary],
					evidence: [...a.evidence, ...b.evidence],
				});
			}
		}
	}
	const uncertainties = [...uncertaintyBySummary.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([summary, evidence]) => ({ summary, ...(evidence.length ? { evidence } : {}) }));
	const sourcePacketIds = packets.map(packet => packet.packetId).sort();
	return {
		synthesisNodeId: createSynthesisNodeId(`synthesis_${sha(`${nodeKey}:${sourcePacketIds.join(":")}`)}`),
		sourcePacketIds,
		findings,
		contradictions,
		uncertainties,
		childNodeIds,
	};
}

export function buildSynthesisTree(
	packets: readonly EvidencePacket[],
	policy: SynthesisPolicy,
): readonly SynthesisPacket[] {
	if (policy.maxFanIn < 2 || policy.singleStepThreshold < 1) throw new Error("Invalid synthesis policy");
	const ordered = [...packets].sort((left, right) => left.packetId.localeCompare(right.packetId));
	if (ordered.length === 0) return [];
	if (ordered.length <= policy.singleStepThreshold) return [mergePackets("final", ordered)];
	const regions = new Map<string, EvidencePacket[]>();
	for (const packet of ordered) {
		const region = policy.regionForPacket(packet);
		const group = regions.get(region);
		if (group) group.push(packet);
		else regions.set(region, [packet]);
	}
	const regional = [...regions.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([region, group]) => {
			const nodes: SynthesisPacket[] = [];
			for (let index = 0; index < group.length; index += policy.maxFanIn)
				nodes.push(mergePackets(`region:${region}:${index}`, group.slice(index, index + policy.maxFanIn)));
			return nodes;
		});
	const syntheticPackets: EvidencePacket[] = regional.map(node => ({
		meta: packets[0]!.meta,
		packetId: node.sourcePacketIds[0]!,
		chunkId: packets[0]!.chunkId,
		attemptId: packets[0]!.attemptId,
		processedEntryIds: [],
		skippedEntries: [],
		findings: node.findings,
		uncertainties: node.uncertainties,
	}));
	return [
		...regional,
		mergePackets(
			"final",
			syntheticPackets,
			regional.map(node => node.synthesisNodeId),
		),
	];
}

export function reviewFinalSynthesis(
	packet: SynthesisPacket,
	knownEntryIds: ReadonlySet<ManifestEntryId>,
): SynthesisPacket {
	for (const finding of packet.findings) {
		if (finding.evidence.length === 0) throw new Error(`Final finding lacks evidence: ${finding.summary}`);
		for (const reference of finding.evidence)
			if (!knownEntryIds.has(reference.manifestEntryId))
				throw new Error(`Unknown final evidence identity: ${reference.manifestEntryId}`);
	}
	return packet;
}
