import { spawn } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const base = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "kokoro");
const venv = path.join(base, "venv");
const models = path.join(base, "models");
const python = path.join(venv, "bin", "python3");
const model = path.join(models, "kokoro-v1.0.onnx");
const voices = path.join(models, "voices-v1.0.bin");

await mkdir(models, { recursive: true });
if (!(await exists(python))) {
  process.stdout.write("Creating isolated Kokoro Python 3.12 runtime…\n");
  await run("uv", ["venv", "--python", "3.12", "--managed-python", venv]);
}
process.stdout.write("Installing Kokoro ONNX runtime…\n");
await run("uv", ["pip", "install", "--python", python, "-U", "kokoro-onnx", "soundfile"]);
await download("https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx", model);
await download("https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin", voices);
process.stdout.write("Kokoro is ready: local English narration, af_heart voice.\n");

async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function download(url, destination) {
  if (await exists(destination)) return process.stdout.write(`Using cached ${path.basename(destination)}\n`);
  const temporary = `${destination}.download`;
  await rm(temporary, { force: true });
  process.stdout.write(`Downloading ${path.basename(destination)}…\n`);
  await run("curl", ["-fL", "--retry", "3", "--output", temporary, url]);
  await rename(temporary, destination);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
