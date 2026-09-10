import { beforeAll, describe, expect, it } from "bun:test";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";

// Fixture snapshot for the approved subagents panel target
// (reviews/orchestrate/2026-09-10-phase2/tui-subagents-panel-spec.md).
// Normative rules only: description col 27, strip col 61, tokens END col 78,
// measured on ANSI-stripped display cells. The spec target block is
// illustrative with uneven deeper lines, so no illustration bytes are
// asserted here. All fixture text is ASCII; cell assertions still go through
// Bun.stringWidth so a future wide glyph cannot silently shift them.

const DESC_CELL = 26; // display col 27, 0-based
const STRIP_CELL = 60; // display col 61, 0-based
const ROW_WIDTH = 78; // tokens END display col 78
const COLUMNS = 80; // call-site convention: terminal width minus 2

function makeSession(opts: {
	id: string;
	agent: string;
	status: ObservableSession["status"];
	tokens: number;
	description?: string;
	resolvedModel?: string;
	fallback?: boolean;
}): ObservableSession {
	const progress: AgentProgress = {
		id: opts.id,
		index: 0,
		agent: opts.agent,
		agentSource: "bundled",
		status: opts.status === "active" ? "running" : opts.status,
		task: `probe task text for ${opts.id} that must never render`,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: opts.tokens,
		cost: 0,
		durationMs: 0,
		...(opts.resolvedModel === undefined ? {} : { resolvedModel: opts.resolvedModel }),
		...(opts.fallback === undefined ? {} : { resolvedModelIsFallback: opts.fallback }),
	};
	return {
		kind: "subagent",
		id: opts.id,
		label: opts.id,
		status: opts.status,
		detached: true,
		lastUpdate: 0,
		agent: opts.agent,
		description: opts.description,
		progress,
	};
}

function renderAll(sessions: ObservableSession[]): { panel: string[]; all: string[] } {
	const ancestry = sessions
		.filter(s => s.id.includes("."))
		.map(s => ({ id: s.id, parentId: s.id.slice(0, s.id.lastIndexOf(".")) }));
	const out = renderSubagentHudLines(sessions, COLUMNS, ancestry);
	const strip = (lines: readonly string[]) => lines.map(line => Bun.stripANSI(line));
	return { panel: strip(out.subagents), all: [...strip(out.subagents), ...strip(out.completed)] };
}

const dotted = (rows: string[]): string[] => rows.filter(line => /[●○✗]/.test(line));

function expectLockedRow(row: string): void {
	expect(Bun.stringWidth(row)).toBe(ROW_WIDTH);
	expect(row).toMatch(/\S$/); // token field ends exactly at col 78, no trailing pad
	expect(row).toMatch(/\d/); // token content preserved
}

function expectDescAt(row: string, desc: string): void {
	const at = row.indexOf(desc);
	expect(at).toBeGreaterThanOrEqual(0);
	expect(Bun.stringWidth(row.slice(0, at))).toBe(DESC_CELL);
}

function expectStripAt(row: string, re: RegExp): void {
	const m = row.match(re);
	expect(m).not.toBeNull();
	expect(Bun.stringWidth(row.slice(0, m!.index!))).toBe(STRIP_CELL);
}

describe("subagents panel column snapshot", () => {
	beforeAll(() => initTheme());

	it("ends tokens at col 78 on every row with description at col 27", () => {
		const sessions = [
			makeSession({ id: "DeepLanding", agent: "poteto-agent-deep", status: "active", tokens: 4_130_000, description: "phase 2 rollup verified receipts" }),
			makeSession({ id: "DeepLanding.StartupLag", agent: "poteto-agent", status: "active", tokens: 1_270_000, description: "isolate 10.8s startup lag" }),
			makeSession({ id: "DeepLanding.IntakeLanding", agent: "poteto-agent", status: "active", tokens: 960_000, description: "posters receiver ranker live" }),
			makeSession({ id: "DeepLanding.GuardsLanding", agent: "poteto-agent", status: "active", tokens: 696_000, description: "envelope guard v3 scratch guard" }),
			makeSession({ id: "DeepLanding.GuardsLanding.ReproA", agent: "researcher", status: "active", tokens: 180_000 }),
			makeSession({ id: "DeepLanding.GuardsLanding.ReproB", agent: "researcher", status: "active", tokens: 190_000 }),
			makeSession({ id: "DeepLanding.GuardsLanding.ReproC", agent: "researcher", status: "active", tokens: 192_000 }),
			makeSession({ id: "DeepLanding.GuardsLanding.LifecycleFix", agent: "implementer", status: "completed", tokens: 107_000 }),
			makeSession({ id: "DeepLanding.M2Landing", agent: "poteto-agent", status: "active", tokens: 678_000, description: "per-PR M2 review packets" }),
			makeSession({ id: "DeepLanding.WidthLanding", agent: "poteto-agent", status: "active", tokens: 205_000, description: "frozen width-floor fix live hook" }),
			makeSession({ id: "DeepLanding.ConfigLanding", agent: "poteto-agent", status: "aborted", tokens: 0, description: "not started" }),
			makeSession({ id: "DeepLanding.SubrolesLanding", agent: "poteto-agent", status: "active", tokens: 117_000, description: "seven seats ledger-scribe diff" }),
			makeSession({ id: "RootListensLead", agent: "poteto-agent", status: "active", tokens: 1_180_000, description: "census histories assembly" }),
			makeSession({ id: "MatrixLiveLead", agent: "poteto-agent", status: "active", tokens: 186_000, description: "matrix report" }),
			makeSession({ id: "FailLead", agent: "poteto-agent", status: "failed", tokens: 500_000, description: "failing lead keeps shape" }),
			makeSession({ id: "FailLead.FailChild", agent: "implementer", status: "active", tokens: 10_000, description: "child keeps parent visible" }),
		];
		const { panel, all } = renderAll(sessions);
		const header = panel.find(line => line.includes("Subagents"));
		expect(header).toBeDefined();
		expect(Bun.stringWidth(header!)).toBe(ROW_WIDTH);

		for (const row of dotted(panel)) expectLockedRow(row);

		const descs: Array<[string, string]> = [
			["DeepLanding", "phase 2 rollup verified receipts"],
			["StartupLag", "isolate 10.8s startup lag"],
			["IntakeLanding", "posters receiver ranker live"],
			["GuardsLanding", "envelope guard v3 scratch guard"],
			["M2Landing", "per-PR M2 review packets"],
			["WidthLanding", "frozen width-floor fix live hook"],
			["SubrolesLanding", "seven seats ledger-scribe diff"],
			["RootListensLead", "census histories assembly"],
			["MatrixLiveLead", "matrix report"],
			["FailLead", "failing lead keeps shape"],
		];
		for (const [, desc] of descs) {
			const row = panel.find(line => line.includes(desc));
			expect(row).toBeDefined();
			expectDescAt(row!, desc);
		}

		const failedRow = all.find(line => line.includes("FailLead") && !line.includes("FailChild"));
		expect(failedRow).toBeDefined();
		expect(failedRow!).toContain("✗");

		const pendingRow = all.find(line => line.includes("ConfigLanding"));
		expect(pendingRow).toBeDefined();
		expect(pendingRow!).toContain("○");
	});

	it("truncates depth-4 with stable columns and an N-deep strip marker", () => {
		const longDesc = "a deliberately overlong chain description that cannot fit past depth three";
		const sessions = [
			makeSession({ id: "Chain0", agent: "owner", status: "active", tokens: 900_000, description: "chain top live" }),
			makeSession({ id: "Chain0.Chain1", agent: "owner", status: "active", tokens: 700_000, description: "chain second live" }),
			makeSession({ id: "Chain0.Chain1.Chain2", agent: "owner", status: "active", tokens: 500_000, description: "chain third live" }),
			makeSession({ id: "Chain0.Chain1.Chain2.Chain3", agent: "owner", status: "active", tokens: 300_000, description: longDesc }),
			makeSession({ id: "Chain0.Chain1.Chain2.Chain3.Chain4", agent: "owner", status: "active", tokens: 100_000, description: "chain fifth live" }),
		];
		const { panel } = renderAll(sessions);
		const rows = dotted(panel);
		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) expectLockedRow(row);

		for (const desc of ["chain top live", "chain second live", "chain third live"]) {
			const row = panel.find(line => line.includes(desc));
			expect(row).toBeDefined();
			expectDescAt(row!, desc);
		}

		const deepRow = panel.find(line => /\d+ deep/.test(line));
		expect(deepRow).toBeDefined();
		expectStripAt(deepRow!, /\d+ deep/);

		const truncRow = panel.find(line => line.includes("Chain3") || line.includes(longDesc.slice(0, 20)));
		expect(truncRow).toBeDefined();
		expect(truncRow!).toContain("…");
		expect(truncRow!).not.toContain(longDesc);
	});

	it("shows role tags and model codes with truncation preserving tag and code", () => {
		// Mapping hypothesis, owner confirms: a bare resolvedModel id maps to
		// its same-name bracket code; missing resolvedModel renders [?]; a
		// fallback resolution appends ! inside the brackets.
		const cases: Array<{ id: string; agent: string; tag: string; model?: string; fallback?: boolean; code: string; desc: string }> = [
			{ id: "T3Deep", agent: "poteto-agent-deep", tag: "D", model: "astra", code: "[astra]", desc: "alpha probe" },
			{ id: "T3Lead", agent: "poteto-agent", tag: "L", model: "muse", code: "[muse]", desc: "beta probe" },
			{ id: "T3Own", agent: "owner", tag: "O", model: "gem", code: "[gem]", desc: "gamma probe" },
			{ id: "T3Mech", agent: "mechanical", tag: "M", model: "opus", code: "[opus]", desc: "delta probe" },
			{ id: "T3Res", agent: "researcher", tag: "R", model: "fable", code: "[fable]", desc: "epsilon probe" },
			{ id: "T3Expl", agent: "explorer", tag: "R", model: "luna", code: "[luna]", desc: "zeta probe" },
			{ id: "T3Rev", agent: "reviewer", tag: "V", model: "grok", code: "[grok]", desc: "eta probe" },
			{ id: "T3Diag", agent: "diagnose-pot", tag: "S", model: "ds", code: "[ds]", desc: "theta probe" },
			{ id: "T3Work", agent: "worker", tag: "W", code: "[?]", desc: "iota probe" },
			{ id: "T3Asst", agent: "assistant", tag: "A", model: "muse", fallback: true, code: "[muse!]", desc: "kappa probe" },
		];
		const longName = "T3ImplWithADeliberatelyOverlongNameForTruncationProbe";
		const sessions = [
			...cases.map((c, i) =>
				makeSession({ id: c.id, agent: c.agent, status: "active", tokens: 120_000 + i * 1_000, description: c.desc, resolvedModel: c.model, fallback: c.fallback }),
			),
			makeSession({ id: longName, agent: "implementer", status: "active", tokens: 26_000, description: "overlong name probe", resolvedModel: "ds" }),
		];
		const { panel } = renderAll(sessions);
		const rows = dotted(panel);

		for (const row of rows) expectLockedRow(row);

		for (const c of cases) {
			const row = panel.find(line => line.includes(c.id));
			expect(row).toBeDefined();
			expect(row!).toContain(`${c.tag}●`);
			expect(row!).toContain(c.code);
			expect(row!.indexOf(`${c.tag}●`)).toBeLessThan(row!.indexOf(c.id));
			expect(row!.indexOf(c.id)).toBeLessThan(row!.indexOf(c.code));
			expectDescAt(row!, c.desc);
		}

		const longRow = panel.find(line => line.includes("overlong name probe"));
		expect(longRow).toBeDefined();
		expect(longRow!).toContain("I●");
		expect(longRow!).toContain("[ds]");
		expect(longRow!).toContain("…");
		expect(longRow!).not.toContain(longName);
	});

	it("caps child strips at 9 glyphs with +N and sorts done running failed cancelled", () => {
		const stripKids = (prefix: string, counts: { done: number; running: number; failed: number; cancelled: number }) => {
			const kids: ObservableSession[] = [];
			let n = 0;
			const add = (status: ObservableSession["status"]) => {
				n += 1;
				kids.push(makeSession({ id: `${prefix}.Kid${n}`, agent: "implementer", status, tokens: 5_000 }));
			};
			for (let i = 0; i < counts.done; i++) add("completed");
			for (let i = 0; i < counts.running; i++) add("active");
			for (let i = 0; i < counts.failed; i++) add("failed");
			for (let i = 0; i < counts.cancelled; i++) add("aborted");
			return kids;
		};
		const sessions = [
			makeSession({ id: "NineStrip", agent: "poteto-agent", status: "active", tokens: 205_000, description: "nine child strip exact" }),
			...stripKids("NineStrip", { done: 5, running: 2, failed: 1, cancelled: 1 }),
			makeSession({ id: "TwelveStrip", agent: "poteto-agent", status: "active", tokens: 678_000, description: "twelve child strip plus-three" }),
			...stripKids("TwelveStrip", { done: 5, running: 4, failed: 1, cancelled: 2 }),
		];
		const { panel } = renderAll(sessions);

		const nine = panel.find(line => line.includes("NineStrip"));
		expect(nine).toBeDefined();
		expectLockedRow(nine!);
		expectStripAt(nine!, /●●●●●●●✗○/);
		expect(nine!).not.toMatch(/\+\d/);

		const twelve = panel.find(line => line.includes("TwelveStrip"));
		expect(twelve).toBeDefined();
		expectLockedRow(twelve!);
		expectStripAt(twelve!, /●{9}\+3/);
	});
});
