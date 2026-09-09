import { describe, expect, test } from "bun:test";
import { rpcAbortReason } from "../src/modes/rpc/rpc-mode";
import { USER_INTERRUPT_LABEL } from "../src/session/messages";

describe("rpcAbortReason", () => {
	test("defaults to the user-interrupt label when no reason is supplied", () => {
		expect(rpcAbortReason(undefined)).toBe(USER_INTERRUPT_LABEL);
	});

	test("defaults to the user-interrupt label for blank reasons", () => {
		expect(rpcAbortReason("")).toBe(USER_INTERRUPT_LABEL);
		expect(rpcAbortReason("   ")).toBe(USER_INTERRUPT_LABEL);
	});

	test("passes a host-supplied reason through verbatim", () => {
		expect(rpcAbortReason("Interrupted by host (turn replaced)")).toBe(
			"Interrupted by host (turn replaced)",
		);
	});
});
