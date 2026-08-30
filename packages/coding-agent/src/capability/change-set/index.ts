import type { ChangePlan, ChangeUnit, WriteWave } from "../contracts/change";
import { createWriteWaves, validateChangePlan, validateWriteWave } from "../contracts/change";
import type { IntegrationState, PatchRecord } from "../contracts/integration";
import { transitionIntegration, validatePatchRecord } from "../contracts/integration";
import type { ChangeUnitId, IntegrationRunId, PatchId } from "../contracts/ids";
import { createIntegrationRunId } from "../contracts/ids";

export interface WriterResult {
	readonly patch: PatchRecord;
}

export interface ChangeSetServices {
	readonly write: (unit: ChangeUnit, context: { readonly wave: WriteWave; readonly isolation: ChangeUnit["isolation"] }) => Promise<WriterResult>;
	readonly apply: (patch: PatchRecord) => Promise<{ readonly revision: string }>;
	readonly record?: (record: { readonly unitId: ChangeUnitId; readonly integrationRunId: IntegrationRunId; readonly state: IntegrationState }) => Promise<void> | void;
	readonly validatePatch?: (patch: PatchRecord) => PatchRecord;
	readonly integrationRunId?: IntegrationRunId;
}

export interface ChangeSetResult {
	readonly waves: readonly WriteWave[];
	readonly patches: readonly PatchRecord[];
	readonly states: ReadonlyMap<ChangeUnitId, IntegrationState>;
}

function failure(code: string, message: string): Error {
	return new Error(`Change set failed: ${code}: ${message}`);
}

function unitMap(plan: ChangePlan): ReadonlyMap<ChangeUnitId, ChangeUnit> {
	return new Map(plan.units.map(unit => [unit.unitId, unit]));
}

function assertOwnership(unit: ChangeUnit, patch: PatchRecord): void {
	if (patch.unitId !== unit.unitId) throw failure("patch_unit_mismatch", `${patch.unitId} does not match ${unit.unitId}`);
	const owned = new Set(unit.ownedPaths);
	for (const path of patch.touchedPaths) {
		if (!owned.has(path)) throw failure("patch_path_not_owned", `${unit.unitId} touched ${path}`);
	}
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
	return { code: "writer_failure", message: error instanceof Error ? error.message : String(error) };
}

export async function executeChangeSet(plan: ChangePlan, services: ChangeSetServices): Promise<ChangeSetResult> {
	validateChangePlan(plan);
	if (!services.write || !services.apply) throw failure("missing_service", "write and apply services are required");
	const waves = createWriteWaves(plan);
	for (const wave of waves) validateWriteWave(wave, plan);
	const units = unitMap(plan);
	const runId = services.integrationRunId ?? createIntegrationRunId(`integration_${String(plan.changePlanId)}`);
	const states = new Map<ChangeUnitId, IntegrationState>();
	const patches: PatchRecord[] = [];
	const record = services.record ?? (() => undefined);

	for (const wave of waves) {
		for (const unitId of wave.unitIds) {
			const unit = units.get(unitId);
			if (!unit) throw failure("unknown_unit", String(unitId));
			let state: IntegrationState = { kind: "pending" };
			const save = async (next: IntegrationState): Promise<void> => {
				state = transitionIntegration(state, next);
				states.set(unitId, state);
				await record({ unitId, integrationRunId: runId, state });
			};
			const currentState = (): IntegrationState => state;
			try {
				const patchId: PatchId = await Promise.resolve().then(async () => {
					const result = await services.write(unit, { wave, isolation: unit.isolation });
					const validated = (services.validatePatch ?? validatePatchRecord)(result.patch);
					assertOwnership(unit, validated);
					patches.push(validated);
					return validated.patchId;
				});
				await save({ kind: "applying", patchId });
				const applied = await services.apply(patches.at(-1)!);
				if (applied.revision.trim().length === 0) throw failure("invalid_revision", "apply returned a blank revision");
				await save({ kind: "accepted", patchId, revision: applied.revision });
			} catch (error) {
				const details = errorDetails(error);
				const stateAtFailure = currentState();
				if (stateAtFailure.kind === "pending") {
					const patchId = patches.at(-1)?.unitId === unitId ? patches.at(-1)?.patchId : undefined;
					if (patchId) {
						await save({ kind: "applying", patchId });
						await save({ kind: "rejected", patchId, error: { ...details, retryable: false, context: { unitId } } });
					}
				} else if (stateAtFailure.kind === "applying") {
					await save({ kind: "rejected", patchId: stateAtFailure.patchId, error: { ...details, retryable: false, context: { unitId } } });
				}
				throw failure(details.code, `${unitId}: ${details.message}`);
			}
		}
	}
	return { waves, patches, states };
}
