const platformIds = new Set(["youtube", "tiktok", "facebook", "instagram"]);
const speechLanguages = new Set([
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Malay", "Norwegian",
  "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Tagalog", "Thai", "Turkish", "Vietnamese",
]);
const geminiSpeechLanguages = new Set([...speechLanguages].filter((language) => !["Khmer", "Tagalog"].includes(language)));
const ttsEngines = new Set(["kokoro", "gemini", "voxcpm2"]);

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
  const normalized = { prompt, category, duration, language, ttsEngine, subtitleLanguage, platforms: normalizePlatforms(value.platforms ?? []) };
  if (value.approvedScript != null && String(value.approvedScript).trim()) {
    normalized.approvedScript = cleanText(value.approvedScript, "Approved script", 20, 4_000);
  }
  return normalized;
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
