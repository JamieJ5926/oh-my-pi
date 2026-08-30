import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import {
	AsyncJobManagerJobExecutor,
	type ExecutableJob,
	type JobExecutionSubstrate,
} from "../../src/capability/job-executor";
import type { SingleResult } from "../../src/task/types";

const managers: AsyncJobManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose()));
});

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
	managers.push(manager);
	return manager;
}

function job(jobId: string, overrides: Partial<ExecutableJob> = {}): ExecutableJob {
	return {
		jobId,
		operationId: "operation-1",
		capabilityStage: "m0",
		objective: `execute ${jobId}`,
		input: { jobId },
		agent: { id: `agent-${jobId}`, name: `Agent ${jobId}`, source: "project" },
		...overrides,
	};
}

function result(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "project",
		task: `execute ${id}`,
		exitCode: 0,
		output: `output-${id}`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		...overrides,
	};
}

describe("AsyncJobManagerJobExecutor", () => {
	test("returns successful jobs in deterministic input order", async () => {
		const first = Promise.withResolvers<SingleResult>();
		const secondCompleted = Promise.withResolvers<void>();
		const substrate: JobExecutionSubstrate = {
			execute: async current => {
				if (current.jobId === "first") return first.promise;
				secondCompleted.resolve();
				return result(current.agent.id);
			},
		};
		const executor = new AsyncJobManagerJobExecutor({ manager: createManager(), substrate });
		const execution = executor.executeBatch([job("first"), job("second")]);
		await secondCompleted.promise;
		first.resolve(result("agent-first"));

		const outcomes = await execution;

		expect(outcomes.map(outcome => outcome.jobId)).toEqual(["first", "second"]);
		expect(outcomes.map(outcome => outcome.disposition.kind)).toEqual(["success", "success"]);
		expect(outcomes.map(outcome => outcome.output)).toEqual(["output-agent-first", "output-agent-second"]);
	});

	test("classifies executor timeout and aborts the substrate", async () => {
		let abortReason: unknown;
		const pending = Promise.withResolvers<unknown>();
		const substrate: JobExecutionSubstrate = {
			execute: async (_current, context) => {
				context.signal.addEventListener(
					"abort",
					() => {
						abortReason = context.signal.reason;
						pending.reject(context.signal.reason);
					},
					{ once: true },
				);
				return pending.promise;
			},
		};
		const executor = new AsyncJobManagerJobExecutor({ manager: createManager(), substrate });

		const [outcome] = await executor.executeBatch([
			job("slow", { timeoutPolicy: { timeoutMs: 5 }, retryPolicy: { retryLimit: 1 } }),
		]);

		expect(outcome.disposition).toEqual({ kind: "timeout", retryable: true });
		expect(abortReason).toBeDefined();
		expect(outcome.diagnostics.asyncJobStatus).toBe("cancelled");
	});

	test("classifies malformed substrate output as non-retryable when retries are disabled", async () => {
		const substrate: JobExecutionSubstrate = { execute: async () => ({ unexpected: true }) };
		const executor = new AsyncJobManagerJobExecutor({ manager: createManager(), substrate });

		const [outcome] = await executor.executeBatch([job("malformed", { retryPolicy: { retryLimit: 0 } })]);

		expect(outcome.disposition).toEqual({
			kind: "malformed_result",
			reason: "invalid_result_shape",
			message: "Substrate result has no details object",
			retryable: false,
		});
	});

	test("preserves settled routing metadata", async () => {
		const substrate: JobExecutionSubstrate = {
			execute: async current =>
				result(current.agent.id, {
					modelOverride: "configured/model",
					modelRole: "explorer",
					resolvedModel: "cli-proxy/codex.gpt-5.6-luna.explorer",
					resolvedModelIsFallback: false,
				}),
		};
		const executor = new AsyncJobManagerJobExecutor({ manager: createManager(), substrate });

		const [outcome] = await executor.executeBatch([job("routed")]);

		expect(outcome.routing).toEqual({
			modelOverride: "configured/model",
			modelRole: "explorer",
			resolvedModel: "cli-proxy/codex.gpt-5.6-luna.explorer",
			resolvedModelIsFallback: false,
		});
	});
});
