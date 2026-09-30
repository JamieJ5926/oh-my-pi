import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const srcRoot = path.join(import.meta.dir, "../../../src");

describe("inspect_many exclusions contract", () => {
	test("tool schema and prompt accept every ScopeSelector kind", () => {
		const tool = readFileSync(path.join(srcRoot, "tools/inspect-many.ts"), "utf8");
		const prompt = readFileSync(path.join(srcRoot, "prompts/tools/inspect_many.md"), "utf8");
		const contract = readFileSync(path.join(srcRoot, "capability/contracts/manifest.ts"), "utf8");
		expect(contract).toContain('kind: "repository"');
		expect(contract).toContain('kind: "path"');
		expect(contract).toContain('kind: "glob"');
		expect(contract).toContain('kind: "package"');
		expect(contract).toContain('kind: "module"');
		expect(tool).toContain("inspectExclusionSchema");
		expect(tool).toContain('kind: "\'repository\'"');
		expect(tool).toContain('kind: "\'path\'"');
		expect(tool).toContain('kind: "\'glob\'"');
		expect(tool).toContain('kind: "\'package\'"');
		expect(tool).toContain('kind: "\'module\'"');
		expect(prompt).toContain("**Exclusions:**");
		expect(prompt).toContain('{ kind: "repository" }');
		expect(prompt).toContain('{ kind: "path", path:');
		expect(prompt).toContain('{ kind: "glob", pattern:');
		expect(prompt).toContain('{ kind: "package", name:');
		expect(prompt).toContain('{ kind: "module", name:');
	});
});
