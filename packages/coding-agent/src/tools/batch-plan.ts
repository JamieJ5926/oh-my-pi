import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { canonicalChangePlanJson, type ChangeIsolation, type ChangePlan, type ChangeUnit, createWriteWaves, validateChangePlan } from "../capability/contracts/change";
import { createChangePlanId, createChangeUnitId, createOperationId } from "../capability/contracts/ids";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import batchPlanDescription from "../prompts/tools/batch-plan.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

const batchPlanUnitSchema = type({
	objective: "string > 0",
	ownedPaths: type("string > 0").array().atLeastLength(1),
	"dependencyUnitIndexes?": type("number").array(),
	validationCommands: type("string > 0").array().atLeastLength(1),
	"isolation?": type("'patch' | 'worktree'"),
});
const batchPlanSchema = type({ objective: "string > 0", units: batchPlanUnitSchema.array().atLeastLength(1) });
type BatchPlanParams = typeof batchPlanSchema.infer;
type UnknownObject = Readonly<Record<string, unknown>>;
interface BatchPlanUnitInput {
	readonly objective: string;
	readonly ownedPaths: readonly [string, ...string[]];
	readonly dependencyUnitIndexes: readonly number[];
	readonly validationCommands: readonly [string, ...string[]];
	readonly isolation: ChangeIsolation;
}

interface BatchPlanDetails {
	artifactUri: string;
	changePlanId: string;
	operationId: string;
	planDigest: string;
	batchWriteRequestTemplate: {
		artifactUri: string;
		manifest: {
			schemaVersion: "1";
			operationId: string;
			changePlanId: string;
			planDigest: string;
			entries: Array<{ unitId: string; writes: unknown[] }>;
		};
	};
	waves: Array<{ waveId: string; unitIds: readonly string[] }>;
	order: string[];
	warnings: string[];
	meta?: OutputMeta;
}

const UNIT_KEYS = new Set(["objective", "ownedPaths", "dependencyUnitIndexes", "validationCommands", "isolation"]);
const MAX_PLAN_UNITS = 128;
const MAX_UNIT_PATHS = 64;
const MAX_VALIDATION_COMMANDS = 32;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_PLAN_ARTIFACT_BYTES = 2 * 1024 * 1024;

function nonEmptyStrings(value: unknown, label: string): readonly [string, ...string[]] {
	if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${label} must be a non-empty array of non-blank strings`);
	}
	const [first, ...rest] = value;
	if (typeof first !== "string") throw new Error(`${label} must not be empty`);
	return [first, ...rest] as readonly [string, ...string[]];
}

function parseUnitInput(value: unknown, index: number): BatchPlanUnitInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`units[${index}] must be an object`);
	const input = value as UnknownObject;
	const unexpected = Object.keys(input).filter(key => !UNIT_KEYS.has(key));
	if (unexpected.length > 0) throw new Error(`units[${index}] has unsupported fields: ${unexpected.sort().join(", ")}`);
	if (typeof input.objective !== "string" || input.objective.trim().length === 0 || input.objective.length > MAX_TEXT_LENGTH) throw new Error(`units[${index}].objective must be a bounded non-blank string`);
	const dependencyUnitIndexes = input.dependencyUnitIndexes === undefined ? [] : input.dependencyUnitIndexes;
	if (!Array.isArray(dependencyUnitIndexes) || dependencyUnitIndexes.length > MAX_PLAN_UNITS || dependencyUnitIndexes.some(item => typeof item !== "number" || !Number.isInteger(item) || item < 0 || item >= MAX_PLAN_UNITS || item === index)) throw new Error(`units[${index}].dependencyUnitIndexes must contain integer indexes in range and not self`);
	if (new Set(dependencyUnitIndexes).size !== dependencyUnitIndexes.length) throw new Error(`units[${index}].dependencyUnitIndexes must contain unique indexes`);
	if (input.isolation !== undefined && input.isolation !== "patch" && input.isolation !== "worktree") throw new Error(`units[${index}].isolation must be patch or worktree`);
	const ownedPaths = nonEmptyStrings(input.ownedPaths, `units[${index}].ownedPaths`);
	const validationCommands = nonEmptyStrings(input.validationCommands, `units[${index}].validationCommands`);
	if (ownedPaths.some(value => value.length > MAX_TEXT_LENGTH) || validationCommands.some(value => value.length > MAX_TEXT_LENGTH)) throw new Error(`units[${index}] contains an overlong path or command`);
	if (ownedPaths.length > MAX_UNIT_PATHS) throw new Error(`units[${index}].ownedPaths exceeds ${MAX_UNIT_PATHS}`);
	if (validationCommands.length > MAX_VALIDATION_COMMANDS) throw new Error(`units[${index}].validationCommands exceeds ${MAX_VALIDATION_COMMANDS}`);
	return { objective: input.objective, ownedPaths, dependencyUnitIndexes: dependencyUnitIndexes as readonly number[], validationCommands, isolation: input.isolation ?? "patch" };
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function localOptions(session: ToolSession): LocalProtocolOptions {
	return session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? session.cwd,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
}

async function publishPlanArtifact(session: ToolSession, uri: string, bytes: string, token: string): Promise<void> {
	const options = localOptions(session);
	const artifactRoot = options.getArtifactsDir?.() ?? session.cwd;
	await fs.mkdir(artifactRoot, { recursive: true });
	const realArtifactRoot = await fs.realpath(artifactRoot);
	const target = resolveLocalUrlToPath(uri, options);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const realParent = await fs.realpath(path.dirname(target));
	if (!realParent.startsWith(`${realArtifactRoot}${path.sep}`) && realParent !== realArtifactRoot) throw new Error("Plan artifact directory escapes the artifact root");
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

export class BatchPlanTool implements AgentTool<typeof batchPlanSchema, BatchPlanDetails> {
	readonly name = "batch_plan";
	readonly label = "Batch Plan";
	readonly summary = "Validate and persist a structural multi-unit change plan";
	readonly description = batchPlanDescription;
	readonly parameters = batchPlanSchema;
	readonly strict = true;
	readonly approval = (): "write" => "write";
	readonly formatApprovalDetails = (): string[] => ["Content-addressed local plan artifact"];

	constructor(private readonly session: ToolSession) {}

	async execute(toolCallId: string, params: BatchPlanParams, _signal?: AbortSignal, _onUpdate?: AgentToolUpdateCallback<BatchPlanDetails>, _context?: AgentToolContext): Promise<AgentToolResult<BatchPlanDetails>> {
		if (params.units.length === 0 || params.units.length > MAX_PLAN_UNITS) throw new Error(`units must contain between 1 and ${MAX_PLAN_UNITS} entries`);
		if (params.objective.length > MAX_TEXT_LENGTH) throw new Error("objective exceeds the length limit");
		const inputs = params.units.map(parseUnitInput);
		const callDigest = createHash("sha256").update(toolCallId, "utf8").digest("hex").slice(0, 32);
		const changePlanId = createChangePlanId(`change_plan_${callDigest}`);
		const operationId = createOperationId(`op_${callDigest}`);
		const units = inputs.map<ChangeUnit>((input, index) => ({
			unitId: createChangeUnitId(`change_unit_${String(index).padStart(4, "0")}`),
			objective: input.objective,
			ownedPaths: input.ownedPaths,
			dependencyIds: input.dependencyUnitIndexes.map(dependencyIndex => createChangeUnitId(`change_unit_${String(dependencyIndex).padStart(4, "0")}`)),
			validationCommands: input.validationCommands,
			isolation: input.isolation,
		}));
		const [firstUnit, ...remainingUnits] = units;
		if (firstUnit === undefined) throw new Error("units must be a non-empty array");
		const plan: ChangePlan = {
			meta: { schemaVersion: "1", createdAt: new Date().toISOString(), operationId },
			changePlanId,
			objective: params.objective,
			units: [firstUnit, ...remainingUnits],
		};
		validateChangePlan(plan);
		const waves = createWriteWaves(plan);
		const canonicalPlan = canonicalChangePlanJson(plan);
		const planDigest = createHash("sha256").update(canonicalPlan, "utf8").digest("hex");
		const artifactUri = `local://batch-plan-${planDigest}.json`;
		const serializedWaves = waves.map(wave => ({ waveId: wave.waveId, unitIds: wave.unitIds }));
		const order = waves.flatMap(wave => [...wave.unitIds]);
		const batchWriteRequestTemplate = {
			artifactUri,
			manifest: {
				schemaVersion: "1" as const,
				operationId,
				changePlanId,
				planDigest,
				entries: plan.units.map(unit => ({ unitId: unit.unitId, writes: [] })),
			},
		};
		const artifactBytes = JSON.stringify({ planDigest, plan, waves: serializedWaves, order }, null, 2);
		if (new TextEncoder().encode(artifactBytes).byteLength > MAX_PLAN_ARTIFACT_BYTES) throw new Error("Plan artifact exceeds the size limit");
		await publishPlanArtifact(this.session, artifactUri, artifactBytes, toolCallId);
		const dependencySummary = plan.units
			.map(unit => `${unit.unitId} <- ${unit.dependencyIds.length === 0 ? "(none)" : unit.dependencyIds.join(", ")}`)
			.join("\n");
		const waveSummary = waves.map(wave => `${wave.waveId}: ${wave.unitIds.join(", ")}`).join("\n");
		return toolResult<BatchPlanDetails>({
			artifactUri,
			planDigest,
			changePlanId,
			operationId,
			batchWriteRequestTemplate,
			waves: serializedWaves,
			order,
			warnings: [],
		}).text(`Plan artifact: ${artifactUri}\nPlan digest: ${planDigest}\nOperation ID: ${operationId}\nChange plan ID: ${changePlanId}\nBatch write request template (fill writes arrays only): ${JSON.stringify(batchWriteRequestTemplate)}\nDependencies:\n${dependencySummary}\nWaves:\n${waveSummary}`).done();
	}
}
