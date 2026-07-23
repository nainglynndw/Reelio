import { saveLocalSettings } from "./settings-store.mjs";

const DEFAULT_GRAPH_VERSION = "v23.0";
const META_SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts,business_management,instagram_basic,instagram_content_publish";
const PAGE_FIELDS = "id,name,access_token,instagram_business_account{id,username},tasks";
const pendingStates = new Map();

export function facebookOAuthConfig() {
  return {
    appId: process.env.META_APP_ID?.trim() ?? "",
    appSecret: process.env.META_APP_SECRET?.trim() ?? "",
    graphVersion: process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION,
    // Meta rejects http:// redirect URIs, so the callback is served over HTTPS on localhost (see npm run https:setup).
    redirectUri: process.env.FACEBOOK_REDIRECT_URI?.trim() || `https://localhost:${process.env.REELIO_HTTPS_PORT ?? 8789}/oauth/facebook/callback`,
  };
}

export function buildFacebookAuthorizationUrl({ appId, redirectUri, state, graphVersion = DEFAULT_GRAPH_VERSION }) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: META_SCOPES,
    state,
  });
  return `https://www.facebook.com/${graphVersion}/dialog/oauth?${params}`;
}

export function startFacebookOAuth() {
  const config = facebookOAuthConfig();
  if (!config.appId || !config.appSecret) throw new FacebookOAuthError(400, "Add the Meta app ID and app secret first.");
  pruneStates();
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now() + 10 * 60_000);
  return { authUrl: buildFacebookAuthorizationUrl({ ...config, state }), redirectUri: config.redirectUri };
}

export async function finishFacebookOAuth(code, state) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiresAt || expiresAt < Date.now()) throw new FacebookOAuthError(400, "This Facebook connection request expired. Start again from Settings.");
  if (!code) throw new FacebookOAuthError(400, "Facebook did not return an authorization code.");

  const config = facebookOAuthConfig();
  const shortLived = await exchangeToken(new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    client_secret: config.appSecret,
    code,
  }), config.graphVersion);
  const longLived = await exchangeToken(new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortLived.access_token,
  }), config.graphVersion);
  const userToken = longLived.access_token;
  if (!userToken) throw new FacebookOAuthError(400, "Meta did not return a user access token.");
  await saveLocalSettings({ metaUserAccessToken: userToken, metaGraphVersion: config.graphVersion });

  const pages = await listPages(userToken, config.graphVersion);
  if (pages.length === 1) return finalizePageSelection(pages[0]);
  if (pages.length === 0) return noPagesStatus(config.graphVersion);
  return pageSelectionStatus(pages, config.graphVersion);
}

export async function selectFacebookPage(pageId) {
  const config = facebookOAuthConfig();
  const userToken = process.env.META_USER_ACCESS_TOKEN?.trim();
  if (!userToken) throw new FacebookOAuthError(400, "Connect Facebook before choosing a Page.");
  const pages = await listPages(userToken, config.graphVersion);
  const page = pages.find((entry) => String(entry.id) === String(pageId));
  if (!page) throw new FacebookOAuthError(400, "That Facebook Page is no longer available. Reconnect and try again.");
  return finalizePageSelection(page);
}

export async function facebookConnectionStatus() {
  const config = facebookOAuthConfig();
  const pageId = process.env.FACEBOOK_PAGE_ID?.trim();
  const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim();
  const userToken = process.env.META_USER_ACCESS_TOKEN?.trim();
  const graphVersion = config.graphVersion;
  const configured = Boolean((config.appId && config.appSecret) || pageToken);
  const hasAuthorization = Boolean(userToken || pageToken);
  if (!configured) return { connected: false, configured: false, hasAuthorization, graphVersion, message: "Add your Meta app ID and secret, then connect Facebook." };
  if (!hasAuthorization) return { connected: false, configured: true, hasAuthorization: false, graphVersion, message: "Meta app credentials saved. Connect your Facebook Page next." };

  if (pageId && pageToken) {
    if (!/^v\d+\.\d+$/.test(graphVersion)) return { connected: false, configured: true, hasAuthorization: true, pageId, graphVersion, message: "Graph API version must look like v23.0." };
    try {
      const fields = new URLSearchParams({ fields: "id,name" });
      const response = await fetch(`https://graph.facebook.com/${graphVersion}/me?${fields}`, {
        headers: { Authorization: `Bearer ${pageToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return { connected: false, configured: true, hasAuthorization: true, pageId, graphVersion, message: result?.error?.message ?? "Meta rejected the Facebook Page credentials." };
      if (String(result.id) !== pageId) return { connected: false, configured: true, hasAuthorization: true, pageId, graphVersion, message: "The saved token does not belong to this Facebook Page ID. Copy the Page id and access_token from the same GET /me/accounts entry." };
      return { connected: true, configured: true, hasAuthorization: true, pageId, pageName: result.name ?? "Facebook Page", graphVersion, message: "Facebook Page token verified." };
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { connected: false, configured: true, hasAuthorization: true, pageId, graphVersion, message: timedOut ? "Facebook connection check timed out. Try again." : "Facebook connection could not be checked." };
    }
  }

  try {
    const pages = await listPages(userToken, graphVersion);
    return pages.length ? pageSelectionStatus(pages, graphVersion) : noPagesStatus(graphVersion);
  } catch (error) {
    return { connected: false, configured: true, hasAuthorization: true, graphVersion, message: error instanceof Error ? error.message : "Facebook connection could not be checked." };
  }
}

async function finalizePageSelection(page) {
  if (!page.access_token) throw new FacebookOAuthError(400, "Meta did not return a Page access token. Confirm your role on that Page and reconnect.");
  const settings = { facebookPageId: String(page.id), facebookPageAccessToken: page.access_token };
  const instagramId = page.instagram_business_account?.id;
  if (instagramId) settings.instagramAccountId = String(instagramId);
  await saveLocalSettings(settings);
  return facebookConnectionStatus();
}

function pageSelectionStatus(pages, graphVersion) {
  return { connected: false, configured: true, hasAuthorization: true, graphVersion, needsPageSelection: true, pages: pages.map((page) => ({ id: String(page.id), name: page.name ?? "Facebook Page" })), message: "Choose which Facebook Page to publish to." };
}

function noPagesStatus(graphVersion) {
  return { connected: false, configured: true, hasAuthorization: true, graphVersion, needsPageSelection: false, message: "No Facebook Page was found for this account. Add a Page in Meta Business Settings, then reconnect." };
}

async function exchangeToken(params, graphVersion) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/oauth/access_token?${params}`, { signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new FacebookOAuthError(400, result?.error?.message ?? "Facebook could not complete authorization.");
  return result;
}

async function listPages(userToken, graphVersion) {
  const params = new URLSearchParams({ fields: PAGE_FIELDS, access_token: userToken });
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/me/accounts?${params}`, { signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new FacebookOAuthError(400, result?.error?.message ?? "Meta could not list your Facebook Pages.");
  return Array.isArray(result.data) ? result.data : [];
}

function pruneStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) if (expiresAt < now) pendingStates.delete(state);
}

export class FacebookOAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "FacebookOAuthError";
    this.status = status;
  }
}
