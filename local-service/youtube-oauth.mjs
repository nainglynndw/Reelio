import { saveLocalSettings } from "./settings-store.mjs";
import { googleAccessToken } from "./publishers.mjs";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const pendingStates = new Map();

export function youtubeOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.YOUTUBE_REDIRECT_URI?.trim() || `http://127.0.0.1:${process.env.REELIO_SERVICE_PORT ?? 8788}/oauth/youtube/callback`,
  };
}

export function buildYouTubeAuthorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READ_SCOPE}`,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function startYouTubeOAuth() {
  const config = youtubeOAuthConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new YouTubeOAuthError(400, "Add the Google OAuth client ID and client secret first.");
  }
  pruneStates();
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now() + 10 * 60_000);
  return {
    authUrl: buildYouTubeAuthorizationUrl({ ...config, state }),
    redirectUri: config.redirectUri,
  };
}

export async function finishYouTubeOAuth(code, state) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiresAt || expiresAt < Date.now()) throw new YouTubeOAuthError(400, "This YouTube connection request expired. Start again from Settings.");
  if (!code) throw new YouTubeOAuthError(400, "Google did not return an authorization code.");

  const config = youtubeOAuthConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new YouTubeOAuthError(400, result?.error_description ?? "Google could not complete YouTube authorization.");
  if (!result.refresh_token && !process.env.GOOGLE_REFRESH_TOKEN) {
    throw new YouTubeOAuthError(400, "Google did not return offline access. Revoke the old Reelio grant and connect again.");
  }
  if (result.refresh_token) await saveLocalSettings({ googleRefreshToken: result.refresh_token });
  return youtubeConnectionStatus(result.access_token);
}

export async function youtubeConnectionStatus(accessToken) {
  const config = youtubeOAuthConfig();
  const configured = Boolean(config.clientId && config.clientSecret);
  const hasAuthorization = Boolean(process.env.GOOGLE_REFRESH_TOKEN || process.env.YOUTUBE_ACCESS_TOKEN || accessToken);
  if (!configured && !process.env.YOUTUBE_ACCESS_TOKEN) return { connected: false, configured: false, hasAuthorization, message: "Google OAuth credentials are not configured." };
  if (!hasAuthorization) return { connected: false, configured: true, hasAuthorization: false, message: "OAuth credentials are saved. Connect your YouTube channel next." };

  try {
    const token = accessToken || await googleAccessToken();
    if (!token) return { connected: false, configured: true, hasAuthorization: false, message: "YouTube authorization is missing." };
    const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { connected: false, configured: true, hasAuthorization: true, message: result?.error?.message ?? "YouTube rejected the saved authorization." };
    const channel = result.items?.[0];
    if (!channel) return { connected: false, configured: true, hasAuthorization: true, message: "The Google account does not have a YouTube channel." };
    return {
      connected: true,
      configured: true,
      hasAuthorization: true,
      channelId: channel.id,
      channelTitle: channel.snippet?.title ?? "YouTube channel",
      message: "YouTube upload access is ready.",
    };
  } catch (error) {
    return { connected: false, configured: true, hasAuthorization: true, message: error instanceof Error ? error.message : "YouTube connection check failed." };
  }
}

function pruneStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) if (expiresAt < now) pendingStates.delete(state);
}

export class YouTubeOAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "YouTubeOAuthError";
    this.status = status;
  }
}
