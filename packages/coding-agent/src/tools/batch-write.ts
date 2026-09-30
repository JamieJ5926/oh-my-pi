import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";

import { canonicalChangePlanJson, createWriteWaves, parseChangePlan, type ChangePlan } from "../capability/contracts/change";
import type { CapabilityError, IntegrationState, PatchRecord } from "../capability/contracts/integration";
import { transitionIntegration } from "../capability/contracts/integration";
import { createBatchWriteReceiptId, createPatchId, type ChangeUnitId } from "../capability/contracts/ids";
import { inspectWriteManifest, type ManifestIssue, type WriteManifestEntry } from "../capability/contracts/write-manifest";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import batchWriteDescription from "../prompts/tools/batch-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { OutputMeta } from "./output-meta";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { toolResult } from "./tool-result";

const writeOperationSchema = type({
	kind: type("'full_content'"),
	path: "string > 0",
	content: "string",
});

const writeManifestEntrySchema = type({
	unitId: "string > 0",
	writes: writeOperationSchema.array().atLeastLength(1),
});

const writeManifestSchema = type({
	schemaVersion: type("'1'"),
	operationId: "string > 0",
	changePlanId: "string > 0",
	planDigest: "string > 0",
	entries: writeManifestEntrySchema.array().atLeastLength(1),
});

const batchWriteSchema = type({
	artifactUri: "string > 0",
	manifest: writeManifestSchema,
});
const MAX_PLAN_ARTIFACT_BYTES = 2 * 1024 * 1024;
type BatchWriteParams = typeof batchWriteSchema.infer;

interface OrderedWrite {
	readonly unitId: ChangeUnitId;
	readonly path: string;
	readonly content: string;
}

async function isPathSafeWithinWorkspace(targetPath: string, cwd: string): Promise<boolean> {
	const absoluteCwd = await fs.realpath(cwd);
	const absolutePath = path.resolve(absoluteCwd, targetPath);
	if (!absolutePath.startsWith(`${absoluteCwd}${path.sep}`) || absolutePath === absoluteCwd) return false;
	let candidate = absolutePath;
	while (candidate.startsWith(absoluteCwd) && candidate !== absoluteCwd) {
		try {
			await fs.access(candidate);
			const realPath = await fs.realpath(candidate);
			return realPath.startsWith(`${absoluteCwd}${path.sep}`);
		} catch {
			candidate = path.dirname(candidate);
		}
	}
	return true;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function toCapabilityError(error: unknown, code: string, context: Readonly<Record<string, unknown>> = {}): CapabilityError {
	return { code, message: error instanceof Error ? error.message : String(error), retryable: false, context };
}

function localOptions(session: ToolSession): LocalProtocolOptions {
	return session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? session.cwd,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
}

async function publishArtifact(session: ToolSession, uri: string, bytes: string, token: string): Promise<void> {
	const options = localOptions(session);
	const artifactRoot = options.getArtifactsDir?.() ?? session.cwd;
	await fs.mkdir(artifactRoot, { recursive: true });
	const realArtifactRoot = await fs.realpath(artifactRoot);
	const target = resolveLocalUrlToPath(uri, options);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const realParent = await fs.realpath(path.dirname(target));
	if (!realParent.startsWith(`${realArtifactRoot}${path.sep}`) && realParent !== realArtifactRoot) throw new Error("Artifact directory escapes the artifact root");
	const safeTarget = path.join(realParent, path.basename(target));
	try {
		const existing = await fs.readFile(safeTarget, "utf8");
		if (existing !== bytes) throw new Error(`Artifact collision at ${uri}`);
		return;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const safeToken = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
	const temporary = `${safeTarget}.tmp-${safeToken}`;
	await fs.writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
	try {
		await fs.link(temporary, safeTarget);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		const existing = await fs.readFile(safeTarget, "utf8");
		if (existing !== bytes) throw new Error(`Artifact collision at ${uri}`);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function writeExactManifestContent(
	session: ToolSession,
	relativePath: string,
	content: string,
	token: string,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Batch write aborted");
	const absoluteCwd = await fs.realpath(session.cwd);
	const requestedTarget = path.resolve(absoluteCwd, relativePath);
	await fs.mkdir(path.dirname(requestedTarget), { recursive: true });
	const realParent = await fs.realpath(path.dirname(requestedTarget));
	if (!realParent.startsWith(`${absoluteCwd}${path.sep}`) && realParent !== absoluteCwd) throw new Error(`Refusing unsafe path ${relativePath}`);
	const target = path.join(realParent, path.basename(requestedTarget));
	let existingMode: number | undefined;
	try {
		const existing = await fs.lstat(target);
		if (existing.isSymbolicLink() || existing.isDirectory()) throw new Error(`Refusing non-file target ${relativePath}`);
		existingMode = existing.mode & 0o7777;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const safeToken = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
	const temporary = path.join(realParent, `.batch-write-${safeToken}.tmp`);
	await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	if (existingMode !== undefined) await fs.chmod(temporary, existingMode);
	try {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Batch write aborted");
		const currentParent = await fs.realpath(path.dirname(requestedTarget));
		if (currentParent !== realParent) throw new Error(`Parent changed during batch write for ${relativePath}`);
		await fs.rename(temporary, target);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	const actual = await fs.readFile(target, "utf8");
	if (actual !== content) throw new Error(`Applied content differs from manifest for ${relativePath}`);
	invalidateFsScanAfterWrite(target);
	session.bumpFileMutationVersion?.(target);
	session.fileSnapshotStore?.invalidate(target);
}

function orderedEntries(plan: ChangePlan, entries: readonly WriteManifestEntry[]): readonly OrderedWrite[] {
	const entriesByUnit = new Map(entries.map(entry => [entry.unitId, entry]));
	const result: OrderedWrite[] = [];
	for (const wave of createWriteWaves(plan)) {
		for (const unitId of wave.unitIds) {
			const entry = entriesByUnit.get(unitId);
			if (entry === undefined) throw new Error(`Missing manifest entry for ${unitId}`);
			for (const write of [...entry.writes].sort((left, right) => compareText(left.path, right.path))) {
				result.push({ unitId, path: write.path, content: write.content });
			}
		}
	}
	return result;
}

function statesList(plan: ChangePlan, states: ReadonlyMap<ChangeUnitId, IntegrationState>): Array<{ unitId: string; state: IntegrationState }> {
	return plan.units.map(unit => ({ unitId: unit.unitId, state: states.get(unit.unitId) ?? { kind: "pending" } }));
}

function patchList(patches: readonly PatchRecord[]): Array<{ patchId: string; unitId: string; touchedPaths: readonly string[] }> {
	return patches.map(patch => ({ patchId: patch.patchId, unitId: patch.unitId, touchedPaths: patch.touchedPaths }));
}

interface BatchWriteDetails {
	status: "applied" | "preflight_rejected" | "manifest_persistence_failed" | "runtime_failed" | "receipt_persistence_failed";
	manifestUri?: string;
	receiptUri?: string;
	failedUnitId?: string;
	waves: Array<{ waveId: string; unitIds: readonly string[] }>;
	patches: Array<{ patchId: string; unitId: string; touchedPaths: readonly string[] }>;
	states: Array<{ unitId: string; state: IntegrationState }>;
	appliedPaths: string[];
	pendingPaths: string[];
	issues?: readonly ManifestIssue[];
	error?: CapabilityError;
	cause?: CapabilityError;
	meta?: OutputMeta;
}

export class BatchWriteTool implements AgentTool<typeof batchWriteSchema, BatchWriteDetails> {
	readonly name = "batch_write";
	readonly label = "Batch Write";
	readonly summary = "Execute a multi-unit change plan with dependency-ordered file writes";
	readonly description = batchWriteDescription;
	readonly parameters = batchWriteSchema;
	readonly strict = true;
	readonly lenientArgValidation = true;
	readonly approval = (): "write" => "write";

	readonly formatApprovalDetails = (args: unknown): string[] => {
		if (typeof args !== "object" || args === null || Array.isArray(args) || !("manifest" in args)) {
			return ["(batch write: manifest not inspectable)"];
		}
		const manifest = args.manifest;
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest) || !("entries" in manifest) || !Array.isArray(manifest.entries)) {
			return ["(batch write: manifest not inspectable)"];
		}
		const paths: string[] = [];
		for (const entry of manifest.entries) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("writes" in entry) || !Array.isArray(entry.writes)) continue;
			for (const write of entry.writes) {
				if (typeof write === "object" && write !== null && !Array.isArray(write) && "path" in write && typeof write.path === "string") paths.push(write.path);
			}
		}
		return paths.length === 0 ? ["(batch write: no target paths)"] : [...new Set(paths)].sort(compareText);
	};

	constructor(private readonly session: ToolSession) {}

	async execute(
		toolCallId: string,
		params: BatchWriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BatchWriteDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BatchWriteDetails>> {
 		const raw = params as unknown;
 		const requestIssues: ManifestIssue[] = [];
 		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
 			requestIssues.push({ code: "schema_invalid", message: "batch write arguments must be an object" });
 		} else {
 			const request = raw as Record<string, unknown>;
 			if (Object.keys(request).some(key => key !== "artifactUri" && key !== "manifest")) requestIssues.push({ code: "schema_invalid", message: "batch write arguments must contain only artifactUri and manifest" });
 			if (typeof request.artifactUri !== "string" || request.artifactUri.trim().length === 0) requestIssues.push({ code: "schema_invalid", message: "artifactUri must be a non-blank string" });
 			const manifest = request.manifest;
 			if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) requestIssues.push({ code: "schema_invalid", message: "manifest must be an object" });
 			else {
 				const m = manifest as Record<string, unknown>;
 				if (Object.keys(m).some(key => !["schemaVersion", "operationId", "changePlanId", "planDigest", "entries"].includes(key))) requestIssues.push({ code: "schema_invalid", message: "manifest must contain only schemaVersion, operationId, changePlanId, planDigest, and entries" });
 				if (!("entries" in m) || !Array.isArray(m.entries)) requestIssues.push({ code: "schema_invalid", message: "entries must be a non-empty array" });
 			}
 		}
 		if (requestIssues.length > 0) {
			const details: BatchWriteDetails = { status: "preflight_rejected", waves: [], patches: [], states: [], appliedPaths: [], pendingPaths: [], issues: requestIssues };
			const example = `Example: { artifactUri: "local://plan.json", manifest: { schemaVersion: "1", operationId: "op_example", changePlanId: "change_plan_example", planDigest: "<sha256>", entries: [] } }`;
			return toolResult<BatchWriteDetails>(details).text([...requestIssues.map(item => `${item.code}: ${item.message}`), example].join("\n")).error().done();
 		}
		const invalidArtifact = (message: string): AgentToolResult<BatchWriteDetails> => toolResult<BatchWriteDetails>({
			status: "preflight_rejected",
			waves: [],
			patches: [],
			states: [],
			appliedPaths: [],
			pendingPaths: [],
			issues: [{ code: "schema_invalid", message }],
		}).text(message).error().done();
		let artifactValue: unknown;
		try {
			const artifactPath = resolveLocalUrlToPath(params.artifactUri, localOptions(this.session));
			const artifactStat = await fs.stat(artifactPath);
			if (!artifactStat.isFile()) return invalidArtifact("Plan artifact must be a file");
			if (artifactStat.size > MAX_PLAN_ARTIFACT_BYTES) return invalidArtifact("Plan artifact exceeds the size limit");
			artifactValue = JSON.parse(await fs.readFile(artifactPath, "utf8"));
		} catch (error) {
			return invalidArtifact(error instanceof Error ? error.message : String(error));
		}
		if (
			typeof artifactValue !== "object"
			|| artifactValue === null
			|| Array.isArray(artifactValue)
			|| Object.keys(artifactValue).sort().join(",") !== "order,plan,planDigest,waves"
			|| !("plan" in artifactValue)
			|| !("planDigest" in artifactValue)
			|| !("waves" in artifactValue)
			|| !("order" in artifactValue)
			|| typeof artifactValue.planDigest !== "string"
			|| !Array.isArray(artifactValue.waves)
			|| !Array.isArray(artifactValue.order)
			|| !/^[a-f0-9]{64}$/.test(artifactValue.planDigest)
		) {
			return invalidArtifact("Plan artifact must contain exactly plan, planDigest, waves, and order");
		}
		let plan: ChangePlan;
		try {
			plan = parseChangePlan(artifactValue.plan);
		} catch (error) {
			return invalidArtifact(error instanceof Error ? error.message : String(error));
		}
		const planDigest = createHash("sha256").update(canonicalChangePlanJson(plan), "utf8").digest("hex");
		if (planDigest !== artifactValue.planDigest) return invalidArtifact("Plan artifact digest does not match its contents");
		const waves = createWriteWaves(plan);
		const serializedWaves = waves.map(wave => ({ waveId: wave.waveId, unitIds: wave.unitIds }));
		const order = waves.flatMap(wave => [...wave.unitIds]);
		if (JSON.stringify(artifactValue.waves) !== JSON.stringify(serializedWaves) || JSON.stringify(artifactValue.order) !== JSON.stringify(order)) {
			return invalidArtifact("Plan artifact schedule does not match the structural plan");
		}
		const emptyDetails = (): BatchWriteDetails => ({
			status: "preflight_rejected",
			waves: waves.map(wave => ({ waveId: wave.waveId, unitIds: wave.unitIds })),
			patches: [],
			states: plan.units.map(unit => ({ unitId: unit.unitId, state: { kind: "pending" } })),
			appliedPaths: [],
			pendingPaths: [],
		});
		const inspection = inspectWriteManifest(params.manifest, plan, planDigest);
		if (inspection.parsed === undefined) {
			const details = { ...emptyDetails(), status: "preflight_rejected" as const, issues: inspection.issues };
			return toolResult(details).text(inspection.issues.map(item => `${item.code}: ${item.message}`).join("\n")).error().done();
		}
		const { manifest, canonicalJson, digest } = inspection.parsed;
		const safetyIssues: ManifestIssue[] = [];
		for (const entry of manifest.entries) {
			for (const write of entry.writes) {
				if (!(await isPathSafeWithinWorkspace(write.path, this.session.cwd))) {
					safetyIssues.push({ code: "unsafe_path", message: `${write.path} escapes the workspace`, unitId: entry.unitId, path: write.path });
				}
			}
		}
		if (safetyIssues.length > 0) {
			safetyIssues.sort((left, right) => compareText(left.unitId ?? "", right.unitId ?? "") || compareText(left.path ?? "", right.path ?? ""));
			const details = { ...emptyDetails(), status: "preflight_rejected" as const, issues: safetyIssues };
			return toolResult(details).text(safetyIssues.map(item => `${item.code}: ${item.message}`).join("\n")).error().done();
		}
		const manifestUri = `local://batch-manifest-${digest}.json`;
		const manifestBytes = JSON.stringify({ writeManifestId: manifest.writeManifestId, manifest: JSON.parse(canonicalJson) }, null, 2);
		try {
			await publishArtifact(this.session, manifestUri, manifestBytes, toolCallId);
		} catch (error) {
			const details = {
				...emptyDetails(),
				status: "manifest_persistence_failed" as const,
				error: toCapabilityError(error, "manifest_persistence_failed"),
			};
			return toolResult(details).text(details.error.message).error().done();
		}

		const writes = orderedEntries(plan, manifest.entries);
		const writeToolCallBase = `${toolCallId}_${digest.slice(0, 12)}`;
		const states = new Map<ChangeUnitId, IntegrationState>(plan.units.map(unit => [unit.unitId, { kind: "pending" }]));
		const patches: PatchRecord[] = [];
		const appliedKeys = new Set<string>();
		const appliedPaths: string[] = [];
		const key = (write: OrderedWrite): string => `${write.unitId}\0${write.path}`;
		const startedAt = new Date().toISOString();
		let failedUnitId: ChangeUnitId | undefined;
		let runtimeError: CapabilityError | undefined;

		for (const wave of waves) {
			if (runtimeError !== undefined) break;
			for (const unitId of wave.unitIds) {
				const unitWrites = writes.filter(write => write.unitId === unitId);
				const patchId = createPatchId(`patch_${unitId}_${digest.slice(0, 12)}`);
				const patch: PatchRecord = {
					meta: { schemaVersion: "1", createdAt: startedAt, operationId: plan.meta.operationId },
					patchId,
					unitId,
					baseRevision: "r0",
					touchedPaths: unitWrites.map(write => write.path),
					patchPath: manifestUri,
					validation: { kind: "accepted" },
				};
				patches.push(patch);
				let state: IntegrationState = transitionIntegration(states.get(unitId) ?? { kind: "pending" }, { kind: "applying", patchId });
				states.set(unitId, state);
				try {
					for (const write of unitWrites) {
						if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Batch write aborted");
						if (!(await isPathSafeWithinWorkspace(write.path, this.session.cwd))) throw new Error(`Refusing unsafe path ${write.path}`);
						await writeExactManifestContent(
							this.session,
							write.path,
							write.content,
							`${writeToolCallBase}_${patchId}_${appliedPaths.length}`,
							signal,
						);
						appliedKeys.add(key(write));
						appliedPaths.push(write.path);
					}
					state = transitionIntegration(state, { kind: "accepted", patchId, revision: `rev_${Date.now()}_${unitId}` });
					states.set(unitId, state);
				} catch (error) {
					runtimeError = toCapabilityError(error, "writer_failure", { unitId });
					failedUnitId = unitId;
					state = transitionIntegration(state, { kind: "rejected", patchId, error: runtimeError });
					states.set(unitId, state);
					break;
				}
			}
		}

		const pendingPaths = writes.filter(write => !appliedKeys.has(key(write))).map(write => write.path);
		const receiptStatus = runtimeError === undefined ? "applied" : "runtime_failed";
		const receiptDigest = createHash("sha256").update(`${digest}\0${toolCallId}`, "utf8").digest("hex");
		const receiptId = createBatchWriteReceiptId(`write_receipt_${receiptDigest}`);
		const receiptUri = `local://batch-write-receipt-${receiptDigest}.json`;
		const receipt = {
			receiptId,
			status: receiptStatus,
			planArtifactUri: params.artifactUri,
			planDigest,
			manifestUri,
			writeManifestId: manifest.writeManifestId,
			startedAt,
			endedAt: new Date().toISOString(),
			patches: patchList(patches),
			states: statesList(plan, states),
			appliedPaths,
			pendingPaths,
			...(failedUnitId === undefined ? {} : { failedUnitId }),
			...(runtimeError === undefined ? {} : { error: runtimeError }),
		};
		try {
			await publishArtifact(this.session, receiptUri, JSON.stringify(receipt, null, 2), `${toolCallId}-receipt`);
		} catch (error) {
			const details: BatchWriteDetails = {
				status: "receipt_persistence_failed",
				manifestUri,
				failedUnitId,
				waves: waves.map(wave => ({ waveId: wave.waveId, unitIds: wave.unitIds })),
				patches: patchList(patches),
				states: statesList(plan, states),
				appliedPaths,
				pendingPaths,
				error: toCapabilityError(error, "receipt_persistence_failed"),
				cause: runtimeError,
			};
			return toolResult(details).text(details.error?.message ?? "Receipt persistence failed").error().done();
		}
		const details: BatchWriteDetails = {
			status: receiptStatus,
			manifestUri,
			receiptUri,
			failedUnitId,
			waves: waves.map(wave => ({ waveId: wave.waveId, unitIds: wave.unitIds })),
			patches: patchList(patches),
			states: statesList(plan, states),
			appliedPaths,
			pendingPaths,
			error: runtimeError,
		};
		const summary = [
			`Status: ${receiptStatus}`,
			`Manifest: ${manifestUri}`,
			`Receipt: ${receiptUri}`,
			`Applied paths: ${appliedPaths.length === 0 ? "(none)" : appliedPaths.join(", ")}`,
			`Pending paths: ${pendingPaths.length === 0 ? "(none)" : pendingPaths.join(", ")}`,
			...(runtimeError === undefined ? [] : [`Error: ${runtimeError.message}`]),
		].join("\n");
		const result = toolResult(details).text(summary);
		return (runtimeError === undefined ? result : result.error()).done();
	}
}
