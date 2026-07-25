import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const dataRoot = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "web-media");
const venv = path.join(dataRoot, "venv");
const python = path.join(venv, "bin", "python3");
const managedPythonRoot = path.join(dataRoot, "python");
const managedEnv = {
  ...process.env,
  UV_PYTHON_INSTALL_DIR: managedPythonRoot,
  UV_CACHE_DIR: path.join(dataRoot, "uv-cache"),
};

await mkdir(dataRoot, { recursive: true });
process.stdout.write("Creating an isolated runtime for public-link media tools\n");
await run("uv", ["python", "install", "3.12"], managedEnv);
await run("uv", ["venv", "--clear", "--python", "3.12", "--python-preference", "only-managed", venv], managedEnv);
await run("uv", ["pip", "install", "--python", python, "yt-dlp[default,curl-cffi]"], managedEnv);
process.stdout.write("Public-link media and caption tools are ready.\n");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
