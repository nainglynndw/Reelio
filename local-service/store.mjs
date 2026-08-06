import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatabasePath, initializeDatabase, localWorkspaceOwnerId, readWorkspaceState, writeWorkspaceState } from "./database.mjs";

const emptyState = {
  version: 2,
  jobs: [],
  automations: [],
  calendarEntries: [],
  toolJobs: [],
  toolInputs: [],
  conversationDrafts: [],
  conversationAssets: [],
  brandKit: null,
  brandKits: {},
};
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
  initializeDatabase(root);
  const databaseState = readWorkspaceState();
  if (databaseState) {
    state = databaseState;
  } else try {
    state = await readState(statePath);
    writeWorkspaceState(state);
  } catch (primaryError) {
    try {
      state = await readState(backupPath);
      preserveBackupOnNextPersist = true;
      writeWorkspaceState(state);
    } catch (backupError) {
      if (primaryError?.code !== "ENOENT" || backupError?.code !== "ENOENT") {
        throw new Error("Reelio state is unreadable. Restore state.json or state.backup.json before starting.");
      }
      state = structuredClone(emptyState);
      writeWorkspaceState(state);
    }
  }
  validateState(state);
  state.toolJobs ??= [];
  state.toolInputs ??= [];
  state.conversationDrafts ??= [];
  state.conversationAssets ??= [];
  state.calendarEntries ??= [];
  state.brandKit ??= null;
  state.brandKits ??= {};
  state.version = Math.max(2, Number(state.version ?? 1));
  const legacyOwnerUserId = localWorkspaceOwnerId();
  if (legacyOwnerUserId) {
    for (const collection of [state.jobs, state.toolJobs, state.toolInputs, state.conversationDrafts, state.conversationAssets, state.automations]) {
      for (const resource of collection) resource.ownerUserId ??= legacyOwnerUserId;
    }
    if (state.brandKit) {
      state.brandKit.ownerUserId ??= legacyOwnerUserId;
      state.brandKits[legacyOwnerUserId] ??= structuredClone(state.brandKit);
    }
  }
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
  const recoveredToolJobIds = [];
  for (const job of state.toolJobs) {
    if (job.state === "running" || job.state === "queued") {
      job.state = "queued";
      job.stage = "recovery";
      job.message = "Recovered after local worker restart";
      job.error = null;
      job.updatedAt = new Date().toISOString();
      recoveredToolJobIds.push(job.id);
    }
  }
  for (const entry of state.calendarEntries) {
    if (entry.briefState === "generating") {
      entry.briefState = "pending";
      entry.error = null;
      entry.updatedAt = new Date().toISOString();
    }
  }
  await persist();
  return { recoveredJobIds, recoveredToolJobIds, root, databasePath: getDatabasePath() };
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

export function listToolJobs() {
  return [...state.toolJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getToolJob(id) {
  return state.toolJobs.find((job) => job.id === id) ?? null;
}

export async function addToolJob(job) {
  state.toolJobs.push(job);
  await persist();
  return job;
}

export async function patchToolJob(id, patch) {
  const job = getToolJob(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return job;
}

export async function removeToolJob(id) {
  const index = state.toolJobs.findIndex((job) => job.id === id);
  if (index < 0) return null;
  const [removed] = state.toolJobs.splice(index, 1);
  await persist({ mirrorBackup: true });
  return removed;
}

export function listToolInputs() {
  return [...state.toolInputs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getToolInput(id) {
  return state.toolInputs.find((input) => input.id === id) ?? null;
}

export async function addToolInput(input) {
  state.toolInputs.push(input);
  await persist();
  return input;
}

export function listConversationDrafts() {
  return [...state.conversationDrafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getConversationDraft(id) {
  return state.conversationDrafts.find((draft) => draft.id === id) ?? null;
}

export async function addConversationDraft(draft) {
  state.conversationDrafts.push(draft);
  await persist();
  return draft;
}

export async function patchConversationDraft(id, patch) {
  const draft = getConversationDraft(id);
  if (!draft) return null;
  Object.assign(draft, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return draft;
}

export async function removeConversationDraft(id) {
  const index = state.conversationDrafts.findIndex((draft) => draft.id === id);
  if (index < 0) return null;
  const [removed] = state.conversationDrafts.splice(index, 1);
  await persist({ mirrorBackup: true });
  return removed;
}

export function listConversationAssets() {
  return [...state.conversationAssets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getConversationAsset(id) {
  return state.conversationAssets.find((asset) => asset.id === id) ?? null;
}

export async function addConversationAsset(asset) {
  state.conversationAssets.push(asset);
  await persist();
  return asset;
}

export async function removeConversationAsset(id) {
  const index = state.conversationAssets.findIndex((asset) => asset.id === id);
  if (index < 0) return null;
  const [removed] = state.conversationAssets.splice(index, 1);
  await persist({ mirrorBackup: true });
  return removed;
}

export function getBrandKit(ownerUserId = localWorkspaceOwnerId()) {
  const brandKit = ownerUserId ? state.brandKits?.[ownerUserId] : null;
  return brandKit ? structuredClone(brandKit) : null;
}

export async function setBrandKit(brandKit, ownerUserId = localWorkspaceOwnerId()) {
  if (!ownerUserId) throw new Error("A user is required to save a Brand Kit.");
  state.brandKits ??= {};
  state.brandKits[ownerUserId] = brandKit ? structuredClone({ ...brandKit, ownerUserId }) : null;
  if (ownerUserId === localWorkspaceOwnerId()) state.brandKit = state.brandKits[ownerUserId];
  await persist();
  return getBrandKit(ownerUserId);
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

export async function removeAutomation(id) {
  const index = state.automations.findIndex((automation) => automation.id === id);
  if (index < 0) return null;
  const [removed] = state.automations.splice(index, 1);
  await persist({ mirrorBackup: true });
  return removed;
}

export function listCalendarEntries() {
  return [...state.calendarEntries].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

export function getCalendarEntry(id) {
  return state.calendarEntries.find((entry) => entry.id === id) ?? null;
}

export async function replaceAutomationCalendarEntries(automationId, entries) {
  state.calendarEntries = state.calendarEntries.filter((entry) => entry.automationId !== automationId);
  state.calendarEntries.push(...entries);
  await persist();
  return entries;
}

export async function patchCalendarEntry(id, patch) {
  const entry = getCalendarEntry(id);
  if (!entry) return null;
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return entry;
}

export async function removeAutomationCalendarEntries(automationId) {
  const removed = state.calendarEntries.filter((entry) => entry.automationId === automationId);
  if (!removed.length) return [];
  state.calendarEntries = state.calendarEntries.filter((entry) => entry.automationId !== automationId);
  await persist({ mirrorBackup: true });
  return removed;
}

async function persist({ mirrorBackup = false } = {}) {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  const preserveBackup = preserveBackupOnNextPersist;
  preserveBackupOnNextPersist = false;
  persistQueue = persistQueue.then(async () => {
    await mkdir(root, { recursive: true });
    writeWorkspaceState(JSON.parse(snapshot));
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
  if (!value || typeof value !== "object" || !Array.isArray(value.jobs) || !Array.isArray(value.automations)
    || (value.calendarEntries != null && !Array.isArray(value.calendarEntries))
    || (value.toolJobs != null && !Array.isArray(value.toolJobs)) || (value.toolInputs != null && !Array.isArray(value.toolInputs))
    || (value.conversationDrafts != null && !Array.isArray(value.conversationDrafts))
    || (value.conversationAssets != null && !Array.isArray(value.conversationAssets))
    || (value.brandKit != null && (typeof value.brandKit !== "object" || Array.isArray(value.brandKit)))
    || (value.brandKits != null && (typeof value.brandKits !== "object" || Array.isArray(value.brandKits)))) {
    throw new Error("Reelio state file has an invalid shape.");
  }
}
