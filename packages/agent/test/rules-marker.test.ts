import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	buildRulesMarkerData,
	createRulesMarkerObserver,
	type RuleMarker,
	type RulesMarkerData,
} from "../../coding-agent/src/sdk";

describe("omp:rules-marker", () => {
	it("observes the mutated provider context after the gate and skips stopped calls", async () => {
		const acceptedMock = createMockModel({ responses: [{ content: ["done"] }] });
		const acceptedEvents: string[] = [];
		let observedPrompt: string[] | undefined;
		const acceptedStream: StreamFn = (...args) => {
			acceptedEvents.push("dispatch");
			return acceptedMock.stream(...args);
		};
		const acceptedAgent = new Agent({
			initialState: { model: acceptedMock.model, systemPrompt: ["initial"], messages: [], tools: [] },
			streamFn: acceptedStream,
			onProviderContextReady: context => {
				acceptedEvents.push("onProviderContextReady");
				observedPrompt = context.systemPrompt;
			},
		});
		acceptedAgent.setBeforeModelCall(context => {
			acceptedEvents.push("beforeModelCall");
			context.systemPrompt = [...(context.systemPrompt ?? []), "mutated"];
		});

		await acceptedAgent.prompt("start");

		expect(observedPrompt).toEqual(["initial", "mutated"]);
		expect(acceptedEvents).toEqual(["beforeModelCall", "onProviderContextReady", "dispatch"]);
		expect(acceptedEvents.indexOf("beforeModelCall")).toBeLessThan(acceptedEvents.indexOf("onProviderContextReady"));
		expect(acceptedEvents.indexOf("onProviderContextReady")).toBeLessThan(acceptedEvents.indexOf("dispatch"));

		const stoppedMock = createMockModel({ responses: [{ content: ["must not dispatch"] }] });
		const stoppedEvents: string[] = [];
		const stoppedStream: StreamFn = (...args) => {
			stoppedEvents.push("dispatch");
			return stoppedMock.stream(...args);
		};
		const stoppedAgent = new Agent({
			initialState: { model: stoppedMock.model, systemPrompt: ["initial"], messages: [], tools: [] },
			streamFn: stoppedStream,
			onProviderContextReady: () => {
				stoppedEvents.push("onProviderContextReady");
			},
		});
		stoppedAgent.setBeforeModelCall(context => {
			stoppedEvents.push("beforeModelCall");
			context.systemPrompt = [...(context.systemPrompt ?? []), "mutated"];
			return { stop: true, reason: "test stop" };
		});

		await stoppedAgent.prompt("stop");

		expect(stoppedEvents).toEqual(["beforeModelCall"]);
		expect(stoppedMock.calls).toHaveLength(0);
	});

	it("continues the provider call when the observer throws", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["initial"], messages: [], tools: [] },
			streamFn: mock.stream,
			onProviderContextReady: async () => {
				throw new Error("observer failure");
			},
		});

		await agent.prompt("start");

		expect(mock.calls).toHaveLength(1);
	});

	it("computes marker data with the exported producer", () => {
		const renderedPrompt = "System prelude\n\nAlways apply: alpha rule content";
		const alphaContent = "Always apply: alpha rule content";
		const betaContent = "Always apply: beta rule content";
		const rules = [
			{ name: "alpha", content: alphaContent },
			{ name: "beta", content: betaContent },
		];
		const markerData: RulesMarkerData | undefined = buildRulesMarkerData(renderedPrompt, rules);

		expect(markerData).toBeDefined();
		if (!markerData) {
			throw new Error("Expected marker data for a nonempty rule set");
		}
		const data: RulesMarkerData = markerData;
		const markerRules: RuleMarker[] = data.rules;
		const alphaRule = markerRules[0];
		const betaRule = markerRules[1];
		if (!alphaRule || !betaRule) {
			throw new Error("Expected two marker rules");
		}

		expect(data.v).toBe(1);
		expect(data.promptDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(data.promptDigest).toBe("e368ac1f97676d72070478d63c11728f8d3e68c3b7718e075ce079efb2eb7f2f");
		expect(data.rulesSetDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(data.rules).toHaveLength(2);
		expect(alphaRule.name).toBe("alpha");
		expect(betaRule.name).toBe("beta");
		expect(alphaRule.rendered).toBe(true);
		expect(betaRule.rendered).toBe(false);
		expect(alphaRule.contentDigest).toBe(Bun.SHA256.hash("Always apply: alpha rule content", "hex"));

		const expectedRulesSetInput =
			"alpha\0b1c0b31701debe7833a1286ab47dae3fb2945b998462f965ea3ee74e194ac8ed\0" +
			"1\nbeta\0" +
			"19067b50344e0b176c3d8fdf684486f39450fa076da4b2fed03422c67d37a52c\0" +
			"0";
		expect(data.rulesSetDigest).toBe(Bun.SHA256.hash(expectedRulesSetInput, "hex"));
		expect(data.rulesSetDigest).toBe("85cfec5f01990bed02b88c722d883f052f04eec5de657c5351366d47e792d186");
		expect(buildRulesMarkerData(renderedPrompt, [])).toBeUndefined();
	});

	it("emits the captured marker through the exported observer", () => {
		const captured: Array<{ customType: string; data: RulesMarkerData }> = [];
		const appendCustomEntry = (customType: string, data: RulesMarkerData): void => {
			captured.push({ customType, data });
		};
		const rules = [
			{ name: "alpha", content: "Always apply: alpha rule content" },
			{ name: "beta", content: "Always apply: beta rule content" },
		];
		const observer = createRulesMarkerObserver(appendCustomEntry, rules);
		const systemPrompt = ["System prelude", "Always apply: alpha rule content"];

		observer({ systemPrompt });

		expect(captured).toHaveLength(1);
		const firstCapture = captured[0];
		if (!firstCapture) {
			throw new Error("Expected one captured marker");
		}
		const { customType, data } = firstCapture;
		expect(customType).toBe("omp:rules-marker");
		expect(data.v).toBe(1);
		expect(data.promptDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(data.rulesSetDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(data.rules).toHaveLength(2);
		expect(data.rules[0]?.name).toBe("alpha");
		expect(data.rules[1]?.name).toBe("beta");
		expect(data.rules[0]?.rendered).toBe(true);
		expect(data.rules[1]?.rendered).toBe(false);
		expect(data.promptDigest).toBe(Bun.SHA256.hash("System prelude\n\nAlways apply: alpha rule content", "hex"));
		console.log(JSON.stringify({ type: "custom", customType, data }));

		const emptyObserver = createRulesMarkerObserver(appendCustomEntry, []);
		emptyObserver({ systemPrompt });
		expect(captured).toHaveLength(1);

		observer({ systemPrompt: undefined });
		expect(captured).toHaveLength(2);
		const undefinedPromptData = captured[1]?.data;
		if (!undefinedPromptData) {
			throw new Error("Expected marker for an undefined system prompt");
		}
		expect(undefinedPromptData.rules.every(rule => rule.rendered)).toBe(false);
		expect(undefinedPromptData.rules.every(rule => !rule.rendered)).toBe(true);
	});
});
