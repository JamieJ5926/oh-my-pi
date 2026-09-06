/**
 * `hub` wait policy: a non-watcher caller may not hold a wait window longer
 * than 120s. Holding the long wait is a watcher's job — a parent that parks on
 * it is the babysitting the cap exists to stop — so the tool rejects the call
 * with the dispatch-a-watcher remedy rather than silently shortening it.
 *
 * The caller class comes from the resolved agent definition (`getCallerRole`),
 * never inferred from the model or the agent id, and defaults to `non-watcher`
 * when the session supplies none.
 *
 * Scope note: the policy is wired into the supervised-process leg of `wait`
 * (`params.timeout`, seconds) only. The message/job leg (`params.timeoutMs`)
 * is unguarded; the last test pins that gap so a later fix has to update it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CallerRoleClass, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type HubDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

/** Substring of the policy rejection; the remedy is asserted separately. */
const CAP_REJECTION = "must be at most 120 seconds";
/**
 * Proof a call cleared the policy gate: the next gate in `case "wait"` is the
 * launch broker, disabled in these sessions. Asserting its message keeps
 * "the policy allowed this" observable without a real process broker.
 */
const PAST_POLICY = "Process supervision is disabled (launch.enabled=false).";

function makeSession(options: { callerRole?: CallerRoleClass; manager?: AsyncJobManager } = {}): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "async.pollWaitDuration") return "5m";
				if (key === "irc.timeoutMs") return 120_000;
				// `launch.enabled` stays unset, so the broker gate rejects.
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: options.manager,
		getAgentId: () => SELF_ID,
		// Omitted entirely when no role is given: that is the default-path case.
		...(options.callerRole === undefined ? {} : { getCallerRole: () => options.callerRole }),
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

function textOf(result: AgentToolResult<HubDetails>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

/** Run the supervised-process leg of `wait` (`name` present, `timeout` in seconds). */
async function processWait(
	timeout: number | undefined,
	callerRole?: CallerRoleClass,
): Promise<{ isError: boolean; text: string }> {
	const tool = new HubTool(makeSession({ callerRole }));
	const result = await tool.execute("call", {
		op: "wait",
		name: "web",
		...(timeout === undefined ? {} : { timeout }),
	});
	return { isError: result.isError === true, text: textOf(result) };
}

describe("hub wait policy", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("rejects a non-watcher wait past the cap and names the remedy", async () => {
		const { isError, text } = await processWait(121, "non-watcher");

		expect(isError).toBe(true);
		expect(text).toContain(CAP_REJECTION);
		// The rejection has to be actionable, not just a refusal.
		expect(text).toContain("Dispatch one watcher that holds the long wait and yields once on the event.");
		// The wait leg is named so the caller can tell which of the two it hit.
		expect(text).toContain("supervised-process");
	});

	test("the cap boundary is 120s inclusive, so 120 clears and 121 does not", async () => {
		const allowed = await processWait(120, "non-watcher");
		const rejected = await processWait(121, "non-watcher");

		// An off-by-one in either direction breaks exactly one of these.
		expect(allowed.text).not.toContain(CAP_REJECTION);
		expect(allowed.text).toContain(PAST_POLICY);
		expect(rejected.text).toContain(CAP_REJECTION);
	});

	test("a watcher may hold a wait far past the non-watcher cap", async () => {
		const { text } = await processWait(600, "watcher");

		expect(text).not.toContain(CAP_REJECTION);
		expect(text).toContain(PAST_POLICY);
	});

	test("a session with no caller role is treated as a non-watcher", async () => {
		// Fail-closed default: an unclassified caller must not buy watcher latitude.
		const { isError, text } = await processWait(121);

		expect(isError).toBe(true);
		expect(text).toContain(CAP_REJECTION);
	});

	test("an omitted timeout falls back to the 30s default and clears the cap", async () => {
		const { text } = await processWait(undefined, "non-watcher");

		expect(text).not.toContain(CAP_REJECTION);
		expect(text).toContain(PAST_POLICY);
	});

	test("the schema forbids timeout: 0, so a process wait cannot request an unbounded window", () => {
		const tool = new HubTool(makeSession());

		expect(() => tool.parameters.assert({ op: "wait", name: "web", timeout: 0 })).toThrow();
		expect(tool.parameters.assert({ op: "wait", name: "web", timeout: 120 })).toEqual({
			op: "wait",
			name: "web",
			timeout: 120,
		});
	});

	test("KNOWN GAP: the message/job leg (timeoutMs) is not capped", async () => {
		// `timeoutMs: 0` means "wait indefinitely" — the exact hold the cap
		// exists to prevent — yet the policy only reads `params.timeout`, so a
		// non-watcher passes straight through. Pinned deliberately: closing the
		// gap must turn this red instead of slipping by unnoticed.
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "idle" });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new HubTool(makeSession({ callerRole: "non-watcher", manager }));
		const result = await tool.execute("call", { op: "wait", timeoutMs: 0 });
		const text = textOf(result);

		expect(text).not.toContain(CAP_REJECTION);
		// No running peer and no jobs, so the wait degrades to an immediate no-op.
		expect(text).toContain("No running background jobs to wait for.");
	});
});
