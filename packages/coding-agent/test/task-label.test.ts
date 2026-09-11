import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateTaskLabel, labelEchoesHandle } from "@oh-my-pi/pi-coding-agent/task/label";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return "online";
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("task label generation", () => {
	it("settles when its executor cancellation signal aborts an in-flight title request", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			requestSignal = options?.signal;
			requestSignal?.addEventListener(
				"abort",
				() => response.resolve({ stopReason: "stop", content: [{ type: "text", text: "" }] } as never),
				{ once: true },
			);
			started.resolve();
			return response.promise;
		});

		const label = generateTaskLabel(
			"Investigate shutdown",
			createRegistry(model),
			createSettings(model),
			undefined,
			controller.signal,
		);
		await started.promise;
		controller.abort();

		expect(requestSignal).toBe(controller.signal);
		// The aborted request yields no model label, so the deterministic local
		// fallback derives one from the assignment instead of returning blank.
		expect(await label).toBe("Investigate shutdown");
	});

	it("replaces a generated label that only echoes the spawn handle with the assignment text", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>AuthLoader</title>" }],
		} as never);

		const echoed = await generateTaskLabel(
			"Sleep forty seconds then reply done",
			createRegistry(model),
			createSettings(model),
			"AuthLoader",
		);
		expect(echoed).toBe("Sleep forty seconds then reply done");

		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Sleep then reply done</title>" }],
		} as never);
		const labeled = await generateTaskLabel(
			"Sleep forty seconds then reply done",
			createRegistry(model),
			createSettings(model),
			"AuthLoader",
		);
		expect(labeled).toBe("Sleep then reply done");
	});

	it("treats a case-insensitive Name-N collision as an echoed handle", () => {
		expect(labelEchoesHandle("AuthLoader-3", "authloader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader-3", "AuthLoader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader", "authloader")).toBe(true);
		expect(labelEchoesHandle("AuthLoader-3", "Migrate users")).toBe(false);
	});
});

describe("task label local fallback", () => {
	it("derives a label from a role-marked assignment that opens with a section header", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "402 Insufficient Balance",
			content: [],
		} as never);

		const label = await generateTaskLabel(
			"ROLE_MARK:poteto-agent # Target You are a strict reviewer that audits shipped code.",
			createRegistry(model),
			createSettings(model),
		);
		expect(label).toBe("You are a strict reviewer that audits shipped code.");
	});

	it("derives a label from a plain sentence assignment", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "402 Insufficient Balance",
			content: [],
		} as never);

		const label = await generateTaskLabel(
			"Refactor the auth loader to drop the dead branch",
			createRegistry(model),
			createSettings(model),
		);
		expect(label).toBe("Refactor the auth loader to drop the dead branch");
	});

	it("returns null when the assignment carries nothing but scaffolding", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "402 Insufficient Balance",
			content: [],
		} as never);

		const label = await generateTaskLabel(
			"ROLE_MARK:owner # Target",
			createRegistry(model),
			createSettings(model),
		);
		expect(label).toBeNull();
	});

	it("returns null when the derived label would only echo the spawn handle", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "402 Insufficient Balance",
			content: [],
		} as never);

		const label = await generateTaskLabel(
			"ROLE_MARK:owner # Target AuthLoader",
			createRegistry(model),
			createSettings(model),
			"AuthLoader",
		);
		expect(label).toBeNull();
	});
});
