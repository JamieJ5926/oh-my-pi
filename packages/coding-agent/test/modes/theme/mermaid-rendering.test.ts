import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings, settings } from "../../../src/config/settings";
import { createTheme, getBuiltinThemes } from "../../../src/modes/theme/loader";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setMarkdownMermaidSpacing,
	setThemeInstance,
} from "../../../src/modes/theme/theme";
import { buildSystemPrompt } from "../../../src/system-prompt";

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function renderMermaidAscii(source: string, maxWidth = 120): string {
	const resolve = getMarkdownTheme().resolveMermaidAscii;
	if (!resolve) throw new Error("Mermaid renderer unavailable");
	const rendered = resolve(source, maxWidth);
	if (rendered === null) throw new Error("Mermaid renderer returned null");
	return stripAnsi(rendered);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
	setMarkdownMermaidRendering(true);
});

describe("Mermaid rendering setting", () => {
	it("removes the Mermaid prompt note when rendering is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: false,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
		});

		expect(systemPrompt.join("\n")).not.toContain("```mermaid");
	});

	it("falls back to a highlighted code fence when rendering is disabled", () => {
		setMarkdownMermaidRendering(false);

		const markdown = new Markdown("```mermaid\ngraph TD\n  A --> B\n```", 0, 0, getMarkdownTheme());
		const lines = stripAnsi(markdown.render(80).join("\n"));

		expect(lines).toContain("```mermaid");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
	});

	it("uses content-visible Titanium colors for Mermaid structure", async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("fallback theme unavailable");
		const titaniumJson = getBuiltinThemes().titanium;
		if (!titaniumJson) throw new Error("Titanium theme unavailable");

		try {
			setThemeInstance(createTheme(titaniumJson, { mode: "truecolor" }));
			const renderer = getMarkdownTheme().resolveMermaidAscii;
			if (!renderer) throw new Error("Mermaid renderer unavailable");
			const rendered = renderer("stateDiagram-v2\n  [*] --> Capture\n  Capture --> [*]", 80);
			const muted = "\x1b[38;2;156;163;176m";

			expect(rendered).toContain(`${muted}╔`);
			expect(rendered).toContain(`${muted}║`);
			expect(rendered).toContain(`${muted}╚`);
			expect(rendered).not.toMatch(/\x1b\[38;2;229;229;231m[╔═╗║╚╝]/);
			expect(rendered).not.toContain("\x1b[38;2;42;48;56m");
			expect(rendered).not.toContain("\x1b[38;2;31;37;45m");
			const labels = renderer("flowchart TD\n  A[x=y]\n  B[status=#1]", 80);
			const text = "\x1b[38;2;229;229;231m";
			expect(labels).toContain(`${text}x=y`);
			expect(labels).toContain(`${text}status=#1`);
		} finally {
			setThemeInstance(dark);
		}
	});

	it("applies settings overrides to rendered diagrams", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		try {
			settings.set("tui.mermaidPaddingX", 0);
			settings.set("tui.mermaidPaddingY", 0);
			settings.set("tui.mermaidBoxBorderPadding", 0);
			const tight = renderMermaidAscii(source);
			expect(tight).not.toBe(baseline);
			expect(tight.length).toBeLessThan(baseline.length);
		} finally {
			settings.set("tui.mermaidPaddingX", 5);
			settings.set("tui.mermaidPaddingY", 5);
			settings.set("tui.mermaidBoxBorderPadding", 1);
		}
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("applies configured spacing to rendered diagrams", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]\n  B --> C[gamma]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: 0, paddingY: 0, boxBorderPadding: 0 });
		const tight = renderMermaidAscii(source);
		expect(tight).not.toBe(baseline);
		expect(tight.length).toBeLessThan(baseline.length);
		setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("falls back to defaults for invalid spacing values", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: NaN, paddingY: -3, boxBorderPadding: 1.9 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});

	it("falls back to the default for fractional paddingX instead of flooring", () => {
		const source = "flowchart TD\n  A[alpha] --> B[beta]";
		const baseline = renderMermaidAscii(source);
		setMarkdownMermaidSpacing({ paddingX: 1.9, paddingY: 5, boxBorderPadding: 1 });
		expect(renderMermaidAscii(source)).toBe(baseline);
	});
});
