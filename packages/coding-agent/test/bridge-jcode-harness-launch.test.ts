import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessLaunchError, inheritCredentials, launchHarness } from "../src/bridge/backends/jcode/harness-launch";

const roots: string[] = [];
const sentinels: ChildProcess[] = [];
setDefaultTimeout(20_000);
function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launch-test-"));
	roots.push(root);
	return root;
}

function writeExecutable(root: string, source: string): string {
	fs.mkdirSync(root, { recursive: true });
	const binary = path.join(root, "jcode-stub.js");
	fs.writeFileSync(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
	return binary;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("condition did not become true before timeout");
}

function ephemeralHomes(): Set<string> {
	return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("omp-jcode-harness-")));
}

const bridgeStub = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const args = process.argv.slice(2);
const socketIndex = args.indexOf("--api-socket");
if (socketIndex < 0 || !args[socketIndex + 1]) process.exit(64);
const apiSocket = args[socketIndex + 1];
const home = process.env.JCODE_HOME;
const runtime = process.env.JCODE_RUNTIME_DIR;
const daemon = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], {
  detached: true,
  stdio: "ignore",
});
daemon.unref();
fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ private: { socket: path.join(runtime, "jcode.sock"), pid: daemon.pid } }));
fs.writeFileSync(process.env.RECORD_PATH, JSON.stringify({ args, env: { JCODE_HOME: home, JCODE_RUNTIME_DIR: runtime, JCODE_API_SOCKET: process.env.JCODE_API_SOCKET, JCODE_SOCKET: process.env.JCODE_SOCKET, CALLER_VALUE: process.env.CALLER_VALUE }, daemonPid: daemon.pid }));
try { fs.unlinkSync(apiSocket); } catch {}
const server = net.createServer((socket) => socket.end());
server.listen(apiSocket);
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(()=>{},1000);
`;

afterEach(async () => {
	for (const child of sentinels.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("private harness launcher", () => {
	it("rejects blank route values before spawning", async () => {
		const root = makeRoot();
		const marker = path.join(root, "spawned");
		const binary = writeExecutable(root, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`);
		const error = await launchHarness({ binary, providerProfile: "  " }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(HarnessLaunchError);
		expect(error).toMatchObject({ code: "invalid_launch_option" });
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("launches on private paths and kills only its bridge and daemon", async () => {
		const root = makeRoot();
		const recordPath = path.join(root, "record.json");
		const binary = writeExecutable(root, bridgeStub);
		const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		sentinels.push(sentinel);
		const launched = await launchHarness({
			binary,
			provider: "openai",
			providerProfile: "private-profile",
			model: "private-model",
			env: { RECORD_PATH: recordPath, CALLER_VALUE: "kept", JCODE_HOME: "/must/not/win" },
			startupTimeoutMs: 5000,
			cleanupTimeoutMs: 5000,
		});
		await waitUntil(() => fs.existsSync(recordPath));
		const record: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"));
		if (typeof record !== "object" || record === null || !("args" in record) || !("env" in record) || !("daemonPid" in record)) {
			throw new Error("stub record has the wrong shape");
		}
		if (!Array.isArray(record.args) || typeof record.env !== "object" || record.env === null || typeof record.daemonPid !== "number") {
			throw new Error("stub record fields have the wrong types");
		}
		if (typeof record.daemonPid !== "number") throw new Error("stub did not record a daemon pid");
		const daemonPid = record.daemonPid;
		expect(record.args).toEqual([
			"--provider",
			"openai",
			"--provider-profile",
			"private-profile",
			"--model",
			"private-model",
			"api-bridge",
			"--api-socket",
			launched.socketPath,
		]);
		expect(record.env).toMatchObject({
			JCODE_HOME: launched.jcodeHome,
			JCODE_RUNTIME_DIR: path.join(launched.jcodeHome, "run"),
			JCODE_API_SOCKET: launched.socketPath,
			JCODE_SOCKET: path.join(launched.jcodeHome, "run", "jcode.sock"),
			CALLER_VALUE: "kept",
		});
		expect(processExists(daemonPid)).toBe(true);
		expect(processExists(sentinel.pid ?? -1)).toBe(true);
		const home = launched.jcodeHome;
		await launched.close();
		await launched.close();
		await waitUntil(() => !processExists(daemonPid), 8000);
		expect(processExists(sentinel.pid ?? -1)).toBe(true);
		await Bun.sleep(1000);
		expect(fs.existsSync(home)).toBe(false);
	});

	it("retains a supplied home and removes ephemeral homes after startup failures", async () => {
		const root = makeRoot();
		const persistentHome = path.join(root, "persistent");
		const recordPath = path.join(root, "persistent-record.json");
		const binary = writeExecutable(root, bridgeStub);
		const launched = await launchHarness({
			binary,
			jcodeHome: persistentHome,
			env: { RECORD_PATH: recordPath },
			startupTimeoutMs: 5000,
		});
		await launched.close();
		expect(fs.existsSync(persistentHome)).toBe(true);

		const beforeMissing = ephemeralHomes();
		await expect(launchHarness({ binary: path.join(root, "missing-jcode"), startupTimeoutMs: 100 })).rejects.toBeInstanceOf(HarnessLaunchError);
		const afterMissing = ephemeralHomes();
		expect([...afterMissing].filter((name) => !beforeMissing.has(name))).toEqual([]);

		const timeoutBinary = writeExecutable(path.join(root, "timeout"), "setInterval(()=>{},1000);");
		const beforeTimeout = ephemeralHomes();
		await expect(launchHarness({ binary: timeoutBinary, startupTimeoutMs: 100, cleanupTimeoutMs: 1000 })).rejects.toMatchObject({
			code: "startup_timeout",
		});
		const afterTimeout = ephemeralHomes();
		expect([...afterTimeout].filter((name) => !beforeTimeout.has(name))).toEqual([]);
	});
	it("inherits credential files without sharing mutable config", () => {
		const root = makeRoot();
		const sourceHome = path.join(root, "source-jcode");
		const userHome = path.join(root, "user-home");
		const appConfig = path.join(root, "app-config");
		const targetHome = path.join(root, "instance");
		fs.mkdirSync(sourceHome, { recursive: true });
		fs.mkdirSync(path.join(userHome, ".codex"), { recursive: true });
		fs.mkdirSync(appConfig, { recursive: true });
		fs.writeFileSync(path.join(sourceHome, "auth.json"), "rotating");
		fs.writeFileSync(path.join(sourceHome, "config.toml"), "model = 'test'");
		fs.writeFileSync(path.join(userHome, ".codex", "auth.json"), "external");
		fs.writeFileSync(path.join(appConfig, "subscription.env"), "TOKEN=dummy");
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "keep"), "untouched");
		fs.mkdirSync(targetHome, { recursive: true });
		fs.symlinkSync(outside, path.join(targetHome, "external"));

		const inherited = inheritCredentials(sourceHome, targetHome, userHome, appConfig);
		expect(inherited).toContain("auth.json");
		expect(inherited).toContain("config.toml");
		expect(inherited).toContain("external/.codex/auth.json");
		expect(fs.lstatSync(path.join(targetHome, "auth.json")).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(path.join(targetHome, "auth.json"))).toBe(fs.realpathSync(path.join(sourceHome, "auth.json")));
		expect(fs.lstatSync(path.join(targetHome, "config.toml")).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8")).toBe("model = 'test'");
		expect(fs.statSync(path.join(targetHome, "config.toml")).mode & 0o777).toBe(0o600);
		fs.writeFileSync(path.join(targetHome, "config.toml"), "changed");
		expect(fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8")).toBe("model = 'test'");
		expect(fs.lstatSync(path.join(targetHome, "external")).isDirectory()).toBe(true);
		expect(fs.lstatSync(path.join(targetHome, "external")).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
		expect(fs.realpathSync(path.join(targetHome, "external", ".codex", "auth.json"))).toBe(
			fs.realpathSync(path.join(userHome, ".codex", "auth.json")),
		);
		expect(fs.existsSync(path.join(targetHome, "missing.json"))).toBe(false);
	});

});
