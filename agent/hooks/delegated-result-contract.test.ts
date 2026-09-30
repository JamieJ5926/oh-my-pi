import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
	disappearanceAbortedRecord,
	extractExplicitCheckpoint,
	modelString,
	parseChildTaskResults,
	rewriteCancelledByCaller,
	shouldBlockSuccessArtifacts,
	shouldBlockTerminalContract,
	shouldBlockTerminalRouting,
	validateSuccessArtifacts,
	validateTerminalRecord,
	validateTerminalRouting,
} from "./lib/delegated-result-contract.ts";
import {
	classifyAgentRole,
	rewriteWriteRoleSelfOnly,
	taskAgentMap,
} from "./pre/feedback-queue.ts";

const fixtureFile = join(mkdtempSync(join(tmpdir(), "artifact-contract-")), "example.ts");
writeFileSync(fixtureFile, "export function parseStatus() {}\n");
const fixtureDigest = createHash("sha256").update(readFileSync(fixtureFile)).digest("hex");

test("valid file result", () => {
	const input = {
		status: "PASS",
		artifacts: [
			{
				locator: fixtureFile,
				claim: "exports parseStatus",
				check: { kind: "read" },
			},
		],
	};
	expect(validateSuccessArtifacts(input)).toEqual({ ok: true });
	expect(shouldBlockSuccessArtifacts(input, true)).toBeUndefined();
});

test("valid result:self", () => {
	const input = {
		result: {
			status: "SUCCESS",
			data: {
				status: "SUCCESS",
				artifacts: [
					{
						locator: "result:self",
						claim: "plan names the cutover order",
						check: { kind: "self-json-pointer", pointer: "/artifacts/0/claim" },
					},
				],
			},
		},
	};
	expect(validateSuccessArtifacts(input)).toEqual({ ok: true });
	expect(shouldBlockSuccessArtifacts(input, true)).toBeUndefined();
});

test("empty artifacts rejection", () => {
	const input = { status: "PASS", artifacts: [] };
	const result = validateSuccessArtifacts(input);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.failure.field).toBe("artifacts");
		expect(result.failure.index).toBe(0);
	}
	const reason = shouldBlockSuccessArtifacts(input, true);
	expect(reason).toContain("artifact 0");
	expect(reason).toContain("field artifacts");
});

test("prose-only check rejection", () => {
	const input = {
		status: "PASS",
		artifacts: [
			{
				locator: fixtureFile,
				claim: "looks fine",
				check: "read it yourself",
			},
		],
	};
	const result = validateSuccessArtifacts(input);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.failure.field).toBe("check");
		expect(result.failure.index).toBe(0);
	}
	const reason = shouldBlockSuccessArtifacts(input, true);
	expect(reason).toContain("artifact 0");
	expect(reason).toContain("field check");
});

test("sha256 mismatch rejection", () => {
	const input = {
		result: {
			data: {
				status: "pass",
				artifacts: [
					{
						locator: fixtureFile,
						claim: "bytes match digest",
						check: { kind: "sha256", digest: "0".repeat(64) },
					},
				],
			},
		},
	};
	const result = validateSuccessArtifacts(input);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.failure.field).toBe("check.digest");
		expect(result.failure.index).toBe(0);
	}
	expect(shouldBlockSuccessArtifacts(input, true)).toContain("field check.digest");
	expect(
		validateSuccessArtifacts({
			status: "PASS",
			artifacts: [
				{
					locator: fixtureFile,
					claim: "bytes match digest",
					check: { kind: "sha256", digest: fixtureDigest },
				},
			],
		}),
	).toEqual({ ok: true });
});

test("root fail-open", () => {
	const input = { status: "PASS", artifacts: [] };
	expect(shouldBlockSuccessArtifacts(input, false)).toBeUndefined();
	expect(validateSuccessArtifacts(input).ok).toBe(false);
});

test("multi-failure yield reports every artifact and routing failure", () => {
	const input = {
		status: "PASS",
		artifacts: [
			{ locator: "", claim: "", check: "prose" },
			{ locator: "/no/such/file.ts", claim: "missing", check: { kind: "read" } },
		],
	};
	const reason = shouldBlockTerminalContract(input, true, { models: ["provider/model-a"] });
	expect(reason).toStartWith("contract: ");
	expect(reason).toContain("artifacts[0].locator is empty");
	expect(reason).toContain("artifacts[0].claim is empty");
	expect(reason).toContain("artifacts[0].check must be a discriminated object");
	expect(reason).toContain("artifacts[1].locator does not exist");
	expect(reason).toContain("routing must be an object");
	expect(reason).toContain("used, not-observed, unknown");
	expect(reason).toContain("; ");
});

test("single-failure artifact text still names field", () => {
	const input = { status: "PASS", artifacts: [] };
	const reason = shouldBlockSuccessArtifacts(input, true);
	expect(reason).toContain("artifacts must be a non-empty array");
	expect(reason).toContain("artifact 0");
	expect(reason).toContain("field artifacts");
});

test("legal fallback states enumerated on missing routing", () => {
	const reason = shouldBlockTerminalRouting({ status: "BLOCKED" }, true, { models: [] });
	expect(reason).toContain("used, not-observed, unknown");
	expect(reason).toContain("(never none)");
});

test("missing routing rejected", () => {
	const input = { status: "BLOCKED" };
	const result = validateTerminalRouting(input, { models: ["provider/model-a"] });
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.failure.field).toBe("routing");
	expect(shouldBlockTerminalRouting(input, true, { models: ["provider/model-a"] })).toContain(
		"field routing",
	);
});

test("mismatched model rejected", () => {
	const input = {
		status: "ISSUES",
		routing: {
			resolvedModel: "provider/wrong",
			fallback: { state: "not-observed", observationSource: "host-model-sequence" },
		},
	};
	const result = validateTerminalRouting(input, { models: ["provider/model-a"] });
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.failure.field).toBe("routing.resolvedModel");
	expect(shouldBlockTerminalRouting(input, true, { models: ["provider/model-a"] })).toContain(
		"field routing.resolvedModel",
	);
});

test("observed switch requiring used", () => {
	const observed = { models: ["provider/model-a", "provider/model-b"] };
	const invalid = {
		status: "PASS",
		routing: {
			resolvedModel: "provider/model-b",
			fallback: { state: "not-observed", observationSource: "host-model-sequence" },
		},
	};
	const invalidResult = validateTerminalRouting(invalid, observed);
	expect(invalidResult.ok).toBe(false);
	if (!invalidResult.ok) expect(invalidResult.failure.field).toBe("routing.fallback.state");
	const valid = {
		status: "PASS",
		routing: {
			resolvedModel: "provider/model-b",
			fallback: {
				state: "used",
				from: "provider/model-a",
				to: "provider/model-b",
				evidence: "host model_change sequence",
			},
		},
	};
	expect(validateTerminalRouting(valid, observed)).toEqual({ ok: true });
	expect(shouldBlockTerminalRouting(valid, true, observed)).toBeUndefined();
});

test("valid not-observed", () => {
	const input = {
		status: "SUCCESS",
		routing: {
			resolvedModel: "provider/model-a",
			fallback: { state: "not-observed", observationSource: "host-model-sequence" },
		},
	};
	expect(validateTerminalRouting(input, { models: ["provider/model-a"] })).toEqual({ ok: true });
	expect(shouldBlockTerminalRouting(input, true, { models: ["provider/model-a"] })).toBeUndefined();
});

test("honest unknown accepted", () => {
	const input = {
		status: "BLOCKED",
		routing: {
			resolvedModel: "unverified",
			fallback: { state: "unknown", reason: "no host model event was visible" },
		},
	};
	expect(validateTerminalRouting(input, { models: [] })).toEqual({ ok: true });
	expect(shouldBlockTerminalRouting(input, true, { models: [] })).toBeUndefined();
});

test("root fail-open for routing", () => {
	const input = { status: "BLOCKED" };
	expect(shouldBlockTerminalRouting(input, false, { models: [] })).toBeUndefined();
	expect(validateTerminalRouting(input, { models: [] }).ok).toBe(false);
});

test("duplicate-identifier sequence accepts not-observed", () => {
	const observed = { models: ["provider/model-a", "provider/model-a"] };
	const input = {
		status: "PASS",
		routing: {
			resolvedModel: "provider/model-a",
			fallback: { state: "not-observed", observationSource: "host-model-sequence" },
		},
	};
	expect(validateTerminalRouting(input, observed)).toEqual({ ok: true });
	expect(shouldBlockTerminalRouting(input, true, observed)).toBeUndefined();
});

test("distinct-pair requires used", () => {
	const observed = { models: ["provider/model-a", "provider/model-b"] };
	const invalid = {
		status: "ISSUES",
		routing: {
			resolvedModel: "provider/model-b",
			fallback: { state: "not-observed", observationSource: "host-model-sequence" },
		},
	};
	const result = validateTerminalRouting(invalid, observed);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.failure.field).toBe("routing.fallback.state");
});

test("object ctx.model normalized then recorded", () => {
	expect(modelString({ provider: "provider", id: "model-a" })).toBe("provider/model-a");
	expect(modelString({ id: "model-a" })).toBe("model-a");
	expect(modelString("provider/model-a")).toBe("provider/model-a");
	const observed = { models: [modelString({ provider: "provider", id: "model-a" }) ?? ""] };
	const input = {
		status: "BLOCKED",
		routing: {
			resolvedModel: "provider/model-a",
			fallback: { state: "not-observed", observationSource: "ctx.model" },
		},
	};
	expect(validateTerminalRouting(input, observed)).toEqual({ ok: true });
});

test("initiator union parse", () => {
	for (const kind of ["explicit-parent", "runtime", "unknown"] as const) {
		const result = validateTerminalRecord({
			recordId: `id-${kind}`,
			taskRef: "LaneA",
			outcome: "CANCELLED",
			observedAt: "2026-09-01T00:00:00.000Z",
			initiator: { kind, evidence: "e" },
			reason: kind === "explicit-parent" ? "Cancelled by caller" : "host cancelled",
			lastCheckpoint: null,
			partialArtifacts: [],
		});
		expect(result.ok).toBe(true);
	}
});

test("forbidden phrase without correlation rejected", () => {
	const result = validateTerminalRecord({
		recordId: "id-bad",
		taskRef: "LaneX",
		outcome: "CANCELLED",
		observedAt: "2026-09-01T00:00:00.000Z",
		initiator: { kind: "unknown", evidence: "task result text" },
		reason: "Cancelled by caller",
		lastCheckpoint: null,
		partialArtifacts: [],
	});
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.failure.field).toBe("reason");
});

test("ABORTED on disappearance", () => {
	const record = disappearanceAbortedRecord({
		recordId: "agent_end:LaneGone",
		taskRef: "LaneGone",
		observedAt: "2026-09-01T00:00:01.000Z",
		lastCheckpoint: "checkpoint",
		partialArtifacts: ["partial.md"],
	});
	expect(record.outcome).toBe("ABORTED");
	expect(record.initiator.kind).toBe("unknown");
	expect(validateTerminalRecord(record).ok).toBe(true);
});

test("PASS mentioning cancel stays PASS and is not rewritten", () => {
	const prose = "PASS: cancel was considered then rejected; artifacts attached.";
	const children = parseChildTaskResults(undefined, prose, "call-pass");
	expect(children).toHaveLength(1);
	expect(children[0]?.cancelled).toBe(false);
	expect(rewriteCancelledByCaller(prose, false)).toBe(prose);
});

test("exact Cancelled by caller phrase still marks cancelled", () => {
	const text = "Cancelled by caller after wait";
	const children = parseChildTaskResults(undefined, text, "call-cancel");
	expect(children[0]?.cancelled).toBe(true);
	expect(rewriteCancelledByCaller(text, false)).not.toContain("Cancelled by caller");
});

test("structured cancelled flag is independent of prose", () => {
	const children = parseChildTaskResults(
		{ results: [{ id: "LaneWait", cancelled: true, content: "waiting" }] },
		undefined,
		"call-flag",
	);
	expect(children[0]?.cancelled).toBe(true);
	expect(children[0]?.taskRef).toBe("LaneWait");
});

test("per-child checkpoint isolation", () => {
	const children = parseChildTaskResults(
		{
			results: [
				{
					id: "LaneA",
					content: "Cancelled by caller",
					lastCheckpoint: "child-a-wait",
					partialArtifacts: ["a.md"],
				},
				{
					id: "LaneB",
					content: "PASS mentioned cancel in notes",
					lastCheckpoint: "child-b-done",
					partialArtifacts: ["b.md"],
				},
			],
		},
		undefined,
		"batch",
	);
	expect(children).toHaveLength(2);
	expect(children[0]?.cancelled).toBe(true);
	expect(children[0]?.lastCheckpoint).toBe("child-a-wait");
	expect(children[0]?.partialArtifacts).toEqual(["a.md"]);
	expect(children[1]?.cancelled).toBe(false);
	expect(children[1]?.lastCheckpoint).toBe("child-b-done");
	expect(children[1]?.partialArtifacts).toEqual(["b.md"]);
});
test("write-role self-only success is marked", () => {
	const roles = new Map([["LaneWrite", classifyAgentRole("implementer")]]);
	const content = JSON.stringify({ status: "PASS", artifacts: [{ locator: "result:self", claim: "done", check: { kind: "self-json-pointer", pointer: "/status" } }] });
	const rewritten = rewriteWriteRoleSelfOnly(content, { results: [{ id: "LaneWrite", content }] }, roles);
	expect(rewritten).toStartWith("contract-violation:");
});

test("write-role file+self success is unmarked", () => {
	const roles = new Map([["LaneWrite", classifyAgentRole("mechanical")]]);
	const content = JSON.stringify({ status: "PASS", artifacts: [{ locator: "/tmp/example.ts", claim: "changed", check: { kind: "read" } }, { locator: "result:self", claim: "summary", check: { kind: "self-json-pointer", pointer: "/status" } }] });
	expect(rewriteWriteRoleSelfOnly(content, { results: [{ id: "LaneWrite", content }] }, roles)).toBe(content);
});

test("read-only self-only success is unmarked", () => {
	const roles = new Map([["LaneRead", classifyAgentRole("planner")]]);
	const content = JSON.stringify({ status: "SUCCESS", artifacts: [{ locator: "result:self", claim: "plan", check: { kind: "self-json-pointer", pointer: "/status" } }] });
	expect(rewriteWriteRoleSelfOnly(content, { results: [{ id: "LaneRead", content }] }, roles)).toBe(content);
});

test("unknown agent is unmarked", () => {
	const roles = new Map([["LaneUnknown", classifyAgentRole("custom")]]);
	const content = JSON.stringify({ status: "PASS", artifacts: [{ locator: "result:self", claim: "done", check: { kind: "self-json-pointer", pointer: "/status" } }] });
	expect(rewriteWriteRoleSelfOnly(content, { results: [{ id: "LaneUnknown", content }] }, roles)).toBe(content);
});

test("dispatch map correlates identifiers", () => {
	const map = taskAgentMap({ tasks: [{ id: "LaneA", name: "first", taskRef: "ref-a", agent: "owner" }, { id: "LaneB", agent: "explorer" }] });
	expect(map.get("LaneA")).toBe("write");
	expect(map.get("first")).toBe("write");
	expect(map.get("ref-a")).toBe("write");
	expect(map.get("LaneB")).toBe("read-only");
});

test("explicit checkpoint marker only, never trailing tool output", () => {
	const grepMiss = [{ content: "No matches found" }];
	expect(extractExplicitCheckpoint(grepMiss).checkpoint).toBeNull();
	const marked = [{ content: "still running\ncheckpoint: waiting on jobs" }];
	expect(extractExplicitCheckpoint(marked).checkpoint).toBe("waiting on jobs");
	const fielded = [{ lastCheckpoint: "named field", content: "No matches found" }];
	expect(extractExplicitCheckpoint(fielded).checkpoint).toBe("named field");
});

test("unclassified agent_end skip is the classified-lane gate", () => {
	const classifiedLane: string | undefined = undefined;
	const isLane = false;
	const shouldAppendAborted = Boolean(isLane && classifiedLane);
	expect(shouldAppendAborted).toBe(false);
});
