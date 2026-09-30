import { createHash } from "node:crypto";
import * as path from "node:path";

import { createWriteWaves, type ChangePlan } from "./change";
import {
	createWriteManifestId,
	parseChangePlanId,
	parseChangeUnitId,
	parseOperationId,
	type ArtifactMeta,
	type ChangePlanId,
	type ChangeUnitId,
	type WriteManifestId,
} from "./ids";

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface WriteOperationInput {
	readonly kind: "full_content";
	readonly path: string;
	readonly content: string;
}

export interface WriteManifestEntryInput {
	readonly unitId: string;
	readonly writes: NonEmptyReadonlyArray<WriteOperationInput>;
}

export interface WriteManifestInput {
	readonly schemaVersion: "1";
	readonly operationId: string;
	readonly changePlanId: string;
	readonly planDigest: string;
	readonly entries: NonEmptyReadonlyArray<WriteManifestEntryInput>;
}

export interface WriteOperation {
	readonly kind: "full_content";
	readonly path: string;
	readonly content: string;
}

export interface WriteManifestEntry {
	readonly unitId: ChangeUnitId;
	readonly writes: NonEmptyReadonlyArray<WriteOperation>;
}

export interface WriteManifest {
	readonly meta: ArtifactMeta & { readonly schemaVersion: "1" };
	readonly writeManifestId: WriteManifestId;
	readonly changePlanId: ChangePlanId;
	readonly planDigest: string;
	readonly entries: NonEmptyReadonlyArray<WriteManifestEntry>;
}

export type ManifestIssueCode =
	| "schema_invalid"
	| "operation_id_mismatch"
	| "change_plan_id_mismatch"
	| "plan_digest_mismatch"
	| "unknown_unit"
	| "duplicate_unit_entry"
	| "missing_unit_entry"
	| "empty_writes"
	| "unsupported_operation"
	| "unsafe_path"
	| "path_not_owned"
	| "duplicate_unit_path"
	| "duplicate_wave_path"
	| "resource_limit";

export interface ManifestIssue {
	readonly code: ManifestIssueCode;
	readonly message: string;
	readonly unitId?: string;
	readonly path?: string;
}

export interface ParsedWriteManifest {
	readonly manifest: WriteManifest;
	readonly canonicalJson: string;
	readonly digest: string;
}

export interface WriteManifestInspection {
	readonly issues: readonly ManifestIssue[];
	readonly parsed?: ParsedWriteManifest;
}

const ISSUE_ORDER: Readonly<Record<ManifestIssueCode, number>> = {
	schema_invalid: 0,
	operation_id_mismatch: 1,
	change_plan_id_mismatch: 2,
	plan_digest_mismatch: 3,
	unknown_unit: 4,
	duplicate_unit_entry: 5,
	missing_unit_entry: 6,
	empty_writes: 7,
	unsupported_operation: 8,
	unsafe_path: 9,
	path_not_owned: 10,
	duplicate_unit_path: 11,
	duplicate_wave_path: 12,
	resource_limit: 13,
};

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

type UnknownObject = Readonly<Record<string, unknown>>;

const MAX_MANIFEST_ENTRIES = 128;
const MAX_MANIFEST_WRITES = 1024;
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every(key => allowed.has(key));
}

function normalizeRelativePath(value: string): string {
	return path.normalize(value);
}

function issue(
	issues: ManifestIssue[],
	code: ManifestIssueCode,
	message: string,
	unitId?: string,
	manifestPath?: string,
): void {
	issues.push({ code, message, ...(unitId === undefined ? {} : { unitId }), ...(manifestPath === undefined ? {} : { path: manifestPath }) });
}

function sortedIssues(issues: readonly ManifestIssue[]): readonly ManifestIssue[] {
	return [...issues].sort((left, right) =>
		ISSUE_ORDER[left.code] - ISSUE_ORDER[right.code]
		|| compareText(left.unitId ?? "", right.unitId ?? "")
		|| compareText(left.path ?? "", right.path ?? "")
		|| compareText(left.message, right.message),
	);
}

function canonicalBody(
	operationId: string,
	changePlanId: string,
	planDigest: string,
	entries: readonly WriteManifestEntry[],
): Record<string, unknown> {
	return {
		schemaVersion: "1",
		operationId,
		changePlanId,
		planDigest,
		entries: [...entries]
			.sort((left, right) => compareText(left.unitId, right.unitId))
			.map(entry => ({
				unitId: entry.unitId,
				writes: [...entry.writes]
					.sort((left, right) => compareText(left.path, right.path))
					.map(write => ({ kind: write.kind, path: write.path, content: write.content })),
			})),
	};
}

export function inspectWriteManifest(input: unknown, plan: ChangePlan, expectedPlanDigest: string): WriteManifestInspection {
 const issues: ManifestIssue[] = [];
 if (typeof input !== "object" || input === null || Array.isArray(input)) {
  issue(issues, "schema_invalid", "manifest must be an object");
  return { issues: sortedIssues(issues) };
 }
 const manifestInput = input as UnknownObject;
 if (!hasOnlyKeys(manifestInput, new Set(["schemaVersion", "operationId", "changePlanId", "planDigest", "entries"]))) issue(issues, "schema_invalid", "manifest must contain only schemaVersion, operationId, changePlanId, planDigest, and entries");
 if (manifestInput.schemaVersion !== "1") issue(issues, "schema_invalid", "schemaVersion must be \"1\"");
 const operationId = parseOperationId(manifestInput.operationId);
 if (operationId === undefined) issue(issues, "schema_invalid", "operationId must be a valid op_ identifier");
 else if (operationId !== plan.meta.operationId) issue(issues, "operation_id_mismatch", `${operationId} does not match ${plan.meta.operationId}`);
 const changePlanId = parseChangePlanId(manifestInput.changePlanId);
 if (changePlanId === undefined) issue(issues, "schema_invalid", "changePlanId must be a valid change_plan_ identifier");
 else if (changePlanId !== plan.changePlanId) issue(issues, "change_plan_id_mismatch", `${changePlanId} does not match ${plan.changePlanId}`);
 if (typeof manifestInput.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifestInput.planDigest)) issue(issues, "schema_invalid", "planDigest must be a lowercase SHA-256 digest");
 else if (manifestInput.planDigest !== expectedPlanDigest) issue(issues, "plan_digest_mismatch", `${manifestInput.planDigest} does not match ${expectedPlanDigest}`);
 const entriesInput = manifestInput.entries;
 if (!Array.isArray(entriesInput) || entriesInput.length === 0) issue(issues, "schema_invalid", "entries must be a non-empty array");
 if (Array.isArray(entriesInput) && entriesInput.length > MAX_MANIFEST_ENTRIES) issue(issues, "resource_limit", `entries exceeds ${MAX_MANIFEST_ENTRIES}`);
 let rawWriteCount = 0;
 if (Array.isArray(entriesInput)) for (const rawEntry of entriesInput) if (typeof rawEntry === "object" && rawEntry !== null && !Array.isArray(rawEntry) && "writes" in rawEntry && Array.isArray(rawEntry.writes)) rawWriteCount += rawEntry.writes.length;
 if (rawWriteCount > MAX_MANIFEST_WRITES) issue(issues, "resource_limit", `writes exceeds ${MAX_MANIFEST_WRITES}`);
 if (!Array.isArray(entriesInput) || entriesInput.length === 0 || entriesInput.length > MAX_MANIFEST_ENTRIES || rawWriteCount > MAX_MANIFEST_WRITES) return { issues: sortedIssues(issues) };
 // validation below assumes the bounded entries shape
 const manifestEntries = entriesInput;
	let totalContentBytes = 0;

	const planUnits = new Map(plan.units.map(unit => [unit.unitId, unit]));
	const waves = createWriteWaves(plan);
	const waveByUnit = new Map<ChangeUnitId, number>();
	waves.forEach((wave, waveIndex) => wave.unitIds.forEach(unitId => waveByUnit.set(unitId, waveIndex)));
	const seenEntries = new Set<ChangeUnitId>();
	const pathWaves = new Map<string, { unitId: ChangeUnitId; waveIndex: number }>();
	const parsedEntries: WriteManifestEntry[] = [];

 for (const rawEntry of manifestEntries) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
			issue(issues, "schema_invalid", "each entry must be an object");
			continue;
		}
		const manifestEntry = rawEntry as UnknownObject;
		if (!hasOnlyKeys(manifestEntry, new Set(["unitId", "writes"]))) {
			issue(issues, "schema_invalid", "each entry must contain only unitId and writes");
			continue;
		}
		const unitId = parseChangeUnitId(manifestEntry.unitId);
		if (unitId === undefined) {
			issue(issues, "schema_invalid", "entry unitId must be a valid change_unit_ identifier", String(manifestEntry.unitId ?? ""));
			continue;
		}
		const unit = planUnits.get(unitId);
		if (unit === undefined) issue(issues, "unknown_unit", `${unitId} is not in the plan`, unitId);
		if (seenEntries.has(unitId)) issue(issues, "duplicate_unit_entry", `${unitId} appears more than once`, unitId);
		seenEntries.add(unitId);
		if (!Array.isArray(manifestEntry.writes) || manifestEntry.writes.length === 0) {
			issue(issues, "empty_writes", `${unitId} must contain at least one write`, unitId);
			continue;
		}
		const seenPaths = new Set<string>();
		const writes: WriteOperation[] = [];
		for (const rawWrite of manifestEntry.writes) {
			if (typeof rawWrite !== "object" || rawWrite === null || Array.isArray(rawWrite)) {
				issue(issues, "schema_invalid", "each write must be an object", unitId);
				continue;
			}
			const manifestWrite = rawWrite as UnknownObject;
			if (!hasOnlyKeys(manifestWrite, new Set(["kind", "path", "content"]))) {
				issue(issues, "schema_invalid", "each write must contain only kind, path, and content", unitId);
				continue;
			}
			if (manifestWrite.kind !== "full_content") {
				issue(issues, "unsupported_operation", "write kind must be full_content", unitId);
				continue;
			}
			if (typeof manifestWrite.path !== "string" || manifestWrite.path.trim().length === 0 || typeof manifestWrite.content !== "string") {
				issue(issues, "schema_invalid", "write path must be non-blank and content must be a string", unitId);
				continue;
			}
			const rawPath = manifestWrite.path;
			const contentBytes = new TextEncoder().encode(manifestWrite.content).byteLength;
			totalContentBytes += contentBytes;
			if (rawPath.length > MAX_PATH_LENGTH) {
				issue(issues, "resource_limit", `${rawPath} exceeds the path length limit`, unitId, rawPath);
				continue;
			}
			if (contentBytes > MAX_FILE_CONTENT_BYTES) {
				issue(issues, "resource_limit", `${rawPath} exceeds the per-file content limit`, unitId, rawPath);
				continue;
			}
			if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
				issue(issues, "resource_limit", "manifest exceeds the aggregate content limit", unitId, rawPath);
				continue;
			}
			const normalizedPath = normalizeRelativePath(rawPath);
			const unsafePath = rawPath.includes("\0")
				|| path.isAbsolute(rawPath)
				|| path.win32.isAbsolute(rawPath)
				|| normalizedPath === "."
				|| normalizedPath === ".."
				|| normalizedPath.startsWith(`..${path.sep}`)
				|| /(^|[\\/])\.\.([\\/]|$)/.test(rawPath);
			if (unsafePath) {
				issue(issues, "unsafe_path", `${rawPath} must stay within the workspace`, unitId, normalizedPath);
				continue;
			}
			if (seenPaths.has(normalizedPath)) issue(issues, "duplicate_unit_path", `${normalizedPath} appears more than once in ${unitId}`, unitId, normalizedPath);
			seenPaths.add(normalizedPath);
			if (unit !== undefined && !unit.ownedPaths.some(ownedPath => normalizeRelativePath(ownedPath) === normalizedPath)) {
				issue(issues, "path_not_owned", `${normalizedPath} is not owned by ${unitId}`, unitId, normalizedPath);
			}
			const waveIndex = waveByUnit.get(unitId);
			const prior = pathWaves.get(normalizedPath);
			if (waveIndex !== undefined && prior !== undefined && prior.waveIndex === waveIndex && prior.unitId !== unitId) {
				issue(issues, "duplicate_wave_path", `${normalizedPath} is written by ${prior.unitId} and ${unitId} in wave ${waveIndex}`, unitId, normalizedPath);
			}
			if (waveIndex !== undefined) pathWaves.set(normalizedPath, { unitId, waveIndex });
			writes.push({ kind: "full_content", path: normalizedPath, content: manifestWrite.content });
		}
		const firstWrite = writes[0];
		if (firstWrite !== undefined) parsedEntries.push({ unitId, writes: [firstWrite, ...writes.slice(1)] });
	}

	for (const unit of plan.units) {
		if (!seenEntries.has(unit.unitId)) issue(issues, "missing_unit_entry", `${unit.unitId} has no manifest entry`, unit.unitId);
	}
	const orderedIssues = sortedIssues(issues);
	const firstEntry = parsedEntries[0];
	if (orderedIssues.length > 0 || operationId === undefined || changePlanId === undefined || firstEntry === undefined) {
		return { issues: orderedIssues };
	}
	const entries: NonEmptyReadonlyArray<WriteManifestEntry> = [firstEntry, ...parsedEntries.slice(1)];
	const body = canonicalBody(operationId, changePlanId, expectedPlanDigest, entries);
	const canonicalJson = JSON.stringify(body);
	const digest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
	const manifest: WriteManifest = {
		meta: { schemaVersion: "1", createdAt: plan.meta.createdAt, operationId },
		writeManifestId: createWriteManifestId(`write_manifest_${digest}`),
		changePlanId,
		planDigest: expectedPlanDigest,
		entries,
	};
	return { issues: [], parsed: { manifest, canonicalJson, digest } };
}
