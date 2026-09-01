import { describe, expect, test } from "bun:test";
import {
	type ChangePlan,
	type ChangeUnit,
	createWriteWaves,
	parseChangePlan,
	topologicalOrder,
	validateChangePlan,
	validateWriteWave,
} from "../../../src/capability/contracts/change";
import {
	createChangePlanId,
	createChangeUnitId,
	createOperationId,
	createWriteWaveId,
} from "../../../src/capability/contracts/ids";

function unit(name: string, dependencies: string[] = [], paths: string[] = [`${name}.ts`]): ChangeUnit {
	return {
		unitId: createChangeUnitId(`change_unit_${name}`),
		objective: name,
		ownedPaths: [paths[0] ?? `${name}.ts`, ...paths.slice(1)],
		dependencyIds: dependencies.map(dependency => createChangeUnitId(`change_unit_${dependency}`)),
		validationCommands: [`test ${name}`],
		isolation: "worktree",
	};
}

function plan(units: ChangeUnit[]): ChangePlan {
	const [first, ...rest] = units;
	if (!first) throw new Error("test plan needs a unit");
	return {
		meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_test") },
		changePlanId: createChangePlanId("change_plan_test"),
		units: [first, ...rest],
	};
}

describe("change plan contracts", () => {
	test("produces deterministic topological order and parallel waves", () => {
		const value = plan([unit("c", ["a", "b"]), unit("b"), unit("a")]);
		expect(topologicalOrder(value)).toEqual([
			createChangeUnitId("change_unit_a"),
			createChangeUnitId("change_unit_b"),
			createChangeUnitId("change_unit_c"),
		]);
		expect(createWriteWaves(value).map(wave => wave.unitIds)).toEqual([
			[createChangeUnitId("change_unit_a"), createChangeUnitId("change_unit_b")],
			[createChangeUnitId("change_unit_c")],
		]);
	});

	test("rejects cycles and unknown dependencies", () => {
		expect(() => validateChangePlan(plan([unit("a", ["b"]), unit("b", ["a"])]))).toThrow("cycle");
		expect(() => validateChangePlan(plan([unit("a", ["missing"])]))).toThrow("unknown dependency");
	});

	test("rejects overlapping ownership inside a wave", () => {
		const value = plan([unit("a", [], ["shared.ts"]), unit("b", [], ["shared.ts"])]);
		expect(() =>
			validateWriteWave(
				{
					waveId: createWriteWaveId("wave_test"),
					unitIds: [createChangeUnitId("change_unit_a"), createChangeUnitId("change_unit_b")],
				},
				value,
			),
		).toThrow("overlapping ownership");
	});

	test("parses external plans and rejects legacy payloads", () => {
		const serialized = JSON.parse(JSON.stringify(plan([unit("a")])));
		expect(parseChangePlan(serialized)).toEqual(plan([unit("a")]));
		expect(() => parseChangePlan({ plan: null })).toThrow("unsupported fields");
		expect(() => parseChangePlan({
			...serialized,
			units: [{ ...serialized.units[0], payload: { kind: "full_content" } }],
		})).toThrow("unsupported fields");
		expect(() => parseChangePlan({
			...serialized,
			meta: { ...serialized.meta, payload: true },
		})).toThrow("meta is invalid");
	});
});
