#!/usr/bin/env bun
import { ToolCallLoopGuard } from "../packages/ai/src/utils/tool-call-loop-guard.ts";

function turn(calls: { name: string; args: Record<string, unknown> }[]) {
	return {
		message: {
			role: "assistant" as const,
			content: calls.map((c, i) => ({
				type: "toolCall" as const,
				id: `call_${i}`,
				name: c.name,
				arguments: c.args,
			})),
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			},
			stopReason: "toolUse" as const,
			timestamp: 0,
		},
		toolResults: calls.map((c, i) => ({
			role: "toolResult" as const,
			toolCallId: `call_${i}`,
			toolName: c.name,
			content: [{ type: "text" as const, text: "result" }],
			isError: c.name === "",
			timestamp: 0,
		})),
	};
}

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = want === "truthy" ? !!got : want === "falsy" ? !got : got === want;
	if (ok) {
		pass++;
		console.log(`PASS: ${label}`);
	} else {
		fail++;
		console.log(`FAIL: ${label} (got ${JSON.stringify(got)})`);
	}
}

const single = turn([{ name: "read", args: {} }]);
const g1 = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
check("single t1 no trigger", g1.recordTurn(single), "falsy");
check("single t2 no trigger", g1.recordTurn(single), "falsy");
check("single t3 triggers", g1.recordTurn(single), "truthy");

const multi = turn([{ name: "glob", args: {} }, { name: "", args: { path: "reviews/errors/**" } }]);
const g2 = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
check("multi t1 no trigger", g2.recordTurn(multi), "falsy");
check("multi t2 no trigger", g2.recordTurn(multi), "falsy");
check("multi t3 triggers", g2.recordTurn(multi), "truthy");

const exempt = turn([{ name: "glob", args: {} }]);
const g3 = new ToolCallLoopGuard({ threshold: 3, exemptTools: ["glob"] });
check("exempt t1", g3.recordTurn(exempt), "falsy");
check("exempt t2", g3.recordTurn(exempt), "falsy");
check("exempt t3 no trigger", g3.recordTurn(exempt), "falsy");

const a = turn([{ name: "read", args: { path: "a" } }]);
const b = turn([{ name: "read", args: { path: "b" } }]);
const g4 = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
g4.recordTurn(a);
g4.recordTurn(a);
g4.recordTurn(b);
check("different resets", g4.recordTurn(a), "falsy");

console.log(`\n${pass}/10`);
process.exit(pass === 10 && fail === 0 ? 0 : 1);
