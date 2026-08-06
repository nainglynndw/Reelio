import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import { registerJobProcess } from "./job-control.mjs";

export const DEFAULT_GEMINI_STT_MODEL = "gemini-3.5-flash-lite";

const root = () => path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "stt");
const languageCodes = {
  Arabic: "ar",
  Burmese: "my",
  Chinese: "zh",
  Danish: "da",
  Dutch: "nl",
  English: "en",
  Finnish: "fi",
  French: "fr",
  German: "de",
  Greek: "el",
  Hebrew: "he",
  Hindi: "hi",
  Indonesian: "id",
  Italian: "it",
  Japanese: "ja",
  Khmer: "km",
  Korean: "ko",
  Lao: "lo",
  Malay: "ms",
  Norwegian: "no",
  Polish: "pl",
  Portuguese: "pt",
  Russian: "ru",
  Spanish: "es",
  Swahili: "sw",
  Swedish: "sv",
  Tagalog: "tl",
  Thai: "th",
  Turkish: "tr",
  Vietnamese: "vi",
};

export function sttConfig() {
  const base = root();
  const requestedProvider = String(process.env.REELIO_STT_PROVIDER || "gemini").trim().toLowerCase();
  const provider = ["local", "faster-whisper", "whisper"].includes(requestedProvider) ? "faster-whisper" : "gemini";
  return {
    provider,
    geminiModel: process.env.GEMINI_STT_MODEL || DEFAULT_GEMINI_STT_MODEL,
    geminiTimeoutMs: Number(process.env.GEMINI_STT_TIMEOUT_MS || 1_800_000),
    python: path.resolve(process.env.STT_PYTHON || path.join(base, "venv", "bin", "python3")),
    model: process.env.STT_MODEL || "small",
    modelDir: path.resolve(process.env.STT_MODEL_DIR || path.join(base, "models")),
    device: process.env.STT_DEVICE || "auto",
    computeType: process.env.STT_COMPUTE_TYPE || "default",
  };
}

export async function getSttHealth() {
  const config = sttConfig();
  if (config.provider === "gemini") {
    const ready = Boolean(geminiApiKey());
    return {
      ready,
      provider: "gemini",
      model: config.geminiModel,
      device: "Gemini API",
      error: ready ? null : "Add a Gemini API key in Settings for cloud transcription.",
    };
  }
  try {
    await access(config.python);
    return { ready: true, provider: "faster-whisper", model: config.model, device: config.device, error: null };
  } catch {
    return { ready: false, provider: "faster-whisper", model: config.model, device: config.device, error: "Local transcription is not installed. Run npm run stt:setup." };
  }
}

export async function transcribeMedia({ input, outputDir, language = "auto" }) {
  const config = sttConfig();
  const health = await getSttHealth();
  if (!health.ready) throw new Error(health.error);
  await mkdir(outputDir, { recursive: true });
  if (config.provider === "gemini") return transcribeWithGemini({ input, outputDir, language, config });
  return transcribeWithFasterWhisper({ input, outputDir, language, config });
}

async function transcribeWithGemini({ input, outputDir, language, config }) {
  const normalizedAudio = path.join(outputDir, "gemini-transcription-audio.mp3");
  await runProcess(ffmpegPath, [
    "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", normalizedAudio,
  ], Number(process.env.REELIO_PROCESS_TIMEOUT_MS || 900_000), "Audio preparation");

  const client = new GoogleGenAI({ apiKey: geminiApiKey() });
  let uploaded;
  try {
    uploaded = await withTimeout(client.files.upload({
      file: normalizedAudio,
      config: { mimeType: "audio/mpeg", displayName: "Reelio transcription audio" },
    }), config.geminiTimeoutMs, "Gemini transcription upload");
    uploaded = await waitForGeminiFile(client, uploaded, config.geminiTimeoutMs);
    if (!uploaded?.uri || !uploaded?.mimeType) throw new Error("Gemini did not return a usable audio reference.");

    const requestedLanguage = sttLanguageCode(language);
    const response = await withTimeout(client.models.generateContent({
      model: config.geminiModel,
      contents: [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
          { text: transcriptionPrompt(requestedLanguage) },
        ],
      }],
      config: {
        maxOutputTokens: 65_536,
        responseMimeType: "application/json",
        responseJsonSchema: transcriptSchema,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    }), config.geminiTimeoutMs, "Gemini transcription");
    const parsed = parseGeminiJson(response.text);
    return normalizeGeminiTranscript(parsed, requestedLanguage, {
      provider: "gemini",
      model: config.geminiModel,
    });
  } finally {
    await rm(normalizedAudio, { force: true });
    if (uploaded?.name) {
      try {
        await client.files.delete({ name: uploaded.name });
      } catch {
        // The uploaded audio expires automatically; local cleanup must still succeed.
      }
    }
  }
}

async function transcribeWithFasterWhisper({ input, outputDir, language, config }) {
  const output = path.join(outputDir, "transcription.json");
  const manifest = path.join(outputDir, "stt-manifest.json");
  await writeFile(manifest, JSON.stringify({
    input,
    output,
    model: config.model,
    modelDir: config.modelDir,
    device: config.device,
    computeType: config.computeType,
    language: sttLanguageCode(language),
  }), "utf8");
  await runProcess(config.python, [path.resolve("scripts/transcribe_audio.py"), manifest], Number(process.env.STT_TIMEOUT_MS || 1_800_000), "Transcription");
  const result = JSON.parse(await readFile(output, "utf8"));
  if (!Array.isArray(result.cues) || !result.cues.length) {
    throw new Error("No recognizable speech or vocals were found. Try Auto detect for the language, or use Extract captions from link if the source provides captions.");
  }
  return { ...result, provider: "faster-whisper", model: config.model };
}

export function normalizeGeminiTranscript(value, requestedLanguage = null, metadata = {}) {
  if (!value || typeof value !== "object" || !Array.isArray(value.cues)) throw new Error("Gemini returned an invalid transcript.");
  const cues = value.cues.map((cue, index) => {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    const text = String(cue?.text ?? "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) {
      throw new Error(`Gemini returned an invalid transcript cue at position ${index + 1}.`);
    }
    return { start, end, text };
  }).sort((a, b) => a.start - b.start);
  if (!cues.length) throw new Error("No recognizable speech was found. Try choosing the source language or use existing source captions.");
  const language = String(value.language || requestedLanguage || "unknown").trim().toLowerCase();
  return {
    cues,
    text: cues.map((cue) => cue.text).join(" "),
    language,
    languageProbability: null,
    fallbackWithoutVad: false,
    ...metadata,
  };
}

export function sttLanguageCode(language) {
  const value = String(language ?? "auto").trim();
  if (!value || value.toLowerCase() === "auto") return null;
  if (/^[a-z]{2,3}$/i.test(value)) return value.toLowerCase();
  const code = languageCodes[value];
  if (!code) throw new Error(`Unsupported transcription language: ${value}.`);
  return code;
}

function transcriptionPrompt(language) {
  const instruction = language
    ? `The spoken language is ${language}. Return that ISO 639 language code in "language".`
    : "Detect the primary spoken language and return its lowercase ISO 639-1 or ISO 639-3 code in \"language\".";
  return [
    "Transcribe all intelligible speech in this audio.",
    instruction,
    "Return chronological subtitle cues with start and end expressed as seconds from the beginning.",
    "Use short, readable cues, preserve names and numbers, and do not summarize, translate, censor, explain, or invent speech.",
    "Exclude non-speech descriptions and return only the requested JSON structure.",
  ].join(" ");
}

const transcriptSchema = {
  type: "object",
  required: ["language", "cues"],
  propertyOrdering: ["language", "cues"],
  properties: {
    language: { type: "string" },
    cues: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["start", "end", "text"],
        propertyOrdering: ["start", "end", "text"],
        properties: {
          start: { type: "number", minimum: 0 },
          end: { type: "number", minimum: 0 },
          text: { type: "string" },
        },
      },
    },
  },
};

async function waitForGeminiFile(client, file, timeoutMs) {
  const started = Date.now();
  let current = file;
  while (current?.state === "PROCESSING" || !current?.state) {
    if (Date.now() - started >= timeoutMs) throw new Error("Gemini audio processing timed out.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    current = await client.files.get({ name: current.name });
  }
  if (current.state === "FAILED") throw new Error(`Gemini could not process the audio${current.error?.message ? `: ${current.error.message}` : "."}`);
  return current;
}

function parseGeminiJson(value) {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) throw new Error("Gemini returned an empty transcript.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini returned transcript data that could not be read.");
  }
}

function runProcess(command, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error(`${label} exceeded the processing time limit.`));
      else reject(new Error(`${label} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1800)}`));
    });
  });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function geminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
}
