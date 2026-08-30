import { describe, expect, test } from "bun:test";
import { createChangeUnitId, createOperationId, createPatchId } from "../../../src/capability/contracts/ids";
import {
	type PatchRecord,
	transitionIntegration,
	validatePatchRecord,
} from "../../../src/capability/contracts/integration";

const patchId = createPatchId("patch_one");

function patch(overrides: Partial<PatchRecord> = {}): PatchRecord {
	return {
		meta: { schemaVersion: "1", createdAt: "2026-08-29T12:00:00Z", operationId: createOperationId("op_test") },
		patchId,
		unitId: createChangeUnitId("change_unit_one"),
		baseRevision: "abc123",
		touchedPaths: ["src/a.ts"],
		patchPath: "/tmp/patch.diff",
		validation: { kind: "accepted" },
		...overrides,
	};
}

describe("integration contracts", () => {
	test("accepts pending through applying to accepted and reverted", () => {
		const applying = transitionIntegration({ kind: "pending" }, { kind: "applying", patchId });
		const accepted = transitionIntegration(applying, { kind: "accepted", patchId, revision: "def456" });
		const reverted = transitionIntegration(accepted, {
			kind: "reverted",
			patchId,
			error: { code: "test_failed", message: "failed", retryable: false, context: {} },
		});
		expect(reverted.kind).toBe("reverted");
	});

	test("rejects terminal regressions and patch correlation mismatch", () => {
		expect(() =>
			transitionIntegration(
				{ kind: "rejected", patchId, error: { code: "bad", message: "bad", retryable: false, context: {} } },
				{ kind: "applying", patchId },
			),
		).toThrow("regress rejected");
		expect(() =>
			transitionIntegration(
				{ kind: "applying", patchId },
				{ kind: "accepted", patchId: createPatchId("patch_other"), revision: "def456" },
			),
		).toThrow("another patch");
	});

	test("validates patch metadata", () => {
		expect(validatePatchRecord(patch())).toEqual(patch());
		expect(() => validatePatchRecord(patch({ touchedPaths: [] }))).toThrow();
		expect(() => validatePatchRecord(patch({ patchPath: " " }))).toThrow();
	});
});
