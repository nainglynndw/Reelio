import path from "node:path";
import { NARRATORS } from "./narrators.mjs";

export const BRAND_ASSET_KINDS = Object.freeze(["logo", "intro", "outro", "music"]);
export const BRAND_FONTS = Object.freeze(["Arial", "Arial Black", "Helvetica", "Verdana", "Trebuchet MS", "Georgia"]);
export const CAPTION_STYLES = Object.freeze(["bold", "classic", "minimal", "kinetic"]);
export const LOGO_POSITIONS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);

const assetRules = Object.freeze({
  logo: {
    label: "Logo",
    extensions: new Set([".png", ".jpg", ".jpeg", ".webp"]),
    mediaPrefixes: ["image/"],
    maximumBytes: 20 * 1024 * 1024,
  },
  intro: {
    label: "Intro video",
    extensions: new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]),
    mediaPrefixes: ["video/"],
    maximumBytes: 1024 * 1024 * 1024,
  },
  outro: {
    label: "Outro video",
    extensions: new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]),
    mediaPrefixes: ["video/"],
    maximumBytes: 1024 * 1024 * 1024,
  },
  music: {
    label: "Music",
    extensions: new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"]),
    mediaPrefixes: ["audio/"],
    maximumBytes: 200 * 1024 * 1024,
  },
});

export function defaultBrandKit(now = new Date().toISOString()) {
  return {
    version: 1,
    enabled: false,
    name: "My Brand",
    primaryColor: "#6f4bf3",
    accentColor: "#18a7b8",
    fontFamily: "Arial",
    captionStyle: "bold",
    logoPosition: "top-right",
    logoOpacity: 0.88,
    brandVoice: "Clear, warm, credible, and concise. Explain ideas without hype.",
    ctaText: "",
    socialHandle: "",
    website: "",
    defaultNarratorId: "maya",
    assets: { logo: null, intro: null, outro: null, music: null },
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeStoredBrandKit(value) {
  const defaults = defaultBrandKit(value?.createdAt);
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const assets = {};
  for (const kind of BRAND_ASSET_KINDS) assets[kind] = normalizeStoredAsset(value.assets?.[kind], kind);
  return {
    ...defaults,
    version: 1,
    enabled: value.enabled !== false,
    name: clean(value.name, defaults.name, 80),
    primaryColor: color(value.primaryColor, defaults.primaryColor),
    accentColor: color(value.accentColor, defaults.accentColor),
    fontFamily: BRAND_FONTS.includes(value.fontFamily) ? value.fontFamily : defaults.fontFamily,
    captionStyle: CAPTION_STYLES.includes(value.captionStyle) ? value.captionStyle : defaults.captionStyle,
    logoPosition: LOGO_POSITIONS.includes(value.logoPosition) ? value.logoPosition : defaults.logoPosition,
    logoOpacity: bounded(value.logoOpacity, 0.25, 1, defaults.logoOpacity),
    brandVoice: clean(value.brandVoice, defaults.brandVoice, 500),
    ctaText: clean(value.ctaText, "", 180, true),
    socialHandle: clean(value.socialHandle, "", 80, true),
    website: cleanWebsite(value.website),
    defaultNarratorId: NARRATORS.some((narrator) => narrator.id === value.defaultNarratorId) ? value.defaultNarratorId : defaults.defaultNarratorId,
    assets,
    createdAt: validDate(value.createdAt) ?? defaults.createdAt,
    updatedAt: validDate(value.updatedAt) ?? defaults.updatedAt,
  };
}

export function updateBrandKit(current, patch, now = new Date().toISOString()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new BrandKitError("Brand Kit settings must be an object.");
  const known = new Set(["enabled", "name", "primaryColor", "accentColor", "fontFamily", "captionStyle", "logoPosition", "logoOpacity", "brandVoice", "ctaText", "socialHandle", "website", "defaultNarratorId"]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new BrandKitError(`Unknown Brand Kit setting: ${key}.`);
  }
  for (const key of ["primaryColor", "accentColor"]) {
    if (Object.hasOwn(patch, key) && !/^#[0-9a-f]{6}$/i.test(String(patch[key] ?? ""))) throw new BrandKitError(`${key === "primaryColor" ? "Primary" : "Accent"} color must use six-digit hex format.`);
  }
  if (Object.hasOwn(patch, "fontFamily") && !BRAND_FONTS.includes(patch.fontFamily)) throw new BrandKitError("Choose a supported Brand Kit font.");
  if (Object.hasOwn(patch, "captionStyle") && !CAPTION_STYLES.includes(patch.captionStyle)) throw new BrandKitError("Choose a supported caption style.");
  if (Object.hasOwn(patch, "logoPosition") && !LOGO_POSITIONS.includes(patch.logoPosition)) throw new BrandKitError("Choose a supported logo position.");
  if (Object.hasOwn(patch, "logoOpacity") && (!Number.isFinite(Number(patch.logoOpacity)) || Number(patch.logoOpacity) < 0.25 || Number(patch.logoOpacity) > 1)) throw new BrandKitError("Logo opacity must be between 25% and 100%.");
  if (Object.hasOwn(patch, "defaultNarratorId") && !NARRATORS.some((narrator) => narrator.id === patch.defaultNarratorId)) throw new BrandKitError("Choose a supported default narrator.");
  const next = normalizeStoredBrandKit({ ...normalizeStoredBrandKit(current), ...patch, assets: normalizeStoredBrandKit(current).assets, updatedAt: now });
  if (Object.hasOwn(patch, "website") && String(patch.website ?? "").trim() && !next.website) throw new BrandKitError("Website must be a valid http:// or https:// address.");
  if (Object.hasOwn(patch, "name") && !String(patch.name ?? "").trim()) throw new BrandKitError("Brand name is required.");
  return next;
}

export function withBrandAsset(current, kind, asset, now = new Date().toISOString()) {
  assertBrandAssetKind(kind);
  const kit = normalizeStoredBrandKit(current);
  return { ...kit, assets: { ...kit.assets, [kind]: normalizeStoredAsset(asset, kind) }, updatedAt: now };
}

export function clearBrandAsset(current, kind, now = new Date().toISOString()) {
  assertBrandAssetKind(kind);
  const kit = normalizeStoredBrandKit(current);
  return { ...kit, assets: { ...kit.assets, [kind]: null }, updatedAt: now };
}

export function validateBrandAssetUpload(kind, { name, bytes, mediaType }) {
  assertBrandAssetKind(kind);
  const rule = assetRules[kind];
  const extension = path.extname(String(name ?? "")).toLowerCase();
  const type = String(mediaType ?? "").toLowerCase();
  const extensionAccepted = rule.extensions.has(extension);
  const mediaAccepted = rule.mediaPrefixes.some((prefix) => type.startsWith(prefix));
  if ((extension && !extensionAccepted) || (!extension && !mediaAccepted)) {
    throw new BrandKitError(`${rule.label} has an unsupported file type.`);
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new BrandKitError(`Choose a non-empty ${rule.label.toLowerCase()} file.`);
  if (bytes > rule.maximumBytes) throw new BrandKitError(`${rule.label} exceeds the ${Math.round(rule.maximumBytes / 1024 / 1024)} MB local limit.`, 413);
  return rule;
}

export function validateProbedBrandAsset(kind, probe) {
  assertBrandAssetKind(kind);
  if (kind === "logo") {
    if (!probe.video || probe.video.width < 32 || probe.video.height < 32) throw new BrandKitError("Logo must be a readable image at least 32×32 pixels.");
    return;
  }
  if (kind === "music") {
    if (!probe.audio || !Number.isFinite(probe.duration) || probe.duration < 1) throw new BrandKitError("Music must contain at least one second of readable audio.");
    if (probe.duration > 3600) throw new BrandKitError("Music must be one hour or shorter.");
    return;
  }
  if (!probe.video || !Number.isFinite(probe.duration) || probe.duration < 0.25) throw new BrandKitError(`${kind === "intro" ? "Intro" : "Outro"} must contain readable video.`);
  if (probe.duration > 15) throw new BrandKitError(`${kind === "intro" ? "Intro" : "Outro"} must be 15 seconds or shorter.`);
}

export function publicBrandKit(value) {
  const kit = normalizeStoredBrandKit(value);
  return {
    ...kit,
    assets: Object.fromEntries(BRAND_ASSET_KINDS.map((kind) => {
      const asset = kit.assets[kind];
      return [kind, asset ? {
        id: asset.id,
        kind,
        name: asset.name,
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        durationSeconds: asset.durationSeconds,
        width: asset.width,
        height: asset.height,
        createdAt: asset.createdAt,
        url: `/brand-kit/assets/${kind}`,
      } : null];
    })),
  };
}

export function snapshotBrandKit(value) {
  const kit = normalizeStoredBrandKit(value);
  return structuredClone(kit);
}

export function sanitizeBrandKitSnapshot(value) {
  if (!value) return null;
  return publicBrandKit(value);
}

export function brandAssetRule(kind) {
  assertBrandAssetKind(kind);
  return assetRules[kind];
}

export function assertBrandAssetKind(kind) {
  if (!BRAND_ASSET_KINDS.includes(kind)) throw new BrandKitError("Choose a supported Brand Kit asset.", 404);
}

function normalizeStoredAsset(value, kind) {
  if (!value || typeof value !== "object" || typeof value.file !== "string" || typeof value.id !== "string") return null;
  return {
    id: value.id,
    kind,
    file: value.file,
    name: clean(value.name, `${kind}.bin`, 180),
    bytes: Number.isSafeInteger(value.bytes) && value.bytes > 0 ? value.bytes : 0,
    mediaType: clean(value.mediaType, "application/octet-stream", 120),
    durationSeconds: Number.isFinite(value.durationSeconds) ? Number(value.durationSeconds.toFixed(3)) : undefined,
    width: Number.isInteger(value.width) ? value.width : undefined,
    height: Number.isInteger(value.height) ? value.height : undefined,
    createdAt: validDate(value.createdAt) ?? new Date().toISOString(),
  };
}

function clean(value, fallback, maximum, allowEmpty = false) {
  const result = String(value ?? fallback).trim().replace(/[\u0000-\u001F\u007F]/g, " ");
  if (!result && !allowEmpty) return fallback;
  return result.slice(0, maximum);
}

function color(value, fallback) {
  const result = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(result) ? result.toLowerCase() : fallback;
}

function bounded(value, minimum, maximum, fallback) {
  const result = Number(value);
  return Number.isFinite(result) && result >= minimum && result <= maximum ? result : fallback;
}

function cleanWebsite(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.toString().slice(0, 240) : "";
  } catch {
    return "";
  }
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export class BrandKitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BrandKitError";
    this.status = status;
  }
}
