import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";

function progress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "poteto-agent",
		agentSource: "bundled",
		status: "running",
		task: "ROLE_MARK: must never render",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 1200,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function session(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: 0,
		agent: "poteto-agent",
		description: "Lane work",
		...overrides,
	};
}

function rowLine(sessions: ObservableSession[], columns: number): string {
	const out = renderSubagentHudLines(sessions, columns);
	const line = out.subagents.map(text => Bun.stripANSI(text).trimEnd()).find(text => text.includes(sessions[0]!.id));
	if (!line) throw new Error(`no HUD row for ${sessions[0]!.id}: ${JSON.stringify(out.subagents.map(Bun.stripANSI))}`);
	return line;
}

describe("subagent HUD trailing model cluster", () => {
	beforeAll(() => initTheme());

	it("renders a normal row as ⟨id:level⟩⟨emoji⟩ from progress.resolvedModel", () => {
		const line = rowLine(
			[
				session({
					id: "PremergePot",
					progress: progress({
						id: "PremergePot",
						resolvedModel: "cli-proxy/dddai.grok-4.6:high",
					}),
				}),
			],
			120,
		);
		expect(line).toBe(
			" ● PremergePot ⟨poteto-agent⟩  Lane work                                                 1.2k  ⟨dddai.grok-4.6:high⟩⟨⚡⟩",
		);
	});

	it("marks a fallback row with ⚠ inside the model bracket", () => {
		const line = rowLine(
			[
				session({
					id: "FallbackLane",
					progress: progress({
						id: "FallbackLane",
						resolvedModel: "cli-proxy/dddai.gpt-6-astra:low",
						resolvedModelIsFallback: true,
					}),
				}),
			],
			120,
		);
		expect(line).toBe(
			" ● FallbackLane ⟨poteto-agent⟩  Lane work                                             1.2k  ⟨⚠dddai.gpt-6-astra:low⟩⟨🍏⟩",
		);
	});

	it("omits the thinking suffix when resolvedModel has no explicit level", () => {
		const line = rowLine(
			[
				session({
					id: "NoThinkLane",
					progress: progress({
						id: "NoThinkLane",
						resolvedModel: "google-antigravity/gemini-3.8-flash",
					}),
				}),
			],
			120,
		);
		expect(line).toBe(
			" ● NoThinkLane ⟨poteto-agent⟩  Lane work                                                    1.2k  ⟨gemini-3.8-flash⟩⟨💎⟩",
		);
	});

	it("drops description tokens strip emoji and thinking before name on a narrow terminal", () => {
		const line = rowLine(
			[
				session({
					id: "NarrowLane",
					progress: progress({
						id: "NarrowLane",
						resolvedModel: "cli-proxy/dddai.grok-4.6:high",
						resolvedModelIsFallback: true,
					}),
				}),
			],
			36,
		);
		expect(line).toBe(" ● NarrowLane ⟨poteto-agent⟩  …  ⟨⚠⟩");
		expect(Bun.stringWidth(line)).toBeLessThanOrEqual(36);
	});
});
