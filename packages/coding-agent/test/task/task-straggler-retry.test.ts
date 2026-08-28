import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	AsyncJobManager,
	STRAGGLER_CANCEL_REASON,
	type AsyncJobRegisterOptions,
} from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};
const STRAGGLER_REASON_LOOKALIKE = Symbol("AsyncJobManager straggler cancellation");

interface ControlledRun {
	readonly id: string;
	readonly options: ExecutorOptions;
	abortReason: unknown;
	settled: boolean;
	resolve(overrides?: Partial<SingleResult>): void;
}

const managers: AsyncJobManager[] = [];
const activeRuns: ControlledRun[] = [];

function createSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.batch": true,
			"task.isolation.mode": "worktree",
			"task.isolation.apply": false,
			"task.maxConcurrency": 4,
		}),
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Parent",
		suppressSpawnAdvisory: true,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
	managers.push(manager);
	return manager;
}

function makeResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 0,
		output: `${options.id} done`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		modelOverride: options.modelOverride,
		modelRole: options.modelRole,
		...overrides,
	};
}

function cancelledResult(run: ControlledRun, reasonLabel: string): Partial<SingleResult> {
	return {
		exitCode: 1,
		output: "",
		stderr: `${run.id} ${reasonLabel}`,
		error: `${run.id} ${reasonLabel}`,
		aborted: true,
		abortReason: reasonLabel,
	};
}

function installControlledIsolatedRunner(): void {
	vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp/repo" } as never);
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
		const gate = Promise.withResolvers<SingleResult>();
		const run: ControlledRun = {
			id: baseOptions.id,
			options: baseOptions,
			abortReason: undefined,
			settled: false,
			resolve: (overrides = {}) => {
				if (run.settled) return;
				run.settled = true;
				gate.resolve(makeResult(baseOptions, overrides));
			},
		};
		baseOptions.signal?.addEventListener(
			"abort",
			() => {
				run.abortReason = baseOptions.signal?.reason;
			},
			{ once: true },
		);
		activeRuns.push(run);
		return gate.promise;
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function pollUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

async function waitForRun(id: string): Promise<ControlledRun> {
	await pollUntil(() => activeRuns.some(run => run.id === id));
	const run = activeRuns.find(candidate => candidate.id === id);
	if (!run) throw new Error(`Run ${id} was not captured`);
	return run;
}

function latestUpdate(updates: Array<{ text: string; details: TaskToolDetails }>): { text: string; details: TaskToolDetails } {
	const update = updates.at(-1);
	if (!update) throw new Error("Expected at least one task update");
	return update;
}

function progressFor(details: TaskToolDetails, id: string) {
	return details.progress?.find(progress => progress.id === id);
}

function optionsForAttempt(
	calls: Array<Parameters<AsyncJobManager["register"]>>,
	logicalItemId: string,
	attempt: number,
): AsyncJobRegisterOptions {
	const options = calls.find(call => call[3]?.logicalItemId === logicalItemId && call[3]?.attempt === attempt)?.[3];
	if (!options) throw new Error(`Missing registration for ${logicalItemId} attempt ${attempt}`);
	return options;
}

function registrationsFor(
	calls: Array<Parameters<AsyncJobManager["register"]>>,
	logicalItemId: string,
): AsyncJobRegisterOptions[] {
	return calls
		.map(call => call[3])
		.filter((options): options is AsyncJobRegisterOptions => options?.logicalItemId === logicalItemId);
}

async function settlePendingRuns(): Promise<void> {
	for (let pass = 0; pass < 5; pass++) {
		const pending = activeRuns.filter(run => !run.settled);
		if (pending.length === 0) return;
		for (const run of pending) {
			run.resolve(
				run.abortReason === undefined
					? undefined
					: cancelledResult(run, run.abortReason === STRAGGLER_CANCEL_REASON ? "straggler" : "cancelled"),
			);
		}
		await flushMicrotasks();
	}
}

describe("TaskTool straggler retry", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		installControlledIsolatedRunner();
	});

	afterEach(async () => {
		await settlePendingRuns();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		activeRuns.length = 0;
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("replaces an opted-in straggler once with a fresh id while preserving the logical batch item", async () => {
		const manager = makeManager();
		const register = vi.spyOn(manager, "register");
		const tool = await TaskTool.create(createSession(manager));
		const updates: Array<{ text: string; details: TaskToolDetails }> = [];

		const result = await tool.execute(
			"tc-retry-success",
			{
				context: "Shared retry context.",
				tasks: [
					{ name: "Fast", task: "Finish first.", isolated: true },
					{
						name: "Slow",
						agent: "task",
						task: "Finish after retry.",
						taskClass: "local-read",
						isolated: true,
						stragglerPolicy: { retryLimit: 1, classifyExhaustedAsMissing: true },
					},
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						text: update.content.find(part => part.type === "text")?.text ?? "",
						details: update.details,
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");
		const fastRun = await waitForRun("Fast");
		const slowRun = await waitForRun("Slow");
		fastRun.resolve();
		await manager.getJob("Fast")?.promise;

		expect(manager.cancel("Slow", undefined, STRAGGLER_CANCEL_REASON)).toBe(true);
		await pollUntil(() => register.mock.calls.some(call => call[3]?.logicalItemId === "Slow" && call[3]?.attempt === 1));
		const retryRun = await waitForRun("Slow-2");
		expect(slowRun.abortReason).toBe(STRAGGLER_CANCEL_REASON);

		const attempt0 = optionsForAttempt(register.mock.calls, "Slow", 0);
		const attempt1 = optionsForAttempt(register.mock.calls, "Slow", 1);
		expect(attempt0).toMatchObject({
			id: "Slow",
			agentId: "Slow",
			ownerId: "Parent",
			batchId: "tc-retry-success",
			logicalItemId: "Slow",
			attempt: 0,
		});
		expect(attempt1).toMatchObject({
			id: "Slow-2",
			agentId: "Slow-2",
			ownerId: "Parent",
			batchId: "tc-retry-success",
			logicalItemId: "Slow",
			attempt: 1,
		});
		expect(registrationsFor(register.mock.calls, "Slow").map(options => options.attempt)).toEqual([0, 1]);

		expect(
			[slowRun, retryRun].map(run => ({
				agent: run.options.agent.name,
				assignment: run.options.assignment,
				context: run.options.context,
				detached: run.options.detached,
			})),
		).toEqual([
			{ agent: "task", assignment: "Finish after retry.", context: "Shared retry context.", detached: true },
			{ agent: "task", assignment: "Finish after retry.", context: "Shared retry context.", detached: true },
		]);

		expect(latestUpdate(updates).details.async?.state).toBe("running");
		retryRun.resolve({ output: "retry won" });
		await manager.getJob("Slow-2")?.promise;
		await pollUntil(() => latestUpdate(updates).details.async?.state === "completed");
		const completed = latestUpdate(updates).details;
		expect(progressFor(completed, "Slow-2")?.status).toBe("completed");
		expect(progressFor(completed, "Slow")).toBeUndefined();

		slowRun.resolve(cancelledResult(slowRun, "late original straggler"));
		await manager.getJob("Slow")?.promise;
		await flushMicrotasks();
		const afterLateOriginal = latestUpdate(updates).details;
		expect(afterLateOriginal.async?.state).toBe("completed");
		expect(progressFor(afterLateOriginal, "Slow-2")?.status).toBe("completed");
		expect(progressFor(afterLateOriginal, "Slow")).toBeUndefined();
		expect(registrationsFor(register.mock.calls, "Slow").map(options => options.attempt)).toEqual([0, 1]);
		expect(manager.getJob("Slow-3")).toBeUndefined();
	});

	it("classifies a second straggler as missing when retry exhaustion asks for missing", async () => {
		const manager = makeManager();
		const register = vi.spyOn(manager, "register");
		const tool = await TaskTool.create(createSession(manager));
		const updates: Array<{ text: string; details: TaskToolDetails }> = [];

		await tool.execute(
			"tc-retry-missing",
			{
				context: "Shared retry context.",
				tasks: [
					{ name: "Fast", task: "Finish first.", isolated: true },
					{
						name: "Slow",
						task: "May go missing.",
						taskClass: "local-read",
						isolated: true,
						stragglerPolicy: { retryLimit: 1, classifyExhaustedAsMissing: true },
					},
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						text: update.content.find(part => part.type === "text")?.text ?? "",
						details: update.details,
					});
				}
			},
		);

		const fastRun = await waitForRun("Fast");
		const slowRun = await waitForRun("Slow");
		fastRun.resolve();
		await manager.getJob("Fast")?.promise;

		expect(manager.cancel("Slow", undefined, STRAGGLER_CANCEL_REASON)).toBe(true);
		await pollUntil(() => register.mock.calls.some(call => call[3]?.logicalItemId === "Slow" && call[3]?.attempt === 1));
		const retryRun = await waitForRun("Slow-2");
		expect(latestUpdate(updates).details.async?.state).toBe("running");

		expect(manager.cancel("Slow-2", undefined, STRAGGLER_CANCEL_REASON)).toBe(true);
		retryRun.resolve(cancelledResult(retryRun, "straggler"));
		await manager.getJob("Slow-2")?.promise;
		slowRun.resolve(cancelledResult(slowRun, "late original straggler"));
		await manager.getJob("Slow")?.promise;
		await flushMicrotasks();

		expect(registrationsFor(register.mock.calls, "Slow").map(options => options.attempt)).toEqual([0, 1]);
		expect(manager.getJob("Slow-3")).toBeUndefined();
		const finalUpdate = latestUpdate(updates);
		expect(finalUpdate.details.async?.state).toBe("failed");
		expect(progressFor(finalUpdate.details, "Slow-2")?.status).toBe("missing");
		expect(finalUpdate.text.toLowerCase()).toContain("missing");
	});

	it("does not retry default policy stragglers or non-straggler cancellations", async () => {
		const cases: Array<{
			name: string;
			params: TaskParams;
			cancelReason: unknown;
		}> = [
			{
				name: "default policy",
				params: {
					context: "No retry by default.",
					tasks: [{ name: "DefaultSlow", task: "Do not retry.", isolated: true }],
				},
				cancelReason: STRAGGLER_CANCEL_REASON,
			},
			{
				name: "ordinary cancellation",
				params: {
					context: "Retry only stragglers.",
					tasks: [
						{
							name: "OrdinarySlow",
							task: "Do not retry this cancellation.",
							isolated: true,
							stragglerPolicy: { retryLimit: 1, classifyExhaustedAsMissing: true },
						},
					],
				},
				cancelReason: STRAGGLER_REASON_LOOKALIKE,
			},
		];

		for (const testCase of cases) {
			const manager = makeManager();
			const register = vi.spyOn(manager, "register");
			const tool = await TaskTool.create(createSession(manager));
			const itemName = testCase.params.tasks?.[0]?.name;
			if (!itemName) throw new Error(`Missing item name for ${testCase.name}`);

			await tool.execute(`tc-no-retry-${testCase.name}`, testCase.params);
			const run = await waitForRun(itemName);
			expect(manager.cancel(itemName, undefined, testCase.cancelReason)).toBe(true);
			run.resolve(
				cancelledResult(
					run,
					testCase.cancelReason === STRAGGLER_CANCEL_REASON ? "straggler without retry" : "AsyncJobManager straggler cancellation",
				),
			);
			await manager.getJob(itemName)?.promise;
			await flushMicrotasks();

			expect(registrationsFor(register.mock.calls, itemName).map(options => options.attempt)).toEqual([0]);
			expect(manager.getJob(`${itemName}-2`)).toBeUndefined();
		}
	});
});
