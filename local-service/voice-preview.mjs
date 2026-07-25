import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { synthesizeGeminiCues } from "./gemini-tts-client.mjs";
import { registerJobProcess } from "./job-control.mjs";
import { synthesizeKokoroCues } from "./kokoro-client.mjs";
import { brandVoiceOverrideEnabled, narratorProfile } from "./narrators.mjs";
import { getRoot } from "./store.mjs";
import { synthesizeVoxCpmCues } from "./voxcpm-client.mjs";

const CACHE_VERSION = "voice-preview-v5";

export function voicePreviewCacheKey(request) {
  const narrator = narratorProfile(request.narratorId);
  return createHash("sha256").update(JSON.stringify({
    version: CACHE_VERSION,
    text: previewTranscript(request.text),
    language: request.language,
    ttsEngine: request.ttsEngine,
    narratorId: narrator.id,
    voices: [narrator.kokoroVoice, narrator.geminiVoice, narrator.voxDescription],
    voxIdentity: [narrator.voxSeed, narrator.voxReferenceText],
    speedScale: narrator.speedScale,
    brandOverride: brandVoiceOverrideEnabled() ? [
      process.env.KOKORO_VOICE,
      process.env.KOKORO_VOICE_BLEND,
      process.env.GEMINI_TTS_VOICE,
      process.env.VOXCPM_VOICE_DESCRIPTION,
    ] : null,
  })).digest("hex");
}

export async function cachedVoicePreview(request) {
  const key = voicePreviewCacheKey(request);
  const file = path.join(previewRoot(), `${key}.m4a`);
  try {
    await access(file);
    return previewResult(request, key, file, true);
  } catch {
    return null;
  }
}

export async function generateVoicePreview(request) {
  const cached = await cachedVoicePreview(request);
  if (cached) return cached;

  const key = voicePreviewCacheKey(request);
  const root = previewRoot();
  const temporary = path.join(root, `.work-${randomUUID()}`);
  const cueDirectory = path.join(temporary, "cues");
  const temporaryOutput = path.join(temporary, `${key}.m4a`);
  const finalOutput = path.join(root, `${key}.m4a`);
  const narrator = narratorProfile(request.narratorId);
  const transcript = previewTranscript(request.text);
  await mkdir(cueDirectory, { recursive: true });

  try {
    const files = request.ttsEngine === "kokoro"
      ? await synthesizeKokoroCues({
        segments: [transcript],
        outputDir: cueDirectory,
        speed: 1.15 * narrator.speedScale,
        voice: narrator.kokoroVoice,
      })
      : request.ttsEngine === "voxcpm2"
        ? await synthesizeVoxCpmCues({
          segments: [transcript],
          language: request.language,
          outputDir: cueDirectory,
          voiceDescription: narrator.voxDescription,
          personaId: narrator.id,
          personaSeed: narrator.voxSeed,
          personaReferenceText: narrator.voxReferenceText,
        })
        : await synthesizeGeminiCues({
          segments: [transcript],
          language: request.language,
          outputDir: cueDirectory,
          voice: narrator.geminiVoice,
          delivery: narrator.delivery,
        });

    await run(ffmpegPath, [
      "-y",
      "-i", files[0],
      "-vn",
      "-filter:a", "loudnorm=I=-16:LRA=7:TP=-1.5,apad=whole_dur=5,atrim=duration=8",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "48000",
      temporaryOutput,
    ]);
    await rename(temporaryOutput, finalOutput);
    return previewResult(request, key, finalOutput, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function previewRoot() {
  return path.join(getRoot(), "voice-previews");
}

function previewTranscript(value) {
  return String(value ?? "").replace(/\[(?:pause|beat|breath)\]/gi, " ").replace(/\s+/g, " ").trim();
}

function previewResult(request, key, file, cached) {
  const narrator = narratorProfile(request.narratorId);
  const usesApi = request.ttsEngine === "gemini";
  return {
    key,
    file,
    cached,
    usesApi,
    provider: usesApi ? "Gemini API" : request.ttsEngine === "kokoro" ? "Local Kokoro" : "Local VoxCPM2",
    narrator: narrator.name,
    url: `/voice-previews/${key}`,
  };
}

function run(command, args) {
  if (!command) throw new Error("FFmpeg is not available.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    registerJobProcess(child);
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.REELIO_PROCESS_TIMEOUT_MS ?? 900_000));
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Voice sample encoding failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1200)}`));
    });
  });
}
