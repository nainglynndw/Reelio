import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerJobProcess } from "./job-control.mjs";

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
    speed: Number(process.env.KOKORO_SPEED || 1.15),
    language: "en-us",
  };
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

export async function synthesizeKokoroCues({ segments, outputDir }) {
  const config = kokoroConfig();
  const health = await getKokoroHealth();
  if (!health.ready) throw new Error(health.error);
  await mkdir(outputDir, { recursive: true });
  const cues = segments.map((text, index) => ({
    text,
    output: path.join(outputDir, `cue-${String(index + 1).padStart(3, "0")}.wav`),
  }));
  const manifestPath = path.join(outputDir, "kokoro-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    model: config.modelPath,
    voices: config.voicesPath,
    voice: config.voice,
    speed: config.speed,
    language: config.language,
    cues,
  }), "utf8");
  await run(config.python, [path.resolve("scripts/kokoro_tts.py"), manifestPath]);
  return cues.map((cue) => cue.output);
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
