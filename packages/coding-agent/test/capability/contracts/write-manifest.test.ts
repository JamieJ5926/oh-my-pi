import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { canonicalChangePlanJson, type ChangePlan } from "../../../src/capability/contracts/change";
import { createChangePlanId, createChangeUnitId, createOperationId } from "../../../src/capability/contracts/ids";
import { inspectWriteManifest } from "../../../src/capability/contracts/write-manifest";

function plan(overlap = false): ChangePlan {
	return {
		meta: { schemaVersion: "1", createdAt: "2026-08-30T00:00:00Z", operationId: createOperationId("op_test") },
		changePlanId: createChangePlanId("change_plan_test"),
		objective: "manifest contract",
		units: [
            { unitId: createChangeUnitId("change_unit_0000"), objective: "write a", ownedPaths: [overlap ? "src/./shared.ts" : "src/a.ts", "src/z.ts"], dependencyIds: [], validationCommands: ["true"], isolation: "patch" },
            { unitId: createChangeUnitId("change_unit_0001"), objective: "write b", ownedPaths: [overlap ? "src/shared.ts" : "src/b.ts"], dependencyIds: [], validationCommands: ["true"], isolation: "patch" },
		],
	};
}

function inspect(entries: unknown[], targetPlan = plan()) {
	const planDigest = createHash("sha256").update(canonicalChangePlanJson(targetPlan), "utf8").digest("hex");
	return inspectWriteManifest({
		schemaVersion: "1",
		operationId: "op_test",
		changePlanId: "change_plan_test",
		planDigest,
		entries,
	}, targetPlan, planDigest);
}

describe("write manifest contract", () => {
	test("canonical identity ignores entry and write order", () => {
		const first = inspect([
            { unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "b" }] },
            { unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/z.ts", content: "z" }, { kind: "full_content", path: "src/a.ts", content: "a" }] },
		]);
		const second = inspect([
            { unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/a.ts", content: "a" }, { kind: "full_content", path: "src/z.ts", content: "z" }] },
            { unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "b" }] },
		]);
		expect(first.issues).toEqual([]);
		expect(second.issues).toEqual([]);
		expect(first.parsed?.digest).toBe(second.parsed?.digest);
		expect(first.parsed?.manifest.writeManifestId).toBe(second.parsed?.manifest.writeManifestId);
	});

	test("content changes manifest identity", () => {
		const first = inspect([
            { unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/a.ts", content: "a" }, { kind: "full_content", path: "src/z.ts", content: "z" }] },
            { unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "b" }] },
		]);
		const second = inspect([
            { unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/a.ts", content: "a" }, { kind: "full_content", path: "src/z.ts", content: "z" }] },
            { unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "changed" }] },
		]);
		expect(first.parsed?.digest).not.toBe(second.parsed?.digest);
	});

	test("reports deterministic aggregate issues", () => {
		const result = inspect([
			{ unitId: "change_unit_unknown", writes: [] },
			{ unitId: "change_unit_0000", writes: [{ kind: "delete", path: "../escape.ts", content: "x" }, { kind: "full_content", path: "src/not-owned.ts", content: "x" }] },
		]);
		expect(result.parsed).toBeUndefined();
		expect(result.issues.map(issue => issue.code)).toEqual(["unknown_unit", "missing_unit_entry", "empty_writes", "unsupported_operation", "path_not_owned"]);
	});

	test("rejects lexically unsafe paths before ownership", () => {
		const result = inspect([
			{ unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "../escape.ts", content: "x" }] },
			{ unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "b" }] },
		]);
		expect(result.issues.map(issue => issue.code)).toContain("unsafe_path");
		expect(result.issues.map(issue => issue.code)).not.toContain("path_not_owned");
	});

	test("rejects normalized same-wave path ambiguity", () => {
		const result = inspect([
			{ unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/./shared.ts", content: "a" }, { kind: "full_content", path: "src/z.ts", content: "z" }] },
			{ unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/shared.ts", content: "b" }] },
		], plan(true));
		expect(result.issues.map(issue => issue.code)).toContain("duplicate_wave_path");
	});

	test("rejects a manifest bound to another plan digest", () => {
		const targetPlan = plan();
		const digest = createHash("sha256").update(canonicalChangePlanJson(targetPlan), "utf8").digest("hex");
		const result = inspectWriteManifest({
			schemaVersion: "1",
			operationId: "op_test",
			changePlanId: "change_plan_test",
			planDigest: "0".repeat(64),
			entries: [
				{ unitId: "change_unit_0000", writes: [{ kind: "full_content", path: "src/a.ts", content: "a" }, { kind: "full_content", path: "src/z.ts", content: "z" }] },
				{ unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/b.ts", content: "b" }] },
			],
		}, targetPlan, digest);
		expect(result.issues.map(issue => issue.code)).toContain("plan_digest_mismatch");
	});
});
