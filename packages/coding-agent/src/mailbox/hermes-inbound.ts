/**
 * Hermes inbound hook for mailbox intake (omp-owned #19).
 *
 * Boundary: this module owns the event-to-line shape and the append-only
 * insert. It never touches the live inbox itself; callers pass file text in
 * and write the result out. The running Hermes gateway (~280MB always-on)
 * and platform setup are out of scope: exercise this against simulated
 * inbound events and fixture copies only.
 */

export const MAILBOX_SEPARATOR = "---";

// node:os import for the HOME-unset fallback (no fs API expands a literal ~).
import { homedir } from "node:os";

/** Default inbox path, resolved lazily so a later HOME change is honored. */
export function defaultMailboxPath(): string {
	const home = process.env.HOME || homedir();
	return `${home}/Obsidean/00-Inbox/MAILBOX.md`;
}

/** Resolve the real inbox path read-only (env override is for fixtures). */
export function resolveMailboxPath(): string {
	return process.env.HERMES_MAILBOX_FILE ?? defaultMailboxPath();
}
const KINDS = ["task", "idea", "message", "note", "feature", "bug", "project", "decision"] as const;
export type MailboxKind = (typeof KINDS)[number];

export interface HermesInboundEvent {
	/** Origin label, e.g. `hermes/telegram` or `hermes/discord:#ops`. */
	source: string;
	/** One of task|idea|message|note|feature|bug|project|decision. Anything else is rejected. */
	kind: string;
	/** Body text; single line, never empty. */
	content: string;
	/** Optional project/repo suffix, e.g. `omp-owned`. Never invented. */
	project?: string;
	/** Event time; defaults to now. */
	at?: Date;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function stamp(d: Date): string {
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}

function oneLine(s: string): string {
	return s.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Format one kind-tagged mailbox line:
 * `- [ ] YYYY-MM-DD HH:MM · <source> · **<kind>** — <content>`
 * Kinds per the mailbox skill: task, idea, message, note, feature, bug,
 * project, decision. Throws on unknown kind, empty source, or empty content.
 */
export function formatMailboxLine(event: HermesInboundEvent, now = new Date()): string {
	const kind = event.kind.trim().toLowerCase();
	if (!KINDS.some((k) => k === kind)) {
		throw new Error(`hermes-inbound: unknown kind ${JSON.stringify(event.kind)} (want ${KINDS.join("|")})`);
	}
	const source = oneLine(event.source);
	if (!source) throw new Error("hermes-inbound: empty source");
	const content = oneLine(event.content);
	if (!content) throw new Error("hermes-inbound: empty content");
	const project = event.project === undefined ? "" : oneLine(event.project);
	const tag = project ? `**${kind}/${project}**` : `**${kind}**`;
	const at = event.at ?? now;
	if (Number.isNaN(at.getTime())) throw new Error("hermes-inbound: invalid at");
	return `- [ ] ${stamp(at)} · ${source} · ${tag} — ${content}`;
}

/**
 * Insert one line newest-first under the mailbox separator without
 * rewriting existing lines. Doctrine (mailbox skill) places entries under
 * the `---` separator, but the live inbox observed 2026-09-09 carries no
 * separator, so: with a separator, insert under it; without one, insert
 * above the first entry line so a doctrine header stays on top; with
 * header text but no entries yet, append after the header; only genuinely
 * empty input takes the line at the top.
 */
export function insertMailboxLine(fileText: string, line: string): string {
	const lines = fileText.split("\n");
	const sep = lines.findIndex((l) => l.trim() === MAILBOX_SEPARATOR);
	if (sep !== -1) return [...lines.slice(0, sep + 1), line, ...lines.slice(sep + 1)].join("\n");
	const firstEntry = lines.findIndex((l) => /^- \[[ x]\]/.test(l));
	if (firstEntry !== -1) return [...lines.slice(0, firstEntry), line, ...lines.slice(firstEntry)].join("\n");
	if (fileText.trim() === "") return line;
	return [...lines, line].join("\n");
}
