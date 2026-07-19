import { createHash, randomBytes } from "node:crypto";
import { saveLocalSettings } from "./settings-store.mjs";

const TIKTOK_SCOPES = "user.info.basic,video.upload";
const pendingStates = new Map();
let cachedToken = null;

export function tiktokOAuthConfig() {
  return {
    clientKey: process.env.TIKTOK_CLIENT_KEY?.trim() ?? "",
    clientSecret: process.env.TIKTOK_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.TIKTOK_REDIRECT_URI?.trim() || `http://127.0.0.1:${process.env.REELIO_SERVICE_PORT ?? 8788}/oauth/tiktok/callback`,
  };
}

export function buildTikTokAuthorizationUrl({ clientKey, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: TIKTOK_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    disable_auto_auth: "1",
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

export function startTikTokOAuth() {
  const config = tiktokOAuthConfig();
  if (!config.clientKey || !config.clientSecret) throw new TikTokOAuthError(400, "Add the TikTok client key and client secret first.");
  pruneStates();
  const state = randomBytes(30).toString("hex");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("hex");
  pendingStates.set(state, { expiresAt: Date.now() + 10 * 60_000, codeVerifier });
  return { authUrl: buildTikTokAuthorizationUrl({ ...config, state, codeChallenge }), redirectUri: config.redirectUri };
}

export async function finishTikTokOAuth(code, state) {
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || pending.expiresAt < Date.now()) throw new TikTokOAuthError(400, "This TikTok connection request expired. Start again from Settings.");
  if (!code) throw new TikTokOAuthError(400, "TikTok did not return an authorization code.");
  const config = tiktokOAuthConfig();
  const result = await tokenRequest({
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code_verifier: pending.codeVerifier,
  });
  if (!result.refresh_token) throw new TikTokOAuthError(400, "TikTok did not return a refresh token.");
  const scopes = String(result.scope ?? "");
  if (!scopes.split(",").includes("video.upload")) throw new TikTokOAuthError(400, "TikTok did not grant video.upload. Enable Content Posting API and authorize that permission.");
  await saveLocalSettings({ tiktokRefreshToken: result.refresh_token, tiktokScopes: scopes });
  cacheAccessToken(result);
  return tiktokConnectionStatus(result.access_token, scopes);
}

export async function getTikTokAccessToken() {
  if (cachedToken?.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const config = tiktokOAuthConfig();
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN?.trim();
  if (!config.clientKey || !config.clientSecret || !refreshToken) return process.env.TIKTOK_ACCESS_TOKEN?.trim() || null;
  const result = await tokenRequest({
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (result.refresh_token && result.refresh_token !== refreshToken) await saveLocalSettings({ tiktokRefreshToken: result.refresh_token });
  if (result.scope) await saveLocalSettings({ tiktokScopes: String(result.scope) });
  cacheAccessToken(result);
  return result.access_token;
}

export async function tiktokConnectionStatus(accessToken, grantedScopes = process.env.TIKTOK_SCOPES ?? "") {
  const config = tiktokOAuthConfig();
  const configured = Boolean(config.clientKey && config.clientSecret);
  const hasAuthorization = Boolean(process.env.TIKTOK_REFRESH_TOKEN || process.env.TIKTOK_ACCESS_TOKEN || accessToken);
  if (!configured && !process.env.TIKTOK_ACCESS_TOKEN) return { connected: false, configured: false, hasAuthorization, message: "TikTok developer credentials are not configured." };
  if (!hasAuthorization) return { connected: false, configured: true, hasAuthorization: false, message: "Developer credentials are saved. Connect your TikTok account next." };
  try {
    const token = accessToken || await getTikTokAccessToken();
    if (!token) return { connected: false, configured, hasAuthorization: false, message: "TikTok authorization is missing." };
    const response = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => ({}));
    const apiError = result?.error;
    if (!response.ok || (apiError?.code && apiError.code !== "ok")) return { connected: false, configured, hasAuthorization: true, message: apiError?.message || result?.error_description || "TikTok rejected the saved authorization." };
    const user = result?.data?.user;
    if (!user) return { connected: false, configured, hasAuthorization: true, message: "TikTok did not return an account profile." };
    const uploadReady = !grantedScopes || grantedScopes.split(",").includes("video.upload");
    return {
      connected: uploadReady,
      configured,
      hasAuthorization: true,
      accountId: user.open_id,
      displayName: user.display_name ?? "TikTok account",
      avatarUrl: user.avatar_url,
      uploadReady,
      message: uploadReady ? "TikTok draft upload access is ready." : "Reconnect and grant video.upload permission.",
    };
  } catch (error) {
    return { connected: false, configured, hasAuthorization: true, message: error instanceof Error ? error.message : "TikTok connection check failed." };
  }
}

async function tokenRequest(values) {
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new TikTokOAuthError(400, result.error_description ?? result.message ?? "TikTok could not complete authorization.");
  return result;
}

function cacheAccessToken(result) {
  cachedToken = { token: result.access_token, expiresAt: Date.now() + Math.max(0, Number(result.expires_in ?? 0) - 60) * 1000 };
}

function pruneStates() {
  const now = Date.now();
  for (const [state, pending] of pendingStates) if (pending.expiresAt < now) pendingStates.delete(state);
}

export class TikTokOAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TikTokOAuthError";
    this.status = status;
  }
}
