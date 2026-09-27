// Launch a private `jcode api-bridge` instance for the explicit harness API.
//
// Mirrors the proven JCode TypeScript SDK launch semantics
// (jcode-bridge/sdk/typescript/src/launch.ts): a dedicated JCODE_HOME with an
// in-home runtime directory, globals before the `api-bridge` subcommand
// (`--provider-profile` and `--model` are clap `global = true` args; the
// subcommand owns `--api-socket`), and a startup loop that waits for the
// private socket to accept connections. Cleanup touches only the launched
// child process and the instance's own state — never the user's live jcode,
// the shared socket, or the default build pointers.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Typed launch failure; `code` matches the SDK's error vocabulary. */
export class HarnessLaunchError extends Error {
	constructor(
		readonly code: "invalid_launch_option" | "startup_failed" | "startup_timeout",
		message: string,
	) {
		super(message);
		this.name = "HarnessLaunchError";
	}
}

export interface HarnessLaunchOptions {
	/** Path to the jcode binary. */
	binary: string;
	/** Working directory for the bridge process. Defaults to the current one. */
	workingDir?: string;
	/**
	 * Instance state directory. Supplied paths persist across runs and are
	 * never deleted; the default is a fresh ephemeral directory removed on
	 * `close()`.
	 */
	jcodeHome?: string;
	/**
	 * Share the user's provider logins with the instance. Defaults to `true`.
	 * Without credentials a fresh instance cannot talk to any model, so the
	 * default is the one that works; pass `false` to start empty.
	 */
	inheritLogins?: boolean;
	/** Extra environment variables for the instance. */
	env?: Record<string, string>;
	/** Named provider profile from `[providers.<name>]`, passed as the global `--provider-profile` flag. */
	providerProfile?: string;
	/** Built-in provider id, passed as the global `--provider` flag. */
	provider?: string;
	/** Model id, passed as the global `--model` flag. */
	model?: string;
	/** Milliseconds to wait for the API socket to accept connections. Defaults to 30000. */
	startupTimeoutMs?: number;
	/** Milliseconds `close()` will spend removing an ephemeral home. Defaults to 10000. */
	cleanupTimeoutMs?: number;
}

export interface LaunchedHarness {
	/** API socket path to connect to. */
	readonly socketPath: string;
	/** The instance's `JCODE_HOME`. */
	readonly jcodeHome: string;
	/** The bridge process. */
	readonly process: ChildProcess;
	/** Stop the bridge and clean up ephemeral state. Idempotent. */
	close(): Promise<void>;
}

const RUNTIME_DIRNAME = "run";
const API_SOCKET_NAME = "jcode-api.sock";
const EPHEMERAL_PREFIX = "omp-jcode-harness-";

/**
 * Files inherited from the user's jcode home when logins are inherited.
 *
 * Deliberately not included: `auth-refresh-state.json` and
 * `auth-validation.json`, derived records of past auth failures — copying
 * them imports another jcode's bad day.
 */
const CREDENTIAL_FILES = [
	"auth.json",
	"openai-auth.json",
	"antigravity_oauth.json",
	"gemini_oauth.json",
	"google_oauth.json",
	"google_credentials.json",
	"config.toml",
];

/** jcode's own config directory name under the platform config root. */
const APP_CONFIG_DIRNAME = "jcode";

/** Where jcode looks for other CLIs' credentials, relative to `$HOME`. */
const EXTERNAL_CREDENTIAL_FILES = [
	".claude/.credentials.json",
	".codex/auth.json",
	".gemini/oauth_creds.json",
	".cursor/auth.json",
	".config/cursor/auth.json",
	"AppData/Roaming/Cursor/auth.json",
	".config/Cursor/User/globalStorage/state.vscdb",
	".config/cursor/User/globalStorage/state.vscdb",
	"Library/Application Support/Cursor/User/globalStorage/state.vscdb",
	"Library/Application Support/cursor/User/globalStorage/state.vscdb",
	"AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
	"AppData/Roaming/cursor/User/globalStorage/state.vscdb",
	".config/github-copilot/hosts.json",
	".config/github-copilot/apps.json",
	".copilot/config.json",
	".hermes/auth.json",
	".pi/agent/auth.json",
	".openclaw/agent/auth.json",
	".openclaw/credentials/oauth.json",
	".local/share/opencode/auth.json",
];

/** Ensure a directory below an instance root contains no symlink components. */
function ensureInstanceDirectory(root: string, relative: string): string {
	if (path.isAbsolute(relative) || relative.split(/[\\/]+/u).includes("..")) {
		throw new HarnessLaunchError("invalid_launch_option", `unsafe instance path: ${relative}`);
	}
	let current = root;
	for (const part of relative.split(/[\\/]+/u).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stats = fs.lstatSync(current);
			if (stats.isSymbolicLink()) {
				fs.unlinkSync(current);
				fs.mkdirSync(current, { mode: 0o700 });
			} else if (!stats.isDirectory()) {
				throw new HarnessLaunchError("invalid_launch_option", `instance credential path is not a directory: ${current}`);
			}
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				fs.mkdirSync(current, { mode: 0o700 });
				continue;
			}
			throw error;
		}
	}
	return current;
}

/** Replace an instance-relative path with a link to one credential file. */
function linkCredentialFile(source: string, root: string, relative: string): boolean {
	let sourceStats;
	try {
		sourceStats = fs.statSync(source);
	} catch {
		return false;
	}
	if (!sourceStats.isFile()) return false;
	const parent = ensureInstanceDirectory(root, path.dirname(relative));
	const destination = path.join(parent, path.basename(relative));
	try {
		fs.unlinkSync(destination);
	} catch {
		// Absent, which is the common case.
	}
	fs.symlinkSync(source, destination);
	return true;
}

/**
 * Give a launched instance the user's provider logins.
 *
 * Rotating credential files are symlinked so token rotation stays coherent
 * (OAuth refresh tokens rotate; two copies of one token fight and whichever
 * refreshes second is logged out); `config.toml` is copied owner-only so the
 * instance can edit its own configuration without touching the user's.
 * App-config `.env` files and other CLIs' exact credential files are linked
	 * file-by-file — never whole directories, which a buggy recursive cleanup
 * could descend through and delete the user's files.
 */
export function inheritCredentials(fromHome: string, toHome: string, userHome = os.homedir(), appConfigDir?: string): string[] {
	fs.mkdirSync(toHome, { recursive: true, mode: 0o700 });
	const toStats = fs.lstatSync(toHome);
	if (toStats.isSymbolicLink() || !toStats.isDirectory()) {
		throw new HarnessLaunchError(
			"invalid_launch_option",
			`instance home must be a real directory, not a link or file: ${toHome}`,
		);
	}
	if (fs.existsSync(fromHome) && fs.realpathSync(fromHome) === fs.realpathSync(toHome)) {
		throw new HarnessLaunchError(
			"invalid_launch_option",
			"instance home must be different from the user's jcode home",
		);
	}
	const inherited: string[] = [];
	for (const name of CREDENTIAL_FILES) {
		const source = path.join(fromHome, name);
		if (name === "config.toml") {
			if (!fs.existsSync(source)) continue;
			fs.copyFileSync(source, path.join(toHome, name));
			fs.chmodSync(path.join(toHome, name), 0o600);
			inherited.push(name);
		} else if (linkCredentialFile(source, toHome, name)) {
			inherited.push(name);
		}
	}

	// jcode's provider env files live in its platform config directory, which
	// `JCODE_HOME` moves to `$JCODE_HOME/config/jcode`. Link only the env
	// files; caches and usage data are not credentials.
	const userConfig =
		appConfigDir ??
		(process.platform === "darwin"
			? path.join(userHome, "Library", "Application Support", APP_CONFIG_DIRNAME)
			: process.platform === "win32"
				? path.join(process.env.APPDATA ?? path.join(userHome, "AppData", "Roaming"), APP_CONFIG_DIRNAME)
				: path.join(process.env.XDG_CONFIG_HOME ?? path.join(userHome, ".config"), APP_CONFIG_DIRNAME));
	try {
		for (const entry of fs.readdirSync(userConfig, { withFileTypes: true })) {
			if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".env")) continue;
			const relative = `config/${APP_CONFIG_DIRNAME}/${entry.name}`;
			if (linkCredentialFile(path.join(userConfig, entry.name), toHome, relative)) {
				inherited.push(relative);
			}
		}
	} catch {
		// No app config directory is a normal fresh-install state.
	}

	// Other CLIs' credential stores, which jcode reads directly and which
	// `JCODE_HOME` redirects to `$JCODE_HOME/external/`. Share only the exact
	// credential files, resolved against the user's original home — the
	// ambient environment, which this module never mutates.
	for (const relative of EXTERNAL_CREDENTIAL_FILES) {
		const source = path.join(userHome, relative);
		if (linkCredentialFile(source, toHome, path.join("external", relative))) {
			inherited.push(`external/${relative}`);
		}
	}

	// OpenClaw's current store is per-agent; link only the credential
	// filenames its loader recognizes.
	try {
		const openclawAgents = path.join(userHome, ".openclaw", "agents");
		for (const agent of fs.readdirSync(openclawAgents, { withFileTypes: true })) {
			if (!agent.isDirectory()) continue;
			for (const name of ["auth-profiles.json", "auth.json"]) {
				const relative = path.join(".openclaw", "agents", agent.name, "agent", name);
				if (linkCredentialFile(path.join(userHome, relative), toHome, path.join("external", relative))) {
					inherited.push(`external/${relative}`);
				}
			}
		}
	} catch {
		// OpenClaw is optional.
	}
	return inherited;
}

/**
 * Render one of jcode's global CLI flags, failing closed on a blank value.
 * A blank profile or model would reach jcode and surface as a confusing
 * runtime failure instead of a launch-time error.
 */
function globalFlagArgs(flag: string, value: string | undefined): string[] {
	if (value === undefined) return [];
	if (value.trim() === "") {
		throw new HarnessLaunchError("invalid_launch_option", `${flag} must be a non-empty value`);
	}
	return [flag, value];
}

/**
 * Child environment: caller env layered over the ambient one, then the four
 * private jcode paths last so neither the ambient environment (which may hold
 * shared default pointers) nor caller env can repoint the instance.
 */
function instanceEnv(
	jcodeHome: string,
	runtimeDir: string,
	socketPath: string,
	extra: Record<string, string>,
): NodeJS.ProcessEnv {
	const inherited: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Never leak ambient jcode pointers (default home, shared socket, build
		// channel selectors) into a private instance.
		if (key.startsWith("JCODE_")) continue;
		inherited[key] = value;
	}
	return {
		...inherited,
		...extra,
		JCODE_HOME: jcodeHome,
		JCODE_RUNTIME_DIR: runtimeDir,
		JCODE_API_SOCKET: socketPath,
		JCODE_SOCKET: path.join(runtimeDir, "jcode.sock"),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once a Unix socket at `socketPath` accepts a connection. */
async function tryConnect(socketPath: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = new net.Socket();
	let settled = false;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(250, () => finish(false));
	try {
		socket.connect({ path: socketPath });
	} catch {
		finish(false);
	}
	return promise;
}

/**
 * Delete an ephemeral instance home. Refuses to follow symlinks out of it
 * (credential inheritance links files, never directories, but cleanup treats
 * an injected directory link as hostile) and only ever touches homes this
 * module created under the platform temp root.
 */
function removeEphemeralHome(home: string): void {
	const resolved = path.resolve(home);
	if (
		path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
		!path.basename(resolved).startsWith(EPHEMERAL_PREFIX)
	) {
		return;
	}
	const walk = (target: string): void => {
		let stats;
		try {
			stats = fs.lstatSync(target);
		} catch {
			return;
		}
		// lstat, not stat: a symlink is unlinked, never descended into.
		if (stats.isSymbolicLink()) {
			fs.unlinkSync(target);
			return;
		}
		if (stats.isDirectory()) {
			for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
			fs.rmdirSync(target);
			return;
		}
		fs.unlinkSync(target);
	};
	try {
		walk(resolved);
	} catch {
		// ponytail: a leaked temp directory is cheaper than a close() that never
		// returns; upgrade path is a settle-window retry loop like the SDK's.
	}
}

function readDaemonPid(jcodeHome: string, runtimeDir: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(jcodeHome, "servers.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const daemonSocket = path.join(runtimeDir, "jcode.sock");
	for (const entry of Object.values(parsed)) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		if (!("socket" in entry) || !("pid" in entry)) continue;
		const socket = entry.socket;
		const pid = entry.pid;
		if (socket === daemonSocket && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) return pid;
	}
	return undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDaemonPid(jcodeHome: string, runtimeDir: string): Promise<number | undefined> {
	const deadline = Date.now() + 2000;
	do {
		const pid = readDaemonPid(jcodeHome, runtimeDir);
		if (pid !== undefined) return pid;
		await sleep(50);
	} while (Date.now() < deadline);
	return undefined;
}

async function stopInstanceDaemon(jcodeHome: string, runtimeDir: string): Promise<void> {
	const pid = await waitForDaemonPid(jcodeHome, runtimeDir);
	if (pid === undefined) return;
	const signal = (name: NodeJS.Signals): void => {
		try {
			process.kill(-pid, name);
		} catch {
			try {
				process.kill(pid, name);
			} catch {}
		}
	};
	signal("SIGTERM");
	const grace = Date.now() + 2000;
	while (Date.now() < grace) {
		if (!processExists(pid)) return;
		await sleep(50);
	}
	signal("SIGKILL");
	const hard = Date.now() + 5000;
	while (Date.now() < hard) {
		if (!processExists(pid)) return;
		await sleep(50);
	}
}

/** Terminate the launched bridge process after its private daemon is gone. */
async function stopBridge(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
	child.once("exit", resolveExit);
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
	}, 3000);
	timer.unref?.();
	await Promise.race([exited, sleep(3100)]);
	clearTimeout(timer);
}

/**
 * Start a private `jcode api-bridge` and return once its API socket accepts
 * connections.
 */
export async function launchHarness(options: HarnessLaunchOptions): Promise<LaunchedHarness> {
	// Validate before any spawn so a blank route never starts a process.
	const providerArgs = globalFlagArgs("--provider", options.provider);
	const profileArgs = globalFlagArgs("--provider-profile", options.providerProfile);
	const modelArgs = globalFlagArgs("--model", options.model);

	const ephemeral = options.jcodeHome === undefined;
	const jcodeHome = options.jcodeHome ?? fs.mkdtempSync(path.join(os.tmpdir(), EPHEMERAL_PREFIX));
	fs.mkdirSync(jcodeHome, { recursive: true, mode: 0o700 });
	const runtimeDir = path.join(jcodeHome, RUNTIME_DIRNAME);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const socketPath = path.join(runtimeDir, API_SOCKET_NAME);

	// Inherit the user's logins before spawning, resolved from the ambient
	// environment — the private `JCODE_HOME` above is child-only.
	if (options.inheritLogins !== false) {
		inheritCredentials(process.env.JCODE_HOME ?? path.join(os.homedir(), ".jcode"), jcodeHome);
	}

	// A stale socket from a previous run on a persistent home would make the
	// connect probe succeed against a dead listener.
	for (const stale of [API_SOCKET_NAME, "jcode.sock", "jcode-debug.sock"]) {
		try {
			fs.unlinkSync(path.join(runtimeDir, stale));
		} catch {
			// Absent, the normal case.
		}
	}

	const child = spawn(
		options.binary,
		[...providerArgs, ...profileArgs, ...modelArgs, "api-bridge", "--api-socket", socketPath],
		{
			cwd: options.workingDir ?? process.cwd(),
			env: instanceEnv(jcodeHome, runtimeDir, socketPath, options.env ?? {}),
			stdio: ["ignore", "ignore", "pipe"],
			detached: false,
		},
	);

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});

	let exited: { code: number | null; signal: string | null } | undefined;
	child.once("exit", (code, signal) => {
		exited = { code, signal };
	});

	// A spawn failure (ENOENT) emits "error" on the child; Node treats an
	// unlistened one as a fatal process-level throw, so capture it explicitly.
	let spawnError: NodeJS.ErrnoException | undefined;
	child.once("error", (error: NodeJS.ErrnoException) => {
		spawnError = error;
		exited = { code: null, signal: null };
	});

	const reapOnExit = (): void => {
		try {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		} catch {}
		const pid = readDaemonPid(jcodeHome, runtimeDir);
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		if (ephemeral) removeEphemeralHome(jcodeHome);
	};
	process.once("exit", reapOnExit);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		process.removeListener("exit", reapOnExit);
		if (spawnError === undefined) await stopInstanceDaemon(jcodeHome, runtimeDir);
		await stopBridge(child);
		if (ephemeral) {
			const deadline = Date.now() + (options.cleanupTimeoutMs ?? 30_000);
			while (Date.now() < deadline) {
				removeEphemeralHome(jcodeHome);
				await sleep(250);
				if (fs.existsSync(jcodeHome)) continue;
				await sleep(750);
				if (!fs.existsSync(jcodeHome)) return;
			}
			if (fs.existsSync(jcodeHome)) {
				process.emitWarning(`harness ephemeral home could not be removed: ${jcodeHome}`);
			}
		}
	};

	const fail = async (error: HarnessLaunchError): Promise<never> => {
		await close();
		throw error;
	};

	const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		if (spawnError !== undefined) {
			return fail(
				new HarnessLaunchError(
					"startup_failed",
					`could not run \`${options.binary}\`: ${spawnError.message}`,
				),
			);
		}
		if (exited !== undefined) {
			return fail(
				new HarnessLaunchError(
					"startup_failed",
					`jcode api-bridge exited during startup (code ${exited.code}, signal ${exited.signal})` +
						(stderr ? `:\n${stderr.trim()}` : ""),
				),
			);
		}
		// Readiness means the socket accepts connections, not merely that its
		// path exists (the daemon binds late; the file can appear first).
		if (await tryConnect(socketPath)) {
			return { socketPath, jcodeHome, process: child, close };
		}
		await sleep(50);
	}
	return fail(
		new HarnessLaunchError(
			"startup_timeout",
			`jcode api-bridge did not accept connections at ${socketPath} within the startup timeout` +
				(stderr ? `:\n${stderr.trim()}` : ""),
		),
	);
}
