import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateGeminiApiKey } from "./text-provider.mjs";

// Runtime-written secrets (OAuth tokens, API keys) live in a worker-owned file, NOT .env.local.
// The Cloudflare/vinext web dev server watches .env.local and hot-restarts (crashing) on every
// change, so writing tokens there mid-session during OAuth would take the web app down.
export function secretsFilePath() {
  return process.env.REELIO_SECRETS_FILE?.trim() || path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "secrets.env");
}

const ALLOWED_SETTINGS = new Map([
  ["geminiApiKey", "GEMINI_API_KEY"],
  ["geminiTextModel", "GEMINI_TEXT_MODEL"],
  ["geminiTtsModel", "GEMINI_TTS_MODEL"],
  ["geminiTtsVoice", "GEMINI_TTS_VOICE"],
  ["reelioTextProvider", "REELIO_TEXT_PROVIDER"],
  ["kokoroVoice", "KOKORO_VOICE"],
  ["kokoroSpeed", "KOKORO_SPEED"],
  ["openrouterApiKey", "OPENROUTER_API_KEY"],
  ["openrouterTextModel", "OPENROUTER_TEXT_MODEL"],
  ["openrouterFallbackModel", "OPENROUTER_FALLBACK_MODEL"],
  ["pexelsApiKey", "PEXELS_API_KEY"],
  ["googleClientId", "GOOGLE_CLIENT_ID"],
  ["googleClientSecret", "GOOGLE_CLIENT_SECRET"],
  ["googleRefreshToken", "GOOGLE_REFRESH_TOKEN"],
  ["youtubePrivacy", "YOUTUBE_PRIVACY"],
  ["tiktokClientKey", "TIKTOK_CLIENT_KEY"],
  ["tiktokClientSecret", "TIKTOK_CLIENT_SECRET"],
  ["tiktokRefreshToken", "TIKTOK_REFRESH_TOKEN"],
  ["tiktokScopes", "TIKTOK_SCOPES"],
  ["metaAppId", "META_APP_ID"],
  ["metaAppSecret", "META_APP_SECRET"],
  ["facebookPageId", "FACEBOOK_PAGE_ID"],
  ["facebookPageAccessToken", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  ["instagramAccountId", "INSTAGRAM_ACCOUNT_ID"],
  ["metaUserAccessToken", "META_USER_ACCESS_TOKEN"],
  ["metaGraphVersion", "META_GRAPH_VERSION"],
  ["publicMediaBaseUrl", "PUBLIC_MEDIA_BASE_URL"],
]);

export async function saveLocalSettings(input) {
  if (typeof input?.geminiApiKey === "string" && input.geminiApiKey.trim()) {
    const status = await validateGeminiApiKey(input.geminiApiKey.trim());
    if (!status.ready) throw new Error(status.error);
  }
  const updates = new Map();
  for (const [field, envName] of ALLOWED_SETTINGS) {
    if (typeof input?.[field] !== "string") continue;
    const value = input[field].trim();
    if (!value) continue;
    if (value.length > 500) throw new Error(`${field} is too long.`);
    updates.set(envName, value);
  }
  if (!updates.size) throw new Error("Enter at least one setting to save.");

  const envFile = secretsFilePath();
  let source = "";
  try { source = await readFile(envFile, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const lines = source ? source.replace(/\n$/, "").split("\n") : [];
  const written = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!match || !updates.has(match[1])) return line;
    written.add(match[1]);
    return `${match[1]}=${encodeEnv(updates.get(match[1]))}`;
  });
  for (const [name, value] of updates) if (!written.has(name)) next.push(`${name}=${encodeEnv(value)}`);
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(envFile, 0o600);
  for (const [name, value] of updates) process.env[name] = value;
  return [...updates.keys()];
}

function encodeEnv(value) {
  return /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : JSON.stringify(value);
}
