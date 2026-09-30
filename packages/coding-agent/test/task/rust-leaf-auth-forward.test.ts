import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { buildLeafChildEnv, driveRustLeaf } from "@oh-my-pi/pi-coding-agent/task/rust-leaf-driver";
import type { AgentDefinition, LeafSelection } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskEffort } from "@oh-my-pi/pi-coding-agent/thinking";

describe("leaf proxy credential forwarding", () => {
	it("absent credential keeps inherit while present forwards", () => {
		expect(buildLeafChildEnv(undefined)).toBeUndefined();
		const env = buildLeafChildEnv("probe-key");
		expect(env?.["PI_TRACK_API_KEY"]).toBe("probe-key");
	});

	it("blank credential never forwards while non-blank does", () => {
		expect(buildLeafChildEnv("")).toBeUndefined();
		expect(buildLeafChildEnv("   ")).toBeUndefined();
		expect(buildLeafChildEnv("probe-key")?.["PI_TRACK_API_KEY"]).toBe("probe-key");
	});

	it("forwarding copies inherit without mutating the host", () => {
		const before = process.env["PI_TRACK_API_KEY"];
		const env = buildLeafChildEnv("probe-key");
		expect(env?.["PI_TRACK_API_KEY"]).toBe("probe-key");
		expect(env?.["PATH"]).toBe(process.env["PATH"]);
		expect(process.env["PI_TRACK_API_KEY"]).toBe(before);
	});
});

const DUMMY_BEARER = "dummy-bearer-test-123";
const NATIVE_ID = "xai.grok-4.6";
const ROUTE_PATTERN = "xai/xai.grok-4.6";

const ALL_OFF_SELECTION: LeafSelection = {
	system: { enabled: false, name: "default", shared: [] },
	role: { enabled: false, name: "probe-role", shared: [] },
	subrole: { enabled: false, name: "probe-subrole", shared: [] },
};

function xaiStubModel(): Model {
	return {
		provider: "xai",
		id: NATIVE_ID,
		api: "openai-responses",
		reasoning: true,
		thinking: { efforts: ["low", "medium", "high", "xhigh"] },
	} as unknown as Model;
}

function stubRegistry(apiKey: string | undefined): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => [xaiStubModel()],
		getApiKey: async () => apiKey,
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

function leafAgent(endpoint: string, binaryPath?: string): AgentDefinition {
	return {
		name: "rust-leaf-auth-probe",
		description: "leaf auth probe",
		systemPrompt: "Probe.",
		source: "project",
		leaf: {
			runtime: "rust",
			endpoint,
			...(binaryPath === undefined ? {} : { binaryPath }),
			selection: ALL_OFF_SELECTION,
		},
	};
}

const STUB_LEAF_LINES = [
	"#!/bin/sh",
	"printf '%s\\n' \"$@\" > \"$LEAF_STUB_ARGV\"",
	"if [ -n \"${PI_TRACK_API_KEY:-}\" ]; then",
	"printf '%s' \"$PI_TRACK_API_KEY\" > \"$LEAF_STUB_ENV\"",
	"else",
	"printf '__ABSENT__' > \"$LEAF_STUB_ENV\"",
	"fi",
	"if [ -n \"${PI_TRACK_API_KEY:-}\" ]; then",
	"code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $PI_TRACK_API_KEY\" \"$LEAF_STUB_URL\")",
	"else",
	"code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \"$LEAF_STUB_URL\")",
	"fi",
	"if [ \"$code\" = \"200\" ]; then",
	"printf '{\"type\":\"event\",\"seq\":2,\"event\":{\"kind\":{\"AssistantDelta\":\"leaf-ok\"}}}\\n'",
	"printf '{\"type\":\"terminal\",\"version\":1,\"turn_id\":1,\"terminal\":\"Answer\",\"final_seq\":2}\\n' >&2",
	"else",
	"printf '{\"type\":\"terminal\",\"version\":1,\"turn_id\":1,\"terminal\":\"Error\",\"final_seq\":0,\"error\":\"proxy returned http %s (controlled)\"}\\n' \"$code\" >&2",
	"fi",
	"while IFS= read -r line; do",
	"case \"$line\" in",
	"*shutdown*) break ;;",
	"esac",
	"done",
	"exit 0",
];

function setStubEnv(values: Record<string, string>): () => void {
	const prev: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		prev[key] = process.env[key];
		process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(prev)) {
			const value = prev[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

interface StubSpawn {
	dir: string;
	stub: string;
	argvFile: string;
	envFile: string;
	restoreEnv: () => void;
	url: string;
	seen: Array<string | null>;
	server: { port: number | undefined; stop: () => void };
}

function setupStubSpawn(): StubSpawn {
	const dir = mkdtempSync(join(tmpdir(), "rust-leaf-auth-"));
	const stub = join(dir, "stub-leaf.sh");
	const argvFile = join(dir, "argv.txt");
	const envFile = join(dir, "env.txt");
	writeFileSync(stub, `${STUB_LEAF_LINES.join("\n")}\n`);
	chmodSync(stub, 0o755);
	const seen: Array<string | null> = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const auth = req.headers.get("authorization");
			seen.push(auth);
			if (auth === `Bearer ${DUMMY_BEARER}`) return new Response("ok", { status: 200 });
			return new Response("controlled-401: missing or wrong bearer", { status: 401 });
		},
	});
	const url = `http://127.0.0.1:${server.port}/proxy`;
	const restoreEnv = setStubEnv({ LEAF_STUB_ARGV: argvFile, LEAF_STUB_ENV: envFile, LEAF_STUB_URL: url });
	return { dir, stub, argvFile, envFile, restoreEnv, url, seen, server };
}

function teardownStubSpawn(spawn: StubSpawn): void {
	spawn.server.stop();
	spawn.restoreEnv();
	rmSync(spawn.dir, { recursive: true, force: true });
}

function wireModel(argvFile: string): string {
	const lines = readFileSync(argvFile, "utf8").split("\n");
	const flag = lines.indexOf("--model");
	if (flag === -1) throw new Error("stub argv missing --model flag");
	return (lines[flag + 1] ?? "").trim();
}

function driveStubSpawn(
	spawn: StubSpawn,
	opts: { id: string; modelOverride?: string; effort?: TaskEffort; apiKey: string | undefined },
) {
	return runSubprocess({
		cwd: spawn.dir,
		agent: leafAgent(spawn.url, spawn.stub),
		task: "Probe task.",
		index: 0,
		id: opts.id,
		settings: Settings.isolated(),
		modelRegistry: stubRegistry(opts.apiKey),
		...(opts.modelOverride === undefined ? {} : { modelOverride: opts.modelOverride }),
		...(opts.effort === undefined ? {} : { effort: opts.effort }),
		enableLsp: false,
	});
}

async function leafReject(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`non-Error leaf rejection: ${String(error)}`);
	}
	throw new Error("expected leaf rejection but the run settled");
}

function resetLeafRegistries(): void {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
}

describe("leaf auth forward over loopback", () => {
	beforeEach(() => {
		resetLeafRegistries();
	});

	afterEach(() => {
		resetLeafRegistries();
	});

	it.skipIf(process.platform === "win32")("driver: present credential forwards the exact bearer and wires native --model bytes", async () => {
		const spawn = setupStubSpawn();
		try {
			const outcome = await driveRustLeaf({
				index: 0,
				id: "leaf-auth-driver-1",
				agentName: "rust-leaf-auth-probe",
				agentSource: "project",
				task: "Probe task.",
				cwd: spawn.dir,
				leaf: { runtime: "rust", endpoint: spawn.url, binaryPath: spawn.stub, selection: ALL_OFF_SELECTION },
				modelOverride: ROUTE_PATTERN,
				modelProvenance: { api: "openai-responses", provider: "xai", model: NATIVE_ID },
				proxyCredential: DUMMY_BEARER,
			});
			expect(outcome.exitCode).toBe(0);
			expect(outcome.output).toBe("leaf-ok");
			expect(outcome.error).toBeUndefined();
			expect(spawn.seen).toEqual([`Bearer ${DUMMY_BEARER}`]);
			expect(readFileSync(spawn.envFile, "utf8")).toBe(DUMMY_BEARER);
			expect(wireModel(spawn.argvFile)).toBe(NATIVE_ID);
			expect(readFileSync(spawn.argvFile, "utf8")).not.toContain(ROUTE_PATTERN);
		} finally {
			teardownStubSpawn(spawn);
		}
	});

	it.skipIf(process.platform === "win32")("runSubprocess: registry credential forwards end to end with native --model bytes", async () => {
		const spawn = setupStubSpawn();
		try {
			const result = await driveStubSpawn(spawn, {
				id: "leaf-auth-e2e-1",
				modelOverride: ROUTE_PATTERN,
				apiKey: DUMMY_BEARER,
			});
			expect(result.exitCode).toBe(0);
			expect(spawn.seen).toEqual([`Bearer ${DUMMY_BEARER}`]);
			expect(readFileSync(spawn.envFile, "utf8")).toBe(DUMMY_BEARER);
			expect(wireModel(spawn.argvFile)).toBe(NATIVE_ID);
			expect(readFileSync(spawn.argvFile, "utf8")).not.toContain(ROUTE_PATTERN);
		} finally {
			teardownStubSpawn(spawn);
		}
	});

	it.skipIf(process.platform === "win32")("runSubprocess: absent credential keeps inherit, no bearer, controlled 401 failure", async () => {
		const spawn = setupStubSpawn();
		try {
			const result = await driveStubSpawn(spawn, {
				id: "leaf-auth-absent-1",
				modelOverride: ROUTE_PATTERN,
				apiKey: undefined,
			});
			expect(spawn.seen).toEqual([null]);
			expect(readFileSync(spawn.envFile, "utf8")).toBe("__ABSENT__");
			expect(result.exitCode).toBe(1);
			expect(result.error ?? "").toContain("401");
			expect(result.error ?? "").toContain("controlled");
		} finally {
			teardownStubSpawn(spawn);
		}
	});

	it.skipIf(process.platform === "win32")("runSubprocess: blank credential keeps inherit, no bearer, controlled 401 failure", async () => {
		const spawn = setupStubSpawn();
		try {
			const result = await driveStubSpawn(spawn, {
				id: "leaf-auth-blank-1",
				modelOverride: ROUTE_PATTERN,
				apiKey: "",
			});
			expect(spawn.seen).toEqual([null]);
			expect(readFileSync(spawn.envFile, "utf8")).toBe("__ABSENT__");
			expect(result.exitCode).toBe(1);
			expect(result.error ?? "").toContain("401");
			expect(result.error ?? "").toContain("controlled");
		} finally {
			teardownStubSpawn(spawn);
		}
	});
});

describe("leaf model gate rejects", () => {
	beforeEach(() => {
		resetLeafRegistries();
	});

	afterEach(() => {
		resetLeafRegistries();
	});

	it("unknown selector rejects with the exact unresolved-route message", async () => {
		const error = await leafReject(
			runSubprocess({
				cwd: "/tmp",
				agent: leafAgent("http://127.0.0.1:9/unused"),
				task: "Probe task.",
				index: 0,
				id: "leaf-auth-unknown-1",
				settings: Settings.isolated(),
				modelRegistry: stubRegistry(DUMMY_BEARER),
				modelOverride: "nope/missing-model",
				enableLsp: false,
			}),
		);
		expect(error.message).toBe(
			"Rust leaf requested but model 'nope/missing-model' resolves to no registered model " +
				"(modelOverride or agent model must match the session registry; " +
				"refusing to send an unresolved route string, leaf usage exits 2)",
		);
	});

	it.skipIf(process.platform === "win32")("resolvable route string still reaches stub spawn (gate does not always throw)", async () => {
		const spawn = setupStubSpawn();
		try {
			await driveStubSpawn(spawn, {
				id: "leaf-auth-resolvable-1",
				modelOverride: ROUTE_PATTERN,
				apiKey: DUMMY_BEARER,
			});
			expect(wireModel(spawn.argvFile)).toBe(NATIVE_ID);
			expect(spawn.seen.length).toBe(1);
		} finally {
			teardownStubSpawn(spawn);
		}
	});

	it("explicit :level suffix rejects with the exact effort-unsupported literal", async () => {
		const error = await leafReject(
			runSubprocess({
				cwd: "/tmp",
				agent: leafAgent("http://127.0.0.1:9/unused"),
				task: "Probe task.",
				index: 0,
				id: "leaf-auth-effort-1",
				settings: Settings.isolated(),
				modelRegistry: stubRegistry(DUMMY_BEARER),
				modelOverride: `${NATIVE_ID}:low`,
				enableLsp: false,
			}),
		);
		expect(error.message).toBe(
			"rust-leaf-effort-unsupported: requested low (explicit :level suffix) for " +
				"xai/xai.grok-4.6; Rust leaf has no effort transport",
		);
	});

	it("caller effort rejects with the task-effort source named", async () => {
		const error = await leafReject(
			runSubprocess({
				cwd: "/tmp",
				agent: leafAgent("http://127.0.0.1:9/unused"),
				task: "Probe task.",
				index: 0,
				id: "leaf-auth-effort-2",
				settings: Settings.isolated(),
				modelRegistry: stubRegistry(DUMMY_BEARER),
				modelOverride: NATIVE_ID,
				effort: "lo",
				enableLsp: false,
			}),
		);
		expect(error.message).toBe(
			"rust-leaf-effort-unsupported: requested low (task effort) for " +
				"xai/xai.grok-4.6; Rust leaf has no effort transport",
		);
	});

	it.skipIf(process.platform === "win32")("same model without suffix or effort reaches stub spawn (gate does not always throw)", async () => {
		const spawn = setupStubSpawn();
		try {
			await driveStubSpawn(spawn, {
				id: "leaf-auth-noeffort-1",
				modelOverride: NATIVE_ID,
				apiKey: DUMMY_BEARER,
			});
			expect(wireModel(spawn.argvFile)).toBe(NATIVE_ID);
			expect(spawn.seen.length).toBe(1);
		} finally {
			teardownStubSpawn(spawn);
		}
	});
});
