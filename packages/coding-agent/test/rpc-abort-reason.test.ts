import { describe, expect, test } from "bun:test";
import {
	RPC_ABORT_REASON_MAX_LENGTH,
	handleRpcAbort,
	resolveRpcAbort,
} from "../src/modes/rpc/rpc-mode";
import {
	buildRpcAbortAndPromptCommand,
	buildRpcAbortCommand,
} from "../src/modes/rpc/rpc-types";
import { USER_INTERRUPT_LABEL } from "../src/session/messages";

describe("resolveRpcAbort", () => {
	test("defaults to the user-interrupt label with no host flag when no reason is supplied", () => {
		expect(resolveRpcAbort(undefined)).toEqual({ reason: USER_INTERRUPT_LABEL, hostInterrupt: false });
	});

	test("defaults to the user-interrupt label with no host flag for blank reasons", () => {
		expect(resolveRpcAbort("")).toEqual({ reason: USER_INTERRUPT_LABEL, hostInterrupt: false });
		expect(resolveRpcAbort("   ")).toEqual({ reason: USER_INTERRUPT_LABEL, hostInterrupt: false });
	});

	test("passes a host-supplied reason through trimmed with the host flag set", () => {
		expect(resolveRpcAbort("Interrupted by host (turn replaced)")).toEqual({
			reason: "Interrupted by host (turn replaced)",
			hostInterrupt: true,
		});
		expect(resolveRpcAbort("  padded  ")).toEqual({ reason: "padded", hostInterrupt: true });
	});

	test("truncates overlong host reasons to the documented bound", () => {
		const resolved = resolveRpcAbort("x".repeat(RPC_ABORT_REASON_MAX_LENGTH + 50));
		expect(resolved.reason).toHaveLength(RPC_ABORT_REASON_MAX_LENGTH);
		expect(resolved.hostInterrupt).toBe(true);
	});
});

describe("abort wire builders", () => {
	test("omits reason entirely for default-compat hosts", () => {
		expect(buildRpcAbortCommand()).toEqual({ type: "abort" });
		expect(buildRpcAbortCommand(undefined)).toEqual({ type: "abort" });
		expect("reason" in buildRpcAbortCommand()).toBe(false);
	});

	test("carries an explicit reason on the wire", () => {
		expect(buildRpcAbortCommand("Interrupted by host")).toEqual({
			type: "abort",
			reason: "Interrupted by host",
		});
	});

	test("abort_and_prompt keeps message/images shape with and without reason", () => {
		expect(buildRpcAbortAndPromptCommand("go again")).toEqual({
			type: "abort_and_prompt",
			message: "go again",
			images: undefined,
		});
		expect(buildRpcAbortAndPromptCommand("go again", undefined, "Interrupted by host")).toEqual({
			type: "abort_and_prompt",
			message: "go again",
			images: undefined,
			reason: "Interrupted by host",
		});
	});
});

function stubSession() {
	const aborts: unknown[] = [];
	const prompts: unknown[] = [];
	return {
		aborts,
		prompts,
		session: {
			abort: async (options: unknown) => {
				aborts.push(options);
			},
			prompt: async (message: unknown, options: unknown) => {
				prompts.push([message, options]);
				return true;
			},
		},
	};
}

describe("handleRpcAbort", () => {
	test("default abort maps to the label with no host flag", async () => {
		const { aborts, session } = stubSession();
		const response = await handleRpcAbort(session, { type: "abort" }, () => {});
		expect(aborts).toEqual([{ reason: USER_INTERRUPT_LABEL, hostInterrupt: false }]);
		expect(response).toEqual({ id: undefined, type: "response", command: "abort", success: true });
	});

	test("host-reason abort forwards text plus the host flag", async () => {
		const { aborts, session } = stubSession();
		const response = await handleRpcAbort(
			session,
			{ id: "a1", type: "abort", reason: "Interrupted by host (turn replaced)" },
			() => {},
		);
		expect(aborts).toEqual([
			{ reason: "Interrupted by host (turn replaced)", hostInterrupt: true },
		]);
		expect(response).toEqual({ id: "a1", type: "response", command: "abort", success: true });
	});

	test("abort_and_prompt schedules the replacement prompt after aborting", async () => {
		const { aborts, prompts, session } = stubSession();
		const response = await handleRpcAbort(
			session,
			{ id: "a2", type: "abort_and_prompt", message: "go again", reason: "Interrupted by host" },
			() => {},
		);
		expect(aborts).toEqual([{ reason: "Interrupted by host", hostInterrupt: true }]);
		expect(prompts).toEqual([["go again", { images: undefined }]]);
		expect(response).toEqual({ id: "a2", type: "response", command: "abort_and_prompt", success: true });
	});

	test("a failed replacement prompt emits a same-id error frame", async () => {
		const outputs: unknown[] = [];
		const { session } = stubSession();
		const failing = {
			...session,
			prompt: async () => {
				throw new Error("schedule boom");
			},
		};
		const response = await handleRpcAbort(
			failing,
			{ id: "a3", type: "abort_and_prompt", message: "go again" },
			frame => outputs.push(frame),
		);
		await Promise.resolve();
		expect(response).toEqual({ id: "a3", type: "response", command: "abort_and_prompt", success: true });
		expect(outputs).toEqual([
			{
				id: "a3",
				type: "response",
				command: "abort_and_prompt",
				success: false,
				error: "schedule boom",
			},
		]);
	});
});
