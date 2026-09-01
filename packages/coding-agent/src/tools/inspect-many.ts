import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { inspectMany, type InspectManyRequest, type InspectManyResult } from "../capability/inspect/inspect-many";
import { AsyncJobManagerJobExecutor, type JobExecutionSubstrate } from "../capability/job-executor";
import { createOperationId } from "../capability/contracts/ids";
import type { ToolSession } from "./index";
import { runStructuredSubagent, type StructuredSubagentInput } from "../task/structured-subagent";
import inspectManyDescription from "../prompts/tools/inspect_many.md" with { type: "text" };

const inspectManySchema = type({
	objective: type("string").describe("What you're investigating (e.g., 'map all API endpoints')"),
	repositoryRoot: type("string").optional().describe("Repository root (defaults to project directory)"),
	selectors: type("array")
		.optional()
		.describe("Scope: repository (all), path, or glob pattern (omit for full repo)"),
	exclusions: type("array").optional().describe("Exclusion patterns"),
	maxFilesPerChunk: type("number").optional().describe("Max files per reader chunk"),
	targetSourceTokensPerChunk: type("number").optional().describe("Target tokens per chunk"),
	maxConcurrency: type("number").optional().describe("Max concurrent reader jobs (default: 4)"),
	requireCompleteCoverage: type("boolean").optional().describe("Fail if any entries unreachable (default: true)"),
});

interface InspectManyToolDetails {
	manifestEntryCount?: number;
	chunkCount?: number;
	findingCount?: number;
	coverageComplete?: boolean;
	status?: string;
	error?: string;
}

export class InspectManyTool implements AgentTool<typeof inspectManySchema, InspectManyToolDetails> {
	readonly name = "inspect_many";
	readonly label = "Inspect Many";
	readonly summary = "Batch codebase inspection with parallel reads and coverage tracking";
	readonly description = inspectManyDescription;
	readonly parameters = inspectManySchema;
	readonly strict = false;
	readonly approval = "exec" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectManyToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectManyToolDetails>> {
		const input = params as {
			objective: string;
			repositoryRoot?: string;
			selectors?: Array<{ kind: "repository" } | { kind: "path"; path: string } | { kind: "glob"; pattern: string }>;
			exclusions?: Array<{ kind: "path"; path: string } | { kind: "glob"; pattern: string }>;
			maxFilesPerChunk?: number;
			targetSourceTokensPerChunk?: number;
			maxConcurrency?: number;
			requireCompleteCoverage?: boolean;
		};

		// Check for job manager
		if (!this.session.asyncJobManager) {
			return {
				content: [
					{
						type: "text",
						text: "inspect_many requires async job manager (not available in this session)",
					},
				],
				details: { error: "async job manager unavailable" },
				isError: true,
			};
		}

		// Create substrate that dispatches reader jobs via runStructuredSubagent
		const substrate: JobExecutionSubstrate = {
			execute: async (job, context) => {
				const subagentInput: StructuredSubagentInput = {
					agent: job.agent.name,
					agentSource: job.agent.source,
					task: job.objective,
					outputSchema: job.outputSchema,
					signal: context.signal,
				};

				try {
					const result = await runStructuredSubagent(subagentInput, this.session);
					return result.data ?? result.output;
				} catch (error) {
					throw new Error(
						`Reader job ${job.jobId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
		};

		const executor = new AsyncJobManagerJobExecutor({
			manager: this.session.asyncJobManager,
			substrate,
		});

		const repositoryRoot = input.repositoryRoot ?? this.session.cwd;
		const selectors = input.selectors ?? [{ kind: "repository" as const }];

		const request: InspectManyRequest = {
			objective: input.objective,
			repositoryRoot,
			selectors,
			exclusions: input.exclusions ?? [],
			repositoryRevision: "working-tree",
			operationId: createOperationId(`inspect_${Date.now()}`),
			agent: {
				id: this.session.getAgentId?.() ?? "agent",
				name: "reader",
			},
			constraints: {
				maxFilesPerChunk: input.maxFilesPerChunk,
				targetSourceTokensPerChunk: input.targetSourceTokensPerChunk,
				maxConcurrency: input.maxConcurrency ?? 4,
				requireCompleteCoverage: input.requireCompleteCoverage ?? true,
			},
			signal,
		};

		try {
			const result: InspectManyResult = await inspectMany(request, { executor });

			const statusText = result.status.kind === "complete" ? "Complete" : result.status.kind;
			const coverageText = result.coverage.complete
				? "✓ Complete coverage"
				: `Partial: ${result.coverage.processedCount}/${result.coverage.requiredCount} entries`;

			const text = [
				`**${statusText}** — ${coverageText}`,
				``,
				`**Manifest:** ${result.manifest.entries.length} entries`,
				`**Chunks:** ${result.chunkPlan.chunks.length} chunks`,
				`**Findings:** ${result.findings.length} findings`,
				``,
				result.findings.slice(0, 10).map(f => `- ${f.summary}`).join("\n"),
				result.findings.length > 10 ? `\n... and ${result.findings.length - 10} more` : "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					manifestEntryCount: result.manifest.entries.length,
					chunkCount: result.chunkPlan.chunks.length,
					findingCount: result.findings.length,
					coverageComplete: result.coverage.complete,
					status: result.status.kind,
				},
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `inspect_many failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: { error: error instanceof Error ? error.message : String(error) },
				isError: true,
			};
		}
	}
}
