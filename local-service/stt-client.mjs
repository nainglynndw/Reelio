import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerJobProcess } from "./job-control.mjs";

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
  return {
    python: path.resolve(process.env.STT_PYTHON || path.join(base, "venv", "bin", "python3")),
    model: process.env.STT_MODEL || "small",
    modelDir: path.resolve(process.env.STT_MODEL_DIR || path.join(base, "models")),
    device: process.env.STT_DEVICE || "auto",
    computeType: process.env.STT_COMPUTE_TYPE || "default",
  };
}

export async function getSttHealth() {
  const config = sttConfig();
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
  await run(config.python, [path.resolve("scripts/transcribe_audio.py"), manifest]);
  const result = JSON.parse(await readFile(output, "utf8"));
  if (!Array.isArray(result.cues) || !result.cues.length) {
    throw new Error("No recognizable speech or vocals were found. Try Auto detect for the language, or use Extract captions from link if the source provides captions.");
  }
  return result;
}

export function sttLanguageCode(language) {
  const value = String(language ?? "auto").trim();
  if (!value || value.toLowerCase() === "auto") return null;
  if (/^[a-z]{2,3}$/i.test(value)) return value.toLowerCase();
  const code = languageCodes[value];
  if (!code) throw new Error(`Unsupported transcription language: ${value}.`);
  return code;
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
    }, Number(process.env.STT_TIMEOUT_MS || 1_800_000));
    timer.unref();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error("Transcription exceeded the processing time limit."));
      else reject(new Error(`Transcription failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1800)}`));
    });
  });
}
