import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerJobProcess } from "./job-control.mjs";
import { brandVoiceOverrideEnabled } from "./narrators.mjs";

const root = () => path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "voxcpm2");
const DEFAULT_REFERENCE_TEXT = "Clear ideas become memorable when they are spoken with purpose, warmth, and natural rhythm.";

export const VOXCPM2_LANGUAGES = [
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Malay", "Norwegian",
  "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Tagalog", "Thai", "Turkish", "Vietnamese",
];

export function voxCpmConfig() {
  const base = root();
  return {
    provider: "voxcpm2",
    model: "OpenBMB/VoxCPM2",
    python: path.resolve(process.env.VOXCPM_PYTHON || path.join(base, "venv", "bin", "python3")),
    modelPath: path.resolve(process.env.VOXCPM_MODEL_PATH || path.join(base, "models", "VoxCPM2")),
    device: process.env.VOXCPM_DEVICE || "auto",
    // Measured on this install: cue F0 range is ~4.3-4.9 semitones and neither cfg_value (1.4/1.7/2.0)
    // nor inference_timesteps (10/30) moves it, while generation time is dominated by the language
    // model rather than the diffusion steps. Keep the cheap cue settings and spend the extra steps
    // only on the persona reference, which is generated once and cached.
    cfgValue: Number(process.env.VOXCPM_CFG_VALUE || 2),
    inferenceTimesteps: Number(process.env.VOXCPM_INFERENCE_TIMESTEPS || 10),
    referenceCfgValue: Number(process.env.VOXCPM_REFERENCE_CFG_VALUE || 2),
    referenceInferenceTimesteps: Number(process.env.VOXCPM_REFERENCE_INFERENCE_TIMESTEPS || 40),
    seed: Number(process.env.VOXCPM_SEED || 42),
    voiceDescription: process.env.VOXCPM_VOICE_DESCRIPTION || "A clear, energetic, confident knowledge presenter with a warm natural voice and a medium conversational pace.",
  };
}

export async function getVoxCpmHealth() {
  const config = voxCpmConfig();
  const missing = [];
  for (const [label, file] of [
    ["runtime", config.python],
    ["model config", path.join(config.modelPath, "config.json")],
    ["acoustic model", path.join(config.modelPath, "audiovae.pth")],
    ["language model", path.join(config.modelPath, "model.safetensors")],
  ]) {
    try { await access(file); } catch { missing.push(label); }
  }
  const downloadEntries = await readdir(path.join(config.modelPath, ".cache", "huggingface", "download")).catch(() => []);
  const loading = missing.includes("language model") && downloadEntries.some((name) => name.endsWith(".incomplete") || name.endsWith(".lock"));
  return {
    enabled: true,
    ready: missing.length === 0,
    loading,
    provider: "voxcpm2",
    model: config.model,
    device: config.device === "auto" ? "local auto (Metal on Apple Silicon)" : `local ${config.device}`,
    error: loading ? "The one-time VoxCPM2 model download is in progress." : missing.length ? `Missing ${missing.join(", ")}. Run npm run voxcpm2:setup.` : null,
  };
}

export async function synthesizeVoxCpmCues({ segments, language, outputDir, voiceDescription, personaId, personaSeed, personaReferenceText }) {
  const config = voxCpmConfig();
  const health = await getVoxCpmHealth();
  if (!health.ready) throw new Error(health.error);
  if (!VOXCPM2_LANGUAGES.includes(language)) throw new Error(`${language} speech is not supported by VoxCPM2.`);
  await mkdir(outputDir, { recursive: true });
  const personaDirectory = path.join(root(), "personas");
  await mkdir(personaDirectory, { recursive: true });
  const cues = segments.map((text, index) => ({
    text,
    output: path.join(outputDir, `cue-${String(index + 1).padStart(3, "0")}.wav`),
  }));
  // Each persona gets a deterministic designed voice reference; later cues clone it for stable identity.
  const description = selectVoxCpmVoiceDescription(voiceDescription);
  const seed = selectVoxCpmSeed(personaSeed);
  const identity = brandVoiceOverrideEnabled() ? "brand" : safePersonaId(personaId);
  const referenceText = voxCpmCalibrationText(language, segments, personaReferenceText);
  const languageId = safeLanguageId(language);
  // Key the cached clip on the persona's own passage so editing it regenerates the reference instead
  // of reusing a clip recorded from the old text. Non-English references are taken from the script,
  // which differs per video, so those key on a stable marker to keep one voice across renders.
  const referenceKey = referenceText === String(personaReferenceText ?? "").trim() ? referenceText : "script-derived";
  const referenceHash = createHash("sha256").update(JSON.stringify({ version: 3, identity, description, seed, language, referenceKey })).digest("hex").slice(0, 12);
  const personaReference = path.join(personaDirectory, `${identity}-${languageId}-${referenceHash}.wav`);
  const personaReferenceTranscript = path.join(personaDirectory, `${identity}-${languageId}-${referenceHash}.txt`);
  const manifestPath = path.join(outputDir, "voxcpm2-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    model: config.modelPath,
    device: config.device,
    cfgValue: config.cfgValue,
    inferenceTimesteps: config.inferenceTimesteps,
    referenceCfgValue: config.referenceCfgValue,
    referenceInferenceTimesteps: config.referenceInferenceTimesteps,
    seed,
    voiceDescription: description,
    personaId: identity,
    personaReference,
    personaReferenceTranscript,
    personaReferenceText: referenceText,
    language,
    cues,
  }), "utf8");
  await run(config.python, [path.resolve("scripts/voxcpm2_tts.py"), manifestPath]);
  return cues.map((cue) => cue.output);
}

export function selectVoxCpmVoiceDescription(personaDescription) {
  const configured = brandVoiceOverrideEnabled() ? process.env.VOXCPM_VOICE_DESCRIPTION : "";
  return String(configured || (typeof personaDescription === "string" ? personaDescription : "") || "A clear, energetic, confident knowledge presenter with a warm natural voice and a medium conversational pace.").trim();
}

export function selectVoxCpmSeed(personaSeed) {
  const configured = brandVoiceOverrideEnabled() ? Number(process.env.VOXCPM_SEED) : Number.NaN;
  const selected = Number.isFinite(configured) ? configured : Number(personaSeed);
  return Number.isFinite(selected) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(selected))) : 42;
}

function safePersonaId(value) {
  const clean = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return clean || "maya";
}

function safeLanguageId(value) {
  const clean = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return clean || "speech";
}

export function voxCpmCalibrationText(language, segments, personaReferenceText) {
  const selectedLanguageText = segments.find((text) => typeof text === "string" && text.trim())?.trim();
  const source = String(language).toLowerCase() === "english"
    ? String(personaReferenceText || selectedLanguageText || DEFAULT_REFERENCE_TEXT).trim()
    : String(selectedLanguageText || personaReferenceText || DEFAULT_REFERENCE_TEXT).trim();
  if (source.length <= 260) return source;
  const shortened = source.slice(0, 259).replace(/\s+\S*$/, "").trim();
  return `${shortened || source.slice(0, 259)}…`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number(process.env.VOXCPM_TIMEOUT_MS || 1_800_000));
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error("VoxCPM2 synthesis exceeded the processing time limit."));
      else reject(new Error(`VoxCPM2 synthesis failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1800)}`));
    });
  });
}
