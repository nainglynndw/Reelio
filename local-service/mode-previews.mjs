import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getJob, getRoot, getToolJob } from "./store.mjs";

export const MODE_PREVIEW_IDS = ["prompt-video", "long-video-shorts", "message-conversation", "sports-highlights", "documentary-recap"];

export async function readModePreviewManifest() {
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyManifest();
    throw new Error("The Create Video preview manifest is unreadable.");
  }
  const modes = {};
  const inputs = {};
  for (const modeId of MODE_PREVIEW_IDS) {
    modes[modeId] = (Array.isArray(value?.modes?.[modeId]) ? value.modes[modeId] : [])
      .slice(0, modeId === "long-video-shorts" ? 4 : 1)
      .map((item, index) => normalizeEntry(item, modeId, index));
    inputs[modeId] = normalizeInput(value?.inputs?.[modeId]);
  }
  return {
    version: 1,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
    concept: cleanText(value?.concept, 140),
    inputs,
    modes,
  };
}

export async function writeModePreviewManifest(value) {
  const modes = {};
  const inputs = {};
  for (const modeId of MODE_PREVIEW_IDS) {
    modes[modeId] = (Array.isArray(value?.modes?.[modeId]) ? value.modes[modeId] : [])
      .slice(0, modeId === "long-video-shorts" ? 4 : 1)
      .map((item, index) => normalizeEntry(item, modeId, index));
    inputs[modeId] = normalizeInput(value?.inputs?.[modeId]);
  }
  if (modes["prompt-video"].length && modes["prompt-video"].length !== 1) throw new Error("Prompt to Video requires exactly one showcase video.");
  if (modes["message-conversation"].length && modes["message-conversation"].length !== 1) throw new Error("Message Conversation requires exactly one showcase video.");
  if (modes["long-video-shorts"].length && (modes["long-video-shorts"].length < 3 || modes["long-video-shorts"].length > 4)) throw new Error("Long Video to Shorts requires three or four showcase videos.");
  for (const modeId of ["sports-highlights", "documentary-recap"]) {
    if (modes[modeId].length > 1) throw new Error(`${modeId} requires at most one showcase video.`);
  }
  for (const modeId of MODE_PREVIEW_IDS) {
    if (modes[modeId].length && !inputs[modeId]) throw new Error(`${modeId} requires a showcase input.`);
  }
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    concept: cleanText(value?.concept, 140),
    inputs,
    modes,
  };
  await writeFile(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return manifest;
}

export async function publicModePreviewManifest() {
  const manifest = await readModePreviewManifest();
  const modes = {};
  for (const modeId of MODE_PREVIEW_IDS) {
    const available = [];
    for (const entry of manifest.modes[modeId]) {
      const asset = await resolveModePreviewAsset(entry.slot).catch(() => null);
      if (!asset) continue;
      available.push({
        slot: entry.slot,
        label: entry.label,
        title: entry.title,
        url: `/mode-previews/assets/${encodeURIComponent(entry.slot)}`,
      });
    }
    modes[modeId] = available;
  }
  return { version: 1, updatedAt: manifest.updatedAt, concept: manifest.concept, inputs: manifest.inputs, modes };
}

export async function assignModePreviewShowcase(modeId, ownerId) {
  if (!MODE_PREVIEW_IDS.includes(modeId)) throw new Error("Choose a valid Create Video mode.");
  const manifest = await readModePreviewManifest();
  if (modeId === "prompt-video") {
    const job = getJob(cleanId(ownerId));
    if (!job || job.state !== "completed" || !job.assets?.final) throw new Error("Choose a completed video with a final MP4.");
    await access(job.assets.final.file);
    manifest.inputs[modeId] = {
      kind: "prompt",
      label: "Prompt",
      value: cleanText(job.request?.prompt, 700),
      url: "",
    };
    manifest.modes[modeId] = [{
      slot: "prompt-video-output",
      kind: "job",
      jobId: job.id,
      assetKey: "final",
      label: "Generated video",
      title: cleanText(job.metadata?.title ?? job.request?.prompt, 90),
    }];
  } else if (modeId === "long-video-shorts") {
    const job = getToolJob(cleanId(ownerId));
    if (!job || job.state !== "completed" || job.request?.toolId !== "long-video-render") {
      throw new Error("Choose a completed Long Video to Shorts render.");
    }
    const clips = Array.isArray(job.metadata?.clips) ? job.metadata.clips : [];
    const entries = Object.entries(job.assets ?? {})
      .filter(([key, asset]) => /^short\d+$/.test(key) && asset?.type === "video")
      .slice(0, 4)
      .map(([assetKey, asset], index) => {
        const clip = clips.find((item) => item?.assetKey === assetKey) ?? clips[index];
        return {
          slot: `long-video-short-${index + 1}`,
          kind: "toolJob",
          jobId: job.id,
          assetKey,
          label: `Short ${String(index + 1).padStart(2, "0")}`,
          title: cleanText(clip?.title ?? asset?.name, 90),
        };
      });
    if (entries.length < 3) throw new Error("A Long Video showcase needs at least three completed shorts.");
    for (const entry of entries) await access(job.assets[entry.assetKey].file);
    const sourceJob = getToolJob(job.request?.inputs?.media?.toolJobId);
    const sourceUrl = safeHttpsUrl(sourceJob?.request?.options?.url);
    manifest.inputs[modeId] = {
      kind: sourceUrl ? "url" : "upload",
      label: sourceUrl ? "Source URL" : "Long video",
      value: sourceUrl || "Uploaded long video",
      url: sourceUrl,
    };
    manifest.modes[modeId] = entries;
  } else if (modeId === "message-conversation") {
    const job = getJob(cleanId(ownerId));
    if (!job || job.state !== "completed" || job.request?.creationMode !== "message-conversation" || !job.assets?.final) {
      throw new Error("Choose a completed Message Conversation video.");
    }
    await access(job.assets.final.file);
    manifest.inputs[modeId] = {
      kind: "prompt",
      label: "Conversation script",
      value: cleanText(job.request?.conversation?.events?.map((event) => event.text).filter(Boolean).slice(0, 3).join(" · ") || job.request?.prompt, 700),
      url: "",
    };
    manifest.modes[modeId] = [{
      slot: "message-conversation-output",
      kind: "job",
      jobId: job.id,
      assetKey: "final",
      label: "Animated conversation",
      title: cleanText(job.metadata?.title ?? job.request?.prompt, 90),
    }];
  } else {
    throw new Error("This planned mode cannot receive a showcase yet.");
  }
  await writeModePreviewManifest(manifest);
  return publicModePreviewManifest();
}

export async function resolveModePreviewAsset(slot) {
  if (!/^[a-z0-9-]{3,64}$/.test(String(slot ?? ""))) return null;
  const manifest = await readModePreviewManifest();
  const entry = Object.values(manifest.modes).flat().find((item) => item.slot === slot);
  if (!entry) return null;
  const owner = entry.kind === "toolJob" ? getToolJob(entry.jobId) : getJob(entry.jobId);
  const asset = owner?.assets?.[entry.assetKey];
  if (!asset?.file) return null;
  await access(asset.file);
  return asset;
}

function normalizeEntry(value, modeId, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Preview ${index + 1} for ${modeId} is invalid.`);
  const kind = value.kind === "toolJob" ? "toolJob" : value.kind === "job" ? "job" : null;
  const jobId = cleanId(value.jobId);
  const assetKey = cleanId(value.assetKey);
  if (!kind || !jobId || !assetKey) throw new Error(`Preview ${index + 1} for ${modeId} has an invalid asset reference.`);
  return {
    slot: cleanSlot(value.slot, `${modeId}-${index + 1}`),
    kind,
    jobId,
    assetKey,
    label: cleanText(value.label, 40) || `Output ${index + 1}`,
    title: cleanText(value.title, 90),
  };
}

function normalizeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = ["prompt", "url", "upload"].includes(value.kind) ? value.kind : null;
  const label = cleanText(value.label, 40);
  const inputValue = cleanText(value.value, kind === "url" ? 2_000 : 700);
  const url = kind === "url" ? safeHttpsUrl(value.url || inputValue) : "";
  if (!kind || !label || !inputValue || (kind === "url" && !url)) return null;
  return { kind, label, value: inputValue, url };
}

function manifestPath() {
  return path.join(getRoot(), "mode-previews.json");
}

function emptyManifest() {
  return {
    version: 1,
    updatedAt: null,
    concept: "",
    inputs: Object.fromEntries(MODE_PREVIEW_IDS.map((id) => [id, null])),
    modes: Object.fromEntries(MODE_PREVIEW_IDS.map((id) => [id, []])),
  };
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(text) ? text : "";
}

function cleanSlot(value, fallback) {
  const text = String(value ?? fallback).trim().toLowerCase();
  return /^[a-z0-9-]{3,64}$/.test(text) ? text : fallback;
}

function cleanText(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}
