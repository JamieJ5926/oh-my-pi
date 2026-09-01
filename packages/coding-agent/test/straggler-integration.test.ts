import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, STRAGGLER_CANCEL_REASON } from "../src/async/job-manager";

describe("AsyncJobManager straggler integration", () => {
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
	});

	it(
		"cancels a real-timer straggler after the configured floor",
		async () => {
			manager = new AsyncJobManager({ maxRunningJobs: 10, retentionMs: 60_000 });
			const ownerId = "integration-owner";
			const batchId = "integration-batch";
			let fastCompletedAt: number | undefined;
			let blockerCancelledAt: number | undefined;
			let blockerAbortReason: unknown;

			const fastJobId = manager.register(
				"task",
				"fast",
				async () => {
					// This test intentionally uses the platform clock to prove timer-driven cancellation.
					await new Promise<void>(resolve => setTimeout(resolve, 50));
					fastCompletedAt = Date.now();
					return "fast complete";
				},
				{ ownerId, batchId, stragglerFloorMs: 2_000 },
			);

			const blockerJobId = manager.register(
				"task",
				"blocker",
				async ({ signal }) =>
					await new Promise<string>(resolve => {
						const onAbort = () => {
							blockerCancelledAt = Date.now();
							blockerAbortReason = signal.reason;
							resolve("blocker cancelled");
						};
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}),
				{ ownerId, batchId, stragglerFloorMs: 2_000 },
			);

			await manager.waitForAll();

			const fastJob = manager.getJob(fastJobId);
			const blockerJob = manager.getJob(blockerJobId);
			expect(fastJob?.status).toBe("completed");
			expect(blockerJob?.status).toBe("cancelled");
			expect(blockerAbortReason).toBe(STRAGGLER_CANCEL_REASON);
			expect(fastCompletedAt).toBeDefined();
			expect(blockerCancelledAt).toBeDefined();

			const completionToCancellationMs = blockerCancelledAt! - fastCompletedAt!;
			expect(completionToCancellationMs).toBeGreaterThanOrEqual(1_800);
			expect(completionToCancellationMs).toBeLessThan(2_500);

			console.log(
				JSON.stringify({
					test: "straggler-real-timer",
					fast: { id: fastJobId, status: fastJob?.status, completedAt: fastCompletedAt },
					blocker: {
						id: blockerJobId,
						status: blockerJob?.status,
						cancelledAt: blockerCancelledAt,
						abortReason:
							blockerAbortReason === STRAGGLER_CANCEL_REASON
								? "STRAGGLER_CANCEL_REASON"
								: blockerAbortReason,
					},
					stragglerFloorMs: 2_000,
					completionToCancellationMs,
				}),
			);
		},
		10_000,
	);

	it(
		"registers one replacement for a straggler and marks an exhausted retry missing",
		async () => {
			manager = new AsyncJobManager({ maxRunningJobs: 10, retentionMs: 60_000 });
			const ownerId = "retry-owner";
			const batchId = "retry-batch";
			const logicalItemId = "logical-item";
			const stragglerPolicy = { retryLimit: 1, classifyExhaustedAsMissing: true };
			let currentAttempt = 0;
			let logicalStatus: "running" | "missing" = "running";
			const readLogicalStatus = (): "running" | "missing" => logicalStatus;
			const registrations: Array<{ id: string; attempt: number; logicalItemId: string }> = [];

			const registerAttempt = (): string => {
				const attempt = currentAttempt;
				const id = attempt === 0 ? logicalItemId : `${logicalItemId}-2`;
				const jobId = manager!.register(
					"task",
					id,
					async ({ signal }) =>
						await new Promise<string>(resolve => {
							const onAbort = () => {
								if (signal.reason !== STRAGGLER_CANCEL_REASON) {
									resolve("ordinary cancellation");
									return;
								}
								if (attempt < stragglerPolicy.retryLimit) {
									currentAttempt = attempt + 1;
									registerAttempt();
								} else if (stragglerPolicy.classifyExhaustedAsMissing) {
									logicalStatus = "missing";
								}
								resolve("straggler cancellation");
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
						}),
					{
						id,
						ownerId,
						batchId,
						logicalItemId,
						attempt,
						stragglerFloorMs: 100,
					},
				);
				registrations.push({ id: jobId, attempt, logicalItemId });
				return jobId;
			};

			const firstJobId = registerAttempt();
			expect(manager.cancel(firstJobId, undefined, STRAGGLER_CANCEL_REASON)).toBe(true);
			await Promise.resolve();
			expect(registrations).toEqual([
				{ id: logicalItemId, attempt: 0, logicalItemId },
				{ id: `${logicalItemId}-2`, attempt: 1, logicalItemId },
			]);

			const replacementJobId = registrations[1]!.id;
			expect(manager.cancel(replacementJobId, undefined, STRAGGLER_CANCEL_REASON)).toBe(true);
			await manager.waitForAll();

			expect(manager.getJob(firstJobId)?.status).toBe("cancelled");
			expect(manager.getJob(replacementJobId)?.status).toBe("cancelled");
			expect(readLogicalStatus()).toBe("missing");
			console.log(
				JSON.stringify({
					test: "straggler-retry-exhaustion",
					logicalItemId,
					stragglerPolicy,
					registrations,
					firstStatus: manager.getJob(firstJobId)?.status,
					replacementStatus: manager.getJob(replacementJobId)?.status,
					finalLogicalStatus: readLogicalStatus(),
					stragglerReason: "STRAGGLER_CANCEL_REASON",
				}),
			);
		},
		10_000,
	);
});
