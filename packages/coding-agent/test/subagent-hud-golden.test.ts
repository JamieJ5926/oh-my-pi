import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";

// Golden render accepted by Jamie on 2026-09-08 ("no its right", pane w2B:pDQ, build cf46fb59).
// Changing this snapshot requires a brief that quotes the ask changing the HUD.
// Standing order 14, reviews/orchestrate/2026-09-08-autonomous-repairs/preferences.md.
// Ask changing this snapshot, Jamie 2026-09-20: "instead of gem at the end can we make it like
// ⟨poteto-agent⟩⟨model-thinking⟩⟨provider emoji⟩". The 2026-09-11 "model-emoji" clause described the
// row when the emoji WAS the model information. Once id:level is on the row the emoji is redundant
// and drops before the model id. Seat stays on the name. Strip still counts child rows a lane draws.

function session(
	id: string,
	agent: string,
	status: ObservableSession["status"],
	tokens: number,
	description?: string,
	resolvedModel = "cli-proxy/dddai.grok-4.6:high",
): ObservableSession {
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
		resolvedModel,
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

// Authorizing ask for this snapshot change: JamieJ5926/omp-owned#20 —
// "Collapse completed rows to a one-line count in exactly one place."
const GOLDEN_COMPLETED = ["… 2 completed"];
const GOLDEN_SUBAGENTS = [
	"",
	"Subagents                                                     9 agents · 2.20M",
	"",
	"▾ L● RulesTrack [grok]    Nested rules synthesis            ●●         Σ 2.13M",
	"  ├─▾ L● RulesInner [grok]                                  ●            Σ 82k",
	"  │ └─▾ S● RulesSy… [grok]                                  ●●●          Σ 40k",
	"  │   ├─ R● explor… [grok]● RuleA  ● RuleB  ● RuleC                         1k",
	"  └─ O● Owner [grok]      Writes the merged file            —            2.00M",
];

describe("subagent HUD golden render", () => {
	beforeAll(() => initTheme());

	it("matches the accepted render at 120 columns", () => {
		const out = renderSubagentHudLines(sessions, 120, ancestry);
		expect(out.completed.map(Bun.stripANSI)).toEqual(GOLDEN_COMPLETED);
		expect(out.subagents.map(line => Bun.stripANSI(line).trimEnd())).toEqual(GOLDEN_SUBAGENTS);
	});

	it("collapses six completed tracks to one count line at 60 columns", () => {
		const completed = ["SkillsTrack", "ScriptsTrack", "RulesTrack", "ModelsTrack", "工具Track", "ReviewTrack"]
			.map(id => session(id, "poteto-agent", "completed", 0));
		const out = renderSubagentHudLines(completed, 60);
		// Issue #20: six clean completed roots fold into the single count line.
		expect(out.completed.map(Bun.stripANSI)).toEqual(["… 6 completed"]);
		for (const line of out.completed) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
	});

	it("wraps failed roots across lines without a count line", () => {
		const failed = ["SkillsTrack", "工具Track", "ModelsTrack", "ReviewTrack"].map(id =>
			session(id, "poteto-agent", "failed", 0),
		);
		const out = renderSubagentHudLines(failed, 60);
		// Failed roots keep full per-root entries (issue #20): no count line,
		// and the joined row wraps — this covers the wide-char wrap path.
		expect(out.completed.map(Bun.stripANSI)).toEqual([
			"✗ SkillsTrack -> ✗ 工具Track -> ✗ ModelsTrack",
			"-> ✗ ReviewTrack",
		]);
		for (const line of out.completed) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
	});

	it("carries the ⟨role⟩ cell on every non-group row and none on a group row", () => {
		const lines = renderSubagentHudLines(sessions, 120, ancestry).subagents.map(line => Bun.stripANSI(line).trimEnd());
		expect(lines).toEqual(GOLDEN_SUBAGENTS);
		const named = lines.filter(line => /[LSO]● /.test(line));
		expect(named.length).toBe(4);
		for (const line of named) expect(line).toMatch(/[LSO]● \S+ \[[^\]]+\]/);
		const group = lines.find(line => line.includes("explor…")) ?? "";
		expect(group).toContain("explor…");
		expect(group).not.toContain("⟨explorer⟩");
	});

	it("never renders task prompt text on any row", () => {
		const text = Bun.stripANSI(renderSubagentHudLines(sessions, 120, ancestry).subagents.join("\n"));
		expect(text).not.toContain("ROLE_MARK");
		expect(text).not.toContain("# Target");
	});
});
