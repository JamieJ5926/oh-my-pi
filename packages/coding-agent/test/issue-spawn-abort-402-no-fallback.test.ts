import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createHost(
	current: Model,
	modelRegistry: ModelRegistry,
	fallbackChains?: Record<string, string[]>,
): TurnRecoveryHost {
	const settings = Settings.isolated({
		...(fallbackChains ? { "retry.fallbackChains": fallbackChains } : {}),
	});
	return {
		agent: { state: { messages: [] } } as never,
		sessionManager: { getLastModelChangeRole: () => undefined } as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => current,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "spawn-abort-402-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }) as never,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

function billingCapMessage(current: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: current.api,
		provider: current.provider,
		model: current.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorStatus: 402,
		errorMessage: "402 Insufficient Balance\nInsufficient Balance (type=unknown_error param=invalid_request_error)",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

describe("spawn-abort: 402 billing cap surfaces instead of substitute-then-abort", () => {
	const current = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!current) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
	const fallback = getBundledModel("openai", "gpt-4o-mini");
	if (!fallback) throw new Error("Expected bundled fallback model openai/gpt-4o-mini");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-spawn-abort-402-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	test("402 Insufficient Balance is not retryable and not fallback eligible", () => {
		const host = createHost(current, modelRegistry, {
			default: [`${fallback.provider}/${fallback.id}`],
		});
		const recovery = new TurnRecovery(host);
		const message = billingCapMessage(current);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});
});
