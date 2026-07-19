import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const dataRoot = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "voxcpm2");
const venv = path.join(dataRoot, "venv");
const python = path.join(venv, "bin", "python3");
const modelPath = path.resolve(process.env.VOXCPM_MODEL_PATH || path.join(dataRoot, "models", "VoxCPM2"));
const managedPythonRoot = path.join(dataRoot, "python");
const managedEnv = { ...process.env, UV_PYTHON_INSTALL_DIR: managedPythonRoot };

await mkdir(dataRoot, { recursive: true });
process.stdout.write("Creating an isolated Python 3.12 runtime for VoxCPM2\n");
await run("uv", ["python", "install", "3.12"], managedEnv);
await run("uv", ["venv", "--clear", "--python", "3.12", "--python-preference", "only-managed", venv], managedEnv);
await run("uv", ["pip", "install", "--python", python, "voxcpm"], managedEnv);
await mkdir(path.dirname(modelPath), { recursive: true });
process.stdout.write("Downloading OpenBMB/VoxCPM2 model files (one-time download)…\n");
await run(python, ["-c", "from huggingface_hub import snapshot_download; import sys; snapshot_download('openbmb/VoxCPM2', local_dir=sys.argv[1])", modelPath], {
  ...managedEnv,
  HF_XET_HIGH_PERFORMANCE: "1",
  HF_HUB_DOWNLOAD_TIMEOUT: "600",
});
process.stdout.write(`VoxCPM2 is ready at ${modelPath}\n`);

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
