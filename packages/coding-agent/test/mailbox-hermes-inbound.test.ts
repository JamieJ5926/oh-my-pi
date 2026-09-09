/**
 * Focused test for the Hermes inbound hook (omp-owned #19).
 * Fixture copies only; never touches the live inbox.
 */
import { describe, expect, it } from "bun:test";
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

	it("prepends at top when no separator exists", () => {
		const body = "- [ ] 2026-09-04 21:12 · coord · **message** — old one";
		const out = insertMailboxLine(body, "- [ ] 2026-09-09 10:05 · hermes/discord · **note** — fresh");
		expect(out.split("\n")[0]).toContain("hermes/discord");
		expect(out).toContain(body);
	});

	it("rejects unknown kinds and empty fields", () => {
		expect(() => formatMailboxLine({ source: "s", kind: "bug", content: "c" })).toThrow("unknown kind");
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

	it("resolves the real inbox path without assuming it", () => {
		delete process.env.HERMES_MAILBOX_FILE;
		expect(resolveMailboxPath()).toBe(`${process.env.HOME}/Obsidean/00-Inbox/MAILBOX.md`);
	});
});
