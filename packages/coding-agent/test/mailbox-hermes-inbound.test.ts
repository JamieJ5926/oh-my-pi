/**
 * Focused test for the Hermes inbound hook (omp-owned #19).
 * Fixture copies only; never touches the live inbox.
 */
import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import {
	formatMailboxLine,
	insertMailboxLine,
	resolveMailboxPath,
} from "../src/mailbox/hermes-inbound";

const FIXTURE = ["doctrine header", "---", "- [ ] 2026-09-04 21:12 · coord · **message** — old one", "- [ ] 2026-09-04 20:48 · coord · **task** — older"].join("\n");

describe("hermes-inbound", () => {
	it("formats the exact kind-tagged line", () => {
		const line = formatMailboxLine(
			{ source: "hermes/telegram", kind: "task", content: "ping the gateway" },
			new Date(2026, 8, 9, 10, 5),
		);
		expect(line).toBe("- [ ] 2026-09-09 10:05 · hermes/telegram · **task** — ping the gateway");
	});

	it("inserts newest-first under the separator without touching existing lines", () => {
		const line = "- [ ] 2026-09-09 10:05 · hermes/telegram · **idea** — fresh";
		const out = insertMailboxLine(FIXTURE, line);
		const rows = out.split("\n");
		expect(rows[0]).toBe("doctrine header");
		expect(rows[1]).toBe("---");
		expect(rows[2]).toBe(line);
		expect(rows.slice(3)).toEqual(FIXTURE.split("\n").slice(2));
	});

	it("inserts above the first entry when a header precedes a missing separator", () => {
		const body = ["doctrine header, no separator", "- [ ] 2026-09-04 21:12 · coord · **message** — old one"].join("\n");
		const line = "- [ ] 2026-09-09 10:05 · hermes/discord · **note** — fresh";
		const rows = insertMailboxLine(body, line).split("\n");
		expect(rows[0]).toBe("doctrine header, no separator");
		expect(rows[1]).toBe(line);
		expect(rows[2]).toContain("old one");
	});

	it("prepends at top when entries start at line 0 (live-inbox shape)", () => {
		const body = "- [ ] 2026-09-04 21:12 · coord · **message** — old one";
		const out = insertMailboxLine(body, "- [ ] 2026-09-09 10:05 · hermes/discord · **note** — fresh");
		expect(out.split("\n")[0]).toContain("hermes/discord");
		expect(out).toContain(body);
	});

	it("accepts all mailbox-skill kinds and rejects the rest", () => {
		for (const kind of ["task", "idea", "message", "note", "feature", "bug", "project", "decision"]) {
			const line = formatMailboxLine({ source: "s", kind, content: "c" }, new Date(2026, 8, 9, 10, 5));
			expect(line).toContain(`**${kind}**`);
		}
		expect(() => formatMailboxLine({ source: "s", kind: "alert", content: "c" })).toThrow("unknown kind");
		expect(() => formatMailboxLine({ source: " ", kind: "task", content: "c" })).toThrow("empty source");
		expect(() => formatMailboxLine({ source: "s", kind: "task", content: " " })).toThrow("empty content");
	});

	it("emits the project suffix and treats blank project as absent", () => {
		const withProj = formatMailboxLine(
			{ source: "hermes/telegram", kind: "task", content: "c", project: "omp-owned" },
			new Date(2026, 8, 9, 10, 5),
		);
		expect(withProj).toBe("- [ ] 2026-09-09 10:05 · hermes/telegram · **task/omp-owned** — c");
		const blankProj = formatMailboxLine(
			{ source: "hermes/telegram", kind: "task", content: "c", project: "   " },
			new Date(2026, 8, 9, 10, 5),
		);
		expect(blankProj).toBe("- [ ] 2026-09-09 10:05 · hermes/telegram · **task** — c");
	});

	it("prefers event.at over now and rejects an invalid at", () => {
		const line = formatMailboxLine(
			{ source: "s", kind: "note", content: "c", at: new Date(2026, 0, 2, 3, 4) },
			new Date(2026, 8, 9, 10, 5),
		);
		expect(line).toStartWith("- [ ] 2026-01-02 03:04 ·");
		expect(() => formatMailboxLine({ source: "s", kind: "note", content: "c", at: new Date(Number.NaN) })).toThrow(
			"invalid at",
		);
	});

	it("accepts uppercase and padded kinds", () => {
		const line = formatMailboxLine(
			{ source: "s", kind: "  Idea ", content: "c" },
			new Date(2026, 8, 9, 10, 5),
		);
		expect(line).toContain("**idea**");
	});

	it("honors the HERMES_MAILBOX_FILE override and restores env", () => {
		const savedFile = process.env.HERMES_MAILBOX_FILE;
		const savedHome = process.env.HOME;
		try {
			process.env.HERMES_MAILBOX_FILE = "/tmp/fixture-MAILBOX.md";
			expect(resolveMailboxPath()).toBe("/tmp/fixture-MAILBOX.md");
			delete process.env.HERMES_MAILBOX_FILE;
			process.env.HOME = "/tmp/fakehome";
			expect(resolveMailboxPath()).toBe("/tmp/fakehome/Obsidean/00-Inbox/MAILBOX.md");
		} finally {
			if (savedFile === undefined) delete process.env.HERMES_MAILBOX_FILE;
			else process.env.HERMES_MAILBOX_FILE = savedFile;
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});

	it("appends after header text when no entries exist yet, top only when empty", () => {
		const line = "- [ ] 2026-09-09 10:05 · hermes/telegram · **task** — first";
		const headerOnly = insertMailboxLine("doctrine header, no entries yet", line);
		expect(headerOnly).toBe(["doctrine header, no entries yet", line].join("\n"));
		expect(insertMailboxLine("", line)).toBe(line);
	});

	it("falls back to homedir() when HOME is unset or empty", () => {
		const savedHome = process.env.HOME;
		try {
			delete process.env.HOME;
			expect(resolveMailboxPath().startsWith(`${homedir()}/Obsidean/00-Inbox/MAILBOX.md`)).toBe(true);
			process.env.HOME = "";
			expect(resolveMailboxPath().startsWith(`${homedir()}/Obsidean/00-Inbox/MAILBOX.md`)).toBe(true);
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});

	it("resolves the default path from the live HOME with save and restore", () => {
		const savedFile = process.env.HERMES_MAILBOX_FILE;
		const savedHome = process.env.HOME;
		try {
			delete process.env.HERMES_MAILBOX_FILE;
			process.env.HOME = "/Users/jamie";
			expect(resolveMailboxPath()).toBe("/Users/jamie/Obsidean/00-Inbox/MAILBOX.md");
		} finally {
			if (savedFile === undefined) delete process.env.HERMES_MAILBOX_FILE;
			else process.env.HERMES_MAILBOX_FILE = savedFile;
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});
});
