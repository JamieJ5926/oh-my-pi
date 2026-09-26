import { expect, test } from "bun:test";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { ProcessTerminal } from "../src/terminal";
test("fallback queue preserves write order across the sliced path", async () => {
	const out: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	const isTTY = process.stdout.isTTY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	setTerminalHeadless(false);
	process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as never;
	try {
		const t = new ProcessTerminal();
		const big = "A".repeat(3 * 1024 * 1024);
		t.write(big);
		t.write("TAIL");
		t.write("MORE");
		await new Promise(r => setTimeout(r, 200));
	} finally {
		process.stdout.write = orig as never;
		Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
	}
	const joined = out.join("");
	console.log("writes", out.length);
	expect(out.length).toBeGreaterThan(3);
	expect(joined.endsWith("TAILMORE")).toBe(true);
	expect(joined.length).toBe(3 * 1024 * 1024 + 8);
});
