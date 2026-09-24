import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { frankModelHop } from "./structured-subagent";

const seat = { provider: "cli-proxy", id: "openrouter.muse-spark-1.3-contributor" };

describe("Frank worker model hop", () => {
	test("a seat with a level sends the provider-qualified hop Frank parses", () => {
		expect(frankModelHop(seat, ThinkingLevel.XHigh)).toBe("cli-proxy/openrouter.muse-spark-1.3-contributor:xhigh");
	});

	test("a seat with no level sends the bare id", () => {
		expect(frankModelHop(seat, undefined)).toBe("openrouter.muse-spark-1.3-contributor");
	});

	test("thinking off stays off the wire", () => {
		expect(frankModelHop(seat, ThinkingLevel.Off)).toBe("openrouter.muse-spark-1.3-contributor");
	});

	test("a literal level on the id is replaced, not duplicated", () => {
		expect(frankModelHop({ provider: "openrouter", id: "z-ai/glm-5.3-flash:max" }, ThinkingLevel.High)).toBe(
			"openrouter/z-ai/glm-5.3-flash:high",
		);
	});

	test("an id with a non-level colon keeps its raw id instead of a second colon", () => {
		expect(frankModelHop({ provider: "openrouter", id: "foo:beta" }, ThinkingLevel.High)).toBe("foo:beta");
	});
});
