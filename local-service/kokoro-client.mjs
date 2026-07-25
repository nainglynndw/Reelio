import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerJobProcess } from "./job-control.mjs";
import { brandVoiceOverrideEnabled } from "./narrators.mjs";

const root = () => path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "kokoro");

export function kokoroConfig() {
  const base = root();
  return {
    provider: "kokoro",
    model: "Kokoro-82M v1.0",
    python: path.resolve(process.env.KOKORO_PYTHON || path.join(base, "venv", "bin", "python3")),
    modelPath: path.resolve(process.env.KOKORO_MODEL_PATH || path.join(base, "models", "kokoro-v1.0.onnx")),
    voicesPath: path.resolve(process.env.KOKORO_VOICES_PATH || path.join(base, "models", "voices-v1.0.bin")),
    voice: process.env.KOKORO_VOICE || "af_heart",
    voiceBlend: parseVoiceBlend(process.env.KOKORO_VOICE_BLEND),
    speed: Number(process.env.KOKORO_SPEED || 1.15),
    language: "en-us",
  };
}

// Optional brand voice: KOKORO_VOICE_BLEND="af_heart:0.6,af_bella:0.4" mixes voice style vectors into
// one distinctive, consistent voiceprint. Returns null (single voice) when unset or malformed.
export function parseVoiceBlend(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const entries = raw.split(",").map((part) => {
    const [name, weight] = part.split(":").map((value) => value.trim());
    return { name, weight: Number(weight ?? "1") };
  }).filter((entry) => entry.name && Number.isFinite(entry.weight) && entry.weight > 0);
  if (entries.length < 2) return null;
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries.map((entry) => ({ name: entry.name, weight: Number((entry.weight / total).toFixed(4)) }));
}

export async function getKokoroHealth() {
  const config = kokoroConfig();
  const missing = [];
  for (const [label, file] of [["runtime", config.python], ["model", config.modelPath], ["voices", config.voicesPath]]) {
    try { await access(file); } catch { missing.push(label); }
  }
  return {
    enabled: true,
    ready: missing.length === 0,
    provider: "kokoro",
    model: config.model,
    voice: config.voice,
    device: "local ONNX",
    error: missing.length ? `Missing ${missing.join(", ")}. Run npm run kokoro:setup.` : null,
  };
}

export async function synthesizeKokoroCues({ segments, outputDir, speed, voice }) {
  const config = kokoroConfig();
  const health = await getKokoroHealth();
  if (!health.ready) throw new Error(health.error);
  await mkdir(outputDir, { recursive: true });
  const cues = segments.map((text, index) => ({
    text,
    output: path.join(outputDir, `cue-${String(index + 1).padStart(3, "0")}.wav`),
  }));
  // A per-topic speed override lets calmer topics slow down and energetic ones speed up.
  const pacedSpeed = Number.isFinite(speed) ? Math.max(0.8, Math.min(1.4, Number(speed))) : config.speed;
  const selectedVoice = selectKokoroVoice(voice);
  const selectedBlend = brandVoiceOverrideEnabled() && process.env.KOKORO_VOICE_BLEND ? config.voiceBlend : null;
  const manifestPath = path.join(outputDir, "kokoro-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    model: config.modelPath,
    voices: config.voicesPath,
    voice: selectedVoice,
    voiceBlend: selectedBlend,
    speed: pacedSpeed,
    language: config.language,
    cues,
  }), "utf8");
  await run(config.python, [path.resolve("scripts/kokoro_tts.py"), manifestPath]);
  return cues.map((cue) => cue.output);
}

export function selectKokoroVoice(personaVoice) {
  const configured = brandVoiceOverrideEnabled() ? process.env.KOKORO_VOICE : "";
  return String(configured || personaVoice || "af_heart").trim();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.KOKORO_TIMEOUT_MS || 900_000));
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Kokoro synthesis failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1600)}`));
    });
  });
}
