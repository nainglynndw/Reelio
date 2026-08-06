import { config as loadEnv } from "dotenv";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { access, copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import cron from "node-cron";
import { allowedOrigin, HttpError, parseByteRange, readJsonBody } from "./http-utils.mjs";
import { createLocalVisualThemePlan, createPlatformCopy, createScriptDraft, createVisualThemePlan, findVisualCandidates, renderJob, ffmpegPath } from "./pipeline.mjs";
import { publishJob } from "./publishers.mjs";
import {
  addAutomation,
  addConversationAsset,
  addConversationDraft,
  addJob,
  addToolInput,
  addToolJob,
  getAutomation,
  getBrandKit,
  getCalendarEntry,
  getConversationAsset,
  getConversationDraft,
  getJob,
  getRoot,
  getToolInput,
  getToolJob,
  initializeStore,
  listAutomations,
  listCalendarEntries,
  listConversationAssets,
  listConversationDrafts,
  listJobs,
  listToolJobs,
  patchAutomation,
  patchCalendarEntry,
  patchConversationDraft,
  patchJob,
  patchToolJob,
  removeAutomation,
  removeAutomationCalendarEntries,
  removeConversationAsset,
  removeConversationDraft,
  removeJob,
  removeToolJob,
  replaceAutomationCalendarEntries,
  setBrandKit,
} from "./store.mjs";
import { cleanText, defaultTtsEngine, normalizePlatforms, normalizeSpeechLanguage, normalizeVideoRequest, normalizeVisualThemes, normalizeVoicePreviewRequest, validateTimezone, ValidationError } from "./validation.mjs";
import { getKokoroHealth } from "./kokoro-client.mjs";
import { getGeminiTtsHealth } from "./gemini-tts-client.mjs";
import { getVoxCpmHealth } from "./voxcpm-client.mjs";
import { getSttHealth } from "./stt-client.mjs";
import { generateGroundedText, generateText, textProviderConfig, validateGeminiApiKey } from "./text-provider.mjs";
import { curatedConversationPitches, normalizeStarterCriteria, parseConversationPitches } from "./conversation-starters.mjs";
import { saveLocalSettings, secretsFilePath } from "./settings-store.mjs";
import { BRIEF_MAX_CHARS, IDEA_SYSTEM_PROMPT, NEWS_RESEARCH_SYSTEM_PROMPT, NEWS_SYSTEM_PROMPT, normalizeIdeaOutput, studioIdea } from "./idea-generator.mjs";
import { assertJobActive, JobStoppedError, runWithJobControl, stopAllJobExecutions, stopJobExecution } from "./job-control.mjs";
import { finishYouTubeOAuth, startYouTubeOAuth, youtubeConnectionStatus, YouTubeOAuthError, youtubeOAuthConfig } from "./youtube-oauth.mjs";
import { finishTikTokOAuth, startTikTokOAuth, tiktokConnectionStatus, TikTokOAuthError, tiktokOAuthConfig } from "./tiktok-oauth.mjs";
import { facebookConnectionStatus, facebookOAuthConfig, FacebookOAuthError, finishFacebookOAuth, selectFacebookPage, startFacebookOAuth } from "./facebook-oauth.mjs";
import { executeTool, normalizeToolRequest, TOOL_DEFINITIONS, toolGroup, ToolValidationError } from "./tools/tool-runner.mjs";
import { ensureLongVideoShortThumbnails, longVideoTitleCardSeconds, prependTitleCard } from "./tools/long-video.mjs";
import { formatSrt, parseSubtitles } from "./tools/subtitles.mjs";
import { getWebMediaHealth } from "./tools/web-media.mjs";
import { cachedVoicePreview, generateVoicePreview } from "./voice-preview.mjs";
import {
  BrandKitError,
  brandAssetRule,
  clearBrandAsset,
  defaultBrandKit,
  publicBrandKit,
  sanitizeBrandKitSnapshot,
  snapshotBrandKit,
  updateBrandKit,
  validateBrandAssetUpload,
  validateProbedBrandAsset,
  withBrandAsset,
} from "./brand-kit.mjs";
import { probeMedia } from "./media-probe.mjs";
import {
  buildConversationDocument,
  buildConversationTimeline,
  compileConversationStoryItems,
  conversationAssetIds,
  conversationBrowserHealth,
  defaultConversationDraft,
  normalizeConversationDraft,
  renderConversationJob,
} from "./conversation-video.mjs";
import { activeAutomationJob, automationPublishMode, buildCalendarEntries, calendarCronExpressions, calendarDateInTimezone, normalizeAutomationCreate, normalizeAutomationPatch } from "./automations.mjs";
import { generateAutomationBrief, firstLine } from "./automation-brief.mjs";
import { assignModePreviewShowcase, publicModePreviewManifest, resolveModePreviewAsset } from "./mode-previews.mjs";
import {
  AuthError,
  assertEntitlement,
  assertResourceAccess,
  authenticateCredentials,
  authenticateRequest,
  authSetupRequired,
  clearSessionCookie,
  consumeRenderAllowance,
  createSession,
  deleteSession,
  registerOwner,
  sessionCookie,
} from "./auth.mjs";

// Load the worker-owned secrets file first (highest precedence), then the static .env files.
// Runtime OAuth/settings writes go to the secrets file so the web dev server never restarts on them.
loadEnv({ path: [secretsFilePath(), ".env.local", ".env"], quiet: true });

const port = Number(process.env.REELIO_SERVICE_PORT ?? 8788);
const maxBodyBytes = Number(process.env.REELIO_MAX_BODY_BYTES ?? 65_536);
const allowedOrigins = new Set((process.env.REELIO_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((value) => value.trim()).filter(Boolean));
const queue = [];
const toolQueue = [];
const calendarBriefQueue = [];
const schedules = new Map();
const stopRequests = new Set();
const toolStopRequests = new Set();
const activeToolCounts = { media: 0, model: 0 };
let working = false;
let voicePreviewPromise = null;
let calendarBriefWorking = false;
let shuttingDown = false;
const authAttempts = new Map();

const store = await initializeStore();
await materializeLegacyLongVideoJobs();
queue.push(...store.recoveredJobIds);
toolQueue.push(...store.recoveredToolJobIds);
for (const automation of listAutomations()) registerSchedule(automation);
for (const automation of listAutomations().filter((item) => item.briefPlanning)) {
  calendarBriefQueue.push(...listCalendarEntries().filter((entry) => entry.automationId === automation.id && entry.briefState === "pending").map((entry) => entry.id));
}
if (queue.length) void workQueue();
if (toolQueue.length) pumpToolQueue();
if (calendarBriefQueue.length) void pumpCalendarBriefQueue();

const requestHandler = async (request, response) => {
  const requestOrigin = request.headers.origin;
  setResponseHeaders(response, requestOrigin);
  if (!allowedOrigin(requestOrigin, allowedOrigins)) return json(response, 403, { error: "Origin is not allowed." });
  if (request.method === "OPTIONS") return end(response, 204);
  const url = new URL(request.url, `http://${request.headers.host ?? `localhost:${port}`}`);

  try {
    if (shuttingDown && request.method !== "GET") return json(response, 503, { error: "The local worker is shutting down." });
    if (request.method === "GET" && url.pathname === "/health") {
      const [gemini, tts, voxcpm2, stt, webMedia, conversationRenderer] = await Promise.all([
        validateGeminiApiKey(),
        getKokoroHealth(),
        getVoxCpmHealth(),
        getSttHealth(),
        getWebMediaHealth(),
        conversationBrowserHealth(),
      ]);
      const geminiTts = getGeminiTtsHealth();
      const text = { ...textProviderConfig(), googleReady: gemini.ready };
      return json(response, 200, {
        ok: true,
        service: "Reelio local worker",
        version: "1.0.0",
        database: { ready: true, engine: "sqlite", location: "REELIO_DATA_DIR" },
        authentication: { ready: true, setupRequired: authSetupRequired() },
        uptimeSeconds: Math.round(process.uptime()),
        queue: { waiting: queue.length, working, toolsWaiting: toolQueue.length, toolsRunning: activeToolCounts.media + activeToolCounts.model },
        ffmpeg: Boolean(ffmpegPath),
        providers: {
          gemini: gemini.ready,
          geminiTts: gemini.ready && geminiTts.ready,
          kokoro: tts.ready,
          voxcpm2: voxcpm2.ready,
          openrouter: Boolean(process.env.OPENROUTER_API_KEY),
          pexels: Boolean(process.env.PEXELS_API_KEY),
          pixabay: Boolean(process.env.PIXABAY_API_KEY),
          youtube: Boolean(process.env.YOUTUBE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN),
          tiktok: Boolean(process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_REFRESH_TOKEN),
          facebook: Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.META_GRAPH_VERSION),
          instagram: Boolean(process.env.INSTAGRAM_ACCOUNT_ID && process.env.META_USER_ACCESS_TOKEN && process.env.META_GRAPH_VERSION && process.env.PUBLIC_MEDIA_BASE_URL),
        },
        tts,
        voxcpm2,
        stt,
        webMedia,
        conversationRenderer,
        geminiTts,
        ttsRouting: "English: Kokoro or Gemini; non-English: VoxCPM2 or Gemini",
        text,
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      await access(ffmpegPath);
      return json(response, 200, { ready: !shuttingDown, ffmpeg: true, state: "writable" });
    }
    if (request.method === "GET" && url.pathname === "/mode-previews") {
      return json(response, 200, await publicModePreviewManifest());
    }
    const publicModePreviewMatch = url.pathname.match(/^\/mode-previews\/assets\/([a-z0-9-]+)$/);
    if (request.method === "GET" && publicModePreviewMatch) {
      const asset = await resolveModePreviewAsset(publicModePreviewMatch[1]);
      return asset?.file ? streamAsset(request, response, url, asset.file) : json(response, 404, { error: "Mode preview not found." });
    }
    if (request.method === "GET" && url.pathname === "/auth/session") {
      const identity = authenticateRequest(request);
      return json(response, 200, {
        authenticated: Boolean(identity),
        setupRequired: authSetupRequired(),
        user: identity?.user ?? null,
      });
    }
    if (request.method === "POST" && url.pathname === "/auth/register") {
      assertAuthAttemptAllowed(request);
      const body = await readJsonBody(request, maxBodyBytes);
      try {
        const user = await registerOwner(body);
        const session = createSession(user.id);
        clearAuthAttempts(request);
        response.setHeader("Set-Cookie", sessionCookie(session.token, request, session.expiresAt));
        return json(response, 201, { authenticated: true, setupRequired: false, user });
      } catch (error) {
        recordAuthFailure(request);
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/auth/login") {
      assertAuthAttemptAllowed(request);
      const body = await readJsonBody(request, maxBodyBytes);
      try {
        const user = await authenticateCredentials(body.email, body.password);
        const session = createSession(user.id);
        clearAuthAttempts(request);
        response.setHeader("Set-Cookie", sessionCookie(session.token, request, session.expiresAt));
        return json(response, 200, { authenticated: true, setupRequired: false, user });
      } catch (error) {
        recordAuthFailure(request);
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      deleteSession(request);
      response.setHeader("Set-Cookie", clearSessionCookie(request));
      return json(response, 200, { authenticated: false });
    }
    const identity = authenticateRequest(request);
    const publicOAuthCallback = request.method === "GET" && /^\/oauth\/(?:youtube|tiktok|facebook)\/callback$/.test(url.pathname);
    if (!identity && !publicOAuthCallback) return json(response, 401, { error: "Sign in to access this Reelio workspace.", code: "AUTH_REQUIRED" });
    if (identity) {
      assertEntitlement(identity, requiredEntitlement(request, url));
      assertOwnedPathAccess(identity, url);
    }
    if (request.method === "GET" && url.pathname === "/conversation-drafts") {
      return json(response, 200, {
        drafts: listConversationDrafts().filter((draft) => draft.ownerUserId === identity.user.id).map(publicConversationDraft),
      });
    }
    if (request.method === "POST" && url.pathname === "/conversation-drafts") {
      assertEntitlement(identity, "mode.conversation");
      const body = await readJsonBody(request, maxBodyBytes);
      const base = defaultConversationDraft(identity.user.id);
      const draft = normalizeConversationDraft({ ...base, ...body, id: base.id, revision: 1, approved: false }, { ownerUserId: identity.user.id });
      await addConversationDraft(draft);
      return json(response, 201, { draft: publicConversationDraft(draft) });
    }
    const conversationDraftMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)$/);
    if (request.method === "GET" && conversationDraftMatch) {
      const draft = getConversationDraft(conversationDraftMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      return json(response, 200, { draft: publicConversationDraft(draft) });
    }
    if (request.method === "PATCH" && conversationDraftMatch) {
      assertEntitlement(identity, "mode.conversation");
      const existing = getConversationDraft(conversationDraftMatch[1]);
      if (!existing) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, existing);
      const body = await readJsonBody(request, Math.max(maxBodyBytes, 512_000));
      if (Number(body.revision) !== existing.revision) throw new ValidationError("This conversation changed in another view. Reload it before saving.", 409);
      const draft = normalizeConversationDraft({
        ...existing,
        ...body,
        id: existing.id,
        ownerUserId: existing.ownerUserId,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
      }, { ownerUserId: existing.ownerUserId });
      await assertConversationDraftAssets(draft, identity);
      await patchConversationDraft(existing.id, draft);
      return json(response, 200, { draft: publicConversationDraft(draft) });
    }
    if (request.method === "DELETE" && conversationDraftMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationDraftMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      await removeConversationDraft(draft.id);
      await removeUnreferencedConversationAssets(draft.id, identity.user.id);
      return json(response, 200, { ok: true, id: draft.id });
    }
    const conversationDuplicateMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/duplicate$/);
    if (request.method === "POST" && conversationDuplicateMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationDuplicateMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const duplicate = await duplicateConversationDraft(draft, identity.user.id);
      await addConversationDraft(duplicate);
      return json(response, 201, { draft: publicConversationDraft(duplicate) });
    }
    const conversationPreviewMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/preview$/);
    if (request.method === "GET" && conversationPreviewMatch) {
      const draft = getConversationDraft(conversationPreviewMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const normalized = normalizeConversationDraft(draft, { ownerUserId: draft.ownerUserId });
      const timeline = buildConversationTimeline(normalized);
      const assetUrls = Object.fromEntries(conversationAssetIds(normalized).map((id) => [id, `/conversation-assets/${encodeURIComponent(id)}`]));
      const activeBrandKit = getBrandKit(identity.user.id) ?? defaultBrandKit();
      const musicUrl = normalized.audio.musicSource === "upload"
        ? assetUrls[normalized.audio.musicAssetId] ?? ""
        : normalized.audio.musicSource === "brand" && normalized.applyBrandKit && activeBrandKit.assets?.music?.file
          ? "/brand-kit/assets/music"
          : "";
      return conversationHtml(response, 200, buildConversationDocument(normalized, timeline, { assetUrls, preview: true, musicUrl }));
    }
    const conversationStarterMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/story-starters$/);
    if (request.method === "POST" && conversationStarterMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationStarterMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const body = await readJsonBody(request, maxBodyBytes);
      if (body.confirmed !== true) throw new ValidationError("Confirm story idea generation before using the configured AI provider.");
      const recentPremises = listConversationDrafts()
        .filter((item) => item.ownerUserId === identity.user.id && item.id !== draft.id)
        .map((item) => item.generation?.premise)
        .filter(Boolean)
        .slice(-20);
      const result = await generateConversationStoryPitches(draft, body, recentPremises);
      return json(response, 200, result);
    }
    const conversationGenerateMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/generate$/);
    if (request.method === "POST" && conversationGenerateMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationGenerateMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const body = await readJsonBody(request, maxBodyBytes);
      const updated = await generateConversationDraft(draft, body);
      await patchConversationDraft(draft.id, updated);
      return json(response, 200, { draft: publicConversationDraft(updated) });
    }
    const conversationTranslateMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/translate$/);
    if (request.method === "POST" && conversationTranslateMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationTranslateMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const body = await readJsonBody(request, maxBodyBytes);
      if (body.confirmed !== true) throw new ValidationError("Confirm AI translation before sending conversation text to the selected provider.");
      const translated = await translateConversationDraft(draft, body.targetLanguage, identity.user.id);
      await addConversationDraft(translated);
      return json(response, 201, { draft: publicConversationDraft(translated) });
    }
    const conversationAssetUploadMatch = url.pathname.match(/^\/conversation-drafts\/([^/]+)\/assets$/);
    if (request.method === "POST" && conversationAssetUploadMatch) {
      assertEntitlement(identity, "mode.conversation");
      const draft = getConversationDraft(conversationAssetUploadMatch[1]);
      if (!draft) return json(response, 404, { error: "Conversation draft not found." });
      assertResourceAccess(identity, draft);
      const asset = await receiveConversationAsset(request, draft, url.searchParams.get("kind") || "image", identity.user.id);
      return json(response, 201, { asset: publicConversationAsset(asset) });
    }
    const conversationAssetMatch = url.pathname.match(/^\/conversation-assets\/([^/]+)$/);
    if (request.method === "GET" && conversationAssetMatch) {
      const asset = getConversationAsset(conversationAssetMatch[1]);
      if (!asset) return json(response, 404, { error: "Conversation asset not found." });
      assertResourceAccess(identity, asset);
      return streamAsset(request, response, url, asset.file);
    }
    if (request.method === "DELETE" && conversationAssetMatch) {
      assertEntitlement(identity, "mode.conversation");
      const asset = getConversationAsset(conversationAssetMatch[1]);
      if (!asset) return json(response, 404, { error: "Conversation asset not found." });
      assertResourceAccess(identity, asset);
      if (conversationAssetReferenced(asset.id)) throw new ValidationError("Remove this asset from its conversation before deleting it.", 409);
      await rm(path.dirname(asset.file), { recursive: true, force: true });
      await removeConversationAsset(asset.id);
      return json(response, 200, { ok: true, id: asset.id });
    }
    if (request.method === "GET" && url.pathname === "/publishing/readiness") {
      const [youtube, tiktok, facebook, instagram] = await Promise.all([youtubeConnectionStatus(), tiktokConnectionStatus(), facebookConnectionStatus(), instagramConnectionStatus()]);
      return json(response, 200, {
        accounts: {
          youtube: { ready: youtube.connected, setupComplete: youtube.configured && youtube.hasAuthorization, accountName: youtube.channelTitle, reason: youtube.connected ? "YouTube channel connected." : youtube.message ?? "Connect a YouTube channel in Settings." },
          tiktok: { ready: tiktok.connected && tiktok.uploadReady !== false, setupComplete: tiktok.configured && tiktok.hasAuthorization, accountName: tiktok.displayName, reason: tiktok.connected && tiktok.uploadReady !== false ? "TikTok draft upload access is ready." : tiktok.message ?? "Connect TikTok with video.upload permission in Settings." },
          facebook: { ready: facebook.connected, setupComplete: facebook.configured && facebook.hasAuthorization, accountName: facebook.pageName, reason: facebook.connected ? "Facebook Page token verified." : facebook.message },
          instagram: { ready: instagram.connected, setupComplete: instagram.configured, accountName: instagram.username, reason: instagram.connected ? "Instagram Professional account verified." : instagram.message },
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/publishing/facebook/status") {
      return json(response, 200, { ...(await facebookConnectionStatus()), redirectUri: facebookOAuthConfig().redirectUri });
    }
    if (request.method === "POST" && url.pathname === "/oauth/facebook/start") {
      return json(response, 200, startFacebookOAuth());
    }
    if (request.method === "POST" && url.pathname === "/oauth/facebook/select-page") {
      const body = await readJsonBody(request, maxBodyBytes);
      const pageId = cleanText(body.pageId, "Facebook Page ID", 1, 64);
      return json(response, 200, await selectFacebookPage(pageId));
    }
    if (request.method === "GET" && url.pathname === "/oauth/facebook/callback") {
      const oauthError = url.searchParams.get("error");
      const oauthDescription = url.searchParams.get("error_description");
      if (oauthError) return html(response, 400, oauthCallbackPage("Facebook", false, oauthDescription || (oauthError === "access_denied" ? "You cancelled Facebook access." : `Facebook returned: ${oauthError}`), "#4b8cff"));
      try {
        const status = await finishFacebookOAuth(url.searchParams.get("code"), url.searchParams.get("state"));
        const message = status.connected ? `${status.pageName ?? "Facebook Page"} is connected.` : status.message ?? "Facebook is connected. Choose a Page in Settings.";
        return html(response, 200, oauthCallbackPage("Facebook", true, message, "#4b8cff"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Facebook connection failed.";
        return html(response, error instanceof FacebookOAuthError ? error.status : 500, oauthCallbackPage("Facebook", false, message, "#4b8cff"));
      }
    }
    if (request.method === "GET" && url.pathname === "/publishing/instagram/status") {
      return json(response, 200, await instagramConnectionStatus());
    }
    if (request.method === "POST" && url.pathname === "/settings") {
      const body = await readJsonBody(request, maxBodyBytes);
      let saved;
      try { saved = await saveLocalSettings(body); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Settings could not be saved."); }
      return json(response, 200, { ok: true, saved, text: textProviderConfig() });
    }
    if (request.method === "GET" && url.pathname === "/brand-kit") {
      return json(response, 200, { brandKit: publicBrandKit(getBrandKit(identity.user.id) ?? defaultBrandKit()) });
    }
    if (request.method === "PATCH" && url.pathname === "/brand-kit") {
      const body = await readJsonBody(request, maxBodyBytes);
      const brandKit = await setBrandKit(updateBrandKit(getBrandKit(identity.user.id) ?? defaultBrandKit(), body), identity.user.id);
      return json(response, 200, { brandKit: publicBrandKit(brandKit) });
    }
    const brandAssetMatch = url.pathname.match(/^\/brand-kit\/assets\/([^/]+)$/);
    if (request.method === "POST" && brandAssetMatch) {
      const brandKit = await receiveBrandAsset(request, brandAssetMatch[1], identity.user.id);
      return json(response, 201, { brandKit: publicBrandKit(brandKit) });
    }
    if (request.method === "DELETE" && brandAssetMatch) {
      const brandKit = await setBrandKit(clearBrandAsset(getBrandKit(identity.user.id) ?? defaultBrandKit(), brandAssetMatch[1]), identity.user.id);
      return json(response, 200, { brandKit: publicBrandKit(brandKit) });
    }
    if (request.method === "GET" && brandAssetMatch) {
      const asset = (getBrandKit(identity.user.id) ?? defaultBrandKit()).assets?.[brandAssetMatch[1]];
      if (!asset?.file) return json(response, 404, { error: "Brand asset not found." });
      return streamAsset(request, response, url, asset.file);
    }
    if (request.method === "GET" && url.pathname === "/oauth/youtube/status") {
      return json(response, 200, { ...(await youtubeConnectionStatus()), redirectUri: youtubeOAuthConfig().redirectUri });
    }
    if (request.method === "POST" && url.pathname === "/oauth/youtube/start") {
      return json(response, 200, startYouTubeOAuth());
    }
    if (request.method === "GET" && url.pathname === "/oauth/youtube/callback") {
      const oauthError = url.searchParams.get("error");
      if (oauthError) return html(response, 400, oauthCallbackPage("YouTube", false, oauthError === "access_denied" ? "You cancelled YouTube access." : `Google returned: ${oauthError}`, "#ff2846"));
      try {
        const status = await finishYouTubeOAuth(url.searchParams.get("code"), url.searchParams.get("state"));
        return html(response, 200, oauthCallbackPage("YouTube", true, `${status.channelTitle ?? "YouTube"} is connected.`, "#ff2846"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "YouTube connection failed.";
        return html(response, error instanceof YouTubeOAuthError ? error.status : 500, oauthCallbackPage("YouTube", false, message, "#ff2846"));
      }
    }
    if (request.method === "GET" && url.pathname === "/oauth/tiktok/status") {
      return json(response, 200, { ...(await tiktokConnectionStatus()), redirectUri: tiktokOAuthConfig().redirectUri });
    }
    if (request.method === "POST" && url.pathname === "/oauth/tiktok/start") {
      return json(response, 200, startTikTokOAuth());
    }
    if (request.method === "GET" && url.pathname === "/oauth/tiktok/callback") {
      const oauthError = url.searchParams.get("error");
      const oauthDescription = url.searchParams.get("error_description");
      if (oauthError) return html(response, 400, oauthCallbackPage("TikTok", false, oauthDescription || (oauthError === "access_denied" ? "You cancelled TikTok access." : `TikTok returned: ${oauthError}`), "#16131c"));
      try {
        const status = await finishTikTokOAuth(url.searchParams.get("code"), url.searchParams.get("state"));
        return html(response, 200, oauthCallbackPage("TikTok", true, `${status.displayName ?? "TikTok"} is connected.`, "#16131c"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "TikTok connection failed.";
        return html(response, error instanceof TikTokOAuthError ? error.status : 500, oauthCallbackPage("TikTok", false, message, "#16131c"));
      }
    }
    if (request.method === "POST" && url.pathname === "/idea") {
      const body = await readJsonBody(request, maxBodyBytes);
      const language = cleanText(body.language ?? "English", "Language", 1, 80);
      const category = cleanText(body.category ?? "Curious knowledge", "Category", 1, 100);
      const duration = cleanText(body.duration ?? "60–90 sec", "Duration", 1, 40);
      const focus = typeof body.focus === "string" && body.focus.trim() ? cleanText(body.focus, "Topic focus", 1, 300) : "";
      const generated = await generateText({
        system: IDEA_SYSTEM_PROMPT,
        user: focus
          ? `Suggest a fact-safe, specific ${duration} knowledge-video brief about "${focus}". Keep it in the "${category}" style. Write it in ${language}.`
          : `Suggest a fact-safe ${duration} knowledge-video brief for the "${category}" category. Write it in ${language}.`,
        maxTokens: 600,
        temperature: 0.65,
        thinkingLevel: "medium",
        task: "creative",
      });
      if (!generated && language.toLowerCase() !== "english") throw new ValidationError(`Add a Gemini API key in Settings to generate ${language} ideas.`);
      const idea = generated ? normalizeIdeaOutput(generated.text) : studioIdea(category);
      if (!idea) throw new ValidationError("The AI did not return a usable idea. Try again.", 502);
      return json(response, 200, generated
        ? { idea, mode: "ai", provider: generated.provider, model: generated.model, fallback: generated.fallback ?? null }
        : { idea, mode: "studio", provider: "studio" });
    }
    if (request.method === "POST" && url.pathname === "/news") {
      const body = await readJsonBody(request, maxBodyBytes);
      const language = cleanText(body.language ?? "English", "Language", 1, 80);
      const category = cleanText(body.category ?? "Curious knowledge", "Category", 1, 100);
      const duration = cleanText(body.duration ?? "60–90 sec", "Duration", 1, 40);
      const focus = typeof body.focus === "string" && body.focus.trim() ? cleanText(body.focus, "Topic focus", 1, 300) : "";
      const today = new Date().toISOString().slice(0, 10);
      const research = await generateGroundedText({
        system: NEWS_RESEARCH_SYSTEM_PROMPT,
        user: focus
          ? `Today is ${today}. Research the latest verifiable news about "${focus}" (within ${category}) for a factual knowledge video.`
          : `Today is ${today}. Research current ${category} news now for a factual knowledge video.`,
        maxTokens: 650,
        temperature: 0.2,
        recentDays: 7,
        thinkingLevel: "high",
      });
      if (!research) throw new ValidationError("Add a Gemini API key in Settings to search current news.", 503);
      if (!research.sources?.length) throw new ValidationError("No verified recent story was found. Try again.", 502);
      const generated = await generateText({
        system: NEWS_SYSTEM_PROMPT,
        user: `Today is ${today}. Create one ${duration} brief in ${language} using only this source-grounded research:\n\n${research.text}`,
        maxTokens: 600,
        temperature: 0.25,
        thinkingLevel: "medium",
        task: "creative",
      });
      const idea = normalizeIdeaOutput(generated?.text);
      if (!idea) throw new ValidationError("No usable current-news idea was produced. Try again.", 502);
      return json(response, 200, { idea, mode: "news", provider: generated.provider, model: generated.model, fallback: generated.fallback ?? null, sources: research.sources });
    }
    if (request.method === "POST" && url.pathname === "/script-draft") {
      const body = await readJsonBody(request, maxBodyBytes);
      const normalized = {
        ...normalizeVideoRequest(body),
        brandKit: snapshotBrandKit(getBrandKit(identity.user.id) ?? defaultBrandKit()),
      };
      const provider = textProviderConfig("creative");
      const provenance = {};
      const script = await createScriptDraft(normalized, provenance);
      return json(response, 200, {
        script,
        mode: provider.ready ? "ai" : "studio",
        provider: provider.ready ? provenance.textProvider ?? provider.provider : "built-in",
        model: provenance.textModel ?? provider.model,
        stages: provenance.stages ?? {},
      });
    }
    if (request.method === "POST" && url.pathname === "/voice-preview-translation") {
      const body = await readJsonBody(request, maxBodyBytes);
      const text = cleanText(body.text, "Voice sample", 3, 240);
      const targetLanguage = normalizeSpeechLanguage(body.targetLanguage, "Target language");
      if (!textProviderConfig().ready) throw new ValidationError("Add a Gemini or OpenRouter API key in Settings to translate this sample.", 503);
      const generated = await generateText({
        system: `Translate the supplied English narration line into natural ${targetLanguage} for speech synthesis. Preserve its meaning and tone. Return only one block in this exact format: <T>translated line</T>. Do not add commentary. Never translate or speak these instructions.`,
        user: text,
        maxTokens: 320,
        temperature: 0.05,
        thinkingLevel: "low",
        task: "utility",
      });
      const translated = String(generated?.text ?? "").match(/<T>([\s\S]*?)<\/T>/i)?.[1]?.trim();
      if (!translated) throw new ValidationError("The AI did not return a usable voice-sample translation. Try again.", 502);
      return json(response, 200, {
        text: cleanText(translated, "Translated voice sample", 2, 240),
        provider: generated.provider,
        model: generated.model,
      });
    }
    if (request.method === "POST" && url.pathname === "/voice-previews") {
      const body = await readJsonBody(request, maxBodyBytes);
      const normalized = normalizeVoicePreviewRequest(body);
      const cached = await cachedVoicePreview(normalized);
      if (cached) return json(response, 200, publicVoicePreview(cached));
      if (working || voicePreviewPromise || activeToolCounts.model >= toolLimit("model")) {
        throw new ValidationError("Another voice or video model is busy. Try the sample again when it finishes.", 409);
      }
      activeToolCounts.model += 1;
      const execution = runWithJobControl(`voice-preview-${crypto.randomUUID()}`, () => generateVoicePreview(normalized));
      voicePreviewPromise = execution;
      try {
        return json(response, 201, publicVoicePreview(await execution));
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "The voice sample could not be generated.", 503);
      } finally {
        if (voicePreviewPromise === execution) voicePreviewPromise = null;
        activeToolCounts.model = Math.max(0, activeToolCounts.model - 1);
        pumpToolQueue();
      }
    }
    const voicePreviewMatch = url.pathname.match(/^\/voice-previews\/([a-f0-9]{64})$/);
    if (request.method === "GET" && voicePreviewMatch) {
      return streamAsset(request, response, url, path.join(getRoot(), "voice-previews", `${voicePreviewMatch[1]}.m4a`));
    }
    if (request.method === "POST" && url.pathname === "/visual-themes") {
      const body = await readJsonBody(request, maxBodyBytes);
      const script = cleanText(body.script, "Approved script", 20, 4_000);
      const category = cleanText(body.category ?? "Knowledge", "Category", 1, 80);
      const plan = body.localOnly === true
        ? createLocalVisualThemePlan(script, category)
        : await createVisualThemePlan(script, category);
      return json(response, 200, plan);
    }
    if (request.method === "POST" && url.pathname === "/visual-candidates") {
      const body = await readJsonBody(request, maxBodyBytes);
      const themes = normalizeVisualThemes(body.themes);
      const requestedPage = Number(body.page ?? 1);
      if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 20) {
        throw new ValidationError("Stock search page must be between 1 and 20.");
      }
      const result = await findVisualCandidates(themes, { page: requestedPage });
      return json(response, 200, result);
    }
    if (request.method === "POST" && url.pathname === "/mode-previews/assign") {
      const body = await readJsonBody(request, maxBodyBytes);
      try {
        const showcaseOwner = body.modeId === "long-video-shorts"
          ? getToolJob(String(body.ownerId ?? ""))
          : getJob(String(body.ownerId ?? ""));
        if (showcaseOwner) assertResourceAccess(identity, showcaseOwner);
        if (body.modeId === "long-video-shorts") {
          const owner = getToolJob(String(body.ownerId ?? ""));
          const thumbnails = await ensureLongVideoShortThumbnails(owner);
          if (thumbnails.changed) await patchToolJob(owner.id, { assets: thumbnails.assets, metadata: thumbnails.metadata });
        }
        const showcase = await assignModePreviewShowcase(body.modeId, body.ownerId);
        return json(response, 200, { showcase });
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "The showcase could not be updated.");
      }
    }
    if (request.method === "GET" && url.pathname === "/tools") {
      return json(response, 200, { tools: TOOL_DEFINITIONS, scheduler: { mediaConcurrency: toolLimit("media"), modelConcurrency: toolLimit("model") } });
    }
    if (request.method === "POST" && url.pathname === "/tool-inputs") {
      const input = await receiveToolInput(request, identity.user.id);
      return json(response, 201, { input: publicToolInput(input) });
    }
    if (request.method === "GET" && url.pathname === "/tool-jobs") {
      return json(response, 200, { jobs: listToolJobs().filter((job) => job.ownerUserId === identity.user.id).map(publicToolJob) });
    }
    if (request.method === "POST" && url.pathname === "/tool-jobs") {
      const body = await readJsonBody(request, maxBodyBytes);
      if (["long-video-analyze", "long-video-render"].includes(String(body.toolId))) assertEntitlement(identity, "mode.long");
      const job = await enqueueToolJob(body, identity);
      return json(response, 202, { job: publicToolJob(job) });
    }
    const toolJobMatch = url.pathname.match(/^\/tool-jobs\/([^/]+)$/);
    if (request.method === "GET" && toolJobMatch) {
      const job = getToolJob(toolJobMatch[1]);
      return job ? json(response, 200, { job: publicToolJob(job) }) : json(response, 404, { error: "Tool job not found." });
    }
    if (request.method === "DELETE" && toolJobMatch) {
      const job = getToolJob(toolJobMatch[1]);
      if (!job) return json(response, 404, { error: "Tool job not found." });
      if (job.state === "running" || job.state === "queued") throw new ToolValidationError("Stop this tool job before deleting it.", 409);
      await rm(path.join(getRoot(), "tool-jobs", job.id), { recursive: true, force: true });
      await removeToolJob(job.id);
      return json(response, 200, { ok: true, id: job.id });
    }
    const toolRetryMatch = url.pathname.match(/^\/tool-jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && toolRetryMatch) {
      const job = getToolJob(toolRetryMatch[1]);
      if (!job) return json(response, 404, { error: "Tool job not found." });
      if (job.state !== "failed" && job.state !== "stopped") throw new ToolValidationError("Only failed or stopped tool jobs can be retried.", 409);
      const retried = await patchToolJob(job.id, { state: "queued", stage: "queued", progress: 0, message: "Queued for retry", error: null, assets: null, metadata: null });
      toolStopRequests.delete(job.id);
      toolQueue.push(job.id);
      pumpToolQueue();
      return json(response, 202, { job: publicToolJob(retried) });
    }
    const toolStopMatch = url.pathname.match(/^\/tool-jobs\/([^/]+)\/stop$/);
    if (request.method === "POST" && toolStopMatch) {
      const job = getToolJob(toolStopMatch[1]);
      if (!job) return json(response, 404, { error: "Tool job not found." });
      if (job.state !== "running" && job.state !== "queued") throw new ToolValidationError("This tool job is not running.", 409);
      if (job.state === "queued") {
        for (let index = toolQueue.length - 1; index >= 0; index -= 1) if (toolQueue[index] === job.id) toolQueue.splice(index, 1);
        const stopped = await patchToolJob(job.id, { state: "stopped", stage: "stopped", message: "Tool job stopped", error: null });
        return json(response, 200, { job: publicToolJob(stopped) });
      } else {
        toolStopRequests.add(job.id);
        stopJobExecution(job.id);
        const stopping = await patchToolJob(job.id, { message: "Stopping tool job…" });
        return json(response, 202, { job: publicToolJob(stopping) });
      }
    }
    const toolAssetMatch = url.pathname.match(/^\/tool-jobs\/([^/]+)\/assets\/([^/]+)$/);
    if (request.method === "GET" && toolAssetMatch) {
      const job = getToolJob(toolAssetMatch[1]);
      const asset = job?.assets?.[toolAssetMatch[2]];
      if (!asset?.file) return json(response, 404, { error: "Tool asset not found." });
      return streamAsset(request, response, url, asset.file);
    }

    if (request.method === "GET" && url.pathname === "/jobs") return json(response, 200, { jobs: listJobs().filter((job) => job.ownerUserId === identity.user.id).map(publicJob) });
    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request, maxBodyBytes);
      if (body?.creationMode === "message-conversation") assertEntitlement(identity, "mode.conversation");
      assertVideoRequestOwnership(identity, body);
      const job = await enqueue(body, { type: "manual" }, identity.user.id);
      return json(response, 202, { job: publicJob(job) });
    }
    if (request.method === "POST" && url.pathname === "/agent-trigger") {
      const body = await readJsonBody(request, maxBodyBytes);
      const objective = cleanText(body.objective, "Agent objective", 3, 700);
      const job = await enqueue({
        prompt: objective,
        category: body.category ?? "AI selected",
        duration: body.duration ?? "60–90 sec",
        language: body.language ?? "English",
        subtitleLanguage: body.subtitleLanguage ?? "English",
        platforms: body.platforms ?? [],
      }, { type: "agent", objective }, identity.user.id);
      return json(response, 202, { job: publicJob(job) });
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = getJob(jobMatch[1]);
      return job ? json(response, 200, { job: publicJob(job) }) : json(response, 404, { error: "Job not found." });
    }
    const metadataRegenerateMatch = url.pathname.match(/^\/jobs\/([^/]+)\/metadata\/regenerate$/);
    if (request.method === "POST" && metadataRegenerateMatch) {
      const job = getJob(metadataRegenerateMatch[1]);
      if (!job) return json(response, 404, { error: "Video not found." });
      if (job.state !== "completed") throw new ValidationError("Wait for the video to finish before regenerating its publishing metadata.", 409);
      if (listJobs().some((item) => item.state === "running" || item.state === "queued")) {
        throw new ValidationError("Wait for the current video generation to finish before regenerating publishing metadata.", 409);
      }
      const updated = await regeneratePublishingMetadata(job);
      return json(response, 200, { job: publicJob(updated) });
    }
    if (request.method === "DELETE" && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) return json(response, 404, { error: "Video not found." });
      if (job.state === "running" || job.state === "queued") throw new ValidationError("Wait for rendering to finish before deleting this video.", 409);
      if (job.metadata?.creationMode === "long-video-shorts" && job.metadata?.legacyPackage && job.metadata?.sourceToolJobId && job.metadata?.sourceAssetKey) {
        const owner = getToolJob(job.metadata.sourceToolJobId);
        if (owner) {
          const dismissed = new Set(Array.isArray(owner.metadata?.libraryDismissedAssetKeys) ? owner.metadata.libraryDismissedAssetKeys.map(String) : []);
          dismissed.add(job.metadata.sourceAssetKey);
          await patchToolJob(owner.id, { metadata: { ...(owner.metadata ?? {}), libraryDismissedAssetKeys: Array.from(dismissed) } });
        }
      }
      await rm(path.join(getRoot(), "generated", job.id), { recursive: true, force: true });
      await removeJob(job.id);
      return json(response, 200, { ok: true, id: job.id });
    }
    const retryMatch = url.pathname.match(/^\/jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      const job = getJob(retryMatch[1]);
      if (!job) return json(response, 404, { error: "Job not found." });
      if (job.state !== "failed" && job.state !== "stopped") return json(response, 409, { error: "Only failed or stopped jobs can be retried." });
      if (listJobs().some((item) => item.id !== job.id && (item.state === "running" || item.state === "queued"))) {
        throw new ValidationError("Another video is already generating. Wait for it to finish before retrying.", 409);
      }
      const retried = await patchJob(job.id, { state: "queued", stage: "recovery", progress: 0, message: "Queued for retry", error: null, assets: null, metadata: null, reviewState: "pending", publishState: "not_started", publishResults: null });
      stopRequests.delete(job.id);
      queue.push(job.id);
      void workQueue();
      return json(response, 202, { job: publicJob(retried) });
    }
    const stopMatch = url.pathname.match(/^\/jobs\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      const job = getJob(stopMatch[1]);
      if (!job) return json(response, 404, { error: "Job not found." });
      if (job.state !== "running" && job.state !== "queued") return json(response, 409, { error: "This job is not running." });
      if (job.state === "queued") {
        for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index] === job.id) queue.splice(index, 1);
      } else {
        stopRequests.add(job.id);
        stopJobExecution(job.id);
      }
      const stopped = await patchJob(job.id, { state: "stopped", stage: "stopped", message: "Generation stopped; local models unloaded", error: null });
      return json(response, 200, { job: publicJob(stopped) });
    }
    const reviewMatch = url.pathname.match(/^\/jobs\/([^/]+)\/review$/);
    if (request.method === "POST" && reviewMatch) {
      const job = getJob(reviewMatch[1]);
      if (!job) return json(response, 404, { error: "Job not found." });
      if (job.state !== "completed") return json(response, 409, { error: "Finish rendering before review." });
      const body = await readJsonBody(request, maxBodyBytes);
      if (body.decision !== "approved" && body.decision !== "rejected") throw new ValidationError("Review decision must be approved or rejected.");
      const reviewed = await patchJob(job.id, { reviewState: body.decision, reviewedAt: new Date().toISOString() });
      await recordAutomationOutcome(reviewed, body.decision === "approved" ? "approved" : "rejected", null);
      return json(response, 200, { job: publicJob(reviewed) });
    }
    const publishMatch = url.pathname.match(/^\/jobs\/([^/]+)\/publish$/);
    if (request.method === "POST" && publishMatch) {
      const job = getJob(publishMatch[1]);
      if (!job) return json(response, 404, { error: "Job not found." });
      if (job.state !== "completed") return json(response, 409, { error: "Finish rendering before publishing." });
      if (job.reviewState !== "approved") return json(response, 409, { error: "Approve this video in review before publishing." });
      if (job.publishState === "running") return json(response, 409, { error: "Publishing is already running." });
      const body = await readJsonBody(request, maxBodyBytes);
      const platformIds = normalizePlatforms(body.platforms?.length ? body.platforms : job.request.platforms);
      if (!platformIds.length) throw new ValidationError("Select at least one publishing platform.");
      const reuploadPlatforms = normalizePlatforms(body.reuploadPlatforms ?? []).filter((platformId) => platformIds.includes(platformId));
      const originalPublishResults = structuredClone(job.publishResults ?? {});
      const liveResults = { ...originalPublishResults };
      for (const platformId of platformIds) {
        const previous = originalPublishResults[platformId];
        liveResults[platformId] = previous?.status === "processing" && !reuploadPlatforms.includes(platformId)
          ? { ...previous, status: "verifying", progress: 100, message: "Checking TikTok delivery status…" }
          : { status: "starting", progress: 0, message: "Starting upload…" };
      }
      await patchJob(job.id, { publishState: "running", publishResults: liveResults });
      const progressJob = { ...job, publishResults: originalPublishResults };
      const reportProgress = async (platformId, result) => {
        liveResults[platformId] = result;
        await patchJob(job.id, { publishResults: { ...liveResults } });
      };
      const results = await publishJob(progressJob, platformIds ?? [], reportProgress, { reuploadPlatforms });
      const mergedResults = { ...liveResults, ...results };
      const hasIssues = Object.values(results).some((result) => !["uploaded", "published", "inbox", "processing"].includes(result.status));
      const published = await patchJob(job.id, { publishState: hasIssues ? "completed_with_issues" : "completed", publishResults: mergedResults });
      await recordAutomationOutcome(published, hasIssues ? "published_with_issues" : "published", hasIssues ? "One or more publishing destinations need attention." : null);
      return json(response, 200, { results: mergedResults });
    }
    const assetMatch = url.pathname.match(/^\/jobs\/([^/]+)\/assets\/([^/]+)$/);
    if (request.method === "GET" && assetMatch) {
      const job = getJob(assetMatch[1]);
      const asset = job?.assets?.[assetMatch[2]];
      if (!asset?.file) return json(response, 404, { error: "Asset not found." });
      await access(asset.file);
      const details = await stat(asset.file);
      const range = parseByteRange(request.headers.range, details.size);
      const headers = {
        "Content-Type": contentType(asset.file),
        "Content-Disposition": url.searchParams.get("download") === "1" ? `attachment; filename="${path.basename(asset.file)}"` : "inline",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      };
      if (range) {
        response.writeHead(206, { ...headers, "Content-Length": range.end - range.start + 1, "Content-Range": `bytes ${range.start}-${range.end}/${details.size}` });
        return createReadStream(asset.file, range).pipe(response);
      }
      response.writeHead(200, { ...headers, "Content-Length": details.size });
      return createReadStream(asset.file).pipe(response);
    }

    if (request.method === "GET" && url.pathname === "/automations") {
      return json(response, 200, { automations: listAutomations().filter((automation) => automation.ownerUserId === identity.user.id).map(publicAutomation) });
    }
    if (request.method === "GET" && url.pathname === "/calendar-entries") {
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const automationId = url.searchParams.get("automationId");
      const ownedAutomationIds = new Set(listAutomations().filter((automation) => automation.ownerUserId === identity.user.id).map((automation) => automation.id));
      const entries = listCalendarEntries().filter((entry) =>
        ownedAutomationIds.has(entry.automationId) && (!start || entry.date >= start) && (!end || entry.date <= end) && (!automationId || entry.automationId === automationId));
      return json(response, 200, { entries: entries.map(publicCalendarEntry) });
    }
    if (request.method === "POST" && url.pathname === "/automations") {
      const body = await readJsonBody(request, maxBodyBytes);
      const normalized = normalizeAutomationCreate(body);
      await assertAutomationPublishReady(normalized);
      const now = new Date().toISOString();
      const automation = await addAutomation({
        id: crypto.randomUUID(),
        ownerUserId: identity.user.id,
        ...normalized,
        lastRunAt: null,
        lastJobId: null,
        lastStatus: "never",
        lastError: null,
        runCount: 0,
        briefPlanning: false,
        createdAt: now,
        updatedAt: now,
      });
      if (automation.mode === "calendar") {
        await replaceAutomationCalendarEntries(automation.id, buildCalendarEntries(automation));
      }
      registerSchedule(automation);
      return json(response, 201, { automation: publicAutomation(automation) });
    }
    const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/);
    if (request.method === "GET" && automationMatch) {
      const automation = getAutomation(automationMatch[1]);
      return automation ? json(response, 200, { automation: publicAutomation(automation) }) : json(response, 404, { error: "Automation not found." });
    }
    if (request.method === "PATCH" && automationMatch) {
      const current = getAutomation(automationMatch[1]);
      if (!current) return json(response, 404, { error: "Automation not found." });
      const body = await readJsonBody(request, maxBodyBytes);
      const patch = normalizeAutomationPatch(current, body);
      await assertAutomationPublishReady({ ...current, ...patch });
      const updated = await patchAutomation(current.id, patch);
      if (updated.mode === "calendar" && ["startDate", "endDate", "weekdays", "times"].some((key) => Object.hasOwn(patch, key))) {
        await syncCalendarEntries(updated);
      }
      registerSchedule(updated);
      return json(response, 200, { automation: publicAutomation(updated) });
    }
    if (request.method === "DELETE" && automationMatch) {
      const current = getAutomation(automationMatch[1]);
      if (!current) return json(response, 404, { error: "Automation not found." });
      stopSchedule(current.id);
      await removeAutomationCalendarEntries(current.id);
      await removeAutomation(current.id);
      return json(response, 200, { ok: true, id: current.id });
    }
    const automationRunMatch = url.pathname.match(/^\/automations\/([^/]+)\/run$/);
    if (request.method === "POST" && automationRunMatch) {
      const automation = getAutomation(automationRunMatch[1]);
      if (!automation) return json(response, 404, { error: "Automation not found." });
      const job = await runAutomation(automation.id, "manual");
      return json(response, 202, { automation: publicAutomation(getAutomation(automation.id)), job: publicJob(job) });
    }
    const automationPlanMatch = url.pathname.match(/^\/automations\/([^/]+)\/plan$/);
    if (request.method === "POST" && automationPlanMatch) {
      const automation = getAutomation(automationPlanMatch[1]);
      if (!automation) return json(response, 404, { error: "Automation not found." });
      if (automation.mode !== "calendar") throw new ValidationError("Only Content Calendar pipelines have dated briefs.");
      if (!textProviderConfig().ready) throw new ValidationError("Add a Gemini or OpenRouter API key in Settings before generating calendar briefs.", 503);
      const pending = listCalendarEntries().filter((entry) => entry.automationId === automation.id && (entry.briefState === "pending" || entry.briefState === "failed"));
      if (!pending.length) return json(response, 200, { queued: 0, automation: publicAutomation(automation) });
      await patchAutomation(automation.id, { briefPlanning: true, lastError: null });
      queueCalendarBriefs(pending.map((entry) => entry.id));
      return json(response, 202, { queued: pending.length, automation: publicAutomation(getAutomation(automation.id)) });
    }
    const calendarEntryMatch = url.pathname.match(/^\/calendar-entries\/([^/]+)$/);
    if (request.method === "PATCH" && calendarEntryMatch) {
      const entry = getCalendarEntry(calendarEntryMatch[1]);
      if (!entry) return json(response, 404, { error: "Calendar entry not found." });
      const body = await readJsonBody(request, maxBodyBytes);
      const patch = {};
      if (body.brief != null) {
        patch.brief = cleanText(body.brief, "Calendar brief", 3, BRIEF_MAX_CHARS);
        patch.title = firstLine(patch.brief);
        patch.briefState = "ready";
        patch.error = null;
      }
      if (body.state != null) {
        const state = String(body.state);
        if (!["planned", "skipped"].includes(state)) throw new ValidationError("Calendar entry state must be planned or skipped.");
        if (entry.jobId) throw new ValidationError("A calendar entry with a video job can no longer be skipped.", 409);
        patch.state = state;
      }
      return json(response, 200, { entry: publicCalendarEntry(await patchCalendarEntry(entry.id, patch)) });
    }
    const calendarEntryRunMatch = url.pathname.match(/^\/calendar-entries\/([^/]+)\/run$/);
    if (request.method === "POST" && calendarEntryRunMatch) {
      const job = await runCalendarEntry(calendarEntryRunMatch[1], "manual");
      return json(response, 202, { job: publicJob(job), entry: publicCalendarEntry(getCalendarEntry(calendarEntryRunMatch[1])) });
    }
    const calendarEntryRegenerateMatch = url.pathname.match(/^\/calendar-entries\/([^/]+)\/regenerate$/);
    if (request.method === "POST" && calendarEntryRegenerateMatch) {
      const entry = getCalendarEntry(calendarEntryRegenerateMatch[1]);
      if (!entry) return json(response, 404, { error: "Calendar entry not found." });
      if (entry.jobId) throw new ValidationError("A brief cannot be regenerated after its video job starts.", 409);
      await patchCalendarEntry(entry.id, { brief: null, title: entry.briefSource === "news" ? "Latest news brief pending" : "Suggested idea pending", briefState: "pending", error: null });
      await patchAutomation(entry.automationId, { briefPlanning: true });
      queueCalendarBriefs([entry.id]);
      return json(response, 202, { entry: publicCalendarEntry(getCalendarEntry(entry.id)) });
    }
    return json(response, 404, { error: "Route not found." });
  } catch (error) {
    const status = error instanceof ValidationError || error instanceof ToolValidationError || error instanceof BrandKitError || error instanceof HttpError || error instanceof YouTubeOAuthError || error instanceof TikTokOAuthError || error instanceof FacebookOAuthError || error instanceof AuthError ? error.status : 500;
    const message = status >= 500 ? "The local worker could not complete this request." : error.message;
    if (status >= 500) process.stderr.write(`[reelio] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return json(response, status, { error: message });
  }
};

const server = http.createServer(requestHandler);
server.requestTimeout = Number(process.env.REELIO_REQUEST_TIMEOUT_MS ?? 900_000);
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`Reelio local worker: http://127.0.0.1:${actualPort}\n`);
});

const httpsServer = startHttpsListener();

function startHttpsListener() {
  const certFile = process.env.REELIO_HTTPS_CERT?.trim() || path.join(getRoot(), "certs", "localhost.pem");
  const keyFile = process.env.REELIO_HTTPS_KEY?.trim() || path.join(getRoot(), "certs", "localhost-key.pem");
  let credentials;
  try {
    credentials = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  } catch {
    process.stdout.write("Reelio HTTPS listener disabled (no certificate). Run npm run https:setup to enable Meta OAuth.\n");
    return null;
  }
  const httpsPort = Number(process.env.REELIO_HTTPS_PORT ?? 8789);
  const secure = https.createServer(credentials, requestHandler);
  secure.requestTimeout = Number(process.env.REELIO_REQUEST_TIMEOUT_MS ?? 900_000);
  secure.headersTimeout = 10_000;
  secure.keepAliveTimeout = 5_000;
  secure.on("error", (error) => process.stderr.write(`[reelio] HTTPS listener error: ${error instanceof Error ? error.message : String(error)}\n`));
  secure.listen(httpsPort, "127.0.0.1", () => process.stdout.write(`Reelio HTTPS worker: https://localhost:${httpsPort}\n`));
  return secure;
}

async function regeneratePublishingMetadata(job) {
  const masterScriptFile = job.assets?.masterScript?.file;
  const transcriptFile = job.assets?.transcript?.file;
  if (!masterScriptFile || !transcriptFile) throw new ValidationError("This video does not have the scripts required to regenerate metadata.", 409);
  const [masterScript, localizedScript] = await Promise.all([
    readFile(masterScriptFile, "utf8"),
    readFile(transcriptFile, "utf8"),
  ]);
  const provenance = {};
  const platformCopy = await createPlatformCopy(job.request, masterScript, provenance, localizedScript);
  const editorial = provenance.editorial;
  if (!editorial?.title || !editorial?.description) throw new ValidationError("Reelio could not generate complete editorial metadata. Try again.", 502);
  const metadata = {
    ...(job.metadata ?? {}),
    title: editorial.title,
    description: editorial.description,
    provisional: false,
    platformCopy,
    publishingCopySource: {
      mode: provenance.mode ?? "unknown",
      provider: provenance.provider ?? null,
      model: provenance.model ?? null,
      error: provenance.error ?? null,
      bilingual: Boolean(provenance.bilingual),
      sourceLanguage: provenance.sourceLanguage ?? "English",
      localizedLanguage: provenance.localizedLanguage ?? job.request.language,
    },
  };
  const metadataPath = job.assets?.metadata?.file ?? path.join(getRoot(), "generated", job.id, "metadata.json");
  const publishingCopyPath = job.assets?.publishingCopy?.file ?? path.join(getRoot(), "generated", job.id, "publishing-copy.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(publishingCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  const assets = {
    ...(job.assets ?? {}),
    metadata: await localJobAsset(metadataPath, "metadata.json"),
    publishingCopy: await localJobAsset(publishingCopyPath, "publishing-copy.json"),
  };
  return patchJob(job.id, { metadata, assets, message: "Video package ready with regenerated publishing metadata" });
}

async function enqueue(request, trigger, ownerUserId) {
  if (request?.creationMode === "message-conversation") {
    return enqueueConversationJob(request, trigger, ownerUserId);
  }
  if (trigger?.type === "manual" && listJobs().some((job) => job.state === "running" || job.state === "queued")) {
    throw new ValidationError("Another video is already generating. Wait for it to finish before starting a new one.", 409);
  }
  const currentBrandKit = getBrandKit(ownerUserId) ?? defaultBrandKit();
  const normalizedRequest = {
    ...normalizeVideoRequest({
      ...request,
      narratorId: request?.narratorId ?? currentBrandKit.defaultNarratorId,
    }),
    brandKit: snapshotBrandKit(currentBrandKit),
  };
  await assertBrandAssetsAvailable(normalizedRequest.brandKit);
  await assertCustomVisualInputsAvailable(normalizedRequest);
  const sourceJob = normalizedRequest.sourceJobId ? getJob(normalizedRequest.sourceJobId) : null;
  if (normalizedRequest.sourceJobId && (!sourceJob || sourceJob.state !== "completed")) {
    throw new ValidationError("The source video for this language version is unavailable or incomplete.", 409);
  }
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    ownerUserId,
    state: "queued",
    stage: "idea",
    progress: 0,
    message: "Waiting for the local renderer",
    request: normalizedRequest,
    trigger,
    attempt: 0,
    publishState: "not_started",
    reviewState: "pending",
    metadata: sourceJob ? {
      title: sourceJob.metadata?.title ?? provisionalVideoTitle(sourceJob.request.prompt),
      description: sourceJob.metadata?.description ?? sourceJob.request.prompt,
      provisional: true,
      languageVersionOf: sourceJob.id,
      sourceLanguage: sourceJob.request.language,
      localizedLanguage: normalizedRequest.language,
    } : undefined,
    createdAt: now,
    updatedAt: now,
  };
  consumeRenderAllowance(ownerUserId);
  await addJob(job);
  queue.push(job.id);
  void workQueue();
  return job;
}

async function enqueueConversationJob(request, trigger, ownerUserId) {
  const renderer = await conversationBrowserHealth();
  if (!renderer.enabled) throw new ValidationError("Message Conversation rendering is disabled. Set REELIO_ENABLE_CONVERSATION_VIDEO=true and restart Reelio.", 503);
  if (!renderer.ready) throw new ValidationError(renderer.message, 503);
  if (trigger?.type === "manual" && listJobs().some((job) => job.state === "running" || job.state === "queued")) {
    throw new ValidationError("Another video is already generating. Wait for it to finish before starting a new one.", 409);
  }
  const draft = getConversationDraft(String(request.draftId ?? ""));
  if (!draft || draft.ownerUserId !== ownerUserId) throw new ValidationError("The approved conversation draft is unavailable.", 404);
  if (Number(request.draftRevision) !== draft.revision) throw new ValidationError("The conversation changed after approval. Review and approve the latest revision.", 409);
  if (!draft.approved) throw new ValidationError("Approve the conversation, timing, design, and audio before rendering.", 409);
  const conversation = normalizeConversationDraft(draft, { ownerUserId });
  assertConversationDraftComplete(conversation);
  const currentBrandKit = getBrandKit(ownerUserId) ?? defaultBrandKit();
  const brandKit = conversation.applyBrandKit ? snapshotBrandKit(currentBrandKit) : null;
  await assertBrandAssetsAvailable(brandKit);
  const jobId = crypto.randomUUID();
  const inputDir = path.join(getRoot(), "generated", jobId, "inputs");
  await mkdir(inputDir, { recursive: true });
  const assets = [];
  try {
    for (const assetId of conversationAssetIds(conversation)) {
      const source = getConversationAsset(assetId);
      if (!source || source.ownerUserId !== ownerUserId) throw new ValidationError(`Conversation asset ${assetId} is no longer available.`);
      await access(source.file);
      const destination = path.join(inputDir, `${assetId}-${path.basename(source.file)}`);
      try {
        await link(source.file, destination);
      } catch {
        await copyFile(source.file, destination);
      }
      assets.push({
        id: source.id,
        file: destination,
        name: source.name,
        bytes: source.bytes,
        mediaType: source.mediaType,
      kind: source.kind,
      durationSeconds: source.durationSeconds,
      width: source.width,
      height: source.height,
      hasAudio: source.hasAudio,
      });
    }
    for (const [kind, asset] of Object.entries(brandKit?.assets ?? {})) {
      if (!asset?.file) continue;
      const destination = path.join(inputDir, `brand-${kind}-${path.basename(asset.file)}`);
      try {
        await link(asset.file, destination);
      } catch {
        await copyFile(asset.file, destination);
      }
      asset.file = destination;
    }
  } catch (error) {
    await rm(path.join(getRoot(), "generated", jobId), { recursive: true, force: true });
    throw error;
  }
  conversation.assets = assets;
  conversation.brandKit = brandKit;
  if (conversation.appearance.theme === "brand" && brandKit?.enabled) {
    conversation.appearance.background.color = brandKit.primaryColor;
    conversation.appearance.background.accentColor = brandKit.accentColor;
  }
  const timeline = buildConversationTimeline(conversation);
  const normalizedRequest = {
    creationMode: "message-conversation",
    draftId: draft.id,
    draftRevision: draft.revision,
    prompt: conversation.title,
    category: "Fictional conversation",
    duration: `${Math.max(6, Math.ceil(timeline.durationMs / 1000))} sec`,
    language: conversation.language,
    ttsEngine: conversation.audio.ttsEngine,
    subtitleLanguage: conversation.language,
    narratorId: conversation.audio.narratorId,
    platforms: conversation.platforms,
    brandKit,
    conversation,
  };
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    ownerUserId,
    state: "queued",
    stage: "conversation-approved",
    progress: 0,
    message: "Waiting to record the approved conversation",
    request: normalizedRequest,
    trigger,
    attempt: 0,
    publishState: "not_started",
    reviewState: "pending",
    createdAt: now,
    updatedAt: now,
  };
  consumeRenderAllowance(ownerUserId);
  await addJob(job);
  queue.push(job.id);
  void workQueue();
  return job;
}

function provisionalVideoTitle(value) {
  const rawTitle = String(value || "Untitled video").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0]
    .replace(/^(?:explain|create|show)\s+/i, "");
  const firstSentence = rawTitle ? `${rawTitle.charAt(0).toUpperCase()}${rawTitle.slice(1)}` : "Untitled video";
  if (firstSentence.length <= 82) return firstSentence;
  const shortened = firstSentence.slice(0, 82).replace(/\s+\S*$/, "").trim();
  return `${shortened || firstSentence.slice(0, 79)}…`;
}

async function assertBrandAssetsAvailable(brandKit) {
  if (!brandKit?.enabled) return;
  for (const asset of Object.values(brandKit.assets ?? {})) {
    if (!asset?.file) continue;
    try {
      await access(asset.file);
    } catch {
      throw new ValidationError(`Brand Kit asset "${asset.name}" is missing from local storage. Replace or remove it in Brand Kit.`);
    }
  }
}

async function assertCustomVisualInputsAvailable(request) {
  for (const selection of request.visualSelections ?? []) {
    if (selection.mode !== "custom") continue;
    const input = getToolInput(selection.uploadId);
    if (!input) throw new ValidationError(`Custom video "${selection.fileName}" is no longer available. Choose the file again.`);
    try {
      await access(input.file);
    } catch {
      throw new ValidationError(`Custom video "${selection.fileName}" is missing from local storage. Choose the file again.`);
    }
    const extension = path.extname(input.name).toLowerCase();
    const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
    if (!String(input.mediaType ?? "").toLowerCase().startsWith("video/") && !videoExtensions.has(extension)) {
      throw new ValidationError(`"${selection.fileName}" is not a supported video file.`);
    }
  }
}

async function workQueue() {
  if (working) return;
  working = true;
  while (queue.length) {
    if (voicePreviewPromise) await voicePreviewPromise.catch(() => {});
    const id = queue.shift();
    const job = getJob(id);
    if (!job || job.state === "stopped") continue;
    const running = await patchJob(id, { state: "running", attempt: job.attempt + 1, error: null });
    if (running.trigger?.calendarEntryId) await patchCalendarEntry(running.trigger.calendarEntryId, { state: "running" });
    try {
      const result = await runWithJobControl(id, async () => {
        if (stopRequests.delete(id)) throw new JobStoppedError();
        await assertBrandAssetsAvailable(job.request.brandKit);
        const renderer = job.request.creationMode === "message-conversation" ? renderConversationJob : renderJob;
        return renderer(job, (stage, progress, message) => {
          assertJobActive();
          return patchJob(id, { stage, progress, message });
        });
      });
      stopRequests.delete(id);
      const completed = await patchJob(id, { ...result, state: "completed", stage: "review", progress: 100, message: "Video package ready for review" });
      await completeAutomationRun(completed);
    } catch (error) {
      const stopRequested = stopRequests.delete(id);
      if (error instanceof JobStoppedError || stopRequested) {
        const stopped = await patchJob(id, { state: "stopped", stage: "stopped", error: null, message: "Generation stopped; local models unloaded" });
        await recordAutomationOutcome(stopped, "stopped", null);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const failed = await patchJob(id, { state: "failed", progress: 100, error: message, message: "Rendering failed" });
        await recordAutomationOutcome(failed, "failed", message);
      }
    }
  }
  working = false;
}

async function enqueueToolJob(value, identity) {
  const request = normalizeToolRequest(value);
  for (const reference of Object.values(request.inputs)) {
    const resource = reference.uploadId ? getToolInput(String(reference.uploadId)) : getToolJob(String(reference.toolJobId));
    if (resource) assertResourceAccess(identity, resource);
  }
  if (["video-synthesis", "long-video-render"].includes(request.toolId) && request.options.applyBrandKit) {
    request.options.brandKit = snapshotBrandKit(getBrandKit(identity.user.id) ?? defaultBrandKit());
    await assertBrandAssetsAvailable(request.options.brandKit);
  }
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    ownerUserId: identity.user.id,
    state: "queued",
    stage: "queued",
    progress: 0,
    message: "Waiting for an available tool worker",
    request,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  await addToolJob(job);
  toolQueue.push(job.id);
  pumpToolQueue();
  return job;
}

function pumpToolQueue() {
  let launched = true;
  while (launched) {
    launched = false;
    for (let index = 0; index < toolQueue.length; index += 1) {
      const job = getToolJob(toolQueue[index]);
      if (!job || job.state !== "queued") {
        toolQueue.splice(index, 1);
        launched = true;
        break;
      }
      const group = toolGroup(job.request.toolId);
      if (activeToolCounts[group] >= toolLimit(group)) continue;
      toolQueue.splice(index, 1);
      activeToolCounts[group] += 1;
      launched = true;
      void runToolQueueJob(job.id, group).finally(() => {
        activeToolCounts[group] = Math.max(0, activeToolCounts[group] - 1);
        pumpToolQueue();
      });
      break;
    }
  }
}

async function runToolQueueJob(id, group) {
  const job = getToolJob(id);
  if (!job || job.state !== "queued") return;
  await patchToolJob(id, { state: "running", stage: "preparing", progress: 2, message: "Preparing tool inputs", attempt: job.attempt + 1, error: null, workerGroup: group });
  try {
    const inputs = await resolveToolInputs(job.request.inputs);
    await assertBrandAssetsAvailable(job.request.options?.brandKit);
    if (toolStopRequests.has(job.id) || getToolJob(job.id)?.state !== "running") throw new JobStoppedError();
    const outputDir = path.join(getRoot(), "tool-jobs", job.id);
    const result = await runWithJobControl(job.id, () => executeTool({
      request: job.request,
      inputs,
      outputDir,
      progress: (stage, progress, message) => {
        assertJobActive();
        return patchToolJob(job.id, { stage, progress, message });
      },
    }));
    if (toolStopRequests.has(job.id) || getToolJob(job.id)?.state !== "running") throw new JobStoppedError();
    toolStopRequests.delete(job.id);
    if (job.request.toolId === "long-video-render" && result.metadata?.packageTreatment) {
      const packageJobs = await materializeLongVideoPackages(job, result);
      result.metadata.packageJobIds = packageJobs.map((item) => item.id);
      result.metadata.clips = (result.metadata.clips ?? []).map((clip) => ({
        ...clip,
        jobId: packageJobs.find((item) => item.metadata?.sourceAssetKey === clip.assetKey)?.id ?? null,
      }));
    }
    await patchToolJob(job.id, { ...result, state: "completed", stage: "completed", progress: 100, message: "Tool outputs are ready" });
  } catch (error) {
    const stopped = toolStopRequests.delete(job.id);
    if (error instanceof JobStoppedError || stopped) {
      await patchToolJob(job.id, { state: "stopped", stage: "stopped", error: null, message: "Tool job stopped" });
    } else {
      await patchToolJob(job.id, { state: "failed", stage: "failed", progress: 100, error: error instanceof Error ? error.message : String(error), message: "Tool job failed" });
    }
  }
}

async function materializeLongVideoPackages(toolJob, result) {
  const clips = Array.isArray(result.metadata?.clips) ? result.metadata.clips : [];
  const sourceToolJob = getToolJob(toolJob.request.inputs.media?.toolJobId);
  const sourceUrl = typeof sourceToolJob?.request?.options?.url === "string" ? sourceToolJob.request.options.url : "";
  const jobs = [];
  for (const clip of clips) {
    if (!clip?.packageAssetKeys || !clip?.packageRequest || !clip?.packageMetadata) continue;
    const id = `long-${toolJob.id}-${clip.assetKey}`;
    const existing = getJob(id);
    if (existing) {
      jobs.push(existing);
      continue;
    }
    const packageDir = path.join(getRoot(), "generated", id);
    await mkdir(packageDir, { recursive: true });
    const assets = {};
    for (const [logicalKey, toolAssetKey] of Object.entries(clip.packageAssetKeys)) {
      const sourceAsset = result.assets?.[toolAssetKey];
      if (!sourceAsset?.file) throw new Error(`The ${logicalKey} asset for ${clip.title || "a short"} is missing.`);
      const destination = path.join(packageDir, path.basename(sourceAsset.file));
      try {
        await link(sourceAsset.file, destination);
      } catch (error) {
        if (error?.code !== "EEXIST") await copyFile(sourceAsset.file, destination);
      }
      assets[logicalKey] = {
        file: destination,
        name: sourceAsset.name || path.basename(destination),
        bytes: (await stat(destination)).size,
      };
    }
    const now = new Date().toISOString();
    const child = {
      id,
      state: "completed",
      stage: "review",
      progress: 100,
      message: "Short-video publishing package ready for review",
      request: {
        ...clip.packageRequest,
        brandKit: toolJob.request.options?.brandKit ?? null,
      },
      trigger: { type: "manual" },
      attempt: 1,
      publishState: "not_started",
      reviewState: "pending",
      assets,
      metadata: {
        ...clip.packageMetadata,
        creationMode: "long-video-shorts",
        sourceToolJobId: toolJob.id,
        sourceAssetKey: clip.assetKey,
        sourceUrl: sourceUrl || null,
        sourceLabel: sourceUrl ? "Public URL" : "Uploaded long video",
        sourceTitle: sourceToolJob?.metadata?.title ?? null,
      },
      createdAt: now,
      updatedAt: now,
    };
    await addJob(child);
    jobs.push(child);
  }
  return jobs;
}

async function materializeLegacyLongVideoJobs() {
  for (const toolJob of listToolJobs().filter((item) =>
    item.request?.toolId === "long-video-render"
    && item.state === "completed"
    && item.metadata?.packageTreatment !== true)) {
    const clips = Array.isArray(toolJob.metadata?.clips) ? toolJob.metadata.clips : [];
    const dismissed = new Set(Array.isArray(toolJob.metadata?.libraryDismissedAssetKeys) ? toolJob.metadata.libraryDismissedAssetKeys.map(String) : []);
    const sourceToolJob = getToolJob(toolJob.request.inputs?.media?.toolJobId);
    const analysisJob = getToolJob(toolJob.request.inputs?.analysis?.toolJobId);
    const sourceUrl = typeof sourceToolJob?.request?.options?.url === "string" ? sourceToolJob.request.options.url : "";
    const sourceLanguage = legacyLanguage(analysisJob);
    const sourceCues = await legacySourceCues(analysisJob);
    const jobIds = [];
    const videoAssets = Object.entries(toolJob.assets ?? {}).filter(([key, asset]) => /^short\d+$/.test(key) && asset?.type === "video");
    for (const [assetKey, videoAsset] of videoAssets) {
      if (dismissed.has(assetKey)) continue;
      const id = `long-${toolJob.id}-${assetKey}`;
      const clip = clips.find((item) => item?.assetKey === assetKey) ?? clips[Number(assetKey.replace(/\D/g, "")) - 1] ?? {};
      const existing = getJob(id);
      if (existing) {
        if (existing.metadata?.legacyPackage) {
          try {
            await upgradeLegacyPublishingDescription(existing, clip);
          } catch (error) {
            console.warn(`Legacy Long Video description upgrade skipped ${toolJob.id}/${assetKey}: ${error instanceof Error ? error.message : error}`);
          }
        }
        if (existing.metadata?.legacyPackage && !existing.metadata?.titleCardSeconds) {
          try {
            await addLegacyTitleCard(existing);
          } catch (error) {
            console.warn(`Legacy Long Video title card skipped ${toolJob.id}/${assetKey}: ${error instanceof Error ? error.message : error}`);
          }
        }
        jobIds.push(existing.id);
        continue;
      }
      try {
        const job = await createLegacyLongVideoJob({ toolJob, analysisJob, sourceToolJob, sourceCues, sourceUrl, sourceLanguage, assetKey, videoAsset, clip });
        await addJob(job);
        await addLegacyTitleCard(job);
        jobIds.push(job.id);
      } catch (error) {
        console.warn(`Legacy Long Video library migration skipped ${toolJob.id}/${assetKey}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (jobIds.length) {
      await patchToolJob(toolJob.id, { metadata: { ...(toolJob.metadata ?? {}), legacyLibraryJobIds: jobIds } });
    }
  }
}

async function addLegacyTitleCard(job) {
  if (!job?.assets?.final?.file || !job.assets?.thumbnail?.file || job.metadata?.titleCardSeconds) return job;
  const titleCardSeconds = longVideoTitleCardSeconds();
  const contentDuration = Number(job.metadata?.durationSeconds || 0);
  if (!Number.isFinite(contentDuration) || contentDuration <= 0) throw new Error("Legacy short duration is unavailable");
  const packageDir = path.join(getRoot(), "generated", job.id);
  const titledPath = path.join(packageDir, "final-with-title-card.mp4");
  await prependTitleCard({
    videoFile: job.assets.final.file,
    thumbnailPath: job.assets.thumbnail.file,
    outputFile: titledPath,
    contentDuration,
    titleCardSeconds,
  });
  const assets = { ...job.assets, final: await localJobAsset(titledPath, job.assets.final.name) };
  if (job.assets.captions?.file) {
    try {
      const captions = parseSubtitles(await readFile(job.assets.captions.file, "utf8")).map((cue) => ({
        ...cue,
        start: cue.start + titleCardSeconds,
        end: cue.end + titleCardSeconds,
      }));
      const shiftedCaptionsPath = path.join(packageDir, "captions-with-title-card.srt");
      await writeFile(shiftedCaptionsPath, formatSrt(captions), "utf8");
      assets.captions = await localJobAsset(shiftedCaptionsPath, "captions.srt");
    } catch {}
  }
  const durationSeconds = contentDuration + titleCardSeconds;
  const metadata = {
    ...(job.metadata ?? {}),
    durationSeconds,
    titleCardSeconds,
    thumbnailTitle: job.metadata?.title ?? job.request?.prompt,
    retentionPreflight: {
      ...(job.metadata?.retentionPreflight ?? {}),
      hookWithinSeconds: titleCardSeconds,
      noIntroBeforeHook: false,
    },
  };
  return patchJob(job.id, {
    assets,
    metadata,
    request: { ...job.request, duration: `${Math.round(durationSeconds)} sec` },
    message: "Legacy short promoted with an editorial title-card intro",
  });
}

async function createLegacyLongVideoJob({ toolJob, analysisJob, sourceToolJob, sourceCues, sourceUrl, sourceLanguage, assetKey, videoAsset, clip }) {
  if (!videoAsset?.file) throw new Error("Rendered video is missing");
  await access(videoAsset.file);
  const id = `long-${toolJob.id}-${assetKey}`;
  const packageDir = path.join(getRoot(), "generated", id);
  await mkdir(packageDir, { recursive: true });
  const title = cleanText(String(clip?.title || videoAsset.name || "Generated short"), "Legacy short title", 1, 120);
  const hook = String(clip?.hook || clip?.reason || "").trim();
  const duration = Math.max(1, Number(clip?.duration || Number(clip?.end) - Number(clip?.start) || 60));
  const analyzedCandidate = Array.isArray(analysisJob?.metadata?.candidates)
    ? analysisJob.metadata.candidates.find((candidate) => candidate?.id === clip?.id)
    : null;
  const transcript = String(clip?.transcript || analyzedCandidate?.transcript || hook || title).replace(/\s+/g, " ").trim();
  const description = String(clip?.description || clip?.reason || analyzedCandidate?.description || analyzedCandidate?.reason || "").trim()
    || legacyEditorialDescription(transcript);
  const finalPath = path.join(packageDir, path.basename(videoAsset.file));
  await linkOrCopy(videoAsset.file, finalPath);
  const assets = { final: await localJobAsset(finalPath, videoAsset.name) };
  const thumbnailAsset = toolJob.assets?.[String(clip?.thumbnailAssetKey || `${assetKey}Thumbnail`)];
  if (thumbnailAsset?.file) {
    const thumbnailPath = path.join(packageDir, path.basename(thumbnailAsset.file));
    await linkOrCopy(thumbnailAsset.file, thumbnailPath);
    assets.thumbnail = await localJobAsset(thumbnailPath, thumbnailAsset.name);
  }
  const transcriptPath = path.join(packageDir, "transcript.txt");
  await writeFile(transcriptPath, `${transcript}\n`, "utf8");
  assets.transcript = await localJobAsset(transcriptPath, "transcript.txt");
  const clipStart = Number(clip?.start || 0);
  const clipEnd = Number(clip?.end || clipStart + duration);
  const clipCues = sourceCues
    .filter((cue) => cue.end > clipStart && cue.start < clipEnd)
    .map((cue) => ({
      start: Math.max(0, cue.start - clipStart),
      end: Math.min(duration, cue.end - clipStart),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start);
  if (clipCues.length) {
    const captionsPath = path.join(packageDir, "captions.srt");
    await writeFile(captionsPath, formatSrt(clipCues), "utf8");
    assets.captions = await localJobAsset(captionsPath, "captions.srt");
  }
  const tags = legacyTags(title);
  const platformCopy = legacyPlatformCopy(title, description, tags);
  const metadata = {
    title,
    description,
    tags,
    durationSeconds: Number(duration.toFixed(2)),
    resolution: `${Number(process.env.REELIO_SHORT_WIDTH || 1080)}x${Number(process.env.REELIO_SHORT_HEIGHT || 1920)}`,
    frameRate: 30,
    narrationLanguage: sourceLanguage,
    subtitleLanguage: sourceLanguage,
    voiceProvider: "Original source audio",
    narrator: "Original source speaker",
    narratorTone: "Original source audio retained",
    visualSource: "Reviewed excerpt from a licensed long-video source",
    creationMode: "long-video-shorts",
    legacyPackage: true,
    sourceToolJobId: toolJob.id,
    sourceAssetKey: assetKey,
    sourceUrl: sourceUrl || null,
    sourceLabel: sourceUrl ? "Public URL" : "Uploaded long video",
    sourceTitle: sourceToolJob?.metadata?.title ?? null,
    sourceStartSeconds: clipStart,
    sourceEndSeconds: clipEnd,
    platformCopy,
    retentionPreflight: {
      score: Math.max(1, Math.min(100, Math.round(Number(clip?.score) || 70))),
      hookWithinSeconds: 0,
      averageVisualChangeSeconds: Number(duration.toFixed(2)),
      highContrastCaptions: toolJob.metadata?.captions !== false,
      noIntroBeforeHook: true,
    },
  };
  const metadataPath = path.join(packageDir, "metadata.json");
  const publishingCopyPath = path.join(packageDir, "publishing-copy.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(publishingCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  assets.metadata = await localJobAsset(metadataPath, "metadata.json");
  assets.publishingCopy = await localJobAsset(publishingCopyPath, "publishing-copy.json");
  const createdAt = toolJob.createdAt || new Date().toISOString();
  return {
    id,
    state: "completed",
    stage: "review",
    progress: 100,
    message: "Legacy short promoted to a reviewable video record",
    request: {
      prompt: description,
      category: "Source recap",
      duration: `${Math.round(duration)} sec`,
      language: sourceLanguage,
      subtitleLanguage: sourceLanguage,
      platforms: normalizePlatforms(toolJob.request.options?.platforms?.length ? toolJob.request.options.platforms : ["youtube", "tiktok", "facebook", "instagram"]),
      approvedScript: transcript,
    },
    trigger: { type: "manual" },
    attempt: 1,
    publishState: "not_started",
    reviewState: "pending",
    assets,
    metadata,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

async function legacySourceCues(analysisJob) {
  const file = analysisJob?.assets?.subtitles?.file;
  if (!file) return [];
  try {
    return parseSubtitles(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

function legacyLanguage(analysisJob) {
  const value = String(analysisJob?.request?.options?.sourceLanguage || analysisJob?.metadata?.language || "English").trim();
  if (!value || value.toLowerCase() === "auto" || value.toLowerCase() === "unknown") return "English";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function upgradeLegacyPublishingDescription(job, clip) {
  if (job.metadata?.descriptionVersion === 2) return job;
  let transcript = "";
  if (job.assets?.transcript?.file) {
    try {
      transcript = await readFile(job.assets.transcript.file, "utf8");
    } catch {}
  }
  const description = String(clip?.description || clip?.reason || "").trim() || legacyEditorialDescription(transcript);
  const title = String(job.metadata?.title || clip?.title || job.request?.prompt || "Generated short").trim();
  const tags = Array.isArray(job.metadata?.tags) && job.metadata.tags.length ? job.metadata.tags : legacyTags(title);
  const platformCopy = legacyPlatformCopy(title, description, tags);
  const metadata = { ...(job.metadata ?? {}), description, descriptionVersion: 2, platformCopy };
  const request = { ...job.request, prompt: description };
  const packageDir = path.join(getRoot(), "generated", job.id);
  const metadataPath = path.join(packageDir, "metadata.json");
  const publishingCopyPath = path.join(packageDir, "publishing-copy.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(publishingCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  const assets = {
    ...(job.assets ?? {}),
    metadata: await localJobAsset(metadataPath, "metadata.json"),
    publishingCopy: await localJobAsset(publishingCopyPath, "publishing-copy.json"),
  };
  return patchJob(job.id, { request, metadata, assets, message: "Legacy short upgraded with an editorial publishing description" });
}

function legacyEditorialDescription(transcript) {
  const clean = String(transcript || "").replace(/\s+/g, " ").trim();
  if (!clean) return "A complete selected moment from the source video, presented with its essential context and takeaway.";
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [clean];
  const selected = sentences.length <= 2 ? sentences : [sentences[1], sentences[sentences.length - 1]];
  const description = selected.join(" ");
  return description.length > 420 ? `${description.slice(0, 417).trimEnd()}…` : description;
}

function legacyTags(title) {
  return Array.from(new Set(title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((word) => word.length > 2).slice(0, 6).concat(["short video", "source recap"])));
}

function legacyPlatformCopy(title, description, tags) {
  const base = { title, caption: `${title}. ${description}`.slice(0, 500), description, tags };
  return {
    youtube: base,
    tiktok: { ...base, caption: `${title}. ${description}`.slice(0, 300) },
    facebook: base,
    instagram: base,
  };
}

async function linkOrCopy(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") await copyFile(source, destination);
  }
}

async function localJobAsset(file, name) {
  return { file, name: name || path.basename(file), bytes: (await stat(file)).size };
}

async function resolveToolInputs(references) {
  const resolved = {};
  for (const [name, reference] of Object.entries(references)) {
    let source;
    if (reference?.uploadId) source = getToolInput(String(reference.uploadId));
    else if (reference?.toolJobId && reference?.assetKey) source = getToolJob(String(reference.toolJobId))?.assets?.[String(reference.assetKey)];
    if (!source?.file) throw new ToolValidationError(`${name} input is no longer available.`);
    await access(source.file).catch(() => { throw new ToolValidationError(`${name} input file is missing.`); });
    resolved[name] = source;
  }
  return resolved;
}

function toolLimit(group) {
  const environmentName = group === "model" ? "REELIO_MODEL_TOOL_CONCURRENCY" : "REELIO_MEDIA_TOOL_CONCURRENCY";
  const fallback = group === "model" ? 1 : 2;
  const value = Number(process.env[environmentName] ?? fallback);
  return Number.isInteger(value) && value > 0 ? Math.min(4, value) : fallback;
}

async function receiveToolInput(request, ownerUserId) {
  const length = Number(request.headers["content-length"] ?? 0);
  const maximum = Number(process.env.REELIO_MAX_TOOL_INPUT_BYTES ?? 10 * 1024 * 1024 * 1024);
  if (!Number.isSafeInteger(length) || length <= 0) throw new ToolValidationError("Choose a non-empty file.");
  if (length > maximum) throw new ToolValidationError(`Tool input exceeds the ${Math.round(maximum / 1024 / 1024)} MB local limit.`, 413);
  const rawName = request.headers["x-file-name"];
  if (typeof rawName !== "string" || !rawName.trim()) throw new ToolValidationError("Tool input filename is required.");
  let decodedName;
  try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
  const safeName = path.basename(decodedName).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180) || "input.bin";
  const id = crypto.randomUUID();
  const directory = path.join(getRoot(), "tool-inputs", id);
  const file = path.join(directory, safeName);
  await mkdir(directory, { recursive: true });
  try {
    await streamPipeline(request, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    const details = await stat(file);
    if (details.size !== length) throw new ToolValidationError("The uploaded file was incomplete.");
    const input = {
      id,
      ownerUserId,
      file,
      name: safeName,
      bytes: details.size,
      mediaType: String(request.headers["content-type"] ?? "application/octet-stream").slice(0, 120),
      createdAt: new Date().toISOString(),
    };
    await addToolInput(input);
    return input;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function receiveConversationAsset(request, draft, rawKind, ownerUserId) {
  const kind = String(rawKind ?? "").trim().toLowerCase();
  const limits = {
    avatar: 5 * 1024 * 1024,
    image: 25 * 1024 * 1024,
    background: 25 * 1024 * 1024,
    video: 250 * 1024 * 1024,
    motion: 250 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
  };
  if (!Object.hasOwn(limits, kind)) throw new ValidationError("Choose a supported conversation asset type.");
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(length) || length <= 0) throw new ValidationError("Choose a non-empty conversation asset.");
  if (length > limits[kind]) throw new ValidationError(`Conversation ${kind} exceeds the ${Math.round(limits[kind] / 1024 / 1024)} MB local limit.`, 413);
  const rawName = request.headers["x-file-name"];
  if (typeof rawName !== "string" || !rawName.trim()) throw new ValidationError("Conversation asset filename is required.");
  let decodedName;
  try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
  const safeName = path.basename(decodedName).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180) || `${kind}.bin`;
  const mediaType = String(request.headers["content-type"] ?? "application/octet-stream").slice(0, 120);
  const id = crypto.randomUUID();
  const directory = path.join(getRoot(), "conversation-assets", id);
  const file = path.join(directory, safeName);
  await mkdir(directory, { recursive: true });
  try {
    await streamPipeline(request, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    const details = await stat(file);
    if (details.size !== length) throw new ValidationError("The conversation asset upload was incomplete.");
    const probe = await probeMedia(file);
    if (["avatar", "image", "background"].includes(kind) && !probe.video) throw new ValidationError("Choose a readable PNG, JPEG, WebP, or GIF image.");
    if (["video", "motion"].includes(kind) && (!probe.video || probe.duration <= 0)) throw new ValidationError("Choose a readable local video.");
    if (kind === "audio" && !probe.audio) throw new ValidationError("Choose a readable local audio file.");
    if (["video", "motion"].includes(kind) && probe.duration > 30.05) throw new ValidationError("Conversation video attachments must be 30 seconds or shorter.");
    if (kind === "audio" && probe.duration > 60.05) throw new ValidationError("Conversation audio attachments must be 60 seconds or shorter.");
    const asset = {
      id,
      draftId: draft.id,
      ownerUserId,
      file,
      name: safeName,
      bytes: details.size,
      mediaType,
      kind,
      durationSeconds: probe.duration || undefined,
      width: probe.video?.width,
      height: probe.video?.height,
      hasAudio: Boolean(probe.audio),
      createdAt: new Date().toISOString(),
    };
    await addConversationAsset(asset);
    return asset;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function assertConversationDraftAssets(draft, identity) {
  for (const assetId of conversationAssetIds(draft)) {
    const asset = getConversationAsset(assetId);
    if (!asset) throw new ValidationError(`Conversation asset ${assetId} is no longer available.`);
    assertResourceAccess(identity, asset);
    if (asset.draftId !== draft.id) throw new ValidationError("Conversation assets cannot be borrowed from another draft.");
    await access(asset.file).catch(() => {
      throw new ValidationError(`Conversation asset "${asset.name}" is missing from local storage.`);
    });
  }
  for (const event of draft.events.filter((item) => item.type === "video" && item.playAudio)) {
    const asset = getConversationAsset(event.assetId);
    if (!asset?.hasAudio) throw new ValidationError(`Video attachment "${event.fileName || "video"}" does not contain an audio track.`);
  }
  if (draft.audio.musicSource === "upload") {
    const soundtrack = getConversationAsset(draft.audio.musicAssetId);
    if (!soundtrack || soundtrack.kind !== "audio" || !soundtrack.hasAudio) {
      throw new ValidationError("Choose a valid local audio file for the conversation soundtrack.");
    }
  }
}

function assertConversationDraftComplete(draft) {
  for (const [index, event] of draft.events.entries()) {
    if (["image", "video", "audio"].includes(event.type) && !event.assetId) {
      throw new ValidationError(`Conversation event ${index + 1} needs a local ${event.type} attachment before rendering.`);
    }
  }
  if (["image", "motion"].includes(draft.appearance.background.type) && !draft.appearance.background.assetId) {
    throw new ValidationError("Choose the local conversation background before rendering.");
  }
  if (draft.audio.musicSource === "upload" && !draft.audio.musicAssetId) {
    throw new ValidationError("Choose a local soundtrack before rendering.");
  }
  if (draft.audio.musicSource === "brand" && !draft.applyBrandKit) {
    throw new ValidationError("Enable Brand Kit for this conversation or choose another soundtrack.");
  }
}

function conversationAssetReferenced(assetId) {
  return listConversationDrafts().some((draft) => conversationAssetIds(draft).includes(assetId));
}

async function removeUnreferencedConversationAssets(draftId, ownerUserId) {
  for (const asset of listConversationAssets().filter((item) => item.draftId === draftId && item.ownerUserId === ownerUserId)) {
    if (conversationAssetReferenced(asset.id)) continue;
    await rm(path.dirname(asset.file), { recursive: true, force: true });
    await removeConversationAsset(asset.id);
  }
}

async function generateConversationStoryPitches(draft, value, recentPremises = []) {
  const criteria = normalizeStarterCriteria({
    ...value,
    language: draft.language,
    participantCount: draft.participants.length,
  });
  const localPitches = () => curatedConversationPitches(criteria, recentPremises);
  if (!textProviderConfig("creative").ready) {
    return {
      pitches: localPitches(),
      mode: "curated",
      provider: "built-in",
      model: null,
      message: "Using Reelio's local story starters because no text provider is configured.",
    };
  }
  try {
    const generated = await generateText({
      system: `Develop exactly three distinct fictional premises for short mobile-message conversation videos.

Each premise must begin inside a concrete situation and support a believable escalation through typed messages. Every pitch needs a clear relationship, immediate friction, a causal middle, and an ending that changes a decision or recontextualizes an earlier detail.

When Comedy is requested, each pitch must name or clearly imply one repeatable comic engine: conflicting goals, status reversal, escalating concealment, mistaken certainty, or a character-specific rule that backfires. Its ending must pay off an earlier concrete word, object, or decision. A mildly awkward premise is not automatically comedy.

Avoid generic concepts, interchangeable secrets, celebrity or public-figure references, current news, factual claims, crime instructions, private data, links, abuse presented as romance, and high-stakes medical, legal, financial, or political scenarios. Do not use "we need to talk", "this changes everything", "you won't believe this", unexplained mystery packages, anonymous threats, lottery wins, or surprise inheritances.

Make the three pitches structurally different from one another. Participant roles should create contrasting message habits rather than stereotypes. Stay within the supplied fictional participant count.

Return only a JSON array with exactly this shape:
[
  {
    "id":"pitch-1",
    "title":"specific 2-6 word title",
    "premise":"one editable sentence containing the setup, escalation, and story direction",
    "relationship":"relationship",
    "genre":"genre",
    "situation":"specific situation",
    "ending":"specific desired ending",
    "tone":"three concise tone qualities",
    "cast":[{"name":"fictional first name","role":"story function and messaging behavior","isSelf":true}]
  }
]
The first cast member is the phone owner. Use the requested language for all creator-facing text.`,
      user: JSON.stringify({
        criteria,
        existingParticipants: draft.participants.map((participant) => ({
          name: participant.name,
          isSelf: participant.isSelf,
        })),
        recentPremises,
      }),
      maxTokens: 2_400,
      thinkingLevel: "medium",
      task: "creative",
    });
    const pitches = parseConversationPitches(generated?.text, criteria);
    if (pitches.length !== 3) throw new Error("The provider did not return three valid story pitches.");
    return {
      pitches,
      mode: "ai",
      provider: generated.provider,
      model: generated.model,
      fallback: generated.fallback ?? null,
      message: "Three AI story starters are ready. Selecting one does not generate or approve the conversation.",
    };
  } catch (error) {
    return {
      pitches: localPitches(),
      mode: "curated",
      provider: "built-in",
      model: null,
      message: "AI suggestions were unavailable, so Reelio loaded three editable local story starters.",
      error: error instanceof Error ? error.message.slice(0, 180) : "Story suggestion failed.",
    };
  }
}

async function generateConversationDraft(draft, value) {
  const premise = cleanText(value.premise, "Conversation premise", 3, 700);
  const tone = typeof value.tone === "string" && value.tone.trim() ? cleanText(value.tone, "Conversation tone", 1, 80) : "tense but natural";
  const genre = typeof value.genre === "string" && value.genre.trim() ? cleanText(value.genre, "Conversation genre", 1, 80) : "social story";
  const ending = typeof value.ending === "string" && value.ending.trim() ? cleanText(value.ending, "Desired ending", 1, 220) : "end with a satisfying reveal";
  const requestedTargetSeconds = Number(value.targetSeconds ?? 60);
  const targetSeconds = Number.isFinite(requestedTargetSeconds) ? Math.max(15, Math.round(requestedTargetSeconds)) : 60;
  const participantIds = new Set(draft.participants.map((participant) => participant.id));
  const roleByParticipantId = new Map();
  if (Array.isArray(value.participantRoles)) {
    for (const [index, item] of value.participantRoles.slice(0, draft.participants.length).entries()) {
      const participantId = String(item?.participantId ?? "");
      if (!participantIds.has(participantId) || typeof item?.role !== "string" || !item.role.trim()) continue;
      roleByParticipantId.set(participantId, cleanText(item.role, `Participant role ${index + 1}`, 1, 160));
    }
  }
  const brief = {
    premise,
    genre,
    tone,
    ending,
    targetSeconds,
    language: draft.language,
    participants: draft.participants.map(({ id, name, isSelf }) => ({
      id,
      name,
      role: roleByParticipantId.get(id) ?? (isSelf ? "phone owner" : "other participant"),
    })),
  };
  const planSystem = `You are developing competing story treatments for a fictional phone-conversation short. The supplied premise is the complete boundary. Create exactly three materially different approaches—not cosmetic rewrites of one plot.

Return only one JSON object:
{"candidates":[{
  "id":"candidate-1",
  "title":"specific working title",
  "genrePromise":"the precise audience experience",
  "audienceSetup":{"relationship":"what the viewer learns","immediateProblem":"the concrete problem happening now","goal":"what each side wants","stakes":"what changes if nobody acts","requiredFacts":["only facts the viewer must know"]},
  "characterVoices":[{"participantId":"exact id","messageHabits":"specific habits","comicOrDramaticFunction":"story function"}],
  "causalBeats":[{"beat":1,"change":"what changes","setupOrPayoff":"specific planted detail or payoff"}],
  "endingMechanism":"how the requested ending is earned",
  "deviceMoments":["only phone UI events that materially affect the story"],
  "qualityRisks":["generic or confusing choices to avoid"],
  "clarityRisks":["specific context or causal gaps to prevent"]
}]}

Every candidate must work for a first-time viewer with no context outside the messages. By the third text message, the relationship, immediate problem, and next desired action must be understandable. Each candidate needs a different causal engine and ending route while honoring the requested ending.
For Comedy, each candidate needs one sustainable comic engine and at least three escalating turns: setup, complication, and planted callback or reversal. Random jokes, insults, reaction words, and unexplained absurdity do not qualify.
For Mystery or Suspense, every reveal must narrow a plausible interpretation. For Drama, every beat must force a cost or choice. For Wholesome, warmth must be earned through a concrete act.`;
  async function createPlanBatch(rejectionContext = null) {
    const result = await generateText({
      system: planSystem,
      user: JSON.stringify({ brief, rejectionContext }),
      maxTokens: 5_000,
      thinkingLevel: "high",
      task: "conversation",
    });
    if (!result?.text) throw new ValidationError("Add a Gemini or OpenRouter key in Settings to generate a conversation draft.");
    const parsed = parseGeneratedJsonObject(result.text, "story treatment batch");
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates.filter((candidate) => candidate && typeof candidate === "object") : [];
    if (candidates.length !== 3) throw new ValidationError("The AI did not return three complete story treatments. Try again.", 502);
    const ids = new Set(candidates.map((candidate) => String(candidate.id ?? "")));
    if (ids.size !== 3 || ids.has("")) throw new ValidationError("The AI returned duplicate or missing story-treatment IDs. Try again.", 502);
    return { result, candidates };
  }
  async function judgePlanBatch(candidates) {
    const result = await generateText({
      system: `You are a skeptical commissioning editor choosing one treatment for a short fictional chat video. Score every candidate independently from 0 to 10 for immediate comprehension, hook, causal escalation, participant voice contrast, genre delivery, originality, and earned ending.

Reject mystery-box writing, vague pronouns, interchangeable characters, missing setup, random escalation, generic sentiment, and endings that introduce an unplanted fact. Do not reward complexity. A simple specific story that is immediately understandable beats a complicated story.

Return only:
{"winnerId":"exact candidate id","overall":number,"scores":[{"id":"candidate id","clarity":number,"hook":number,"escalation":number,"voices":number,"genre":number,"originality":number,"ending":number,"overall":number,"failure":"empty or concise fatal issue"}],"requiredRepairs":["specific repairs the winning dialogue writer must make"]}

The winner's overall score must reflect the lowest important weakness rather than averaging it away.`,
      user: JSON.stringify({ brief, candidates }),
      maxTokens: 2_600,
      thinkingLevel: "high",
      task: "conversation",
    });
    if (!result?.text) throw new ValidationError("The configured text provider could not judge the story treatments.");
    const judgment = parseGeneratedJsonObject(result.text, "story treatment judgment");
    const winnerId = String(judgment.winnerId ?? "");
    const winner = candidates.find((candidate) => String(candidate.id) === winnerId);
    const scoreRecord = Array.isArray(judgment.scores) ? judgment.scores.find((score) => String(score?.id) === winnerId) : null;
    const overall = Number.parseFloat(String(judgment.overall ?? scoreRecord?.overall ?? ""));
    if (!winner || !Number.isFinite(overall)) throw new ValidationError("The AI story judge did not select and score a valid treatment. Try again.", 502);
    return { result, judgment, winner, overall };
  }
  let planBatch = await createPlanBatch();
  let planJudgment = await judgePlanBatch(planBatch.candidates);
  let planRetryCount = 0;
  if (planJudgment.overall < 7.2) {
    planRetryCount = 1;
    planBatch = await createPlanBatch({
      rejectedCandidates: planBatch.candidates,
      judgeScores: planJudgment.judgment.scores,
      requiredRepairs: planJudgment.judgment.requiredRepairs,
      instruction: "Replace the weak causal engines; do not merely rewrite their wording.",
    });
    planJudgment = await judgePlanBatch(planBatch.candidates);
  }
  if (planJudgment.overall < 7.2) {
    throw new ValidationError("Reelio rejected two weak story-treatment batches. Change the premise or genre and try again.", 502);
  }
  const planResult = planBatch.result;
  const storyPlan = {
    ...planJudgment.winner,
    selection: {
      score: planJudgment.overall,
      scores: planJudgment.judgment.scores,
      requiredRepairs: planJudgment.judgment.requiredRepairs,
      retryCount: planRetryCount,
    },
  };
  const generated = await generateText({
    system: `Write the story and dialogue for a fictional mobile-message short from the approved brief, winning treatment, judge score, and required repairs. Use only the supplied fictional participants and preserve their exact IDs. Do not introduce real people, news, factual claims, private data, links, or outside evidence.

This is a story-writing stage. Do not generate playback delays, millisecond timings, displayed clock times, delivery receipts, reactions, stable event IDs, or other renderer metadata. Reelio compiles those locally after the story passes review.

Dialogue rules:
- Write messages people would actually type. No narration disguised as dialogue and no screenplay exposition.
- Give every participant a recognizable rhythm, punctuation pattern, vocabulary, and avoidance behavior.
- Begin during the problem, but orient a first-time viewer immediately. Within the first three text messages, make the participants' functional relationship, the concrete problem, and the next desired action understandable.
- Introduce one important new fact per message. Every message must reveal, pressure, decide, misdirect fairly, or pay off something specific.
- Name a person, object, place, or past event before referring to it as "he", "she", "they", "it", "this", or "that". A pronoun must have one obvious antecedent in the recent messages.
- Do not rely on unstated off-screen knowledge. If the viewer needs a past fact to understand a decision or reveal, state that fact naturally before its payoff.
- Prefer concrete nouns and actions over vague suspense phrases. Every reply must logically answer or react to the message immediately before it.
- Keep most messages under 90 characters. Vary message length and rhythm.
- Use "clean", "natural", "hesitant", or "fast" typingStyle. Hesitation and corrections should reveal character pressure, not appear on every line.
- Keep the phone owner fast or clean unless story pressure specifically justifies hesitation.
- Do not use generic hooks such as "we need to talk", "this changes everything", "you won't believe this", "I have a confession", or "let's just say".

Genre execution is mandatory. For Comedy, the conversation must contain at least three earned laugh beats from the planned comic engine, escalating rather than repeating. Include a setup that looks ordinary, a complication that worsens the social problem, and a callback or reversal whose exact wording or object was planted earlier. Never label a line as a joke or add laughter to prove it is funny.

Phone events are optional story tools, not decoration:
- notification: an incoming banner above the current chat.
- battery: a low-battery alert that interrupts the screen.
- call: a full phone-call screen; callDialogue contains spoken lines from the participants.
- chat-switch: opens another chatId and chatTitle; later messages assigned that chatId appear on that screen.
Use at most three device-level events unless the story plan specifically depends on more.

Return only a JSON array with as many story items as the complete story needs, between 6 and 200. The target length guides story depth, never timing or cutoff. Allowed shapes are:
{"type":"text","participantId":"exact id","text":"message","typingStyle":"clean|natural|hesitant|fast","chatId":"primary","chatTitle":""}
Notification:
{"type":"notification","participantId":"exact id","notificationTitle":"sender or chat","text":"preview","chatId":"another-chat","chatTitle":"chat title"}
Low battery:
{"type":"battery","batteryLevel":integer,"charging":false}
Call:
{"type":"call","participantId":"exact id","text":"Phone call","callState":"incoming|outgoing|completed|missed|declined","chatId":"primary","chatTitle":"","callDialogue":[{"participantId":"exact id","text":"spoken line"}]}
Chat switch:
{"type":"chat-switch","text":"screen title","chatId":"safe-id","chatTitle":"screen title"}
System/date:
{"type":"system|date","text":"short visible notice","chatId":"primary"}`,
    user: JSON.stringify({ brief, storyPlan }),
    maxTokens: 6_000,
    thinkingLevel: "high",
    task: "conversation",
  });
  if (!generated?.text) throw new ValidationError("The configured text provider did not return a conversation draft.");
  const firstDraft = parseGeneratedJsonArray(generated.text);
  if (firstDraft.length < 6 || firstDraft.length > 200) throw new ValidationError("The AI draft did not contain the required 6 to 200 story events. Try again.", 502);
  const revised = await generateText({
    system: `Act as a strict genre editor for a fictional phone conversation. Rewrite the supplied semantic story-item array, returning only the improved JSON array.

Preserve the premise boundary, participant IDs, requested ending, story-item shapes, causal order, and natural conversational rhythm. The target duration is only guidance: never remove a necessary beat or truncate the ending. Remove exposition, interchangeable phrasing, repeated beats, fake suspense, and generic final lines. Make each participant sound distinct.

If the genre is Comedy, reject a merely light or quirky draft. It must produce at least three recognizable comic turns through one causal engine, with escalating consequences and a planted callback/reversal at the end. Prefer precise social embarrassment, conflicting goals, status changes, and character-specific understatement. Never insert random jokes, memes, canned banter, or explanatory laughter.

Use typingStyle only as a performance note; use hesitant typing only where a specific correction or thinking pause carries story meaning. Keep device-level events only when they create a reveal, interruption, or consequence. Do not add renderer timing, clock, receipt, reaction, or ID fields.`,
    user: JSON.stringify({ brief, storyPlan, draft: firstDraft }),
    maxTokens: 6_000,
    thinkingLevel: "high",
    task: "conversation",
  });
  if (!revised?.text) throw new ValidationError("The configured text provider could not complete the genre quality pass.");
  const genreEditedValues = parseGeneratedJsonArray(revised.text);
  if (genreEditedValues.length < 6 || genreEditedValues.length > 200) throw new ValidationError("The AI genre edit did not preserve the required 6 to 200 story events. Try again.", 502);
  const clarified = await generateText({
    system: `Act as the final clarity editor for a fictional phone conversation. Return only the revised semantic story-item array.

The viewer has no context outside this array. Preserve the premise, genre engine, participant IDs, distinct voices, planted setups, payoffs, requested ending, causal order, story-item shapes, and useful device events. Do not flatten humor, suspense, emotion, or character-specific phrasing.

Repair comprehension only where needed:
- By the end of the first three text messages, the functional relationship, immediate concrete problem, and next desired action must be understandable.
- Every pronoun or vague reference must have exactly one obvious recent antecedent. Replace ambiguous "it", "that", "this", "they", "there", and unexplained nicknames with the concrete noun when needed.
- A viewer must encounter every necessary fact before a decision, reaction, callback, or reveal depends on it.
- Each message should introduce at most one important new fact and should logically respond to the preceding message.
- Remove unexplained off-screen history, abrupt subject changes, redundant twists, and device events whose story meaning is unclear.
- Keep exposition conversational. Split an overloaded message instead of turning it into a speech.
- Preserve a clear cause-and-effect chain through the ending. If a line can be read in two incompatible ways unintentionally, rewrite it.

If the array is already clear, keep its wording and structure. Never add narration, renderer metadata, explanatory labels, or facts outside the supplied premise and story plan.`,
    user: JSON.stringify({ brief, storyPlan, draft: genreEditedValues }),
    maxTokens: 6_000,
    thinkingLevel: "high",
    task: "conversation",
  });
  if (!clarified?.text) throw new ValidationError("The configured text provider could not complete the conversation clarity pass.");
  const values = parseGeneratedJsonArray(clarified.text);
  if (values.length < 6 || values.length > 200) throw new ValidationError("The AI clarity edit did not preserve the required 6 to 200 story events. Try again.", 502);
  const events = compileConversationStoryItems(values, draft);
  const normalized = normalizeConversationDraft({
    ...draft,
    events,
    approved: false,
    revision: draft.revision + 1,
      generation: {
        mode: "ai",
        premise,
        provider: generated.provider,
        model: clarified.model ?? revised.model ?? generated.model,
        fallback: clarified.fallback ?? revised.fallback ?? generated.fallback ?? planResult.fallback ?? null,
        genre,
        qualityStages: ["treatment-candidates", "treatment-judge", "dialogue-draft", "genre-edit", "clarity-edit", "local-compile"],
        generatedAt: new Date().toISOString(),
      },
  }, { ownerUserId: draft.ownerUserId });
  return normalized;
}

async function duplicateConversationDraft(draft, ownerUserId) {
  const now = new Date().toISOString();
  const draftId = crypto.randomUUID();
  const assetMap = await duplicateConversationAssets(draft, draftId, ownerUserId);
  try {
    const duplicate = normalizeConversationDraft({
      ...draft,
      id: draftId,
      ownerUserId,
      revision: 1,
      title: `${draft.title} — Copy`,
      participants: draft.participants.map((participant) => ({
        ...participant,
        avatarAssetId: participant.avatarAssetId ? assetMap.get(participant.avatarAssetId) : null,
      })),
      events: draft.events.map((event) => ({
        ...event,
        assetId: event.assetId ? assetMap.get(event.assetId) : null,
      })),
      appearance: {
        ...draft.appearance,
        background: {
          ...draft.appearance.background,
          assetId: draft.appearance.background.assetId ? assetMap.get(draft.appearance.background.assetId) : null,
        },
      },
      approved: false,
      generation: { mode: "manual", premise: "", provider: "", model: "", generatedAt: null },
      createdAt: now,
      updatedAt: now,
    }, { ownerUserId, preserveIdentity: true });
    duplicate.createdAt = now;
    return duplicate;
  } catch (error) {
    await removeDuplicatedConversationAssets(assetMap);
    throw error;
  }
}

async function translateConversationDraft(draft, targetLanguageValue, ownerUserId) {
  const targetLanguage = normalizeSpeechLanguage(targetLanguageValue, "Translation language");
  if (targetLanguage === draft.language) throw new ValidationError("Choose a different translation language.");
  const translatable = draft.events.map((event, index) => ({ id: index, text: event.text })).filter((item) => item.text);
  const generated = await generateText({
    system: `Translate every fictional conversation item into natural ${targetLanguage}. Return only a JSON array of objects shaped {"id":number,"text":"translation"}. Preserve every numeric ID exactly once. Preserve meaning, tone, names, emoji, and message boundaries; do not add, merge, split, explain, or fact-check.`,
    user: JSON.stringify(translatable),
    maxTokens: 4_000,
    temperature: 0.05,
    thinkingLevel: "low",
    task: "utility",
  });
  if (!generated?.text) throw new ValidationError("Translation requires a configured Gemini or OpenRouter provider.");
  const translations = new Map(parseGeneratedJsonArray(generated.text).map((item) => [Number(item.id), String(item.text ?? "").trim()]));
  if (translations.size !== translatable.length) throw new ValidationError("Translation did not preserve every conversation event.", 502);
  const now = new Date().toISOString();
  const translatedDraftId = crypto.randomUUID();
  const assetMap = await duplicateConversationAssets(draft, translatedDraftId, ownerUserId);
  try {
    const translated = normalizeConversationDraft({
      ...draft,
      id: translatedDraftId,
      ownerUserId,
      revision: 1,
      title: `${draft.title} — ${targetLanguage}`,
      language: targetLanguage,
      participants: draft.participants.map((participant) => ({
        ...participant,
        avatarAssetId: participant.avatarAssetId ? assetMap.get(participant.avatarAssetId) : null,
      })),
      events: draft.events.map((event, index) => ({
        ...event,
        text: event.text ? translations.get(index) : "",
        assetId: event.assetId ? assetMap.get(event.assetId) : null,
      })),
      appearance: {
        ...draft.appearance,
        background: {
          ...draft.appearance.background,
          assetId: draft.appearance.background.assetId ? assetMap.get(draft.appearance.background.assetId) : null,
        },
      },
      audio: { ...draft.audio, ttsEngine: defaultTtsEngine(targetLanguage) },
      approved: false,
      generation: {
        mode: "ai",
        premise: `Translated from ${draft.language}`,
        provider: generated.provider,
        model: generated.model,
        generatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }, { ownerUserId, preserveIdentity: true });
    translated.createdAt = now;
    return translated;
  } catch (error) {
    await removeDuplicatedConversationAssets(assetMap);
    throw error;
  }
}

async function duplicateConversationAssets(draft, targetDraftId, ownerUserId) {
  const mapping = new Map();
  try {
    for (const sourceId of conversationAssetIds(draft)) {
      const source = getConversationAsset(sourceId);
      if (!source || source.ownerUserId !== ownerUserId || source.draftId !== draft.id) {
        throw new ValidationError(`Conversation asset ${sourceId} is no longer available for translation.`);
      }
      await access(source.file);
      const id = crypto.randomUUID();
      const directory = path.join(getRoot(), "conversation-assets", id);
      const file = path.join(directory, path.basename(source.file));
      await mkdir(directory, { recursive: true });
      try {
        await link(source.file, file);
      } catch {
        await copyFile(source.file, file);
      }
      await addConversationAsset({ ...source, id, draftId: targetDraftId, file, createdAt: new Date().toISOString() });
      mapping.set(sourceId, id);
    }
    return mapping;
  } catch (error) {
    await removeDuplicatedConversationAssets(mapping);
    throw error;
  }
}

async function removeDuplicatedConversationAssets(mapping) {
  for (const assetId of mapping.values()) {
    const asset = getConversationAsset(assetId);
    if (asset) await rm(path.dirname(asset.file), { recursive: true, force: true });
    await removeConversationAsset(assetId);
  }
}

function parseGeneratedJsonArray(value) {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new ValidationError("The AI returned an invalid conversation structure. Try again.", 502); }
  }
  if (!Array.isArray(parsed)) throw new ValidationError("The AI returned an invalid conversation structure. Try again.", 502);
  return parsed;
}

function parseGeneratedJsonObject(value, label = "response") {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new ValidationError(`The AI returned an invalid ${label}. Try again.`, 502); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError(`The AI returned an invalid ${label}. Try again.`, 502);
  return parsed;
}

async function receiveBrandAsset(request, kind, ownerUserId) {
  const rule = brandAssetRule(kind);
  const length = Number(request.headers["content-length"] ?? 0);
  const rawName = request.headers["x-file-name"];
  if (typeof rawName !== "string" || !rawName.trim()) throw new BrandKitError("Brand asset filename is required.");
  let decodedName;
  try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
  const safeName = path.basename(decodedName).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180) || `${kind}.bin`;
  const mediaType = String(request.headers["content-type"] ?? "application/octet-stream").slice(0, 120);
  validateBrandAssetUpload(kind, { name: safeName, bytes: length, mediaType });
  if (length > rule.maximumBytes) throw new BrandKitError(`${rule.label} exceeds the local upload limit.`, 413);
  const id = crypto.randomUUID();
  const directory = path.join(getRoot(), "brand-assets", kind, id);
  const file = path.join(directory, safeName);
  await mkdir(directory, { recursive: true });
  try {
    await streamPipeline(request, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    const details = await stat(file);
    if (details.size !== length) throw new BrandKitError("The uploaded Brand Kit asset was incomplete.");
    const probe = await probeMedia(file);
    validateProbedBrandAsset(kind, probe);
    const asset = {
      id,
      kind,
      file,
      name: safeName,
      bytes: details.size,
      mediaType,
      durationSeconds: probe.duration || undefined,
      width: probe.video?.width,
      height: probe.video?.height,
      createdAt: new Date().toISOString(),
    };
    return setBrandKit(withBrandAsset(getBrandKit(ownerUserId) ?? defaultBrandKit(), kind, asset), ownerUserId);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function registerSchedule(automation) {
  stopSchedule(automation.id);
  if (!automation.enabled) return;
  const expressions = calendarCronExpressions(automation);
  if (!expressions.length) return;
  try {
    const tasks = expressions.map((expression, index) => cron.schedule(expression, async () => {
      const action = automation.mode === "calendar"
        ? runDueCalendarEntry(automation.id, automation.times[index])
        : runAutomation(automation.id, "cron");
      await action.catch((error) => {
        process.stderr.write(`[reelio] Automation ${automation.id} failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, { timezone: validateTimezone(automation.timezone), noOverlap: true }));
    schedules.set(automation.id, tasks);
  } catch (error) {
    process.stderr.write(`[reelio] Automation ${automation.id} disabled in memory: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function stopSchedule(automationId) {
  const tasks = schedules.get(automationId) ?? [];
  for (const task of Array.isArray(tasks) ? tasks : [tasks]) task.stop();
  schedules.delete(automationId);
}

async function runAutomation(automationId, source) {
  const automation = getAutomation(automationId);
  if (!automation) throw new ValidationError("Automation not found.", 404);
  if (automation.mode === "calendar") throw new ValidationError("Run a specific Content Calendar entry.", 409);
  if (source === "cron" && !automation.enabled) throw new ValidationError("Automation is paused.", 409);
  const active = activeAutomationJob(listJobs(), automation.id);
  if (active) {
    await patchAutomation(automation.id, {
      lastStatus: "skipped",
      lastError: "The previous automation run is still queued or rendering.",
    });
    throw new ValidationError("The previous run is still queued or rendering.", 409);
  }
  const triggeredAt = new Date().toISOString();
  try {
    await assertAutomationPublishReady(automation, { force: true });
    const resolved = await generateAutomationBrief(automation, recentAutomationBriefs(automation.id));
    const job = await enqueue({ ...automation.template, prompt: resolved.brief }, {
      type: source === "cron" ? "cron" : "automation",
      automationId: automation.id,
      automationName: automation.name,
      expression: automation.cron,
      timezone: automation.timezone,
      publishMode: automationPublishMode(automation),
      briefSource: automation.briefSource,
    }, automation.ownerUserId);
    await patchAutomation(automation.id, {
      lastRunAt: triggeredAt,
      lastJobId: job.id,
      lastStatus: "queued",
      lastError: null,
      runCount: Number(automation.runCount ?? 0) + 1,
    });
    return job;
  } catch (error) {
    await patchAutomation(automation.id, {
      lastRunAt: triggeredAt,
      lastStatus: "failed",
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runDueCalendarEntry(automationId, time) {
  const automation = getAutomation(automationId);
  if (!automation || !automation.enabled || automation.mode !== "calendar") return null;
  const date = calendarDateInTimezone(new Date(), automation.timezone);
  const entry = listCalendarEntries().find((item) => item.automationId === automation.id && item.date === date && item.time === time);
  if (!entry || entry.state === "skipped" || entry.jobId) return null;
  return runCalendarEntry(entry.id, "cron");
}

async function runCalendarEntry(entryId, source) {
  let entry = getCalendarEntry(entryId);
  if (!entry) throw new ValidationError("Calendar entry not found.", 404);
  const automation = getAutomation(entry.automationId);
  if (!automation) throw new ValidationError("Calendar pipeline not found.", 404);
  if (entry.jobId) {
    const existing = getJob(entry.jobId);
    if (existing) throw new ValidationError("This calendar entry already has a video job.", 409);
  }
  if (entry.state === "skipped") throw new ValidationError("Restore this skipped calendar entry before running it.", 409);
  await assertAutomationPublishReady(automation, { force: true });
  if (entry.briefState !== "ready" || !entry.brief) {
    entry = await generateCalendarEntryBrief(entry, automation);
  }
  const triggeredAt = new Date().toISOString();
  try {
    const job = await enqueue({ ...automation.template, prompt: entry.brief }, {
      type: source === "cron" ? "cron" : "automation",
      automationId: automation.id,
      automationName: automation.name,
      calendarEntryId: entry.id,
      scheduledFor: `${entry.date}T${entry.time}`,
      timezone: automation.timezone,
      publishMode: automationPublishMode(automation),
      briefSource: automation.briefSource,
    }, automation.ownerUserId);
    await patchCalendarEntry(entry.id, { state: "queued", jobId: job.id, error: null });
    await patchAutomation(automation.id, {
      lastRunAt: triggeredAt,
      lastJobId: job.id,
      lastStatus: "queued",
      lastError: null,
      runCount: Number(automation.runCount ?? 0) + 1,
    });
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchCalendarEntry(entry.id, { state: "failed", error: message });
    await patchAutomation(automation.id, { lastRunAt: triggeredAt, lastStatus: "failed", lastError: message });
    throw error;
  }
}

function recentAutomationBriefs(automationId) {
  const calendarBriefs = listCalendarEntries()
    .filter((entry) => entry.automationId === automationId && entry.brief)
    .map((entry) => entry.brief);
  const jobBriefs = listJobs()
    .filter((job) => job.trigger?.automationId === automationId)
    .map((job) => job.request?.prompt)
    .filter(Boolean);
  return [...jobBriefs, ...calendarBriefs].slice(-20);
}

async function generateCalendarEntryBrief(entry, automation) {
  await patchCalendarEntry(entry.id, { briefState: "generating", error: null });
  try {
    const resolved = await generateAutomationBrief(automation, recentAutomationBriefs(automation.id).filter((brief) => brief !== entry.brief));
    return patchCalendarEntry(entry.id, {
      brief: resolved.brief,
      title: resolved.title,
      briefState: "ready",
      provider: resolved.provider,
      model: resolved.model,
      sources: resolved.sources,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchCalendarEntry(entry.id, { briefState: "failed", error: message });
    throw error;
  }
}

function queueCalendarBriefs(entryIds) {
  for (const entryId of entryIds) if (!calendarBriefQueue.includes(entryId)) calendarBriefQueue.push(entryId);
  void pumpCalendarBriefQueue();
}

async function pumpCalendarBriefQueue() {
  if (calendarBriefWorking) return;
  calendarBriefWorking = true;
  try {
    while (calendarBriefQueue.length) {
      const entryId = calendarBriefQueue.shift();
      const entry = getCalendarEntry(entryId);
      const automation = entry ? getAutomation(entry.automationId) : null;
      if (!entry || !automation || entry.jobId || entry.briefState === "ready") continue;
      await generateCalendarEntryBrief(entry, automation).catch(() => {});
      const remaining = listCalendarEntries().some((item) => item.automationId === automation.id && (item.briefState === "pending" || item.briefState === "generating"));
      if (!remaining) await patchAutomation(automation.id, { briefPlanning: false });
    }
  } finally {
    calendarBriefWorking = false;
  }
}

async function syncCalendarEntries(automation) {
  const generated = buildCalendarEntries(automation);
  const existing = listCalendarEntries().filter((entry) => entry.automationId === automation.id);
  const bySlot = new Map(existing.map((entry) => [`${entry.date}T${entry.time}`, entry]));
  const merged = generated.map((entry) => bySlot.get(`${entry.date}T${entry.time}`) ?? entry);
  merged.push(...existing.filter((entry) => entry.jobId && !merged.some((item) => item.id === entry.id)));
  await replaceAutomationCalendarEntries(automation.id, merged);
}

async function assertAutomationPublishReady(automation, { force = false } = {}) {
  if ((!automation?.enabled && !force) || automationPublishMode(automation) !== "auto") return;
  const selected = normalizePlatforms(automation.template?.platforms ?? []);
  const checks = {
    youtube: youtubeConnectionStatus,
    tiktok: tiktokConnectionStatus,
    facebook: facebookConnectionStatus,
    instagram: instagramConnectionStatus,
  };
  const results = await Promise.all(selected.map(async (platformId) => {
    const status = await checks[platformId]();
    const ready = platformId === "tiktok" ? status.connected && status.uploadReady !== false : status.connected;
    return { platformId, ready };
  }));
  const missing = results.filter((result) => !result.ready).map((result) => result.platformId);
  if (missing.length) throw new ValidationError(`Connect these publishing accounts before enabling automatic publishing: ${missing.join(", ")}.`, 409);
}

async function completeAutomationRun(job) {
  const automationId = job?.trigger?.automationId;
  if (!automationId) return;
  const automation = getAutomation(automationId);
  if (!automation) return;
  const publishMode = job.trigger?.publishMode ?? automationPublishMode(automation);
  if (publishMode !== "auto") {
    await recordAutomationOutcome(job, "awaiting_review", null);
    return;
  }
  const platformIds = normalizePlatforms(job.request.platforms);
  if (!platformIds.length) {
    await recordAutomationOutcome(job, "failed", "Automatic publishing has no selected platforms.");
    return;
  }
  const approved = await patchJob(job.id, {
    reviewState: "approved",
    reviewedAt: new Date().toISOString(),
    publishState: "running",
  });
  const liveResults = {};
  for (const platformId of platformIds) liveResults[platformId] = { status: "starting", progress: 0, message: "Starting automatic upload…" };
  await patchJob(job.id, { publishResults: liveResults });
  try {
    const reportProgress = async (platformId, result) => {
      liveResults[platformId] = result;
      await patchJob(job.id, { publishResults: { ...liveResults } });
    };
    const results = await publishJob(approved, platformIds, reportProgress);
    const hasIssues = Object.values(results).some((result) => !["uploaded", "published", "inbox", "processing"].includes(result.status));
    const finished = await patchJob(job.id, {
      publishState: hasIssues ? "completed_with_issues" : "completed",
      publishResults: { ...liveResults, ...results },
    });
    await recordAutomationOutcome(finished, hasIssues ? "published_with_issues" : "published", hasIssues ? "One or more publishing destinations need attention." : null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await patchJob(job.id, { publishState: "failed" });
    await recordAutomationOutcome(failed, "failed", message);
  }
}

async function recordAutomationOutcome(job, status, error) {
  const automationId = job?.trigger?.automationId;
  if (!automationId || !getAutomation(automationId)) return;
  if (job.trigger?.calendarEntryId && getCalendarEntry(job.trigger.calendarEntryId)) {
    const entryState = status === "awaiting_review" || status === "approved" ? "ready"
      : status === "published" ? "published"
        : status === "published_with_issues" || status === "failed" || status === "stopped" || status === "rejected" ? status
          : status;
    await patchCalendarEntry(job.trigger.calendarEntryId, { state: entryState, error });
  }
  await patchAutomation(automationId, {
    lastJobId: job.id,
    lastStatus: status,
    lastError: error,
  });
}

function publicAutomation(automation) {
  const safeAutomation = { ...automation };
  delete safeAutomation.ownerUserId;
  const tasks = schedules.get(automation.id) ?? [];
  const active = activeAutomationJob(listJobs(), automation.id);
  const nextRuns = (Array.isArray(tasks) ? tasks : [tasks]).map((task) => task?.getNextRun?.()).filter(Boolean);
  const entries = automation.mode === "calendar" ? listCalendarEntries().filter((entry) => entry.automationId === automation.id) : [];
  return {
    ...safeAutomation,
    mode: automation.mode ?? "quick",
    briefSource: automation.briefSource ?? "suggested",
    color: automation.color ?? "#6f4bf3",
    publishMode: automationPublishMode(automation),
    requireReview: automationPublishMode(automation) === "review",
    nextRunAt: automation.enabled && nextRuns.length ? new Date(Math.min(...nextRuns.map((date) => date.getTime()))).toISOString() : null,
    activeJobId: active?.id ?? null,
    calendarEntryCount: entries.length,
    calendarBriefsReady: entries.filter((entry) => entry.briefState === "ready").length,
  };
}

function publicCalendarEntry(entry) {
  const automation = getAutomation(entry.automationId);
  return {
    ...entry,
    automationName: automation?.name ?? "Deleted pipeline",
    color: automation?.color ?? "#8f8997",
  };
}

function publicJob(job) {
  const safeJob = { ...job };
  delete safeJob.ownerUserId;
  const assets = job.assets ? Object.fromEntries(Object.entries(job.assets).map(([key, asset]) => [key, { name: asset.name, url: `/jobs/${job.id}/assets/${key}`, downloadUrl: `/jobs/${job.id}/assets/${key}?download=1` }])) : null;
  let request = job.request?.brandKit ? { ...job.request, brandKit: sanitizeBrandKitSnapshot(job.request.brandKit) } : job.request;
  if (request?.conversation) {
    const conversation = structuredClone(request.conversation);
    delete conversation.ownerUserId;
    conversation.assets = (conversation.assets ?? []).map((asset) => {
      const item = { ...asset };
      delete item.file;
      return item;
    });
    if (conversation.brandKit) conversation.brandKit = sanitizeBrandKitSnapshot(conversation.brandKit);
    request = { ...request, conversation };
  }
  return { ...safeJob, request, assets };
}

function publicConversationDraft(draft) {
  const safe = structuredClone(draft);
  delete safe.ownerUserId;
  return safe;
}

function publicConversationAsset(asset) {
  return {
    id: asset.id,
    draftId: asset.draftId,
    name: asset.name,
    bytes: asset.bytes,
    mediaType: asset.mediaType,
    kind: asset.kind,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    url: `/conversation-assets/${asset.id}`,
    createdAt: asset.createdAt,
  };
}

function publicToolJob(job) {
  const safeJob = { ...job };
  delete safeJob.ownerUserId;
  const assets = job.assets ? Object.fromEntries(Object.entries(job.assets).map(([key, asset]) => [key, {
    name: asset.name,
    bytes: asset.bytes,
    type: asset.type,
    url: `/tool-jobs/${job.id}/assets/${key}`,
    downloadUrl: `/tool-jobs/${job.id}/assets/${key}?download=1`,
  }])) : null;
  const request = job.request?.options?.brandKit ? {
    ...job.request,
    options: { ...job.request.options, brandKit: sanitizeBrandKitSnapshot(job.request.options.brandKit) },
  } : job.request;
  return { ...safeJob, request, assets };
}

function publicToolInput(input) {
  return { id: input.id, name: input.name, bytes: input.bytes, mediaType: input.mediaType, createdAt: input.createdAt };
}

function publicVoicePreview(preview) {
  return {
    url: preview.url,
    cached: preview.cached,
    usesApi: preview.usesApi,
    provider: preview.provider,
    narrator: preview.narrator,
  };
}

function assertOwnedPathAccess(identity, url) {
  const pathName = url.pathname;
  const jobId = pathName.match(/^\/jobs\/([^/]+)/)?.[1];
  if (jobId) {
    const job = getJob(jobId);
    if (job) assertResourceAccess(identity, job);
    return;
  }
  const toolJobId = pathName.match(/^\/tool-jobs\/([^/]+)/)?.[1];
  if (toolJobId) {
    const job = getToolJob(toolJobId);
    if (job) assertResourceAccess(identity, job);
    return;
  }
  const automationId = pathName.match(/^\/automations\/([^/]+)/)?.[1];
  if (automationId) {
    const automation = getAutomation(automationId);
    if (automation) assertResourceAccess(identity, automation);
    return;
  }
  const entryId = pathName.match(/^\/calendar-entries\/([^/]+)/)?.[1];
  if (entryId) {
    const entry = getCalendarEntry(entryId);
    const automation = entry ? getAutomation(entry.automationId) : null;
    if (automation) assertResourceAccess(identity, automation);
    return;
  }
  const conversationDraftId = pathName.match(/^\/conversation-drafts\/([^/]+)/)?.[1];
  if (conversationDraftId) {
    const draft = getConversationDraft(conversationDraftId);
    if (draft) assertResourceAccess(identity, draft);
    return;
  }
  const conversationAssetId = pathName.match(/^\/conversation-assets\/([^/]+)/)?.[1];
  if (conversationAssetId) {
    const asset = getConversationAsset(conversationAssetId);
    if (asset) assertResourceAccess(identity, asset);
  }
}

function assertVideoRequestOwnership(identity, value) {
  if (value?.creationMode === "message-conversation" && value?.draftId) {
    const draft = getConversationDraft(String(value.draftId));
    if (draft) assertResourceAccess(identity, draft);
  }
  if (value?.sourceJobId) {
    const sourceJob = getJob(String(value.sourceJobId));
    if (sourceJob) assertResourceAccess(identity, sourceJob);
  }
  for (const selection of Array.isArray(value?.visualSelections) ? value.visualSelections : []) {
    if (!selection?.uploadId) continue;
    const input = getToolInput(String(selection.uploadId));
    if (input) assertResourceAccess(identity, input);
  }
}

function requiredEntitlement(request, url) {
  const pathName = url.pathname;
  if (request.method === "GET") return "content.read";
  if (pathName.startsWith("/settings") || pathName.startsWith("/oauth/")) return "providers.manage";
  if (pathName.startsWith("/automations") || pathName.startsWith("/calendar-entries")) return "automations.manage";
  if (pathName.startsWith("/brand-kit") || pathName === "/mode-previews/assign") return "brand.manage";
  if (pathName.startsWith("/conversation-drafts") || pathName.startsWith("/conversation-assets")) return "mode.conversation";
  if (pathName.startsWith("/tool-jobs") || pathName.startsWith("/tool-inputs")) return "tools.run";
  if (/^\/jobs\/[^/]+\/publish$/.test(pathName)) return "publish";
  return "video.create";
}

function setResponseHeaders(response, origin) {
  if (origin && allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  if (origin && allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,X-File-Name");
  response.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function authAttemptKey(request) {
  return request.socket.remoteAddress ?? "local";
}

function assertAuthAttemptAllowed(request) {
  const key = authAttemptKey(request);
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { failures: 0, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (current.failures >= 10) throw new AuthError("Too many sign-in attempts. Wait 15 minutes and try again.", 429);
}

function recordAuthFailure(request) {
  const key = authAttemptKey(request);
  const now = Date.now();
  const current = authAttempts.get(key);
  authAttempts.set(key, current && current.resetAt > now
    ? { ...current, failures: current.failures + 1 }
    : { failures: 1, resetAt: now + 15 * 60 * 1000 });
}

function clearAuthAttempts(request) {
  authAttempts.delete(authAttemptKey(request));
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function html(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  response.end(body);
}

function conversationHtml(response, status, body) {
  const frameAncestors = ["'self'", ...[...allowedOrigins].flatMap((origin) => {
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin ? [origin] : [];
    } catch {
      return [];
    }
  })].join(" ");
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Content-Security-Policy": `default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors ${frameAncestors}`,
  });
  response.end(body);
}

function oauthCallbackPage(platform, ok, message, accent) {
  const safeMessage = String(message).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const payload = JSON.stringify({ type: `reelio-${platform.toLowerCase()}-oauth`, ok, message: String(message) }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${platform} connection</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f9;color:#17151d;font:16px Arial,sans-serif}.card{width:min(420px,calc(100% - 40px));padding:32px;border:1px solid #e7e2ee;border-radius:18px;background:white;box-shadow:0 16px 50px #35246516;text-align:center}h1{font-size:24px;margin:0 0 10px}p{color:#6e6876;line-height:1.6;margin:0 0 20px}.mark{width:54px;height:54px;margin:0 auto 18px;border-radius:16px;display:grid;place-items:center;background:${ok ? "#e9f8f0;color:#198354" : "#fff0ed;color:#b84e45"};font-size:28px;font-weight:bold}button{height:40px;padding:0 18px;border:0;border-radius:9px;background:${accent};color:white;font-weight:700}</style></head><body><main class="card"><div class="mark">${ok ? "✓" : "!"}</div><h1>${ok ? `${platform} connected` : "Connection failed"}</h1><p>${safeMessage}</p><button onclick="window.close()">Return to Reelio</button></main><script>window.opener?.postMessage(${payload},'*');</script></body></html>`;
}

function end(response, status) {
  response.writeHead(status);
  response.end();
}

async function streamAsset(request, response, url, file) {
  await access(file);
  const details = await stat(file);
  const range = parseByteRange(request.headers.range, details.size);
  const headers = {
    "Content-Type": contentType(file),
    "Content-Disposition": url.searchParams.get("download") === "1" ? `attachment; filename="${path.basename(file)}"` : "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (range) {
    response.writeHead(206, { ...headers, "Content-Length": range.end - range.start + 1, "Content-Range": `bytes ${range.start}-${range.end}/${details.size}` });
    return createReadStream(file, range).pipe(response);
  }
  response.writeHead(200, { ...headers, "Content-Length": details.size });
  return createReadStream(file).pipe(response);
}

async function instagramConnectionStatus() {
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim();
  const token = process.env.META_USER_ACCESS_TOKEN?.trim();
  const graphVersion = process.env.META_GRAPH_VERSION?.trim();
  const publicMediaBaseUrl = process.env.PUBLIC_MEDIA_BASE_URL?.trim();
  const configured = Boolean(accountId && token && graphVersion && publicMediaBaseUrl);
  if (!configured) return { connected: false, configured: false, accountId: accountId || null, graphVersion: graphVersion || null, publicMediaBaseUrl: publicMediaBaseUrl || null, message: "Add an Instagram Professional account ID, Meta user token, Graph API version, and public media URL." };
  if (!/^v\d+\.\d+$/.test(graphVersion)) return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: "Graph API version must look like v23.0." };
  try {
    const mediaUrl = new URL(publicMediaBaseUrl);
    if (mediaUrl.protocol !== "https:" || mediaUrl.hostname === "localhost" || mediaUrl.hostname === "127.0.0.1") {
      return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: "Public media base URL must be a publicly reachable HTTPS address, not localhost." };
    }
  } catch {
    return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: "Public media base URL must be a valid HTTPS URL." };
  }
  try {
    const fields = new URLSearchParams({ fields: "id,username" });
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(accountId)}?${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: result?.error?.message ?? "Meta rejected the Instagram credentials." };
    if (String(result.id) !== accountId) return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: "The Meta token does not have access to this Instagram account ID." };
    return { connected: true, configured: true, accountId, username: result.username ? `@${result.username}` : "Instagram Professional account", graphVersion, publicMediaBaseUrl, message: "Instagram Professional account verified." };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { connected: false, configured: true, accountId, graphVersion, publicMediaBaseUrl, message: timedOut ? "Instagram connection check timed out. Try again." : "Instagram connection could not be checked." };
  }
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".aac") return "audio/aac";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".srt") return "application/x-subrip; charset=utf-8";
  if (extension === ".vtt") return "text/vtt; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[reelio] ${signal}: finishing shutdown\n`);
  for (const tasks of schedules.values()) for (const task of Array.isArray(tasks) ? tasks : [tasks]) task.stop();
  stopAllJobExecutions();
  httpsServer?.close();
  server.close(() => process.exit(0));
  const timeout = Number(process.env.REELIO_SHUTDOWN_TIMEOUT_MS ?? 10_000);
  setTimeout(() => process.exit(1), timeout).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
