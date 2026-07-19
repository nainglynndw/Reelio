import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("serializes state writes and recovers from the backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelio-store-"));
  const previousRoot = process.env.REELIO_DATA_DIR;
  process.env.REELIO_DATA_DIR = root;
  try {
    const store = await import(`../local-service/store.mjs?test=${Date.now()}`);
    await store.initializeStore();
    const createdAt = new Date().toISOString();
    await store.addJob({ id: "job-1", state: "queued", stage: "idea", progress: 0, request: {}, createdAt, updatedAt: createdAt });
    await Promise.all(Array.from({ length: 20 }, (_, progress) => store.patchJob("job-1", { progress })));
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    assert.equal(state.jobs.length, 1);
    assert.equal(typeof state.jobs[0].progress, "number");

    await writeFile(path.join(root, "state.json"), "not-json", "utf8");
    const recovered = await store.initializeStore();
    assert.ok(Array.isArray(recovered.recoveredJobIds));
    assert.equal(store.listJobs().length, 1);
    const backup = JSON.parse(await readFile(path.join(root, "state.backup.json"), "utf8"));
    assert.equal(backup.jobs.length, 1);

    const removed = await store.removeJob("job-1");
    assert.equal(removed.id, "job-1");
    assert.equal(store.listJobs().length, 0);
    const deletedState = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    const deletedBackup = JSON.parse(await readFile(path.join(root, "state.backup.json"), "utf8"));
    assert.equal(deletedState.jobs.length, 0);
    assert.equal(deletedBackup.jobs.length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.REELIO_DATA_DIR;
    else process.env.REELIO_DATA_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
