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
    await store.addToolInput({ id: "input-1", file: "/tmp/input.mp4", name: "input.mp4", bytes: 100, mediaType: "video/mp4", createdAt });
    await store.addToolJob({ id: "tool-1", state: "running", stage: "processing", progress: 30, request: { toolId: "chop", inputs: {} }, createdAt, updatedAt: createdAt });
    await store.addAutomation({ id: "automation-1", name: "Weekday video", enabled: true, cron: "30 8 * * 1-5", timezone: "Asia/Bangkok", template: {}, createdAt, updatedAt: createdAt });
    await store.replaceAutomationCalendarEntries("automation-1", [
      { id: "calendar-1", automationId: "automation-1", date: "2026-07-24", time: "08:30", briefState: "generating", state: "planned", createdAt, updatedAt: createdAt },
      { id: "calendar-2", automationId: "automation-1", date: "2026-07-24", time: "18:30", briefState: "ready", state: "planned", createdAt, updatedAt: createdAt },
    ]);
    await Promise.all(Array.from({ length: 20 }, (_, progress) => store.patchJob("job-1", { progress })));
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    assert.equal(state.jobs.length, 1);
    assert.equal(state.toolJobs.length, 1);
    assert.equal(state.toolInputs.length, 1);
    assert.equal(state.automations.length, 1);
    assert.equal(state.calendarEntries.length, 2);
    assert.equal(typeof state.jobs[0].progress, "number");

    await writeFile(path.join(root, "state.json"), "not-json", "utf8");
    const recovered = await store.initializeStore();
    assert.ok(Array.isArray(recovered.recoveredJobIds));
    assert.deepEqual(recovered.recoveredToolJobIds, ["tool-1"]);
    assert.equal(store.listJobs().length, 1);
    assert.equal(store.getToolJob("tool-1").state, "queued");
    assert.equal(store.getToolInput("input-1").name, "input.mp4");
    assert.equal(store.getCalendarEntry("calendar-1").briefState, "pending");
    await store.patchCalendarEntry("calendar-2", { state: "queued", jobId: "job-2" });
    assert.equal(store.getCalendarEntry("calendar-2").jobId, "job-2");
    const backup = JSON.parse(await readFile(path.join(root, "state.backup.json"), "utf8"));
    assert.equal(backup.jobs.length, 1);

    const removed = await store.removeJob("job-1");
    assert.equal(removed.id, "job-1");
    assert.equal(store.listJobs().length, 0);
    const deletedState = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    const deletedBackup = JSON.parse(await readFile(path.join(root, "state.backup.json"), "utf8"));
    assert.equal(deletedState.jobs.length, 0);
    assert.equal(deletedBackup.jobs.length, 0);
    const removedTool = await store.removeToolJob("tool-1");
    assert.equal(removedTool.id, "tool-1");
    assert.equal(store.listToolJobs().length, 0);
    const removedAutomation = await store.removeAutomation("automation-1");
    assert.equal(removedAutomation.id, "automation-1");
    assert.equal(store.listAutomations().length, 0);
    const removedCalendar = await store.removeAutomationCalendarEntries("automation-1");
    assert.equal(removedCalendar.length, 2);
    assert.equal(store.listCalendarEntries().length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.REELIO_DATA_DIR;
    else process.env.REELIO_DATA_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
