/**
 * The model that actually served a lane, shared by Agent Hub and the subagent HUD
 * so the two panels cannot disagree about fallback.
 *
 * Order matches `modelBadge` (agent-hub-renderer.ts): serving.isFallback, then
 * progress.resolvedModelIsFallback, then history.resolvedModelIsFallback.
 * An armed fallback that has not served is ignored; persisted-agents.ts:214-217
 * refuses to credit it, and this helper does the same by requiring isFallback.
 */
export type ServedModelSource = {
	serving?: { isFallback: boolean; selector: string };
	progress?: { resolvedModel?: string; resolvedModelIsFallback?: boolean };
	history?: { resolvedModel?: string; resolvedModelIsFallback?: boolean };
};

export type ServedModel = {
	selector: string;
	isFallback: boolean;
};

export function resolveServedModel(source: ServedModelSource): ServedModel | undefined {
	const fallbackSelector =
		(source.serving?.isFallback ? source.serving.selector : undefined) ??
		(source.progress?.resolvedModelIsFallback ? source.progress.resolvedModel : undefined) ??
		(source.history?.resolvedModelIsFallback ? source.history.resolvedModel : undefined);
	if (fallbackSelector) return { selector: fallbackSelector, isFallback: true };
	const selector = source.progress?.resolvedModel ?? source.history?.resolvedModel ?? source.serving?.selector;
	if (selector) return { selector, isFallback: false };
	return undefined;
}
