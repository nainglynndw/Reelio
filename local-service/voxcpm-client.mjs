import { spawn } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerJobProcess } from "./job-control.mjs";

const root = () => path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "voxcpm2");

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
    cfgValue: Number(process.env.VOXCPM_CFG_VALUE || 2),
    inferenceTimesteps: Number(process.env.VOXCPM_INFERENCE_TIMESTEPS || 10),
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

export async function synthesizeVoxCpmCues({ segments, language, outputDir, voiceDescription }) {
  const config = voxCpmConfig();
  const health = await getVoxCpmHealth();
  if (!health.ready) throw new Error(health.error);
  if (!VOXCPM2_LANGUAGES.includes(language)) throw new Error(`${language} speech is not supported by VoxCPM2.`);
  await mkdir(outputDir, { recursive: true });
  const cues = segments.map((text, index) => ({
    text,
    output: path.join(outputDir, `cue-${String(index + 1).padStart(3, "0")}.wav`),
  }));
  // A per-topic voice description steers VoxCPM2's tone (calm, energetic, cinematic, …).
  const description = typeof voiceDescription === "string" && voiceDescription.trim() ? voiceDescription.trim() : config.voiceDescription;
  const manifestPath = path.join(outputDir, "voxcpm2-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    model: config.modelPath,
    device: config.device,
    cfgValue: config.cfgValue,
    inferenceTimesteps: config.inferenceTimesteps,
    seed: config.seed,
    voiceDescription: description,
    language,
    cues,
  }), "utf8");
  await run(config.python, [path.resolve("scripts/voxcpm2_tts.py"), manifestPath]);
  return cues.map((cue) => cue.output);
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
