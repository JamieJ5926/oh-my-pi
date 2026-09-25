import { describe, expect, test } from "bun:test";
import { taskSchema } from "./types";

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
});
