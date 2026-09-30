import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../../src/config/settings";
import { resolveLocalUrlToPath } from "../../src/internal-urls/local-protocol";
import type { ToolSession } from "../../src/sdk";
import { BatchPlanTool } from "../../src/tools/batch-plan";
import { BatchWriteTool } from "../../src/tools/batch-write";
import { WriteTool } from "../../src/tools/write";

function createTestToolSession(cwd: string, sharedArtifactRoot?: string, deviceOnlyWrite = false): ToolSession {
	const settings = Settings.isolated();
	return {
		cwd,
		getSessionId: () => "test-session",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		requireYieldTool: false,
		restrictToolNames: false,
		enableLsp: false,
		deviceOnlyWrite,
		...(sharedArtifactRoot === undefined ? {} : {
			localProtocolOptions: {
				getArtifactsDir: () => sharedArtifactRoot,
				getSessionId: () => "shared-parent-session",
			},
		}),
	};
}

interface PlanArtifact {
	readonly artifactUri: string;
	readonly planDigest: string;
	readonly operationId: string;
	readonly changePlanId: string;
	readonly unitId: string;
}

async function createPlanArtifact(session: ToolSession, _unitId: string, ownedPath: string): Promise<PlanArtifact> {
	const tool = new BatchPlanTool(session);
	const result = await tool.execute("plan-call", {
		objective: "batch safety",
		units: [{
			objective: "write one path",
			ownedPaths: [ownedPath],
			dependencyUnitIndexes: [],
			validationCommands: ["true"],
			isolation: "patch",
		}],
	});
	if (result.details === undefined) throw new Error("batch_plan returned no details");
	const unitId = result.details.batchWriteRequestTemplate.manifest.entries[0]?.unitId;
	if (unitId === undefined) throw new Error("batch_plan returned no unit ID");
	return { artifactUri: result.details.artifactUri, planDigest: result.details.planDigest, operationId: result.details.operationId, changePlanId: result.details.changePlanId, unitId };
}

function manifest(plan: PlanArtifact, unitId: string, manifestPath: string, content = "exploit") {
	return {
		schemaVersion: "1" as const,
		operationId: plan.operationId,
		changePlanId: plan.changePlanId,
		planDigest: plan.planDigest,
		entries: [{ unitId, writes: [{ kind: "full_content" as const, path: manifestPath, content }] }],
	};
}

function missingPlan(artifactUri: string): PlanArtifact {
	return {
		artifactUri,
		planDigest: "0".repeat(64),
		operationId: "op_missing",
		changePlanId: "change_plan_missing",
		unitId: "change_unit_0000" as PlanArtifact["unitId"],
	};
}

async function createMultiUnitPlan(session: ToolSession): Promise<PlanArtifact> {
	const result = await new BatchPlanTool(session).execute("multi-plan", {
		objective: "multi-write failure",
		units: [
			{ objective: "write first unit", ownedPaths: ["src/a.ts", "src/blocker"], dependencyUnitIndexes: [], validationCommands: ["true"], isolation: "patch" },
			{ objective: "write dependent unit", ownedPaths: ["src/later.ts"], dependencyUnitIndexes: [0], validationCommands: ["true"], isolation: "patch" },
		],
	});
	if (result.details === undefined) throw new Error("batch_plan returned no details");
	const unitId = result.details.batchWriteRequestTemplate.manifest.entries[0]?.unitId;
	if (unitId === undefined) throw new Error("batch_plan returned no unit ID");
	return { artifactUri: result.details.artifactUri, planDigest: result.details.planDigest, operationId: result.details.operationId, changePlanId: result.details.changePlanId, unitId };
}

function artifactPath(session: ToolSession, uri: string): string {
	return resolveLocalUrlToPath(uri, session.localProtocolOptions ?? {
		getArtifactsDir: () => session.cwd,
		getSessionId: () => session.getSessionId?.() ?? null,
	});
}

describe("batch-write manifest safety", () => {
	test("rejects path traversal before writing", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "../outside.ts");
			const result = await new BatchWriteTool(session).execute("write-call", { artifactUri: plan.artifactUri, manifest: manifest(plan, plan.unitId, "../outside.ts") });
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.map(issue => issue.code)).toContain("unsafe_path");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rejects absolute paths before writing", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "/etc/passwd");
			const result = await new BatchWriteTool(session).execute("write-call", { artifactUri: plan.artifactUri, manifest: manifest(plan, plan.unitId, "/etc/passwd") });
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.map(issue => issue.code)).toContain("unsafe_path");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rejects symlink escapes before writing", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-outside-"));
		try {
			await fs.symlink(outsideDir, path.join(tmpDir, "evil-link"));
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "evil-link/exploit.ts");
			const result = await new BatchWriteTool(session).execute("write-call", { artifactUri: plan.artifactUri, manifest: manifest(plan, plan.unitId, "evil-link/exploit.ts") });
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.map(issue => issue.code)).toContain("unsafe_path");
			expect(await fs.readdir(outsideDir)).toEqual([]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});

	test("writes a safe manifest and publishes artifacts", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "src/auth.ts");
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/auth.ts", "export const auth = 'safe';"),
			});
			expect(result.isError).not.toBe(true);
			expect(result.details?.status).toBe("applied");
			expect(result.details?.states[0]?.state.kind).toBe("accepted");
			expect(result.details?.appliedPaths).toEqual(["src/auth.ts"]);
			expect(result.details?.manifestUri).toStartWith("local://batch-manifest-");
			expect(result.details?.receiptUri).toStartWith("local://batch-write-receipt-");
			expect(await fs.readFile(path.join(tmpDir, "src/auth.ts"), "utf8")).toBe("export const auth = 'safe';");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("does not record a returned write error as applied", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "src");
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src", "cannot replace a directory"),
			});
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("runtime_failed");
			expect(result.details?.appliedPaths).toEqual([]);
			expect(result.details?.pendingPaths).toEqual(["src"]);
			expect(result.details?.states[0]?.state.kind).toBe("rejected");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rejects a tampered content-addressed plan", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir);
			const plan = await createPlanArtifact(session, "", "src/tamper.ts");
			const planPath = artifactPath(session, plan.artifactUri);
			const artifact = JSON.parse(await fs.readFile(planPath, "utf8"));
			artifact.plan.objective = "tampered";
			await fs.writeFile(planPath, JSON.stringify(artifact), "utf8");
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/tamper.ts", "tamper"),
			});
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.[0]?.message).toContain("digest");
			expect(fs.readFile(path.join(tmpDir, "src/tamper.ts"), "utf8")).rejects.toThrow();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("records exact partial state when the second write fails", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src/blocker"), { recursive: true });
			const session = createTestToolSession(tmpDir);
			const plan = await createMultiUnitPlan(session);
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: {
					schemaVersion: "1",
					operationId: plan.operationId,
					changePlanId: plan.changePlanId,
					planDigest: plan.planDigest,
					entries: [
						{ unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/later.ts", content: "later" }] },
						{ unitId: "change_unit_0000", writes: [
							{ kind: "full_content", path: "src/blocker", content: "blocked" },
							{ kind: "full_content", path: "src/a.ts", content: "first" },
						] },
					],
				},
			});
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("runtime_failed");
			expect(result.details?.failedUnitId).toBe("change_unit_0000");
			expect(result.details?.appliedPaths).toEqual(["src/a.ts"]);
			expect(result.details?.pendingPaths).toEqual(["src/blocker", "src/later.ts"]);
			expect(result.details?.states.map(item => item.state.kind)).toEqual(["rejected", "pending"]);
			expect(await fs.readFile(path.join(tmpDir, "src/a.ts"), "utf8")).toBe("first");
			expect(fs.readFile(path.join(tmpDir, "src/later.ts"), "utf8")).rejects.toThrow();
			expect(result.details?.error?.message.length).toBeGreaterThan(0);
			if (result.details?.receiptUri === undefined) throw new Error("runtime failure returned no receipt");
			const receipt = JSON.parse(await fs.readFile(artifactPath(session, result.details.receiptUri), "utf8"));
			expect(receipt.status).toBe("runtime_failed");
			expect(receipt.appliedPaths).toEqual(["src/a.ts"]);
			expect(receipt.pendingPaths).toEqual(["src/blocker", "src/later.ts"]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("applies a successful dependency chain in canonical order", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir);
			const plan = await createMultiUnitPlan(session);
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: {
					schemaVersion: "1",
					operationId: plan.operationId,
					changePlanId: plan.changePlanId,
					planDigest: plan.planDigest,
					entries: [
						{ unitId: "change_unit_0001", writes: [{ kind: "full_content", path: "src/later.ts", content: "later" }] },
						{ unitId: "change_unit_0000", writes: [
							{ kind: "full_content", path: "src/blocker", content: "second" },
							{ kind: "full_content", path: "src/a.ts", content: "first" },
						] },
					],
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.details?.status).toBe("applied");
			expect(result.details?.appliedPaths).toEqual(["src/a.ts", "src/blocker", "src/later.ts"]);
			expect(result.details?.states.map(item => item.state.kind)).toEqual(["accepted", "accepted"]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("shares plan and receipt artifacts across planner and implementer sessions", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-shared-"));
		const plannerCwd = path.join(root, "planner");
		const writerCwd = path.join(root, "writer");
		const artifactRoot = path.join(root, "artifacts");
		try {
			await fs.mkdir(plannerCwd, { recursive: true });
			await fs.mkdir(path.join(writerCwd, "src"), { recursive: true });
			await fs.mkdir(artifactRoot, { recursive: true });
			const plannerSession = createTestToolSession(plannerCwd, artifactRoot);
			const writerSession = createTestToolSession(writerCwd, artifactRoot);
			const plan = await createPlanArtifact(plannerSession, "", "src/shared.ts");
			expect(artifactPath(plannerSession, plan.artifactUri).startsWith(artifactRoot)).toBe(true);
			const result = await new BatchWriteTool(writerSession).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/shared.ts", "shared"),
			});
			expect(result.details?.status).toBe("applied");
			expect(await fs.readFile(path.join(writerCwd, "src/shared.ts"), "utf8")).toBe("shared");
			if (result.details?.receiptUri === undefined) throw new Error("batch_write returned no receipt");
			expect(artifactPath(writerSession, result.details.receiptUri).startsWith(artifactRoot)).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("returns stable preflight details for a missing plan artifact", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			const session = createTestToolSession(tmpDir);
			const plan = missingPlan("local://missing-plan.json");
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/missing.ts"),
			});
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.[0]?.message.length).toBeGreaterThan(0);
			expect(result.details?.appliedPaths).toEqual([]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rejects a directory used as the plan artifact", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			const session = createTestToolSession(tmpDir);
			await fs.mkdir(artifactPath(session, "local://"), { recursive: true });
			const plan = missingPlan("local://");
			const result = await new BatchWriteTool(session).execute("write-call", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/missing.ts"),
			});
			expect(result.isError).toBe(true);
			expect(result.details?.status).toBe("preflight_rejected");
			expect(result.details?.issues?.[0]?.message).toContain("file");
			expect(result.details?.appliedPaths).toEqual([]);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("replays the same explicit plan without artifact collision", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-test-"));
		try {
			const session = createTestToolSession(tmpDir);
			const first = await createPlanArtifact(session, "", "src/replay.ts");
			const second = await createPlanArtifact(session, "", "src/replay.ts");
			expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(second.planDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(await fs.readFile(artifactPath(session, first.artifactUri), "utf8")).toContain(first.planDigest);
			expect(await fs.readFile(artifactPath(session, second.artifactUri), "utf8")).toContain(second.planDigest);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("keeps direct write unavailable while batch_write uses the composite write path", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-restricted-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir, undefined, true);
			await expect(new WriteTool(session).execute("direct-write", {
				path: "src/direct.ts",
				content: "direct",
			})).rejects.toThrow("limited to the xd:// device transport");
			const plan = await createPlanArtifact(session, "", "src/restricted.ts");
			const result = await new BatchWriteTool(session).execute("batch-write", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/restricted.ts", "batch"),
			});
			expect(result.details?.status).toBe("applied");
			expect(await fs.readFile(path.join(tmpDir, "src/restricted.ts"), "utf8")).toBe("batch");
			expect(fs.readFile(path.join(tmpDir, "src/direct.ts"), "utf8")).rejects.toThrow();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("preserves an existing file mode on replacement", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-write-mode-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const target = path.join(tmpDir, "src/mode.ts");
			await fs.writeFile(target, "old", "utf8");
			await fs.chmod(target, 0o744);
			const session = createTestToolSession(tmpDir, undefined, true);
			const plan = await createPlanArtifact(session, "", "src/mode.ts");
			const result = await new BatchWriteTool(session).execute("batch-write", {
				artifactUri: plan.artifactUri,
				manifest: manifest(plan, plan.unitId, "src/mode.ts", "new"),
			});
			expect(result.details?.status).toBe("applied");
			expect((await fs.stat(target)).mode & 0o777).toBe(0o744);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("hashes arbitrary tool-call IDs before minting plan IDs", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-plan-id-"));
		try {
			const session = createTestToolSession(tmpDir);
			const result = await new BatchPlanTool(session).execute("unsafe/../call", {
				objective: "safe identifiers",
                units: [{
                    objective: "own one file",
                    ownedPaths: ["src/id.ts"],
                    dependencyUnitIndexes: [],
                    validationCommands: ["true"],
                    isolation: "patch",
                }],
            });
			if (result.details === undefined) throw new Error("batch_plan returned no details");
			expect(result.details.operationId).toMatch(/^op_[a-f0-9]{32}$/);
			expect(result.details.changePlanId).toMatch(/^change_plan_[a-f0-9]{32}$/);
			expect(result.details.operationId).not.toContain("/");
			expect(result.details.changePlanId).not.toContain("/");
			expect(result.details.batchWriteRequestTemplate).toEqual({
				artifactUri: result.details.artifactUri,
				manifest: {
					schemaVersion: "1",
					operationId: result.details.operationId,
					changePlanId: result.details.changePlanId,
					planDigest: result.details.planDigest,
						entries: [{ unitId: "change_unit_0000", writes: [] }],
				},
			});
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
	test("executes the ready batch request returned by batch_plan", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-plan-request-"));
		try {
			await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
			const session = createTestToolSession(tmpDir, undefined, true);
			const planned = await new BatchPlanTool(session).execute("ready-request", {
				objective: "ready request",
                units: [{
                    objective: "write ready file",
                    ownedPaths: ["src/ready.ts"],
                    dependencyUnitIndexes: [],
                    validationCommands: ["true"],
                    isolation: "patch",
                }],
            });
			if (planned.details === undefined) throw new Error("batch_plan returned no details");
			const template = planned.details.batchWriteRequestTemplate;
			const firstEntry = template.manifest.entries[0];
			if (firstEntry === undefined) throw new Error("batch_plan returned no manifest entry");
			const result = await new BatchWriteTool(session).execute("ready-write", {
				artifactUri: template.artifactUri,
				manifest: {
					...template.manifest,
					entries: [{
						unitId: firstEntry.unitId,
						writes: [{ kind: "full_content", path: "src/ready.ts", content: "ready" }],
					}],
				},
			});
			expect(result.details?.status).toBe("applied");
			expect(await fs.readFile(path.join(tmpDir, "src/ready.ts"), "utf8")).toBe("ready");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
