import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { frankModelChain, frankModelHop } from "./structured-subagent";

const seat = { provider: "cli-proxy", id: "openrouter.muse-spark-1.3-contributor" };

describe("Frank worker model hop", () => {
	test("a seat with a level sends the provider-qualified hop Frank parses", () => {
		expect(frankModelHop(seat, ThinkingLevel.XHigh)).toBe("cli-proxy/openrouter.muse-spark-1.3-contributor:xhigh");
	});

	test("a seat with no level sends the provider-qualified hop", () => {
		expect(frankModelHop(seat, undefined)).toBe("cli-proxy/openrouter.muse-spark-1.3-contributor");
	});

	test("thinking off stays off the wire but keeps the provider", () => {
		expect(frankModelHop(seat, ThinkingLevel.Off)).toBe("cli-proxy/openrouter.muse-spark-1.3-contributor");
	});

	test("a literal level on the id is replaced, not duplicated", () => {
		expect(frankModelHop({ provider: "openrouter", id: "z-ai/glm-5.3-flash:max" }, ThinkingLevel.High)).toBe(
			"openrouter/z-ai/glm-5.3-flash:high",
		);
	});

	test("an id with a non-level colon keeps its provider-qualified raw id", () => {
		expect(frankModelHop({ provider: "openrouter", id: "foo:beta" }, ThinkingLevel.High)).toBe("openrouter/foo:beta");
	});
});

describe("Frank worker model chain", () => {
	const scope = (provider: string, id: string, thinkingLevel?: ThinkingLevel) =>
		({ model: { provider, id }, thinkingLevel }) as unknown as Parameters<typeof frankModelChain>[0][number];
	const endpoints: Record<string, string> = { "cli-proxy": "http://127.0.0.1:8317/v1", anthropic: "https://api.anthropic.com" };
	const endpointOf = (m: { provider: string }) => endpoints[m.provider];

	test("a seat's model list becomes Frank's comma chain in order", () => {
		expect(
			frankModelChain(
				[scope("cli-proxy", "codex.gpt-6-luna.fast", ThinkingLevel.Low), scope("cli-proxy", "frank.deepseek")],
				endpointOf,
			),
		).toBe("cli-proxy/codex.gpt-6-luna.fast:low,cli-proxy/frank.deepseek");
	});

	test("a single model is a single hop", () => {
		expect(frankModelChain([scope("cli-proxy", "frank.explorer", ThinkingLevel.Low)], endpointOf)).toBe(
			"cli-proxy/frank.explorer:low",
		);
	});

	test("hops on another endpoint are dropped because Frank uses one endpoint per turn", () => {
		expect(
			frankModelChain([scope("cli-proxy", "frank.muse"), scope("anthropic", "claude-opus-5-5")], endpointOf),
		).toBe("cli-proxy/frank.muse");
	});
});
