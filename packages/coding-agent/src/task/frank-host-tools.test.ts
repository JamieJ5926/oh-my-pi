import { describe, expect, test } from "bun:test";
import { createFrankHostToolService } from "./frank-host-tools";
import type { ToolSession } from "../tools";

describe("Frank host tool service", () => {
	const session = {} as ToolSession;

	test("disabled unknown tool name is refused by default", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test" });
		const result = await service.handle("missing-tool", {});

		expect(result).toEqual({ ok: false, error: "host tool is not enabled: missing-tool" });
	});

	test("enabled but unknown tool name is refused", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test", names: ["missing-tool"] });
		const result = await service.handle("missing-tool", {});

		expect(result).toEqual({ ok: false, error: "unknown host tool: missing-tool" });
	});

	test("tool outside the enabled names is refused and named in the error", async () => {
		const service = createFrankHostToolService({ session, agentId: "frank-test", names: ["task"] });
		const result = await service.handle("hub", {});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("host tool is not enabled: hub");
	});
});
