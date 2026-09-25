import { describe, expect, test } from "bun:test";
import { taskSchema } from "./types";
import { getDefault } from "../config/settings-schema";

describe("task orchestration contract fields", () => {
	test("applies defaults when a task item omits the contract fields", () => {
		expect(taskSchema({ agent: "frank-explorer", task: "read" })).toEqual({
			agent: "frank-explorer",
			task: "read",
			delegable: "none",
			width: 1,
			childrenReadOnly: false,
		});
	});

	test("preserves explicitly supplied contract fields", () => {
		expect(
			taskSchema({
				agent: "frank-explorer",
				task: "read",
				seat: "explorer",
				delegable: "inspect task schemas",
				width: 3,
				childrenReadOnly: true,
			}),
		).toEqual({
			agent: "frank-explorer",
			task: "read",
			seat: "explorer",
			delegable: "inspect task schemas",
			width: 3,
			childrenReadOnly: true,
		});
	});

	test("a task item that omits frankTransport inherits the daemon default", () => {
		const parsed = taskSchema({ agent: "frank-explorer", task: "read" });
		expect(parsed.frankTransport).toBeUndefined();
		expect(getDefault("task.frankTransport")).toBe("daemon");
	});
});
