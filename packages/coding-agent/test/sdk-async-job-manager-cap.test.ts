import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

test("async.maxJobs above 100 controls SDK manager admission", async () => {
	const sdkSource = fs.readFileSync(path.join(import.meta.dir, "../src/sdk.ts"), "utf8");
	expect(sdkSource).not.toMatch(/Math\.min\(\s*100\s*,\s*Math\.max\(1,\s*settings\.get\("async\.maxJobs"\)/);

	const manager = new AsyncJobManager({ maxRunningJobs: 150 });
	const release = Promise.withResolvers<string>();
	try {
		for (let i = 0; i < 150; i++) {
			manager.register("bash", `job ${i + 1}`, async () => release.promise);
		}
		expect(manager.getRunningJobs()).toHaveLength(150);
		expect(() => manager.register("bash", "job 151", async () => release.promise)).toThrow(
			/Background job limit reached \(150\)/,
		);
		const queuedId = manager.register("bash", "queued job", async () => release.promise, { queued: true });
		expect(manager.getJob(queuedId)?.queued).toBe(true);
		expect(manager.getRunningJobs()).toHaveLength(151);
	} finally {
		release.resolve("done");
		await manager.waitForAll();
		await manager.dispose();
	}
});
