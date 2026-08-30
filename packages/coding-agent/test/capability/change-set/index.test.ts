import { describe, expect, test } from "bun:test";
import { createChangePlanId, createChangeUnitId, createOperationId, createPatchId } from "../../../src/capability/contracts/ids";
import type { ChangePlan, ChangeUnit } from "../../../src/capability/contracts/change";
import { executeChangeSet } from "../../../src/capability/change-set";

function unit(name: string, dependencies: string[] = [], paths = [`${name}.ts`]): ChangeUnit {
	return {
		unitId: createChangeUnitId(`change_unit_${name}`), objective: name,
		ownedPaths: [paths[0]!, ...paths.slice(1)],
		dependencyIds: dependencies.map(value => createChangeUnitId(`change_unit_${value}`)),
		validationCommands: [`test ${name}`], isolation: "worktree",
	};
}
function plan(units: ChangeUnit[]): ChangePlan {
	return { meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_change") }, changePlanId: createChangePlanId("change_plan_change"), units: [units[0]!, ...units.slice(1)] };
}

describe("executeChangeSet", () => {
	test("writes dependency-safe waves and accepts patches", async () => {
		const calls: string[] = [];
		const result = await executeChangeSet(plan([unit("b", ["a"]), unit("a")]), {
			write: async (value) => { calls.push(value.objective); return { patch: { meta: plan([unit("a")]).meta, patchId: createPatchId(`patch_${value.objective}`), unitId: value.unitId, baseRevision: "r0", touchedPaths: [...value.ownedPaths], patchPath: `${value.objective}.diff`, validation: { kind: "accepted" } } }; },
			apply: async () => ({ revision: "r1" }),
		});
		expect(calls).toEqual(["a", "b"]);
		expect(result.waves).toHaveLength(2);
		expect([...result.states.values()].every(state => state.kind === "accepted")).toBe(true);
	});

	test("rejects a writer patch outside owned paths", async () => {
		await expect(executeChangeSet(plan([unit("a")]), {
			write: async value => ({ patch: { meta: plan([unit("a")]).meta, patchId: createPatchId("patch_bad"), unitId: value.unitId, baseRevision: "r0", touchedPaths: ["other.ts"], patchPath: "bad.diff", validation: { kind: "accepted" } } }),
			apply: async () => ({ revision: "r1" }),
		})).rejects.toThrow("patch_path_not_owned");
	});
});
