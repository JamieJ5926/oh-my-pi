import type * as net from "node:net";
import { parseDaemonWireResponse } from "./protocol";

export const DAEMON_BUILD_ID = process.env.OMP_BUILD_ID ?? "dev";

export async function verifyDaemonBrokerVersion(socket: net.Socket, token: string, projectDir: string): Promise<void> {
	const id = crypto.randomUUID();
	await new Promise<void>((resolve, reject) => {
		let buffer = "";
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
			if (error) {
				socket.destroy();
				reject(error);
			} else resolve();
		};
		const onError = (error: Error): void => finish(error);
		const onClose = (): void => finish(new Error("Daemon broker closed during version negotiation"));
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			if (buffer.length > 65_536) return finish(new Error("Daemon broker version response exceeds size limit"));
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = parseDaemonWireResponse(JSON.parse(buffer.slice(0, newline)));
				if (response.id !== id) throw new Error("Daemon broker version response ID mismatch");
				if (!response.ok) throw new Error(response.error);
				const result = response.result;
				if (typeof result !== "object" || result === null || !("projectDir" in result) || result.projectDir !== projectDir) {
					throw new Error("Daemon broker version response project mismatch");
				}
				const actual = "buildId" in result ? result.buildId : undefined;
				if (typeof actual !== "string" || actual !== DAEMON_BUILD_ID) {
					throw new Error(`Stale daemon broker build ${typeof actual === "string" ? actual : "missing or malformed"}; expected ${DAEMON_BUILD_ID}. Stop broker-owned workloads and close all sessions using this project before restarting the broker. No shutdown was requested.`);
				}
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const timer = setTimeout(() => finish(new Error("Daemon broker version negotiation timed out")), 5_000);
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
		socket.write(`${JSON.stringify({ id, token, operation: { op: "ping" } })}\n`);
	});
}
