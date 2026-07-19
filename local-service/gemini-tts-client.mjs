import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

export const GEMINI_TTS_LANGUAGES = [
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Korean", "Lao", "Malay", "Norwegian", "Polish",
  "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Thai", "Turkish", "Vietnamese",
];

export function geminiTtsConfig() {
  return {
    provider: "google",
    model: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
    voice: process.env.GEMINI_TTS_VOICE || "Puck",
    timeoutMs: Number(process.env.GEMINI_TTS_TIMEOUT_MS || 120_000),
    maxRetries: Number(process.env.GEMINI_TTS_MAX_RETRIES || 3),
    ready: Boolean(apiKey()),
  };
}

export function getGeminiTtsHealth() {
  const config = geminiTtsConfig();
  return {
    enabled: true,
    ready: config.ready,
    provider: "google",
    model: config.model,
    voice: config.voice,
    device: "Gemini API",
    error: config.ready ? null : "Add a Gemini API key for non-English narration.",
  };
}

export async function synthesizeGeminiCues({ segments, language, outputDir }) {
  const config = geminiTtsConfig();
  if (!config.ready) throw new Error("Gemini TTS requires a Gemini API key.");
  if (!GEMINI_TTS_LANGUAGES.includes(language)) throw new Error(`${language} speech is not supported by Gemini TTS.`);
  await mkdir(outputDir, { recursive: true });
  const client = new GoogleGenAI({ apiKey: apiKey() });
  const outputs = segments.map((_, index) => path.join(outputDir, `cue-${String(index + 1).padStart(3, "0")}.wav`));
  const concurrency = Math.max(1, Math.min(3, Number(process.env.GEMINI_TTS_CONCURRENCY || 2)));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      const index = nextIndex++;
      const audio = await generateCue(client, segments[index], language, config);
      await writeFile(outputs[index], pcmToWave(audio.pcm, audio.sampleRate, audio.channels));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));
  return outputs;
}

async function generateCue(client, text, language, config) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const delivery = language === "Burmese"
        ? "Use an engaging Burmese presenter voice at a clear, natural medium pace. Articulate every syllable and pause briefly between clauses without sounding slow or rushed."
        : "Use a lively, energetic knowledge-presenter delivery with clear articulation and a natural medium pace.";
      const response = await withTimeout(client.interactions.create({
        model: config.model,
        input: `Synthesize speech only. ${delivery} Speak in ${language}. Do not translate, paraphrase, add, omit, or read these instructions. Speak exactly the transcript after TRANSCRIPT START.\n\nTRANSCRIPT START\n${text}\nTRANSCRIPT END`,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: config.voice }] },
      }), config.timeoutMs, `Gemini TTS cue ${attempt}`);
      const data = response.output_audio?.data;
      if (!data) throw new Error("Gemini TTS returned no audio.");
      return {
        pcm: Buffer.from(data, "base64"),
        sampleRate: Number(response.output_audio?.sample_rate || 24_000),
        channels: Number(response.output_audio?.channels || 1),
      };
    } catch (error) {
      lastError = error;
      if (attempt < config.maxRetries) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`Gemini TTS failed after ${config.maxRetries} attempts: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

export function pcmToWave(pcm, sampleRate = 24_000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs); timer.unref(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
