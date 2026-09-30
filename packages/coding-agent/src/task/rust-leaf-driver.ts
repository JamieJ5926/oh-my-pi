/**
 * Read-only Rust leaf driver (frozen slice v2).
 *
 * Sole public entry: {@link driveRustLeaf}. Everything else in this file is
 * private (select/build/spawn) except the fixture/mapping/revival contract
 * surface ({@link RustLeafFixture}, {@link replayLeafFixture},
 * {@link throwLeafRevivalUnsupported}),
 * which exists so the AcceptanceLead unit gate can pin the contract without
 * spawning a live leaf. Zero profile rendering in O: the F6 selection struct
 * is forwarded verbatim and Rust composes.
 *
 * Transport contract (settled against
 * `crates/pi_track_accept/src/main.rs` usage text and `agent_mode.rs`
 * header, 2026-09-13):
 * - argv: `agent --endpoint URL --model NAME --cwd DIR [--max-tool-calls N]
 *   [--wall-secs S] [--events-path PATH] [--load PATH]`.
 * - stdin: JSONL ops; `{"op":"submit","turn_id":N,"text":"..."}` with
 *   `turn_id > 0` (`turn_id: 0` is a caller bug, acked `accepted:false`).
 * - stdout: display events only, `{"type":"event","seq":N,...}` per line;
 *   drained to the `final_seq` named by the stderr terminal record.
 * - stderr: control records; `{"type":"terminal",...,"final_seq":N}` ends
 *   the turn. No cross-pipe order is claimed between the two fds.
 * - F6 forward-struct: `LeafSelection` mirrors `ProfileSel` exactly —
 *   per-layer `{ enabled, name, shared }` for system, role, subrole, no
 *   top-level shared. Consumed on the actual Rust path as CLI flags (the
 *   only selection surface the leaf binary reads: `main.rs` usage text,
 *   `agent_mode.rs` `AgentOpts`): `--instructions-system on|off`,
 *   `--instructions-role NAME` + `--instructions-role-enabled` /
 *   `--no-instructions-role-enabled`, `--instructions-subrole NAME` +
 *   `--instructions-subrole-enabled` /
 *   `--no-instructions-subrole-enabled`, repeatable
 *   `--instructions-{system,role,subrole}-shared PATH`. OMP validates
 *   shape only before spawn, never renders instruction text and performs
 *   no second parse. Rust owns assembly, ordering, confinement, and
 *   frontmatter. System name is fixed `'default'`. The model travels
 *   separately through the existing executor selection (`modelOverride`
 *   ?? agent model), never inside the layer struct. `--model` carries the
 *   registry-resolved native id (`modelProvenance.model`); an unresolvable
 *   pattern fails closed before spawn and never reaches the wire verbatim.
 *   Effort never reaches this driver: the executor leaf branch rejects any
 *   effective effort level pre-spawn (the leaf binary has no effort flag
 *   and `ProviderReq` has no effort field), so only level-free runs arrive.
 *   There is no env
	 *   selection channel: OMP never sends
 *   `PI_RUST_LEAF_SELECTION` and the leaf never reads it, so no selection
 *   state is ever pending consumption.
 * - Timings come from the host clock (`Date.now()`).
 * - Binary precedence (ROOT CUTS 2026-09-13): explicit per-call
 *   `LeafRequest.binaryPath` always wins; the configured
 *   `task.rustLeaf.binaryPath` value is next; `PI_RUST_LEAF_CMD` env is a
 *   last-resort fallback only, never an override. Otherwise fail closed
 *   (throw before spawn; never silently substitute the host path on
 *   explicit opt-in failure).
 *
 * Revival (ROOT REVIVAL RULE 2026-09-13, decided by evidence): the native
 * revive path (`task/persisted-revive.ts:113-126`
 * `SessionManager.open(sessionFile)` + `createAgentSession`, and
 * `task/executor.ts:3564-3596` revival closure) restores the full OMP
 * message history from an OMP-format session file. A leaf run creates no
 * `AgentSession` and its events file holds R display records, not message
 * history, so `SessionManager.open` cannot restore it — mapping natively
 * would mean teaching the session manager a second history format (scope
 * explosion). First-integration restriction, stated in code: leaf runs are
 * explicitly non-revivable ({@link LEAF_REVIVAL_UNSUPPORTED}). The leaf
 * branch in `runSubprocess` returns before `createAgentSession` and never
 * touches the `AgentRegistry`; every driven id is recorded via
 * {@link markLeafRunId}, and `runSubagentFollowUpTurn` checks
 * {@link isLeafRunId} first so a follow-up addressing a leaf id returns
 * the named {@link leafRevivalUnsupportedResult} through its own path —
 * never the accidental unknown-agent fallthrough. Exact limitation: a
 * leaf run produces R display records, not OMP message history, so there
 * is no history for `SessionManager.open` (or any revive path) to
 * restore; re-drive the leaf with a fresh turn instead.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, LeafRequest, LeafSelection, SingleResult } from "./types";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";

/** Host-side outcome of a leaf drive: the existing settled-run shape. */
export type HostDriveOutcome = SingleResult;

/** Arguments for {@link driveRustLeaf}: host identity fields plus the leaf request. */
export interface RustLeafDriveArgs {
	index: number;
	id: string;
	agentName: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	assignment?: string;
	description?: string;
	cwd: string;
	leaf: LeafRequest;
	/** Configured `task.rustLeaf.binaryPath` value, resolved by the caller. */
	configuredBinaryPath?: string;
	modelOverride?: string | string[];
	/** Agent-file model patterns (`AgentDefinition.model`): fallback when no per-call `modelOverride` is set, mirroring the host `modelOverride ?? agent.model` selection. */
	agentModel?: string | string[];
	modelRole?: string;
	signal?: AbortSignal;
	/**
	 * Real model provenance resolved by the caller through the existing
	 * model registry. Absent when the patterns resolve to no registered
	 * model (opaque gate literals): attribution then names the actual
	 * serving endpoint and `--model` flag at the emit sites, never a
	 * fabricated provider string.
	 */
	modelProvenance?: LeafModelProvenance;
	/**
	 * Proxy credential for the leaf child, resolved by the caller through
	 * the existing model registry. Forwarded into the child env as
	 * `PI_TRACK_API_KEY` (the first name the Rust provider reads). Absent
	 * or blank keeps spawn inherit, byte-identical to today. The value
	 * never enters logs or fixtures; only presence is observable.
	 */
	proxyCredential?: string;
	/**
	 * Caller-asserted forced-tool-choice support for the resolved model.
	 * False emits `--tool-choice auto`; true or absent omits the flag and
	 * the binary keeps its historical forced-`required` with tools. No
	 * tool-policy change: the offered tool set is untouched.
	 */
	forceToolChoice?: boolean;
	/** Streaming sink for validated leaf display records as native agent events, fired as lines arrive. */
	onAgentEvent?: (event: AgentEvent) => void;
}

/**
 * Deterministic recorded leaf I/O for the AcceptanceLead unit gate: the
 * exact spawn surface (binary, argv, stdin lines) plus the exact observed
 * surface (stdout/stderr lines, exit code, duration). Replay is pure —
 * no clock, no spawn — so fixtures pin the outcome mapping byte-for-byte.
 */
export interface RustLeafFixture {
	binary: string;
	argv: string[];
	stdinLines: string[];
	stdoutLines: string[];
	stderrLines: string[];
	exitCode: number;
	durationMs: number;
}

/** Identity fields a fixture replay stamps onto the outcome. */
export interface RustLeafFixtureIdentity {
	index: number;
	id: string;
	agentName: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	assignment?: string;
	description?: string;
	model: string;
}

/** First-integration restriction code: leaf runs cannot be revived. */
export const LEAF_REVIVAL_UNSUPPORTED = "rust-leaf-revival-unsupported" as const;

/**
 * Named guard for any revive/follow-up path that reaches a leaf run.
 * Always throws; never a parity claim.
 */
export function throwLeafRevivalUnsupported(id: string): never {
	throw new Error(
		`${LEAF_REVIVAL_UNSUPPORTED}: leaf run ${id} is non-revivable in this integration — ` +
			"native revive restores OMP message history via SessionManager.open, which a Rust leaf run never produces",
	);
}

/**
 * stderr terminal control record: turn end state plus the final-seq
 * watermark. `terminal` stays an open string — Rust owns the kind set
 * (`Answer`, `Cancelled`, failure kinds) and OMP only branches on the two
 * named here. `finalSeq` names the terminal event's seq, not a truncation
 * point: both pipes always drain to EOF.
 */
interface LeafTerminal {
	terminal: string;
	turnId: number;
	finalSeq: number;
	error?: string;
}

/**
 * Real model provenance for adapted assistant messages, resolved by the
 * caller through the existing model registry. No literals here: every
 * field arrives resolved, never defaulted.
 */
export interface LeafModelProvenance {
	api: Api;
	provider: string;
	model: string;
}

interface LeafAssistantChunk {
	seq: number;
	text: string;
}

interface LeafStreamDigest {
	lastSeq: number;
	terminal?: LeafTerminal;
	userSeq: number;
	deltas: LeafAssistantChunk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Mirror of `assistant_stream_text_after` + `last_user_seq` in
 * `crates/pi_track_accept/src/verify.rs`: assistant text is the
 * concatenated `/event/kind/AssistantDelta` stream after the latest
 * `/event/kind/User` seq, so the turn's answer — not prior turns — is
 * the adapted output.
 */
function parseLeafLine(line: string, digest: LeafStreamDigest): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(parsed)) return;
	const type = parsed["type"];
	if (type === "event") {
		const seq = parsed["seq"];
		if (typeof seq === "number" && Number.isInteger(seq) && seq > digest.lastSeq) digest.lastSeq = seq;
		const event = parsed["event"];
		if (!isRecord(event)) return;
		const kind = event["kind"];
		if (!isRecord(kind)) return;
		const seqNum = typeof seq === "number" && Number.isInteger(seq) ? seq : 0;
		if (typeof kind["User"] === "string" && seqNum > digest.userSeq) digest.userSeq = seqNum;
		const delta = kind["AssistantDelta"];
		if (typeof delta === "string" && delta) digest.deltas.push({ seq: seqNum, text: delta });
		return;
	}
	if (type === "terminal" && typeof parsed["terminal"] === "string") {
		const turnId = parsed["turn_id"];
		const finalSeq = parsed["final_seq"];
		const error = parsed["error"];
		digest.terminal = {
			terminal: parsed["terminal"],
			turnId: typeof turnId === "number" ? turnId : 0,
			finalSeq: typeof finalSeq === "number" ? finalSeq : digest.lastSeq,
			error: typeof error === "string" ? error : undefined,
		};
	}
}

function digestLeafLines(stdoutLines: string[], stderrLines: string[]): LeafStreamDigest {
	const digest: LeafStreamDigest = { lastSeq: 0, userSeq: 0, deltas: [] };
	for (const line of stdoutLines) {
		if (line.trim()) parseLeafLine(line, digest);
	}
	for (const line of stderrLines) {
		if (line.trim()) parseLeafLine(line, digest);
	}
	return digest;
}
/**
 * Shape-only validation before spawn, mirroring `LoaderError::MissingExplicit`:
 * an enabled layer with an empty name is a usage error and rejected here.
 * System name is fixed `'default'`. Rust owns everything else (assembly,
 * ordering, confinement, frontmatter).
 */
export function validateLeafSelection(selection: LeafSelection): void {
	const layers = { system: selection.system, role: selection.role, subrole: selection.subrole };
	for (const [layer, sel] of Object.entries(layers)) {
		if (sel.enabled && !sel.name.trim()) {
			throw new Error(`Rust leaf selection: layer '${layer}' is enabled but has an empty name (mirrors MissingExplicit)`);
		}
	}
	if (selection.system.name !== "default") {
		throw new Error(`Rust leaf selection: system name is fixed 'default', got '${selection.system.name}'`);
	}
}

/**
 * Binary precedence (ROOT CUTS 2026-09-13): explicit per-call path wins,
 * then the configured `task.rustLeaf.binaryPath` value, then the
 * `PI_RUST_LEAF_CMD` env last-resort fallback. Otherwise fail closed.
 */
export function selectLeafBinary(args: {
	explicitPath: string | undefined;
	configuredPath: string | undefined;
	envPath: string | undefined;
}): string {
	const explicit = args.explicitPath?.trim();
	if (explicit) return explicit;
	const configured = args.configuredPath?.trim();
	if (configured) return configured;
	const env = args.envPath?.trim();
	if (env) return env;
	throw new Error(
		"Rust leaf requested but no binary is configured (per-call LeafRequest.binaryPath, task.rustLeaf.binaryPath, or PI_RUST_LEAF_CMD); refusing to substitute the host path on explicit opt-in failure",
	);
}

/**
 * Single-turn submit payload: one JSONL op line with `turn_id: 1`
 * (`turn_id: 0` is a caller bug, acked `accepted:false` per agent_mode.rs).
 */
export function submitLeafLines(submitText: string): string[] {
	return [JSON.stringify({ op: "submit", turn_id: 1, text: submitText })];
}

/**
 * Events-file derivation: an explicit per-call `LeafRequest.eventsPath`
 * wins; otherwise a distinct R display-events file per drive under the
 * host tmpdir, namespaced by sanitized drive id. Never the OMP session
 * jsonl: R appends live display records here while OMP adapts the piped
 * stdout, so sharing that file would corrupt session history.
 */
export function resolveLeafEventsPath(leaf: LeafRequest, id: string): string {
	const explicit = leaf.eventsPath?.trim();
	if (explicit) return explicit;
	const safeId = id.replace(/[^A-Za-z0-9_-]/g, "_") || "leaf";
	return join(tmpdir(), `rust-leaf-events-${safeId}-${Date.now()}.jsonl`);
}

/**
 * Translate the F6 forward-struct into the consumed CLI selection surface
 * (`main.rs` usage text, `agent_mode.rs` `AgentOpts`): system on/off, role
 * and subrole names with explicit enable toggles, repeatable per-layer
 * shared refs in listed order. OMP never renders instruction text here.
 */
export function buildLeafSelectionArgv(selection: LeafSelection): string[] {
	const argv: string[] = [];
	argv.push("--instructions-system", selection.system.enabled ? "on" : "off");
	for (const shared of selection.system.shared) argv.push("--instructions-system-shared", shared);
	if (selection.role.name) argv.push("--instructions-role", selection.role.name);
	argv.push(selection.role.enabled ? "--instructions-role-enabled" : "--no-instructions-role-enabled");
	for (const shared of selection.role.shared) argv.push("--instructions-role-shared", shared);
	if (selection.subrole.name) argv.push("--instructions-subrole", selection.subrole.name);
	argv.push(
		selection.subrole.enabled ? "--instructions-subrole-enabled" : "--no-instructions-subrole-enabled",
	);
	for (const shared of selection.subrole.shared) argv.push("--instructions-subrole-shared", shared);
	return argv;
}

/**
 * Map the caller-asserted forced-tool-choice support onto the consumed
 * `--tool-choice` CLI surface. False emits auto; true or absent omits the
 * flag so the binary keeps its historical forced-`required` with tools.
 * Pure mapping, no spawn, no policy.
 */
export function buildLeafToolChoiceArgv(forceToolChoice: boolean | undefined): string[] {
	return forceToolChoice === false ? ["--tool-choice", "auto"] : [];
}

function buildLeafArgv(args: { leaf: LeafRequest; cwd: string; model: string; eventsPath: string; forceToolChoice?: boolean }): string[] {
	const { leaf, cwd, model, eventsPath } = args;
	if (!leaf.endpoint) {
		throw new Error("Rust leaf requested but LeafRequest.endpoint is empty (leaf usage exits 2)");
	}
	if (!model) {
		throw new Error("Rust leaf requested but no model is available (modelOverride or agent model is required, leaf --model is required, usage exits 2)");
	}
	const argv = ["agent", "--endpoint", leaf.endpoint, "--model", model, "--cwd", cwd];
	// Read-only driver: without this the leaf defaults to allow_all.
	argv.push("--read-only");
	argv.push(...buildLeafToolChoiceArgv(args.forceToolChoice));
	if (leaf.maxToolCalls !== undefined) argv.push("--max-tool-calls", String(leaf.maxToolCalls));
	if (leaf.wallSecs !== undefined) argv.push("--wall-secs", String(leaf.wallSecs));
	// The R events file is always distinct from the OMP session jsonl;
	// R appends live display events here while OMP adapts the piped stdout.
	argv.push("--events-path", eventsPath);
	if (leaf.loadPath) argv.push("--load", leaf.loadPath);
	argv.push(...buildLeafSelectionArgv(leaf.selection));
	return argv;
}

/**
 * Adapted assistant message for one leaf turn: the leaf's actual assistant
 * text plus the caller's real model provenance. Usage stays zero — the leaf
 * protocol reports no token buckets — and the timestamp is the host clock.
 */
function leafAssistantMessage(
	text: string,
	provenance: LeafModelProvenance,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: provenance.api,
		provider: provenance.provider,
		model: provenance.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * Terminal stop reason from the real end state: the stderr terminal record
 * when present, else the exit code. Cancelled stays aborted so salvage keeps
 * its cancellation naming in `error`.
 */
function leafStopReason(terminal: LeafTerminal | undefined, exitCode: number): AssistantMessage["stopReason"] {
	if (terminal?.terminal === "Cancelled") return "aborted";
	if (terminal !== undefined && terminal.terminal !== "Answer") return "error";
	if (exitCode !== 0) return "error";
	return "stop";
}

function assembleLeafOutcome(args: {
	identity: RustLeafFixtureIdentity;
	stdout: string;
	stderr: string;
	stdoutLines: string[];
	stderrLines: string[];
	exitCode: number;
	durationMs: number;
	modelOverride?: string | string[];
	modelRole?: string;
}): HostDriveOutcome {
	const digest = digestLeafLines(args.stdoutLines, args.stderrLines);
	const terminal = digest.terminal;
	const terminalFailed =
		terminal !== undefined && terminal.terminal !== "Answer" && terminal.terminal !== "Cancelled";
	// Real adaptation (not fixture replay): the adapted output is the leaf's
	// actual assistant text — never the raw display-event JSONL. Deltas stream
	// to the executor as message_end AgentEvents during spawn and the terminal
	// turn closes as agent_end before the existing finalizeRunResult, which maps yield extraction to the terminal kind:
	// `Answer` carries the completed payload (the leaf has no `yield` tool;
	// its answer IS the result). Salvage mirrors the consumer: a `Cancelled`
	// turn with partial stream text keeps that text and names the cancellation
	// in `error` instead of going empty.
	let assistantText = "";
	for (const chunk of digest.deltas) {
		if (chunk.seq > digest.userSeq) assistantText += chunk.text;
	}
	// A textless new turn stays empty: historical deltas belong to prior turns.
	const failed = args.exitCode !== 0 || terminalFailed;
	// The leaf process exits 0 even on Error/BudgetExceeded turns; surface the
	// terminal failure as a nonzero exit so the finalizer keeps it a failure.
	const exitCode = terminalFailed && args.exitCode === 0 ? 1 : args.exitCode;
	const stderrHead = args.stderr.trim().slice(0, 500);
	const error =
		(args.exitCode === 2
			? `--load/usage failure (exit 2): ${stderrHead || "leaf exited 2"}`
			: undefined) ??
		(terminal?.error !== undefined ? `leaf terminal ${terminal.terminal}: ${terminal.error}`.slice(0, 500) : undefined) ??
		(terminal?.terminal === "Cancelled" && assistantText
			? `leaf turn cancelled; salvaged ${assistantText.length} chars of partial assistant text`
			: undefined) ??
		(failed ? `leaf exited ${exitCode}` : undefined);
	return {
		index: args.identity.index,
		id: args.identity.id,
		agent: args.identity.agentName,
		agentSource: args.identity.agentSource,
		task: args.identity.task,
		assignment: args.identity.assignment,
		description: args.identity.description,
		exitCode,
		output: assistantText,
		stderr: args.stderr,
		truncated: false,
		durationMs: args.durationMs,
		tokens: 0,
		requests: 1,
		modelOverride: args.modelOverride,
		modelRole: args.modelRole,
		resolvedModel: args.identity.model,
		error,
		aborted: terminal?.terminal === "Cancelled",
		abortReason: terminal?.terminal === "Cancelled" ? "cancelled" : undefined,
	};
}

/**
 * Pure deterministic replay of a {@link RustLeafFixture} into the host
 * outcome. No clock, no spawn: the acceptance gate pins this mapping.
 */
export function replayLeafFixture(
	fixture: RustLeafFixture,
	identity: RustLeafFixtureIdentity,
): HostDriveOutcome {
	return assembleLeafOutcome({
		identity,
		stdout: fixture.stdoutLines.join("\n"),
		stderr: fixture.stderrLines.join("\n"),
		stdoutLines: fixture.stdoutLines,
		stderrLines: fixture.stderrLines,
		exitCode: fixture.exitCode,
		durationMs: fixture.durationMs,
	});
}

	/**
	 * Child env for the leaf spawn. Absent or blank credentials return
	 * `undefined` so `spawn` inherits untouched. A present credential maps
	 * to `PI_TRACK_API_KEY` over a full inherit copy, closing the
	 * forwarding drop where the child sent no bearer and the proxy
	 * answered 401.
	 */
	export function buildLeafChildEnv(credential: string | undefined): NodeJS.ProcessEnv | undefined {
		const key = credential?.trim();
		if (!key) return undefined;
		return { ...process.env, PI_TRACK_API_KEY: key };
	}

function spawnLeaf(args: {
	binary: string;
	argv: string[];
	submitText: string;
	wallSecs: number | undefined;
	signal: AbortSignal | undefined;
	env: NodeJS.ProcessEnv | undefined;
	/** Per complete line as it arrives on either pipe; trailing partials flush in finish. */
	onLine?: (line: string) => void;
}): Promise<{ exitCode: number; stdout: string; stderr: string; stdoutLines: string[]; stderrLines: string[] }> {
	// Cooperative-cancel spawn (contract settled against
	// `crates/pi_track_accept/src/agent_mode.rs` header): stdin carries JSONL
	// ops (`submit`, then `cancel`, then `shutdown`) and stays open until the
	// stderr terminal record arrives; only then is `shutdown` written and
	// stdin ended, and both pipes drain to EOF (`close`). Exactly one
	// terminal ever exists: the host never synthesizes one, an abort after
	// the terminal is a no-op, and an abort before the submit ack is queued
	// until the `accepted:true` ack for turn 1 arrives — never a new
	// submit/turn. When the terminal (or close) does not arrive inside the
	// bounded escalation window, the tree is SIGTERM'd then SIGKILL'd
	// (process-group on POSIX where this spawn owns its session, direct
	// child otherwise — the `signalStdioProcess` rule in
	// `mcp/transports/stdio.ts`), and the outcome stays truthful: whatever
	// lines actually arrived plus the real exit code, never an invented
	// terminal. Listeners and timers are removed exactly once on settle.
	// Escalation graces mirror the stdio transport (TERM 1000ms, KILL 500ms).
	const LEAF_CANCEL_TERM_GRACE_MS = 1000;
	const LEAF_CANCEL_KILL_GRACE_MS = 500;
	const { promise, resolve, reject } = Promise.withResolvers<{
		exitCode: number;
		stdout: string;
		stderr: string;
		stdoutLines: string[];
		stderrLines: string[];
	}>();
	// Own session on POSIX so escalation reaches the whole tree (stubborn
	// shell-child). Unlike MCP stdio — which stays attached on darwin so TCC
	// can prompt — the leaf needs no terminal session. Never a group signal
	// on win32.
	const detached = process.platform !== "win32";
	let child: ChildProcess;
	try {
		// No selection env channel: selection travels as consumed CLI flags.
		// Auth travels as an explicit env mapping: a present credential was
		// resolved host-side and lands as PI_TRACK_API_KEY; absent keeps
		// inherit untouched (env: undefined), byte-identical to today.
		child = spawn(args.binary, args.argv, { stdio: ["pipe", "pipe", "pipe"], detached, env: args.env });
	} catch (error) {
		reject(error instanceof Error ? error : new Error(String(error)));
		return promise;
	}
	if (child.stdout === null || child.stderr === null || child.stdin === null) {
		reject(new Error("Rust leaf spawn returned null stdio handles"));
		return promise;
	}
	let stdout = "";
	let stderr = "";
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	let stdoutRemainder = "";
	let stderrRemainder = "";
	let settled = false;
	let cleaned = false;
	let terminalSeen = false;
	let acked = false;
	let cancelQueued = false;
	let cancelSent = false;
	let shutdownSent = false;
	let stdinEnded = false;
	let wallExpired = false;
	let wallTimer: NodeJS.Timeout | undefined;
	let termTimer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	const clearEscalation = (): void => {
		if (termTimer !== undefined) {
			clearTimeout(termTimer);
			termTimer = undefined;
		}
		if (killTimer !== undefined) {
			clearTimeout(killTimer);
			killTimer = undefined;
		}
	};
	const signalTree = (signal: NodeJS.Signals): void => {
		// Group signal only into a session this spawn owns (POSIX detached):
		// a negative-pid signal elsewhere could hit an unrelated group.
		// ESRCH means already gone (success); anything else falls back to
		// the direct child. Every step is no-op-safe against an exited target.
		if (detached && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
			}
		}
		try {
			child.kill(signal);
		} catch {
			// Already exited; the close handler settles the promise.
		}
	};
	const endStdin = (): void => {
		if (stdinEnded || child.stdin === null) return;
		stdinEnded = true;
		try {
			child.stdin.end();
		} catch {
			// Already gone; the close handler settles the promise.
		}
	};
	const writeOp = (op: unknown): void => {
		if (child.stdin === null || stdinEnded || settled) return;
		try {
			child.stdin.write(`${JSON.stringify(op)}\n`);
		} catch {
			// EPIPE after child death; close settles truthfully below.
		}
	};
	const armEscalation = (): void => {
		if (termTimer !== undefined || settled || terminalSeen) return;
		termTimer = setTimeout(() => {
			termTimer = undefined;
			if (settled || terminalSeen) return;
			signalTree("SIGTERM");
			killTimer = setTimeout(() => {
				killTimer = undefined;
				if (settled || terminalSeen) return;
				// Group SIGKILL sweep even when the leader already exited: a
				// stubborn grandchild can outlive it holding the pipes open.
				signalTree("SIGKILL");
			}, LEAF_CANCEL_KILL_GRACE_MS);
			killTimer.unref?.();
		}, LEAF_CANCEL_TERM_GRACE_MS);
		termTimer.unref?.();
	};
	const sendCancel = (): void => {
		if (cancelSent || terminalSeen || settled) return;
		cancelSent = true;
		// Fresh grace from the actually-sent cancel, not from the abort edge.
		clearEscalation();
		writeOp({ op: "cancel", turn_id: 1 });
		armEscalation();
	};
	const sendShutdown = (): void => {
		if (shutdownSent || settled) return;
		shutdownSent = true;
		writeOp({ op: "shutdown" });
		endStdin();
	};
	const onAbort = (): void => {
		if (settled || terminalSeen) return;
		if (acked) {
			sendCancel();
			return;
		}
		// Pre-ack abort: queue until the accepted ack arrives, never a new turn.
		cancelQueued = true;
		armEscalation();
	};
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		clearTimeout(wallTimer);
		clearEscalation();
		if (args.signal !== undefined) args.signal.removeEventListener("abort", onAbort);
		endStdin();
	};
	const finish = (exitCode: number): void => {
		if (settled) return;
		settled = true;
		cleanup();
		// Drain trailing partial lines (no newline before close) on both pipes.
		if (stdoutRemainder.trim()) stdoutLines.push(stdoutRemainder);
		if (stderrRemainder.trim()) stderrLines.push(stderrRemainder);
		resolve({ exitCode, stdout, stderr, stdoutLines, stderrLines });
	};
	// Ack/terminal sniff for the stdin lifecycle only (turn 1): the outcome
	// mapping re-parses every recorded line through parseLeafLine, so this
	// never filters or reinterprets the recorded stream.
	const sniffControl = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (parsed["type"] === "ack" && parsed["turn_id"] === 1 && parsed["accepted"] === true) {
			acked = true;
			if (cancelQueued) sendCancel();
			return;
		}
		if (parsed["type"] === "terminal" && typeof parsed["terminal"] === "string") {
			if (terminalSeen) return;
			terminalSeen = true;
			clearEscalation();
			sendShutdown();
		}
	};
	if (args.wallSecs !== undefined && args.wallSecs > 0) {
		wallTimer = setTimeout(() => {
			// Timeout fallback only: no cancel op, no invented terminal —
			// escalate the tree and settle truthfully on close. Never while a
			// cooperative shutdown drain is already in flight.
			if (settled || terminalSeen) return;
			wallExpired = true;
			signalTree("SIGTERM");
			killTimer = setTimeout(() => {
				killTimer = undefined;
				if (settled) return;
				signalTree("SIGKILL");
			}, LEAF_CANCEL_KILL_GRACE_MS);
			killTimer.unref?.();
		}, args.wallSecs * 1000);
		wallTimer.unref?.();
	}
	if (args.signal !== undefined) {
		if (args.signal.aborted) {
			onAbort();
		} else {
			args.signal.addEventListener("abort", onAbort);
			// Abort raced the attach above; the listener missed the edge.
			if (args.signal.aborted) onAbort();
		}
	}
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		const lines = (stdoutRemainder + chunk).split("\n");
		stdoutRemainder = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			stdoutLines.push(line);
			args.onLine?.(line);
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
		const lines = (stderrRemainder + chunk).split("\n");
		stderrRemainder = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			stderrLines.push(line);
			sniffControl(line);
			args.onLine?.(line);
		}
	});
	child.on("error", (error: Error) => {
		if (!settled) {
			settled = true;
			cleanup();
			reject(error);
		}
	});
	child.on("exit", () => {
		// The leader dying proves nothing about the tree: sweep the group so
		// a stubborn grandchild cannot hold the pipes past the drain below.
		// No-op-safe once the group is gone; the normal path never arms this.
		if (cancelSent || cancelQueued || wallExpired) signalTree("SIGKILL");
	});
	child.on("close", (code: number | null) => finish(code ?? 1));
	try {
		for (const line of submitLeafLines(args.submitText)) {
			child.stdin.write(`${line}\n`);
		}
	} catch {
		// EPIPE on an instantly-dead child; close settles truthfully below.
	}
	return promise;
}

/**
 * In-process record of driven leaf ids. The leaf branch never touches the
 * `AgentRegistry`, so without this a follow-up addressing a leaf id would
 * fall through to the unknown-agent error. `runSubagentFollowUpTurn`
 * checks {@link isLeafRunId} first and returns
 * {@link leafRevivalUnsupportedResult} instead.
 */
const leafRunIds = new Set<string>();

/** Cap on recorded leaf ids; the oldest entry is evicted past the cap. */
const MAX_LEAF_RUN_IDS = 1000;

/** Record a driven leaf run id (called after successful spawn, never on failed drives). */
export function markLeafRunId(id: string): void {
	if (leafRunIds.has(id)) return;
	while (leafRunIds.size >= MAX_LEAF_RUN_IDS) {
		const oldest = leafRunIds.values().next();
		if (oldest.done === true) break;
		leafRunIds.delete(oldest.value);
	}
	leafRunIds.add(id);
}

/** True when `id` belongs to a leaf run driven in this process. */
export function isLeafRunId(id: string): boolean {
	return leafRunIds.has(id);
}

/**
 * Explicit named unsupported-revival result for a follow-up addressing a
 * leaf id. Exact limitation, stated on the result: a leaf run produces R
 * display records, not OMP message history, so no revive path can restore
 * it — re-drive the leaf with a fresh turn instead of continuing this id.
 */
export function leafRevivalUnsupportedResult(args: {
	index: number;
	id: string;
	agentName: string;
	agentSource: SingleResult["agentSource"];
}): SingleResult {
	return {
		index: args.index,
		id: args.id,
		agent: args.agentName,
		agentSource: args.agentSource,
		task: "",
		exitCode: 1,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		resolvedModel: "",
		error:
			`${LEAF_REVIVAL_UNSUPPORTED}: leaf run ${args.id} is non-revivable — ` +
			"a leaf run produces R display records, not OMP message history, so SessionManager.open cannot restore it; re-drive the leaf with a fresh turn instead of continuing this id",
	};
}

/**
 * Drive one explicit Rust-leaf run to settlement and return the host
 * outcome for the existing monitor/finalize path. Throws before spawn on
 * explicit opt-in failure (no binary, empty endpoint/model); never falls
 * back to the host path. Leaf runs are non-revivable by default (see
 * {@link throwLeafRevivalUnsupported}).
 */
export async function driveRustLeaf(args: RustLeafDriveArgs): Promise<HostDriveOutcome> {
	const startMs = Date.now();
	// The model travels the existing executor selection (`modelOverride ?? agent.model`), never the layer struct.
	const firstPattern = (value: string | string[] | undefined): string =>
		typeof value === "string" ? value : (value?.[0] ?? "");
	const leafModel = firstPattern(args.modelOverride) || firstPattern(args.agentModel);
	// Fail closed on unresolved route strings: the wire model is always the
	// registry-resolved native id, never the raw `provider/id:level` pattern.
	const wireModel = args.modelProvenance?.model;
	if (!wireModel) {
		throw new Error(
			`Rust leaf requested but model '${leafModel}' resolves to no registered model (modelOverride or agent model must match the session registry; refusing to send an unresolved route string, leaf usage exits 2)`,
		);
	}
	// Effective message provenance: the caller's registry-resolved triple
	// when present, else the actual serving endpoint plus the `--model` flag.
	// `buildLeafArgv` below throws on empty endpoint/model before any emit
	// site runs, so the backstop is always non-empty where used.
	const provenance: LeafModelProvenance = args.modelProvenance ?? {
		api: args.leaf.endpoint,
		provider: args.leaf.endpoint,
		model: leafModel,
	};
	validateLeafSelection(args.leaf.selection);
	const binary = selectLeafBinary({
		explicitPath: args.leaf.binaryPath,
		configuredPath: args.configuredBinaryPath,
		envPath: process.env.PI_RUST_LEAF_CMD,
	});
	const eventsPath = resolveLeafEventsPath(args.leaf, args.id);
	const argv = buildLeafArgv({ leaf: args.leaf, cwd: args.cwd, model: wireModel, eventsPath, forceToolChoice: args.forceToolChoice });
	const submitText = args.assignment ?? args.task;
	const liveDigest: LeafStreamDigest = { lastSeq: 0, userSeq: 0, deltas: [] };
	let liveText = "";
	const streamLeafLine = (line: string): void => {
		if (args.onAgentEvent === undefined) return;
		const before = liveDigest.deltas.length;
		parseLeafLine(line, liveDigest);
		for (const chunk of liveDigest.deltas.slice(before)) {
			liveText += chunk.text;
			// In-flight partials carry the neutral `stopReason: "stop"`; the
			// single `message_end` after the turn carries the terminal reason.
			const partial = leafAssistantMessage(liveText, provenance, "stop");
			const deltaEvent: AgentEvent = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk.text, partial },
			};
			args.onAgentEvent(deltaEvent);
		}
	};
	const spawned = await spawnLeaf({
		binary,
		argv,
		submitText,
		wallSecs: args.leaf.wallSecs,
		signal: args.signal,
		env: buildLeafChildEnv(args.proxyCredential),
		onLine: streamLeafLine,
	});
	// binary, endpoint/model, spawn rejection) must not poison follow-up routing.
	markLeafRunId(args.id);
	const outcome = assembleLeafOutcome({
		identity: {
			index: args.index,
			id: args.id,
			agentName: args.agentName,
			agentSource: args.agentSource,
			task: args.task,
			assignment: args.assignment,
			description: args.description,
			model: wireModel,
		},
		stdout: spawned.stdout,
		stderr: spawned.stderr,
		stdoutLines: spawned.stdoutLines,
		stderrLines: spawned.stderrLines,
		exitCode: spawned.exitCode,
		durationMs: Date.now() - startMs,
		modelOverride: args.modelOverride,
		modelRole: args.modelRole,
	});
	if (args.onAgentEvent !== undefined) {
		// Single `message_end` per provider response: the leaf drive is one
		// submit → one turn, so the turn closes once with the full adapted
		// text and the terminal stop reason, never once per streamed chunk.
		const terminalDigest = digestLeafLines(spawned.stdoutLines, spawned.stderrLines);
		const finalMessage = leafAssistantMessage(
			outcome.output,
			provenance,
			leafStopReason(terminalDigest.terminal, spawned.exitCode),
		);
		const messageEnd: AgentEvent = { type: "message_end", message: finalMessage };
		args.onAgentEvent(messageEnd);
		const endEvent: AgentEvent = {
			type: "agent_end",
			messages: [finalMessage],
		};
		args.onAgentEvent(endEvent);
	}
	return outcome;
}
