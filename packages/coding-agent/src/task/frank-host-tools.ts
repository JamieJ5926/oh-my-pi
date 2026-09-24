import { BUILTIN_TOOLS } from "../tools";
import type { ToolSession } from "../tools";

export interface FrankHostToolResult {
	ok: boolean;
	content?: string;
	error?: string;
}

export interface FrankHostToolService {
	handle(name: string, args: unknown): Promise<FrankHostToolResult>;
	closed: boolean;
}

export function createFrankHostToolService(options: {
	session: ToolSession;
	agentId: string;
	signal?: AbortSignal;
	names?: string[];
}): FrankHostToolService {
	const enabled: Record<string, true> = Object.fromEntries((options.names ?? ["task", "hub"]).map(name => [name, true]));
	let closed = false;
	options.signal?.addEventListener("abort", () => { closed = true; }, { once: true });

	return {
		get closed() { return closed; },
		async handle(name, args) {
			if (closed || options.signal?.aborted) {
				return { ok: false, error: "host tool service is closed" };
			}
			if (!enabled[name]) return { ok: false, error: `host tool is not enabled: ${name}` };
			const factory = Object.entries(BUILTIN_TOOLS).find(([toolName]) => toolName === name)?.[1];
			if (!factory) return { ok: false, error: `unknown host tool: ${name}` };
			try {
				const tool = await factory(options.session);
				if (!tool) return { ok: false, error: `host tool is unavailable: ${name}` };
				const result = await tool.execute(
					options.agentId,
					args,
					options.signal,
					undefined,
					options.session.getToolContext?.(),
				);
				const text = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map(part => part.text)
					.join("");
				return { ok: true, content: text };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
