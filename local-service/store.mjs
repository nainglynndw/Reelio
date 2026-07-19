import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const emptyState = { jobs: [], automations: [] };
let state = structuredClone(emptyState);
let root;
let statePath;
let tempPath;
let backupPath;
let persistQueue = Promise.resolve();
let preserveBackupOnNextPersist = false;

export async function initializeStore() {
  root = path.resolve(process.env.REELIO_DATA_DIR || path.join(process.cwd(), ".reelio"));
  statePath = path.join(root, "state.json");
  tempPath = path.join(root, "state.tmp.json");
  backupPath = path.join(root, "state.backup.json");
  await mkdir(path.join(root, "generated"), { recursive: true });
  try {
    state = await readState(statePath);
  } catch (primaryError) {
    try {
      state = await readState(backupPath);
      preserveBackupOnNextPersist = true;
    } catch (backupError) {
      if (primaryError?.code !== "ENOENT" || backupError?.code !== "ENOENT") {
        throw new Error("Reelio state is unreadable. Restore state.json or state.backup.json before starting.");
      }
      state = structuredClone(emptyState);
    }
  }
  validateState(state);
  const recoveredJobIds = [];
  for (const job of state.jobs) {
    if (job.state === "running" || job.state === "queued") {
      job.state = "queued";
      job.stage = "recovery";
      job.message = "Recovered after local worker restart";
      job.error = null;
      job.updatedAt = new Date().toISOString();
      recoveredJobIds.push(job.id);
    }
  }
  await persist();
  return { recoveredJobIds, root };
}

export function getRoot() {
  return root;
}

export function listJobs() {
  return [...state.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id) {
  return state.jobs.find((job) => job.id === id) ?? null;
}

export async function addJob(job) {
  state.jobs.push(job);
  await persist();
  return job;
}

export async function patchJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return job;
}

export async function removeJob(id) {
  const index = state.jobs.findIndex((job) => job.id === id);
  if (index < 0) return null;
  const [removed] = state.jobs.splice(index, 1);
  await persist({ mirrorBackup: true });
  return removed;
}

export function listAutomations() {
  return [...state.automations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getAutomation(id) {
  return state.automations.find((automation) => automation.id === id) ?? null;
}

export async function addAutomation(automation) {
  state.automations.push(automation);
  await persist();
  return automation;
}

export async function patchAutomation(id, patch) {
  const automation = getAutomation(id);
  if (!automation) return null;
  Object.assign(automation, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return automation;
}

async function persist({ mirrorBackup = false } = {}) {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  const preserveBackup = preserveBackupOnNextPersist;
  preserveBackupOnNextPersist = false;
  persistQueue = persistQueue.then(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(tempPath, snapshot, "utf8");
    if (!preserveBackup) {
      await copyFile(statePath, backupPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await rename(tempPath, statePath);
    if (mirrorBackup) await writeFile(backupPath, snapshot, "utf8");
  });
  return persistQueue;
}

async function readState(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function validateState(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.jobs) || !Array.isArray(value.automations)) {
    throw new Error("Reelio state file has an invalid shape.");
  }
}
