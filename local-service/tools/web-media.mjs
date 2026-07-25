import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { registerJobProcess } from "../job-control.mjs";

const ffprobePath = ffprobe.path;

export function webMediaConfig() {
  const base = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "web-media");
  return {
    executable: path.resolve(process.env.WEB_MEDIA_DOWNLOADER || path.join(base, "venv", "bin", "yt-dlp")),
    cacheDir: path.join(base, "cache"),
    maxBytes: boundedBytes(process.env.REELIO_MAX_WEB_MEDIA_BYTES, 2 * 1024 * 1024 * 1024),
  };
}

export async function getWebMediaHealth() {
  const config = webMediaConfig();
  try {
    await access(config.executable);
    return { ready: true, provider: "yt-dlp", error: null };
  } catch {
    return { ready: false, provider: "yt-dlp", error: "Link tools are not installed. Run npm run webmedia:setup." };
  }
}

export async function downloadWebMedia({ url, outputDir, progress }) {
  const safeUrl = await validatePublicMediaUrl(url);
  const config = webMediaConfig();
  await requireDownloader();
  await progress("processing", 12, "Reading the public media link");
  const stdout = await runDownloader(config, [
    "--no-playlist",
    "--force-overwrites",
    "--cache-dir", config.cacheDir,
    "--ffmpeg-location", ffmpegPath,
    "--max-filesize", String(config.maxBytes),
    "--format", "bv*+ba/b",
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    "--output", path.join(outputDir, "downloaded-media.%(ext)s"),
    "--print", "after_move:filepath",
    safeUrl,
  ]);
  await progress("processing", 86, "Checking the downloaded video");
  const printedPaths = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const candidates = [
    ...printedPaths,
    ...(await readdir(outputDir)).filter((name) => /\.(?:mp4|mov|m4v|webm|mkv)$/i.test(name)).map((name) => path.join(outputDir, name)),
  ];
  const file = candidates.map((candidate) => path.resolve(candidate)).find((candidate) => isInside(outputDir, candidate));
  if (!file) throw new Error("The link did not produce a downloadable video.");
  const size = (await stat(file)).size;
  if (size <= 0 || size > config.maxBytes) throw new Error("The downloaded video is empty or exceeds Reelio’s link-download limit.");
  await assertVideoStream(file);
  await progress("finalizing", 96, "Downloaded video is ready");
  return { file, metadata: { sourceUrl: safeUrl, bytes: size, downloader: "yt-dlp" } };
}

export async function downloadWebCaptions({ url, language, outputDir, progress }) {
  const safeUrl = await validatePublicMediaUrl(url);
  const config = webMediaConfig();
  await requireDownloader();
  await progress("processing", 15, "Checking the link for existing captions");
  const metadataSource = await runDownloader(config, [
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
    safeUrl,
  ]);
  let metadata;
  try {
    metadata = JSON.parse(metadataSource);
  } catch {
    throw new Error("The source returned unreadable caption information.");
  }
  const track = selectWebCaptionTrack(metadata, language);
  if (!track) {
    throw new Error(`This link has no accessible ${language} captions. Download the video, then use Generate subtitle with Auto detect.`);
  }
  await progress("processing", 38, `Downloading the ${track.language} ${track.automatic ? "automatic" : "manual"} caption track`);
  await runDownloader(config, [
    "--no-playlist",
    "--force-overwrites",
    "--cache-dir", config.cacheDir,
    "--ffmpeg-location", ffmpegPath,
    "--skip-download",
    track.automatic ? "--write-auto-subs" : "--write-subs",
    "--sub-langs", track.language,
    "--sub-format", "srt/best",
    "--convert-subs", "srt",
    "--retries", "3",
    "--retry-sleep", "http:exp=2:20",
    "--sleep-subtitles", "2",
    "--output", path.join(outputDir, "web-captions.%(ext)s"),
    safeUrl,
  ]);
  const files = (await readdir(outputDir)).filter((name) => /\.srt$/i.test(name)).sort();
  if (!files.length) {
    throw new Error(`The ${track.language} caption track was listed but could not be saved. Retry later, or use Generate subtitle with Auto detect.`);
  }
  await progress("finalizing", 95, "Existing web captions are ready");
  return { file: path.join(outputDir, files[0]), metadata: { sourceUrl: safeUrl, language: track.language, automatic: track.automatic, downloader: "yt-dlp", usedSpeechRecognition: false } };
}

export function selectWebCaptionTrack(metadata, requestedLanguage) {
  const requested = String(requestedLanguage ?? "").trim().toLowerCase();
  const manual = Object.keys(metadata?.subtitles ?? {});
  const automatic = Object.keys(metadata?.automatic_captions ?? {});
  const manualMatch = bestLanguageMatch(manual, requested);
  if (manualMatch) return { language: manualMatch, automatic: false };
  const originalAutomatic = bestLanguageMatch(automatic.filter((value) => /-orig$/i.test(value)), requested);
  if (originalAutomatic) return { language: originalAutomatic, automatic: true };
  const automaticMatch = bestLanguageMatch(automatic, requested);
  return automaticMatch ? { language: automaticMatch, automatic: true } : null;
}

export function normalizeWebMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Enter a valid HTTPS media or webpage link.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Link must be a public HTTPS URL without embedded credentials.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local and private-network links are not supported.");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new Error("Local and private-network links are not supported.");
  return url.href;
}

async function validatePublicMediaUrl(value) {
  const safeUrl = normalizeWebMediaUrl(value);
  const hostname = new URL(safeUrl).hostname;
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (!addresses.length) throw new Error("The link’s host could not be resolved.");
    if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Local and private-network links are not supported.");
  }
  return safeUrl;
}

async function requireDownloader() {
  const health = await getWebMediaHealth();
  if (!health.ready) throw new Error(health.error);
}

function runDownloader(config, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, ["--ignore-config", "--no-colors", "--newline", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.REELIO_PROCESS_TIMEOUT_MS ?? 900_000));
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(downloaderErrorMessage(Buffer.concat(stderr).toString("utf8"))));
    });
  });
}

function downloaderErrorMessage(stderr) {
  const source = String(stderr ?? "");
  if (/HTTP Error 429|Too Many Requests/i.test(source)) {
    return "The source temporarily rate-limited caption access (HTTP 429). Wait a few minutes before retrying, or use Generate subtitle with Auto detect.";
  }
  if (/no impersonate target is available|required dependencies.*impersonation/i.test(source)) {
    return "The link utility needs its browser compatibility package. Run npm run webmedia:setup, then retry.";
  }
  if (/Sign in|login|cookies-from-browser|authentication/i.test(source)) {
    return "This source requires a signed-in browser session, which Reelio’s public-link tools do not use.";
  }
  const errors = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^ERROR:/i.test(line));
  return (errors.at(-1) ?? "The link is unsupported, private, login-protected, rate-limited, or unavailable.")
    .replace(/^ERROR:\s*/i, "")
    .slice(0, 500);
}

function bestLanguageMatch(available, requested) {
  return available.find((value) => value.toLowerCase() === requested)
    ?? available.find((value) => value.toLowerCase() === `${requested}-orig`)
    ?? available.find((value) => value.toLowerCase().startsWith(`${requested}-`))
    ?? null;
}

function assertVideoStream(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 && Buffer.concat(stdout).toString("utf8").trim() === "video"
      ? resolve()
      : reject(new Error("The link did not provide a usable video stream.")));
  });
}

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : "");
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function boundedBytes(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= 10 * 1024 * 1024 ? number : fallback;
}
