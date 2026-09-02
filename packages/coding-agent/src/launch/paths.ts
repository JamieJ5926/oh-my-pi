import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";

const BRIDGE_DIR = "bridge";

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/** Synchronous form for process-global bootstraps that cannot await before constructing singletons. */
export function canonicalProjectDirSync(projectDir: string): string {
	const resolved = path.resolve(projectDir);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

/** Read the project directory recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}

/** File-backed session directory shared by every process in one daemon scope. */
export function daemonBridgeDirectoryPath(runtimeDir: string): string {
	return path.join(runtimeDir, BRIDGE_DIR, "sessions.json");
}

/** Socket/pipe used by the daemon broker's embedded bridge transport server. */
export function daemonBridgeTransportEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-bridge-${key}`;
	}
	return path.join(runtimeDir, BRIDGE_DIR, "transport.sock");
}

/** Durable broker-side delivery journal for the embedded bridge transport server. */
export function daemonBridgeTransportBrokerJournalPath(runtimeDir: string): string {
	return path.join(runtimeDir, BRIDGE_DIR, "broker.jsonl");
}

/** Durable process-local delivery journal for a bridge transport client. */
export function daemonBridgeTransportClientJournalPath(runtimeDir: string, processId = process.pid): string {
	return path.join(runtimeDir, BRIDGE_DIR, `client-${processId}.jsonl`);
}
