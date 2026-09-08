import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DAEMON_BUILD_ID, verifyDaemonBrokerVersion } from "./broker-version";
import { parseDaemonRpcResult } from "./protocol";

for (const [label, buildId] of [["matching", DAEMON_BUILD_ID], ["mismatched", "other-build"], ["legacy", undefined], ["malformed", 42]] as const) {
	test(`broker handshake ${label}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-version-"));
		const endpoint = path.join(root, "broker.sock");
		const operations: string[] = [];
		const sockets = new Set<net.Socket>();
		const server = net.createServer(socket => {
			sockets.add(socket);
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				operations.push(request.operation.op);
				socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { projectDir: root, buildId } })}\n`);
			});
		});
		await new Promise<void>(resolve => server.listen(endpoint, resolve));
		const client = net.createConnection({ path: endpoint });
		try {
			await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
			const negotiation = verifyDaemonBrokerVersion(client, "private-test-token", root);
			if (label === "matching") await negotiation;
			else await expect(negotiation).rejects.toThrow("Stale daemon broker build");
			expect(operations).toEqual(["ping"]);
			console.log(`${label}: ${label === "matching" ? "accepted" : "refused"}; operations=ping; shutdown=0`);
		} finally {
			client.destroy();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

test("ping decoding preserves optional version compatibility", () => {
	expect(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/project" })).toEqual({ op: "ping", projectDir: "/project", buildId: undefined });
	expect(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/project", buildId: DAEMON_BUILD_ID })).toEqual({ op: "ping", projectDir: "/project", buildId: DAEMON_BUILD_ID });
	expect(() => parseDaemonRpcResult({ op: "ping" }, { projectDir: "/project", buildId: 42 })).toThrow("result.buildId");
});
