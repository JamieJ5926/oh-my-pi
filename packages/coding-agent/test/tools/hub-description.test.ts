/**
 * The hub tool description must tell every agent that peer messaging is
 * available mid-turn. The `# Peers` block cannot carry that fact: it is gated
 * on `ircSelfId` (subagent-system-prompt.md), which only subagents receive, so
 * the root agent would never read it.
 */
import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeSession(): ToolSession {
	// The constructor renders hub.md and reads no session field, so a bare stub
	// still exercises the real description loader.
	return { cwd: "/tmp/hub-description-test" } as unknown as ToolSession;
}

describe("hub tool description", () => {
	it("tells the agent it can message a peer mid-turn", () => {
		const description = new HubTool(makeSession()).description;

		expect(description).toContain("You can message a peer at any point in your turn.");
		expect(description).toContain("reaches a sibling or your parent and returns immediately");
		expect(description).toContain("A peer's message arrives as steering while you work.");
		expect(description).toContain("Answer it with `send` and `replyTo`.");
	});
});
