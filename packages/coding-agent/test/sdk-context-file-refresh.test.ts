import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const INITIAL_CONTEXT = "reload-context-initial-marker";
const UPDATED_CONTEXT = "reload-context-updated-marker";
const PROJECT_CONTEXT_EXTENSION_ID = "context-file:project:AGENTS.md";

async function createContextSession(
	cwd: string,
	settings: Settings,
	options: { advisor?: boolean } = {},
): Promise<{ session: AgentSession; authStorage: AuthStorage; sessionManager: SessionManager }> {
	const authStorage = await AuthStorage.create(`${cwd}/auth.db`);
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (options.advisor) {
		authStorage.setRuntimeApiKey("openai", "test-key");
		settings.set("advisor.enabled", true);
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
	}
	const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.json`);
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRegistry,
		sessionManager,
		settings,
		model,
		disableExtensionDiscovery: true,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		restrictToolNames: true,
		skipPythonPreflight: true,
	});
	return { session, authStorage, sessionManager };
}

describe("context-file prompt refresh", () => {
	it("replaces edited context-file content in the current system prompt", async () => {
		using tempDir = TempDir.createSync("@omp-context-refresh-edit-");
		const contextPath = tempDir.join("AGENTS.md");
		await Bun.write(contextPath, INITIAL_CONTEXT);
		const { session, authStorage } = await createContextSession(tempDir.path(), Settings.isolated({}));

		try {
			expect(session.systemPrompt.join("\n")).toContain(INITIAL_CONTEXT);

			await Bun.write(contextPath, UPDATED_CONTEXT);
			await session.refreshSkills();

			const refreshedPrompt = session.systemPrompt.join("\n");
			expect(refreshedPrompt).toContain(UPDATED_CONTEXT);
			expect(refreshedPrompt).not.toContain(INITIAL_CONTEXT);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("removes a disabled context file from the current system prompt", async () => {
		using tempDir = TempDir.createSync("@omp-context-refresh-disable-");
		await Bun.write(tempDir.join("AGENTS.md"), INITIAL_CONTEXT);
		const settings = Settings.isolated({});
		const { session, authStorage } = await createContextSession(tempDir.path(), settings);

		try {
			expect(session.systemPrompt.join("\n")).toContain(INITIAL_CONTEXT);

			settings.set("disabledExtensions", [PROJECT_CONTEXT_EXTENSION_ID]);
			await session.refreshSkills();

			expect(session.systemPrompt.join("\n")).not.toContain(INITIAL_CONTEXT);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("honors the session's own disabledExtensions, not the process-global settings", async () => {
		using tempDir = TempDir.createSync("@omp-context-refresh-isolation-");
		await Bun.write(tempDir.join("AGENTS.md"), INITIAL_CONTEXT);
		const settings = Settings.isolated({});
		const { session, authStorage } = await createContextSession(tempDir.path(), settings);

		try {
			expect(session.systemPrompt.join("\n")).toContain(INITIAL_CONTEXT);

			// A concurrently-created session installs different global settings that
			// disable this session's context file. The refresh must consult this
			// session's own settings, so the entry survives.
			const competingSettings = Settings.isolated({ disabledExtensions: [PROJECT_CONTEXT_EXTENSION_ID] });
			initializeWithSettings(competingSettings);
			await session.refreshSkills();

			expect(session.systemPrompt.join("\n")).toContain(INITIAL_CONTEXT);
		} finally {
			initializeWithSettings(settings);
			await session.dispose();
			authStorage.close();
		}
	});

	it("refreshes the advisor context prompt when context files change", async () => {
		using tempDir = TempDir.createSync("@omp-context-refresh-advisor-");
		const contextPath = tempDir.join("AGENTS.md");
		await Bun.write(contextPath, INITIAL_CONTEXT);
		const { session, authStorage } = await createContextSession(tempDir.path(), Settings.isolated({}), {
			advisor: true,
		});

		try {
			const advisorPrompt = () => session.getAdvisorAgent()?.state.systemPrompt.join("\n") ?? "";
			expect(session.isAdvisorActive()).toBe(true);
			expect(advisorPrompt()).toContain(INITIAL_CONTEXT);

			await Bun.write(contextPath, UPDATED_CONTEXT);
			await session.refreshSkills();

			const refreshed = advisorPrompt();
			expect(refreshed).toContain(UPDATED_CONTEXT);
			expect(refreshed).not.toContain(INITIAL_CONTEXT);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("recomputes active repo context after the session cwd changes", async () => {
		using tempDir = TempDir.createSync("@omp-context-refresh-cwd-");
		const cwdA = tempDir.join("cwd-a");
		const cwdB = tempDir.join("cwd-b");
		fs.mkdirSync(path.join(cwdA, "old-repo", ".git"), { recursive: true });
		fs.mkdirSync(path.join(cwdB, "new-repo", ".git"), { recursive: true });
		const { session, authStorage, sessionManager } = await createContextSession(cwdA, Settings.isolated({}));

		try {
			expect(session.systemPrompt.join("\n")).toContain("old-repo");

			await sessionManager.moveTo(cwdB);
			await session.refreshSkills();

			const refreshedPrompt = session.systemPrompt.join("\n");
			expect(refreshedPrompt).toContain("new-repo");
			expect(refreshedPrompt).not.toContain("old-repo");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});

describe("createAgentSession systemPrompt rebuild path", () => {
	async function createPromptSession(cwd: string, systemPrompt?: CreateAgentSessionOptions["systemPrompt"]) {
		const authStorage = await AuthStorage.create(`${cwd}/auth.db`);
		const model = getBundledModel("openai", "gpt-4o-mini");
		const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.json`);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({}),
			model,
			disableExtensionDiscovery: true,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
			restrictToolNames: true,
			skipPythonPreflight: true,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
		});
		return { session, authStorage };
	}

	it("wraps a string, passes an array through, and builds the default otherwise", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-rebuild-");
		const stringed = await createPromptSession(tempDir.join("string"), "custom string prompt");
		try {
			expect(stringed.session.systemPrompt).toEqual(["custom string prompt"]);
		} finally {
			await stringed.session.dispose();
			stringed.authStorage.close();
		}
		const arrayed = await createPromptSession(tempDir.join("array"), ["block-a", "block-b"]);
		try {
			expect(arrayed.session.systemPrompt).toEqual(["block-a", "block-b"]);
		} finally {
			await arrayed.session.dispose();
			arrayed.authStorage.close();
		}
		const viaCallback = await createPromptSession(tempDir.join("callback"), () => ["wrapped default"]);
		try {
			expect(viaCallback.session.systemPrompt).toEqual(["wrapped default"]);
		} finally {
			await viaCallback.session.dispose();
			viaCallback.authStorage.close();
		}
		const defaulted = await createPromptSession(tempDir.join("default"));
		try {
			expect(defaulted.session.systemPrompt.length).toBeGreaterThan(0);
			expect(defaulted.session.systemPrompt).not.toEqual(["wrapped default"]);
		} finally {
			await defaulted.session.dispose();
			defaulted.authStorage.close();
		}
	});

	it("keeps advisor context wiring when an explicit prompt overrides the default", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-advisor-override-");
		const contextPath = tempDir.join("AGENTS.md");
		await Bun.write(contextPath, INITIAL_CONTEXT);
		const authStorage = await AuthStorage.create(`${tempDir.join("explicit")}/auth.db`);
		const model = getBundledModel("openai", "gpt-4o-mini");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const settings = Settings.isolated({});
		settings.set("advisor.enabled", true);
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		const modelRegistry = new ModelRegistry(authStorage, `${tempDir.join("explicit")}/models.json`);
		const sessionManager = SessionManager.inMemory(tempDir.join("explicit"));
		const { session } = await createAgentSession({
			cwd: tempDir.join("explicit"),
			agentDir: tempDir.path(),
			modelRegistry,
			sessionManager,
			settings,
			model,
			disableExtensionDiscovery: true,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
			restrictToolNames: true,
			skipPythonPreflight: true,
			systemPrompt: "explicit override prompt",
		});
		try {
			const advisorPrompt = () => session.getAdvisorAgent()?.state.systemPrompt.join("\n") ?? "";
			expect(session.systemPrompt).toEqual(["explicit override prompt"]);
			expect(session.isAdvisorActive()).toBe(true);
			expect(advisorPrompt()).toContain(INITIAL_CONTEXT);
			await Bun.write(contextPath, UPDATED_CONTEXT);
			await session.refreshSkills();
			expect(session.systemPrompt).toEqual(["explicit override prompt"]);
			const refreshed = advisorPrompt();
			expect(refreshed).toContain(UPDATED_CONTEXT);
			expect(refreshed).not.toContain(INITIAL_CONTEXT);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
