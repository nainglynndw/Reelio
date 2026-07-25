import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const dataRoot = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "stt");
const venv = path.join(dataRoot, "venv");
const python = path.join(venv, "bin", "python3");
const managedPythonRoot = path.join(dataRoot, "python");
const managedEnv = { ...process.env, UV_PYTHON_INSTALL_DIR: managedPythonRoot };

await mkdir(dataRoot, { recursive: true });
process.stdout.write("Creating an isolated Python runtime for local transcription\n");
await run("uv", ["python", "install", "3.12"], managedEnv);
await run("uv", ["venv", "--clear", "--python", "3.12", "--python-preference", "only-managed", venv], managedEnv);
await run("uv", ["pip", "install", "--python", python, "faster-whisper"], managedEnv);
process.stdout.write("Transcription is ready. The selected Whisper model downloads on first use.\n");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
