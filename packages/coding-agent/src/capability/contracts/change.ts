import {
	type ArtifactMeta,
	type ChangePlanId,
	type ChangeUnitId,
	type WriteWaveId,
	createWriteWaveId,
	parseArtifactMeta,
	parseChangePlanId,
	parseChangeUnitId,
} from "./ids";

export type ChangeIsolation = "worktree" | "patch";

export interface ChangeUnit {
	readonly unitId: ChangeUnitId;
	readonly objective: string;
	readonly ownedPaths: readonly [string, ...string[]];
	readonly dependencyIds: readonly ChangeUnitId[];
	readonly validationCommands: readonly [string, ...string[]];
	readonly isolation: ChangeIsolation;
}

export interface ChangePlan {
	readonly meta: ArtifactMeta;
	readonly changePlanId: ChangePlanId;
	readonly objective?: string;
	readonly units: readonly [ChangeUnit, ...ChangeUnit[]];
}

export interface WriteWave {
	readonly waveId: WriteWaveId;
	readonly unitIds: readonly [ChangeUnitId, ...ChangeUnitId[]];
}

function invalid(message: string): never {
	throw new Error(`Invalid change plan: ${message}`);
}

function assertNonBlank(value: string, label: string): void {
	if (value.trim().length === 0) invalid(`${label} must not be blank`);
}

function validateUnit(unit: ChangeUnit, unitIds: ReadonlySet<string>): void {
	assertNonBlank(unit.objective, `change unit ${unit.unitId} objective`);
	if (unit.ownedPaths.length === 0) invalid(`change unit ${unit.unitId} must own at least one path`);
	const paths = new Set<string>();
	for (const path of unit.ownedPaths) {
		assertNonBlank(path, `change unit ${unit.unitId} owned path`);
		if (paths.has(path)) invalid(`change unit ${unit.unitId} owns path more than once: ${path}`);
		paths.add(path);
	}
	if (unit.validationCommands.length === 0) {
		invalid(`change unit ${unit.unitId} must have a validation command`);
	}
	for (const command of unit.validationCommands) {
		assertNonBlank(command, `change unit ${unit.unitId} validation command`);
	}
	for (const dependencyId of unit.dependencyIds) {
		if (!unitIds.has(dependencyId)) {
			invalid(`change unit ${unit.unitId} has unknown dependency ${dependencyId}`);
		}
		if (dependencyId === unit.unitId) invalid(`change unit ${unit.unitId} depends on itself`);
	}
}

function unitMap(units: readonly ChangeUnit[]): Map<ChangeUnitId, ChangeUnit> {
	const result = new Map<ChangeUnitId, ChangeUnit>();
	for (const unit of units) result.set(unit.unitId, unit);
	return result;
}

function dependencyGraph(units: readonly ChangeUnit[]): {
	readonly dependents: Map<ChangeUnitId, ChangeUnitId[]>;
	readonly remainingDependencies: Map<ChangeUnitId, number>;
} {
	const dependents = new Map<ChangeUnitId, ChangeUnitId[]>();
	const remainingDependencies = new Map<ChangeUnitId, number>();
	for (const unit of units) {
		dependents.set(unit.unitId, []);
		remainingDependencies.set(unit.unitId, unit.dependencyIds.length);
	}
	for (const unit of units) {
		for (const dependencyId of unit.dependencyIds) {
			const children = dependents.get(dependencyId);
			if (children === undefined) invalid(`change unit ${unit.unitId} has unknown dependency ${dependencyId}`);
			children.push(unit.unitId);
		}
	}
	return { dependents, remainingDependencies };
}

function sortedReady(
	remainingDependencies: ReadonlyMap<ChangeUnitId, number>,
	completed: ReadonlySet<ChangeUnitId>,
): ChangeUnitId[] {
	return [...remainingDependencies]
		.filter(([unitId, remaining]) => remaining === 0 && !completed.has(unitId))
		.map(([unitId]) => unitId)
		.sort();
}

export function validateChangePlan(plan: ChangePlan): ChangePlan {
	if (plan.units.length === 0) invalid("must contain at least one change unit");
	const ids = new Set<string>();
	for (const unit of plan.units) {
		if (ids.has(unit.unitId)) invalid(`duplicate change unit ${unit.unitId}`);
		ids.add(unit.unitId);
	}
	for (const unit of plan.units) validateUnit(unit, ids);

	const { dependents, remainingDependencies } = dependencyGraph(plan.units);
	const completed = new Set<ChangeUnitId>();
	while (completed.size < plan.units.length) {
		const ready = sortedReady(remainingDependencies, completed);
		if (ready.length === 0) invalid("dependency graph contains a cycle");
		for (const unitId of ready) {
			completed.add(unitId);
			const children = dependents.get(unitId);
			if (children === undefined) invalid(`missing graph node ${unitId}`);
			for (const childId of children) {
				const remaining = remainingDependencies.get(childId);
				if (remaining === undefined) invalid(`missing graph node ${childId}`);
				remainingDependencies.set(childId, remaining - 1);
			}
		}
	}
	return plan;
}

export function topologicalOrder(plan: ChangePlan): readonly ChangeUnitId[] {
	validateChangePlan(plan);
	const { dependents, remainingDependencies } = dependencyGraph(plan.units);
	const completed = new Set<ChangeUnitId>();
	const ordered: ChangeUnitId[] = [];
	while (ordered.length < plan.units.length) {
		const ready = sortedReady(remainingDependencies, completed);
		if (ready.length === 0) invalid("dependency graph contains a cycle");
		for (const unitId of ready) {
			completed.add(unitId);
			ordered.push(unitId);
			const children = dependents.get(unitId);
			if (children === undefined) invalid(`missing graph node ${unitId}`);
			for (const childId of children) {
				const remaining = remainingDependencies.get(childId);
				if (remaining === undefined) invalid(`missing graph node ${childId}`);
				remainingDependencies.set(childId, remaining - 1);
			}
		}
	}
	return ordered;
}

function pathsConflict(left: ChangeUnit, right: ChangeUnit): boolean {
	const rightPaths = new Set(right.ownedPaths);
	return left.ownedPaths.some(path => rightPaths.has(path));
}

export function validateWriteWave(wave: WriteWave, plan: ChangePlan): WriteWave {
	validateChangePlan(plan);
	const units = unitMap(plan.units);
	const seen = new Set<string>();
	const selected: ChangeUnit[] = [];
	for (const unitId of wave.unitIds) {
		if (seen.has(unitId)) invalid(`write wave ${wave.waveId} repeats unit ${unitId}`);
		seen.add(unitId);
		const unit = units.get(unitId);
		if (unit === undefined) invalid(`write wave ${wave.waveId} references unknown unit ${unitId}`);
		selected.push(unit);
	}
	for (let index = 0; index < selected.length; index += 1) {
		for (const other of selected.slice(index + 1)) {
			if (pathsConflict(selected[index], other)) {
				invalid(
					`write wave ${wave.waveId} has overlapping ownership between ${selected[index].unitId} and ${other.unitId}`,
				);
			}
		}
	}
	return wave;
}

export function createWriteWaves(plan: ChangePlan): readonly WriteWave[] {
	validateChangePlan(plan);
	const { dependents, remainingDependencies } = dependencyGraph(plan.units);
	const units = unitMap(plan.units);
	const completed = new Set<ChangeUnitId>();
	const waves: WriteWave[] = [];
	let waveNumber = 0;

	while (completed.size < plan.units.length) {
		const ready = sortedReady(remainingDependencies, completed);
		if (ready.length === 0) invalid("dependency graph contains a cycle");
		const selected: ChangeUnitId[] = [];
		const selectedUnits: ChangeUnit[] = [];
		for (const unitId of ready) {
			const unit = units.get(unitId);
			if (unit === undefined) invalid(`missing graph node ${unitId}`);
			if (selectedUnits.every(other => !pathsConflict(unit, other))) {
				selected.push(unitId);
				selectedUnits.push(unit);
			}
		}
		if (selected.length === 0) invalid("unable to construct a non-conflicting write wave");
		const [firstUnitId, ...remainingUnitIds] = selected;
		if (firstUnitId === undefined) invalid("unable to construct a non-conflicting write wave");
		const wave: WriteWave = {
			waveId: createWriteWaveId(`wave_${String(waveNumber).padStart(4, "0")}`),
			unitIds: [firstUnitId, ...remainingUnitIds],
		};
		validateWriteWave(wave, plan);
		waves.push(wave);
		waveNumber += 1;
		for (const unitId of selected) {
			completed.add(unitId);
			const children = dependents.get(unitId);
			if (children === undefined) invalid(`missing graph node ${unitId}`);
			for (const childId of children) {
				const remaining = remainingDependencies.get(childId);
				if (remaining === undefined) invalid(`missing graph node ${childId}`);
				remainingDependencies.set(childId, remaining - 1);
			}
		}
	}
	return waves;
}

type UnknownObject = Readonly<Record<string, unknown>>;
const MAX_PLAN_UNITS = 128;
const MAX_UNIT_PATHS = 64;
const MAX_VALIDATION_COMMANDS = 32;
const MAX_PLAN_TEXT_LENGTH = 16 * 1024;

export function parseChangePlan(value: unknown): ChangePlan {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("must be an object");
	const input = value as UnknownObject;
	const allowedPlanKeys = new Set(["meta", "changePlanId", "objective", "units"]);
	const unexpectedPlanKeys = Object.keys(input).filter(key => !allowedPlanKeys.has(key));
	if (unexpectedPlanKeys.length > 0) invalid(`has unsupported fields: ${unexpectedPlanKeys.sort().join(", ")}`);
	const meta = parseArtifactMeta(input.meta);
	if (meta === undefined) invalid("meta is invalid");
	const changePlanId = parseChangePlanId(input.changePlanId);
	if (changePlanId === undefined) invalid("changePlanId is invalid");
	if (input.objective !== undefined && (typeof input.objective !== "string" || input.objective.length > MAX_PLAN_TEXT_LENGTH)) invalid("objective must be a bounded string");
	if (!Array.isArray(input.units) || input.units.length === 0 || input.units.length > MAX_PLAN_UNITS) invalid(`units must contain between 1 and ${MAX_PLAN_UNITS} entries`);
	const units: ChangeUnit[] = input.units.map((rawUnit, index) => {
		if (typeof rawUnit !== "object" || rawUnit === null || Array.isArray(rawUnit)) invalid(`unit ${index} must be an object`);
		const unit = rawUnit as UnknownObject;
		const allowedUnitKeys = new Set(["unitId", "objective", "ownedPaths", "dependencyIds", "validationCommands", "isolation"]);
		const unexpectedUnitKeys = Object.keys(unit).filter(key => !allowedUnitKeys.has(key));
		if (unexpectedUnitKeys.length > 0) invalid(`unit ${index} has unsupported fields: ${unexpectedUnitKeys.sort().join(", ")}`);
		const unitId = parseChangeUnitId(unit.unitId);
		if (unitId === undefined || String(unit.unitId).length > MAX_PLAN_TEXT_LENGTH) invalid(`unit ${index} unitId is invalid`);
		if (typeof unit.objective !== "string" || unit.objective.length > MAX_PLAN_TEXT_LENGTH) invalid(`unit ${index} objective must be a bounded string`);
		if (!Array.isArray(unit.ownedPaths) || unit.ownedPaths.length === 0 || unit.ownedPaths.length > MAX_UNIT_PATHS || unit.ownedPaths.some(item => typeof item !== "string" || item.length > MAX_PLAN_TEXT_LENGTH)) {
			invalid(`unit ${index} ownedPaths must be a bounded non-empty string array`);
		}
		if (!Array.isArray(unit.dependencyIds) || unit.dependencyIds.length > MAX_PLAN_UNITS) invalid(`unit ${index} dependencyIds must be a bounded array`);
		const dependencyIds: ChangeUnitId[] = [];
		for (const dependencyId of unit.dependencyIds) {
			const parsedDependencyId = parseChangeUnitId(dependencyId);
			if (parsedDependencyId === undefined) invalid(`unit ${index} dependencyIds must contain change_unit_ identifiers`);
			dependencyIds.push(parsedDependencyId);
		}
		if (!Array.isArray(unit.validationCommands) || unit.validationCommands.length === 0 || unit.validationCommands.length > MAX_VALIDATION_COMMANDS || unit.validationCommands.some(item => typeof item !== "string" || item.length > MAX_PLAN_TEXT_LENGTH)) {
			invalid(`unit ${index} validationCommands must be a bounded non-empty string array`);
		}
		if (unit.isolation !== "patch" && unit.isolation !== "worktree") invalid(`unit ${index} isolation is invalid`);
		const [firstOwnedPath, ...ownedPaths] = unit.ownedPaths;
		const [firstCommand, ...validationCommands] = unit.validationCommands;
		if (typeof firstOwnedPath !== "string" || typeof firstCommand !== "string") invalid(`unit ${index} arrays must not be empty`);
		return {
			unitId,
			objective: unit.objective,
			ownedPaths: [firstOwnedPath, ...ownedPaths] as readonly [string, ...string[]],
			dependencyIds,
			validationCommands: [firstCommand, ...validationCommands] as readonly [string, ...string[]],
			isolation: unit.isolation,
		};
	});
	const [firstUnit, ...remainingUnits] = units;
	if (firstUnit === undefined) invalid("units must not be empty");
	return validateChangePlan({
		meta,
		changePlanId,
		...(input.objective === undefined ? {} : { objective: input.objective }),
		units: [firstUnit, ...remainingUnits],
	});
}

export function canonicalChangePlanJson(plan: ChangePlan): string {
	validateChangePlan(plan);
	const units = [...plan.units]
		.sort((left, right) => left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0)
		.map(unit => ({
			unitId: unit.unitId,
			objective: unit.objective,
			ownedPaths: [...unit.ownedPaths].sort(),
			dependencyIds: [...unit.dependencyIds].sort(),
			validationCommands: [...unit.validationCommands],
			isolation: unit.isolation,
		}));
	return JSON.stringify({
		schemaVersion: "1",
		createdAt: plan.meta.createdAt,
		operationId: plan.meta.operationId,
		changePlanId: plan.changePlanId,
		objective: plan.objective ?? null,
		units,
	});
}
