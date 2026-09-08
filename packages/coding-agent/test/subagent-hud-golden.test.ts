import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";

// Golden render accepted by Jamie on 2026-09-08 ("no its right", pane w2B:pDQ, build cf46fb59).
// Changing this snapshot requires a brief that quotes the ask changing the HUD.
// Standing order 14, reviews/orchestrate/2026-09-08-autonomous-repairs/preferences.md.

function session(id: string, agent: string, status: ObservableSession["status"], tokens: number, description?: string): ObservableSession {
	const progress: AgentProgress = {
		id,
		index: 0,
		agent,
		agentSource: "bundled",
		status: status === "active" ? "running" : status,
		task: "ROLE_MARK:" + agent + " # Target generic prompt text that must never render",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens,
		cost: 0,
		durationMs: 0,
	};
	return { kind: "subagent", id, label: id, status, detached: true, lastUpdate: 0, agent, description, progress };
}

const sessions = [
	session("SkillsTrack", "poteto-agent", "completed", 34_200),
	session("ScriptsTrack", "poteto-agent", "completed", 41_500),
	session("RulesTrack", "poteto-agent", "active", 43_200, "Nested rules synthesis"),
	session("RulesTrack.RulesInner", "poteto-agent", "active", 42_600),
	session("RulesTrack.RulesInner.RulesSynth", "synthesizer", "active", 38_500),
	session("RulesTrack.RulesInner.RulesSynth.RuleA", "explorer", "active", 0),
	session("RulesTrack.RulesInner.RulesSynth.RuleB", "explorer", "completed", 1_200),
	session("RulesTrack.RulesInner.RulesSynth.RuleC", "explorer", "active", 0),
	session("RulesTrack.Owner", "owner", "active", 2_000_000, "Writes the merged file"),
];
const ancestry = sessions
	.filter(s => s.id.includes("."))
	.map(s => ({ id: s.id, parentId: s.id.slice(0, s.id.lastIndexOf(".")) }));

const GOLDEN_COMPLETED = ["● SkillsTrack -> ● ScriptsTrack"];
const GOLDEN_SUBAGENTS = [
	"",
	"Subagents",
	" └─ ● RulesTrack ⟦poteto-agent⟧: Nested rules synthesis · 43.2k tok",
	"    ├─ ● RulesInner ⟦poteto-agent⟧ · 42.6k tok",
	"    │  └─ ● RulesSynth ⟦synthesizer⟧ · 38.5k tok",
	"    │     └─ ● explorer x3 · 1 done · 2 running · 0 failed · 0 cancelled · 1.2k tok",
	"    │        └─ ● RuleA  ● RuleB  ● RuleC",
	"    └─ ● Owner ⟦owner⟧: Writes the merged file · 2m tok",
];

describe("subagent HUD golden render", () => {
	beforeAll(() => initTheme());

	it("matches the accepted render at 120 columns", () => {
		const out = renderSubagentHudLines(sessions, 120, ancestry);
		expect(out.completed.map(Bun.stripANSI)).toEqual(GOLDEN_COMPLETED);
		expect(out.subagents.map(line => Bun.stripANSI(line).trimEnd())).toEqual(GOLDEN_SUBAGENTS);
	});

	it("wraps completed tracks at 60 columns without losing content", () => {
		const completed = ["SkillsTrack", "ScriptsTrack", "RulesTrack", "ModelsTrack", "工具Track", "ReviewTrack"]
			.map(id => session(id, "poteto-agent", "completed", 0));
		const out = renderSubagentHudLines(completed, 60);
		const lines = out.completed.map(Bun.stripANSI);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of out.completed) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		expect(lines).toEqual([
			"● SkillsTrack -> ● ScriptsTrack -> ● RulesTrack",
			"-> ● ModelsTrack -> ● 工具Track -> ● ReviewTrack",
		]);
		expect(lines.join(" ")).toBe(completed.map(item => `● ${item.id}`).join(" -> "));
	});

	it("never renders task prompt text on any row", () => {
		const text = Bun.stripANSI(renderSubagentHudLines(sessions, 120, ancestry).subagents.join("\n"));
		expect(text).not.toContain("ROLE_MARK");
		expect(text).not.toContain("# Target");
	});
});
