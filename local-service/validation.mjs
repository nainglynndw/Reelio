import { DEFAULT_SCRIPT_STYLE, SCRIPT_STYLES } from "./script-styles.mjs";
import { DEFAULT_NARRATOR_ID, NARRATORS } from "./narrators.mjs";

const platformIds = new Set(["youtube", "tiktok", "facebook", "instagram"]);
const speechLanguages = new Set([
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Malay", "Norwegian",
  "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Tagalog", "Thai", "Turkish", "Vietnamese",
]);
const geminiSpeechLanguages = new Set([...speechLanguages].filter((language) => !["Khmer", "Tagalog"].includes(language)));
const ttsEngines = new Set(["kokoro", "gemini", "voxcpm2"]);
const scriptStyleIds = new Set(SCRIPT_STYLES.map((style) => style.id));
const narratorIds = new Set(NARRATORS.map((narrator) => narrator.id));

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

export function normalizeVideoRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Request body must be an object.");
  const prompt = cleanText(value.prompt, "Video idea", 3, 700);
  const category = cleanText(value.category ?? "Knowledge", "Category", 1, 80);
  const duration = cleanText(value.duration ?? "60–90 sec", "Duration", 1, 32);
  durationBounds(duration);
  const language = cleanText(value.language ?? "English", "Speech language", 2, 40);
  if (!speechLanguages.has(language)) throw new ValidationError(`Unsupported speech language: ${language}.`);
  const ttsEngine = String(value.ttsEngine ?? defaultTtsEngine(language)).toLowerCase().trim();
  if (!ttsEngines.has(ttsEngine)) throw new ValidationError(`Unsupported TTS engine: ${ttsEngine}.`);
  if (language === "English" && !["kokoro", "gemini"].includes(ttsEngine)) throw new ValidationError("English speech supports Kokoro or Gemini TTS.");
  if (language !== "English" && !["voxcpm2", "gemini"].includes(ttsEngine)) throw new ValidationError("Non-English speech supports VoxCPM2 or Gemini TTS.");
  if (ttsEngine === "gemini" && !geminiSpeechLanguages.has(language)) throw new ValidationError(`${language} speech is not supported by Gemini TTS; choose VoxCPM2.`);
  const subtitleLanguage = cleanText(value.subtitleLanguage ?? "English", "Subtitle language", 2, 40);
  const scriptStyle = String(value.scriptStyle ?? DEFAULT_SCRIPT_STYLE).trim();
  if (!scriptStyleIds.has(scriptStyle)) throw new ValidationError(`Unsupported script style: ${scriptStyle}.`);
  const narratorId = String(value.narratorId ?? DEFAULT_NARRATOR_ID).trim();
  if (!narratorIds.has(narratorId)) throw new ValidationError(`Unsupported narrator: ${narratorId}.`);
  const normalized = { prompt, category, duration, language, ttsEngine, subtitleLanguage, scriptStyle, narratorId, platforms: normalizePlatforms(value.platforms ?? []) };
  if (value.approvedScript != null && String(value.approvedScript).trim()) {
    normalized.approvedScript = cleanText(value.approvedScript, "Approved script", 20, 4_000);
  }
  if (value.visualThemes != null) normalized.visualThemes = normalizeVisualThemes(value.visualThemes);
  if (value.visualSelections != null) {
    if (!normalized.visualThemes) throw new ValidationError("Visual selections require a reviewed visual theme plan.");
    normalized.visualSelections = normalizeVisualSelections(value.visualSelections, normalized.visualThemes.length);
  }
  return normalized;
}

export function normalizeVoicePreviewRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Request body must be an object.");
  const rawText = cleanText(value.text, "Voice sample", 3, 240);
  const text = cleanText(rawText.replace(/\[(?:pause|beat|breath)\]/gi, " ").replace(/\s+/g, " "), "Voice sample", 3, 240);
  const language = normalizeSpeechLanguage(value.language ?? "English");
  validateVoicePreviewLanguageText(text, language);
  const ttsEngine = String(value.ttsEngine ?? defaultTtsEngine(language)).toLowerCase().trim();
  if (!ttsEngines.has(ttsEngine)) throw new ValidationError(`Unsupported TTS engine: ${ttsEngine}.`);
  if (language === "English" && !["kokoro", "gemini"].includes(ttsEngine)) throw new ValidationError("English speech supports Kokoro or Gemini TTS.");
  if (language !== "English" && !["voxcpm2", "gemini"].includes(ttsEngine)) throw new ValidationError("Non-English speech supports VoxCPM2 or Gemini TTS.");
  if (ttsEngine === "gemini" && !geminiSpeechLanguages.has(language)) throw new ValidationError(`${language} speech is not supported by Gemini TTS; choose VoxCPM2.`);
  const narratorId = String(value.narratorId ?? DEFAULT_NARRATOR_ID).trim();
  if (!narratorIds.has(narratorId)) throw new ValidationError(`Unsupported narrator: ${narratorId}.`);
  return { text, language, ttsEngine, narratorId };
}

export function normalizeSpeechLanguage(value, label = "Speech language") {
  const language = cleanText(value, label, 2, 40);
  if (!speechLanguages.has(language)) throw new ValidationError(`Unsupported speech language: ${language}.`);
  return language;
}

export function validateVoicePreviewLanguageText(text, language) {
  const normalized = String(language ?? "").trim().toLowerCase();
  if (normalized !== "burmese" && normalized !== "myanmar") return;
  const letters = [...String(text ?? "")].filter((character) => /\p{L}/u.test(character));
  const myanmarLetters = letters.filter((character) => /\p{Script=Myanmar}/u.test(character));
  if (letters.length < 3 || myanmarLetters.length !== letters.length) {
    throw new ValidationError("A Burmese voice sample must be written entirely in Myanmar script.");
  }
}

export function normalizeVisualThemes(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new ValidationError("Visual themes must contain between 2 and 8 themes.");
  }
  const normalized = value.map((theme, index) => {
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) throw new ValidationError(`Visual theme ${index + 1} must be an object.`);
    const title = cleanText(theme.title, `Visual theme ${index + 1} title`, 2, 80);
    const startSegment = Number(theme.startSegment);
    const endSegment = Number(theme.endSegment);
    if (!Number.isInteger(startSegment) || !Number.isInteger(endSegment) || startSegment < 0 || endSegment < startSegment || endSegment > 199) {
      throw new ValidationError(`Visual theme ${index + 1} has an invalid script range.`);
    }
    if (!Array.isArray(theme.queries) || theme.queries.length < 1 || theme.queries.length > 2) {
      throw new ValidationError(`Visual theme ${index + 1} must have 1 or 2 stock searches.`);
    }
    const queries = [...new Set(theme.queries.map((query, queryIndex) => cleanText(query, `Visual theme ${index + 1} search ${queryIndex + 1}`, 2, 90)))];
    return { title, startSegment, endSegment, queries };
  }).sort((a, b) => a.startSegment - b.startSegment);
  if (normalized[0].startSegment !== 0) throw new ValidationError("Visual themes must begin with the first script segment.");
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startSegment !== normalized[index - 1].endSegment + 1) {
      throw new ValidationError("Visual theme script ranges must be contiguous.");
    }
  }
  return normalized;
}

export function normalizeVisualSelections(value, themeCount) {
  if (!Array.isArray(value) || value.length !== themeCount) {
    throw new ValidationError("Choose one visual option for every theme.");
  }
  const seen = new Set();
  const normalized = value.map((selection, index) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new ValidationError(`Visual selection ${index + 1} must be an object.`);
    const themeIndex = Number(selection.themeIndex);
    if (!Number.isInteger(themeIndex) || themeIndex < 0 || themeIndex >= themeCount || seen.has(themeIndex)) {
      throw new ValidationError("Visual selections must reference every theme exactly once.");
    }
    seen.add(themeIndex);
    const mode = String(selection.mode ?? "").trim().toLowerCase();
    if (mode === "motion") return { themeIndex, mode };
    if (mode === "custom") {
      const uploadId = String(selection.uploadId ?? "").trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
        throw new ValidationError(`Visual selection ${index + 1} has an invalid custom video reference.`);
      }
      const fileName = cleanText(selection.fileName, `Visual selection ${index + 1} filename`, 1, 180);
      return { themeIndex, mode, uploadId, fileName };
    }
    if (mode !== "media") throw new ValidationError(`Visual selection ${index + 1} must use stock media, a custom video, or a motion background.`);
    const provider = String(selection.provider ?? "pexels").trim().toLowerCase();
    if (!["pexels", "pixabay"].includes(provider)) throw new ValidationError(`Visual selection ${index + 1} has an unsupported stock provider.`);
    const mediaId = String(selection.mediaId ?? "").trim();
    if (provider === "pexels" && !/^[vp]\d{1,20}$/.test(mediaId)) throw new ValidationError(`Visual selection ${index + 1} has an invalid Pexels media ID.`);
    if (provider === "pixabay" && !/^pixabay-[vi]\d{1,20}$/.test(mediaId)) throw new ValidationError(`Visual selection ${index + 1} has an invalid Pixabay media ID.`);
    const mediaType = String(selection.mediaType ?? "").trim().toLowerCase();
    if (!["video", "image"].includes(mediaType)) throw new ValidationError(`Visual selection ${index + 1} has an invalid media type.`);
    const mediaUrl = provider === "pexels"
      ? cleanStockUrl(selection.mediaUrl, `Visual selection ${index + 1} media URL`, "Pexels", ["videos.pexels.com", "images.pexels.com"])
      : cleanStockUrl(selection.mediaUrl, `Visual selection ${index + 1} media URL`, "Pixabay", ["cdn.pixabay.com", "pixabay.com", "www.pixabay.com"]);
    const sourceUrl = provider === "pexels"
      ? cleanStockUrl(selection.sourceUrl, `Visual selection ${index + 1} source URL`, "Pexels", ["pexels.com", "www.pexels.com"])
      : cleanStockUrl(selection.sourceUrl, `Visual selection ${index + 1} source URL`, "Pixabay", ["pixabay.com", "www.pixabay.com"]);
    const creator = cleanText(selection.creator, `Visual selection ${index + 1} creator`, 1, 120);
    const query = cleanText(selection.query, `Visual selection ${index + 1} search`, 2, 90);
    return { themeIndex, mode, provider, mediaId, mediaType, mediaUrl, sourceUrl, creator, query };
  });
  return normalized.sort((a, b) => a.themeIndex - b.themeIndex);
}

function cleanStockUrl(value, label, provider, allowedHosts) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ValidationError(`${label} must be a valid ${provider} URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new ValidationError(`${label} must use an approved ${provider} host.`);
  }
  return url.href;
}

export function defaultTtsEngine(language) {
  return String(language).toLowerCase() === "english" ? "kokoro" : "voxcpm2";
}

export function normalizePlatforms(value) {
  if (!Array.isArray(value)) throw new ValidationError("Platforms must be an array.");
  const normalized = [...new Set(value.map((item) => String(item).toLowerCase().trim()).filter(Boolean))];
  const unsupported = normalized.filter((item) => !platformIds.has(item));
  if (unsupported.length) throw new ValidationError(`Unsupported platform: ${unsupported.join(", ")}.`);
  return normalized;
}

export function durationBounds(value) {
  const normalized = String(value ?? "60–90 sec").toLowerCase().replaceAll("–", "-").trim();
  const upToMinutes = normalized.match(/^up\s+to\s+(\d{1,2})\s*(?:min|mins|minute|minutes)$/);
  if (upToMinutes) return clampBounds(60, Number(upToMinutes[1]) * 60);

  const range = normalized.match(/^(\d{1,3})\s*-\s*(\d{1,3})\s*(sec|secs|second|seconds|min|mins|minute|minutes)?$/);
  if (range) {
    const multiplier = range[3]?.startsWith("min") ? 60 : 1;
    return clampBounds(Number(range[1]) * multiplier, Number(range[2]) * multiplier);
  }

  const single = normalized.match(/^(\d{1,3})\s*(sec|secs|second|seconds|min|mins|minute|minutes)$/);
  if (single) {
    const seconds = Number(single[1]) * (single[2].startsWith("min") ? 60 : 1);
    return clampBounds(seconds, seconds);
  }
  throw new ValidationError("Duration must look like “60 sec”, “60–90 sec”, or “up to 3 min”.");
}

export function validateTimezone(value) {
  const timezone = cleanText(value ?? "Asia/Bangkok", "Timezone", 1, 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new ValidationError("Timezone must be a valid IANA timezone, such as Asia/Bangkok.");
  }
}

export function cleanText(value, label, min, max) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const clean = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (clean.length < min) throw new ValidationError(`${label} must be at least ${min} characters.`);
  if (clean.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return clean;
}

function clampBounds(first, second) {
  const min = Math.min(first, second);
  const max = Math.max(first, second);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 6 || max > 180) {
    throw new ValidationError("Video duration must be between 6 seconds and 3 minutes.");
  }
  return { min, max };
}
