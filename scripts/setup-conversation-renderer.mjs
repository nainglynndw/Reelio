import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const dataRoot = path.resolve(process.env.REELIO_DATA_DIR || path.join(process.cwd(), ".reelio"));
const browserRoot = path.join(dataRoot, "browsers");
await mkdir(browserRoot, { recursive: true });

process.stdout.write(`Installing the conversation render browser under ${browserRoot}\n`);
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(executable, ["playwright", "install", "chromium"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
});
child.once("error", (error) => {
  process.stderr.write(`Conversation renderer setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code) => {
  if (code === 0) process.stdout.write("Conversation renderer browser is ready.\n");
  else process.exitCode = code || 1;
});
