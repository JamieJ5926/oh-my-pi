import { describe, expect, it } from "bun:test";
import {
	ExecutionCoordinator,
	ResourceAdmissionController,
	truncateUtf8,
	utf8ByteLength,
	type ExecutionEvent,
	type ExecutionSession,
} from "../src/bridge/index.js";

describe("bridge resource contracts", () => {
	it("admits one running execution, queues one, and rejects the third deterministically", () => {
		const controller = new ResourceAdmissionController({ maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 32, maxEventBytes: 128, maxEventsPerExecution: 4 });
		expect(controller.admit("one", 4)).toEqual({ kind: "admitted", reservationId: "one" });
		controller.transition({ kind: "running", id: "one" });
		expect(controller.admit("two", 4)).toEqual({ kind: "queued", reservationId: "two", position: 0 });
		expect(controller.admit("three", 4)).toEqual({ kind: "rejected", reason: "queue-full" });
		expect(controller.snapshot()).toMatchObject({ runningWorkers: 1, queuedExecutions: 1, admittedExecutions: 1, queuedBytes: 4 });
		controller.transition({ kind: "cancelled", id: "two" });
		controller.transition({ kind: "terminal", id: "one", resultBytes: 40 });
		expect(controller.snapshot()).toMatchObject({ runningWorkers: 0, queuedExecutions: 0, resultBytes: 32 });
	});

	it("tracks overflow and bounds UTF-8 output without splitting code points", () => {
		const controller = new ResourceAdmissionController({ maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 5, maxEventBytes: 128, maxEventsPerExecution: 4 });
		expect(utf8ByteLength("é🙂")).toBe(6);
		expect(truncateUtf8("é🙂z", 5)).toEqual({ value: "é", bytes: 2, truncated: true });
		const bounded = controller.boundResult("abcdef");
		expect(bounded).toEqual({ output: "abcde", bytes: 5, overflow: true });
		expect(controller.admit("overflow", 1).kind).toBe("admitted");
		controller.transition({ kind: "overflow", id: "overflow", droppedBytes: 1 });
		expect(controller.snapshot().overflowedExecutions).toBe(1);
	});

	it("preserves OMP admission, event order, cancellation, resume, and model attribution", async () => {
		const events: ExecutionEvent[] = [];
		const admission = {
			admit: async ({ executionId }: { executionId: string }) => ({ leaseId: `lease-${executionId}`, owner: "omp" }),
			release: async () => undefined,
		};
		const session: ExecutionSession = {
			events: (async function* () {
				yield { kind: "started", executionId: "exec", sequence: 1, attribution: { fallback: "no" as const } };
				yield { kind: "text-delta", executionId: "exec", sequence: 2, text: "done", attribution: { fallback: "no" as const } };
				yield { kind: "terminal", executionId: "exec", sequence: 3, result: { executionId: "exec", output: "done", outputBytes: 4, stopReason: "completed", attribution: { fallback: "no" as const }, telemetry: { startedAt: 1, finishedAt: 2, eventCount: 2, droppedEventCount: 0, cancellationRequested: false, backend: "pi" } } };
			})(),
			result: Promise.resolve({ executionId: "exec", output: "done", outputBytes: 4, stopReason: "completed", attribution: { fallback: "no" as const }, telemetry: { startedAt: 1, finishedAt: 2, eventCount: 2, droppedEventCount: 0, cancellationRequested: false, backend: "pi" } }),
			cancel: async () => undefined,
			resume: async () => session,
		};
		const coordinator = new ExecutionCoordinator({
			policy: { maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 32, maxEventBytes: 1024, maxEventsPerExecution: 8 },
			admission,
			backends: { get: () => ({ backend: "pi" as const, start: async () => session }) },
			id: () => "exec",
		});
		const handle = coordinator.execute({ executionId: "exec", backend: "pi", prompt: "hello", provider: "p", model: "m" });
		for await (const event of handle.events) events.push(event);
		const result = await handle.result;
		expect(events.map(event => event.kind)).toEqual(["started", "text-delta", "terminal"]);
		expect(result.output).toBe("done");
		expect(result.attribution.requestedModel).toBeUndefined();
		expect(result.telemetry.backend).toBe("pi");
	});

    it("uses the supplied clock callback when backend execution fails", async () => {
        const coordinator = new ExecutionCoordinator({
            policy: { maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 32, maxEventBytes: 1024, maxEventsPerExecution: 8 },
            admission: { admit: async () => ({ leaseId: "lease-error" }) },
            backends: {
                get: () => ({
                    backend: "pi" as const,
                    start: async () => {
                        throw new Error("backend failed");
                    },
                }),
            },
            now: () => 123,
            id: () => "error-exec",
        });
        const result = await coordinator.execute({ backend: "pi", prompt: "hello" }).result;
        expect(result.stopReason).toBe("failed");
        expect(result.error).toEqual({ code: "EXECUTION_FAILED", message: "backend failed" });
        expect(result.telemetry.startedAt).toBe(123);
        expect(result.telemetry.finishedAt).toBe(123);
    });

    it("resumes the supplied session without starting the backend again", async () => {
        let startCount = 0;
        let resumeCount = 0;
        const resultFor = (executionId: string, output: string) => ({
            executionId,
            output,
            outputBytes: output.length,
            stopReason: "completed" as const,
            attribution: { fallback: "no" as const },
            telemetry: { startedAt: 1, finishedAt: 2, eventCount: 1, droppedEventCount: 0, cancellationRequested: false, backend: "pi" as const },
        });
        const sessionFor = (executionId: string, output: string): ExecutionSession => ({
            events: (async function* () {
                yield { kind: "terminal", executionId, sequence: 1, result: resultFor(executionId, output) };
            })(),
            result: Promise.resolve(resultFor(executionId, output)),
            cancel: async () => undefined,
            resume: async () => {
                resumeCount++;
                return sessionFor(`${executionId}:resumed`, "resumed");
            },
        });
        const initial = sessionFor("exec", "initial");
        const coordinator = new ExecutionCoordinator({
            policy: { maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 32, maxEventBytes: 1024, maxEventsPerExecution: 8 },
            admission: { admit: async ({ executionId }) => ({ leaseId: `lease-${executionId}` }) },
            backends: {
                get: () => ({
                    backend: "pi" as const,
                    start: async () => {
                        startCount++;
                        if (startCount > 1) throw new Error("backend started twice");
                        return initial;
                    },
                }),
            },
        });
        const handle = coordinator.execute({ executionId: "exec", backend: "pi", prompt: "hello" });
        expect((await handle.result).output).toBe("initial");
        const resumed = await handle.resume();
        expect((await resumed.result).output).toBe("resumed");
        expect(startCount).toBe(1);
        expect(resumeCount).toBe(1);
    });

	it("rejects requests when RSS exceeds the configured limit", () => {
		const controller = new ResourceAdmissionController({ maxInferenceWorkers: 1, maxQueuedExecutions: 1, maxQueuedBytes: 100, maxResultBytes: 32, maxEventBytes: 128, maxEventsPerExecution: 4, maxRssBytes: 10 });
		controller.setRssBytes(11);
		expect(controller.admit("rss", 1)).toEqual({ kind: "rejected", reason: "rss-limit" });
	});
});
