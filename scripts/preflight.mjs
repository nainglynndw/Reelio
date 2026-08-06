import { config as loadEnv } from "dotenv";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { getKokoroHealth } from "../local-service/kokoro-client.mjs";
import { getSttHealth } from "../local-service/stt-client.mjs";
import { getVoxCpmHealth } from "../local-service/voxcpm-client.mjs";
import { textProviderConfig } from "../local-service/text-provider.mjs";
import { conversationBrowserHealth } from "../local-service/conversation-video.mjs";

loadEnv({ path: [".env.local", ".env"], quiet: true });

const failures = [];
const warnings = [];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) failures.push("Node.js 22.13 or newer is required.");

try {
  await access(ffmpegPath);
} catch {
  failures.push("The bundled FFmpeg executable is unavailable. Run npm install again.");
}

const dataRoot = path.resolve(process.env.REELIO_DATA_DIR || path.join(process.cwd(), ".reelio"));
try {
  await mkdir(dataRoot, { recursive: true });
  const probe = path.join(dataRoot, `.write-probe-${process.pid}`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
} catch {
  failures.push(`The Reelio data directory is not writable: ${dataRoot}`);
}

const kokoro = await getKokoroHealth();
if (!kokoro.ready) failures.push("Local Kokoro narration is not ready. Run npm run kokoro:setup.");
else process.stdout.write(`TTS   ${kokoro.model} / ${kokoro.voice}\n`);
const voxcpm2 = await getVoxCpmHealth();
if (!voxcpm2.ready) warnings.push("Local VoxCPM2 narration is not ready. Run npm run voxcpm2:setup, or select Gemini TTS for non-English speech.");
else process.stdout.write(`TTS   ${voxcpm2.model} / ${voxcpm2.device}\n`);
const text = textProviderConfig();
if (!text.ready) warnings.push("No hosted text provider is configured: only English fallback scripts are available. Add GEMINI_API_KEY for multilingual generation.");
else process.stdout.write(`TEXT  ${text.provider} / ${text.model}\n`);
const stt = await getSttHealth();
if (!stt.ready) warnings.push(stt.error);
else process.stdout.write(`STT   ${stt.provider} / ${stt.model}\n`);
const conversationRenderer = await conversationBrowserHealth();
if (!conversationRenderer.ready) warnings.push("Message Conversation preview is available, but final rendering needs npm run conversation:setup.");
else process.stdout.write(`CHAT  ${conversationRenderer.browser}\n`);
if (!process.env.PEXELS_API_KEY && !process.env.PIXABAY_API_KEY) {
  warnings.push("No stock provider is configured: Prompt to Video can use custom local videos or generated motion backgrounds.");
} else if (!process.env.PEXELS_API_KEY) {
  warnings.push("Pexels is not configured: Pixabay will provide stock fallback.");
} else if (!process.env.PIXABAY_API_KEY) {
  warnings.push("Pixabay is not configured: Pexels will provide stock fallback.");
}
if (![process.env.YOUTUBE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN, process.env.TIKTOK_ACCESS_TOKEN, process.env.FACEBOOK_PAGE_ACCESS_TOKEN, process.env.META_USER_ACCESS_TOKEN].some(Boolean)) {
  warnings.push("No publishing credentials are configured: rendered packages remain downloadable and uploads stay disabled by provider checks.");
}

for (const warning of warnings) process.stdout.write(`WARN  ${warning}\n`);
for (const failure of failures) process.stderr.write(`FAIL  ${failure}\n`);
if (failures.length) process.exitCode = 1;
else process.stdout.write("READY Production preflight passed.\n");
