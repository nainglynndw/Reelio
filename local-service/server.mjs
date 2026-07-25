import { config as loadEnv } from "dotenv";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import cron from "node-cron";
import { allowedOrigin, HttpError, parseByteRange, readJsonBody } from "./http-utils.mjs";
import { createLocalVisualThemePlan, createScriptDraft, createVisualThemePlan, findVisualCandidates, renderJob, ffmpegPath } from "./pipeline.mjs";
import { publishJob } from "./publishers.mjs";
import {
  addAutomation,
  addJob,
  addToolInput,
  addToolJob,
  getAutomation,
  getBrandKit,
  getCalendarEntry,
  getJob,
  getRoot,
  getToolInput,
  getToolJob,
  initializeStore,
  listAutomations,
  listCalendarEntries,
  listJobs,
  listToolJobs,
  patchAutomation,
  patchCalendarEntry,
  patchJob,
  patchToolJob,
  removeAutomation,
  removeAutomationCalendarEntries,
  removeJob,
  removeToolJob,
  replaceAutomationCalendarEntries,
  setBrandKit,
} from "./store.mjs";
import { cleanText, normalizePlatforms, normalizeSpeechLanguage, normalizeVideoRequest, normalizeVisualThemes, normalizeVoicePreviewRequest, validateTimezone, ValidationError } from "./validation.mjs";
import { getKokoroHealth } from "./kokoro-client.mjs";
import { getGeminiTtsHealth } from "./gemini-tts-client.mjs";
import { getVoxCpmHealth } from "./voxcpm-client.mjs";
import { getSttHealth } from "./stt-client.mjs";
import { generateGroundedText, generateText, textProviderConfig, validateGeminiApiKey } from "./text-provider.mjs";
import { saveLocalSettings, secretsFilePath } from "./settings-store.mjs";
import { BRIEF_MAX_CHARS, IDEA_SYSTEM_PROMPT, NEWS_RESEARCH_SYSTEM_PROMPT, NEWS_SYSTEM_PROMPT, normalizeIdeaOutput, studioIdea } from "./idea-generator.mjs";
import { assertJobActive, JobStoppedError, runWithJobControl, stopAllJobExecutions, stopJobExecution } from "./job-control.mjs";
import { finishYouTubeOAuth, startYouTubeOAuth, youtubeConnectionStatus, YouTubeOAuthError, youtubeOAuthConfig } from "./youtube-oauth.mjs";
import { finishTikTokOAuth, startTikTokOAuth, tiktokConnectionStatus, TikTokOAuthError, tiktokOAuthConfig } from "./tiktok-oauth.mjs";
import { facebookConnectionStatus, facebookOAuthConfig, FacebookOAuthError, finishFacebookOAuth, selectFacebookPage, startFacebookOAuth } from "./facebook-oauth.mjs";
import { executeTool, normalizeToolRequest, TOOL_DEFINITIONS, toolGroup, ToolValidationError } from "./tools/tool-runner.mjs";
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
import { activeAutomationJob, automationPublishMode, buildCalendarEntries, calendarCronExpressions, calendarDateInTimezone, normalizeAutomationCreate, normalizeAutomationPatch } from "./automations.mjs";
import { generateAutomationBrief, firstLine } from "./automation-brief.mjs";

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

const store = await initializeStore();
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
      const [gemini, tts, voxcpm2, stt, webMedia] = await Promise.all([validateGeminiApiKey(), getKokoroHealth(), getVoxCpmHealth(), getSttHealth(), getWebMediaHealth()]);
      const geminiTts = getGeminiTtsHealth();
      const text = { ...textProviderConfig(), googleReady: gemini.ready };
      return json(response, 200, {
        ok: true,
        service: "Reelio local worker",
        version: "1.0.0",
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
        geminiTts,
        ttsRouting: "English: Kokoro or Gemini; non-English: VoxCPM2 or Gemini",
        text,
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      await access(ffmpegPath);
      return json(response, 200, { ready: !shuttingDown, ffmpeg: true, state: "writable" });
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
      return json(response, 200, { brandKit: publicBrandKit(getBrandKit() ?? defaultBrandKit()) });
    }
    if (request.method === "PATCH" && url.pathname === "/brand-kit") {
      const body = await readJsonBody(request, maxBodyBytes);
      const brandKit = await setBrandKit(updateBrandKit(getBrandKit() ?? defaultBrandKit(), body));
      return json(response, 200, { brandKit: publicBrandKit(brandKit) });
    }
    const brandAssetMatch = url.pathname.match(/^\/brand-kit\/assets\/([^/]+)$/);
    if (request.method === "POST" && brandAssetMatch) {
      const brandKit = await receiveBrandAsset(request, brandAssetMatch[1]);
      return json(response, 201, { brandKit: publicBrandKit(brandKit) });
    }
    if (request.method === "DELETE" && brandAssetMatch) {
      const brandKit = await setBrandKit(clearBrandAsset(getBrandKit() ?? defaultBrandKit(), brandAssetMatch[1]));
      return json(response, 200, { brandKit: publicBrandKit(brandKit) });
    }
    if (request.method === "GET" && brandAssetMatch) {
      const asset = (getBrandKit() ?? defaultBrandKit()).assets?.[brandAssetMatch[1]];
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
      });
      if (!generated && language.toLowerCase() !== "english") throw new ValidationError(`Add a Gemini API key in Settings to generate ${language} ideas.`);
      const idea = generated ? normalizeIdeaOutput(generated.text) : studioIdea(category);
      if (!idea) throw new ValidationError("The AI did not return a usable idea. Try again.", 502);
      return json(response, 200, generated
        ? { idea, mode: "ai", provider: generated.provider, model: generated.model }
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
      });
      const idea = normalizeIdeaOutput(generated?.text);
      if (!idea) throw new ValidationError("No usable current-news idea was produced. Try again.", 502);
      return json(response, 200, { idea, mode: "news", provider: generated.provider, model: generated.model, sources: research.sources });
    }
    if (request.method === "POST" && url.pathname === "/script-draft") {
      const body = await readJsonBody(request, maxBodyBytes);
      const normalized = {
        ...normalizeVideoRequest(body),
        brandKit: snapshotBrandKit(getBrandKit() ?? defaultBrandKit()),
      };
      const provider = textProviderConfig();
      const script = await createScriptDraft(normalized);
      return json(response, 200, {
        script,
        mode: provider.ready ? "ai" : "studio",
        provider: provider.ready ? provider.provider : "built-in",
        model: provider.model,
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

    if (request.method === "GET" && url.pathname === "/tools") {
      return json(response, 200, { tools: TOOL_DEFINITIONS, scheduler: { mediaConcurrency: toolLimit("media"), modelConcurrency: toolLimit("model") } });
    }
    if (request.method === "POST" && url.pathname === "/tool-inputs") {
      const input = await receiveToolInput(request);
      return json(response, 201, { input: publicToolInput(input) });
    }
    if (request.method === "GET" && url.pathname === "/tool-jobs") {
      return json(response, 200, { jobs: listToolJobs().map(publicToolJob) });
    }
    if (request.method === "POST" && url.pathname === "/tool-jobs") {
      const body = await readJsonBody(request, maxBodyBytes);
      const job = await enqueueToolJob(body);
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

    if (request.method === "GET" && url.pathname === "/jobs") return json(response, 200, { jobs: listJobs().map(publicJob) });
    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request, maxBodyBytes);
      const job = await enqueue(body, { type: "manual" });
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
      }, { type: "agent", objective });
      return json(response, 202, { job: publicJob(job) });
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = getJob(jobMatch[1]);
      return job ? json(response, 200, { job: publicJob(job) }) : json(response, 404, { error: "Job not found." });
    }
    if (request.method === "DELETE" && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) return json(response, 404, { error: "Video not found." });
      if (job.state === "running" || job.state === "queued") throw new ValidationError("Wait for rendering to finish before deleting this video.", 409);
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
      return json(response, 200, { automations: listAutomations().map(publicAutomation) });
    }
    if (request.method === "GET" && url.pathname === "/calendar-entries") {
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const automationId = url.searchParams.get("automationId");
      const entries = listCalendarEntries().filter((entry) =>
        (!start || entry.date >= start) && (!end || entry.date <= end) && (!automationId || entry.automationId === automationId));
      return json(response, 200, { entries: entries.map(publicCalendarEntry) });
    }
    if (request.method === "POST" && url.pathname === "/automations") {
      const body = await readJsonBody(request, maxBodyBytes);
      const normalized = normalizeAutomationCreate(body);
      await assertAutomationPublishReady(normalized);
      const now = new Date().toISOString();
      const automation = await addAutomation({
        id: crypto.randomUUID(),
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
    const status = error instanceof ValidationError || error instanceof ToolValidationError || error instanceof BrandKitError || error instanceof HttpError || error instanceof YouTubeOAuthError || error instanceof TikTokOAuthError || error instanceof FacebookOAuthError ? error.status : 500;
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

async function enqueue(request, trigger) {
  if (trigger?.type === "manual" && listJobs().some((job) => job.state === "running" || job.state === "queued")) {
    throw new ValidationError("Another video is already generating. Wait for it to finish before starting a new one.", 409);
  }
  const currentBrandKit = getBrandKit() ?? defaultBrandKit();
  const normalizedRequest = {
    ...normalizeVideoRequest({
      ...request,
      narratorId: request?.narratorId ?? currentBrandKit.defaultNarratorId,
    }),
    brandKit: snapshotBrandKit(currentBrandKit),
  };
  await assertBrandAssetsAvailable(normalizedRequest.brandKit);
  await assertCustomVisualInputsAvailable(normalizedRequest);
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    state: "queued",
    stage: "idea",
    progress: 0,
    message: "Waiting for the local renderer",
    request: normalizedRequest,
    trigger,
    attempt: 0,
    publishState: "not_started",
    reviewState: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await addJob(job);
  queue.push(job.id);
  void workQueue();
  return job;
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
        return renderJob(job, (stage, progress, message) => {
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

async function enqueueToolJob(value) {
  const request = normalizeToolRequest(value);
  if (request.toolId === "video-synthesis" && request.options.applyBrandKit) {
    request.options.brandKit = snapshotBrandKit(getBrandKit() ?? defaultBrandKit());
    await assertBrandAssetsAvailable(request.options.brandKit);
  }
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
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

async function receiveToolInput(request) {
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

async function receiveBrandAsset(request, kind) {
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
    return setBrandKit(withBrandAsset(getBrandKit() ?? defaultBrandKit(), kind, asset));
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
    });
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
    });
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
  const tasks = schedules.get(automation.id) ?? [];
  const active = activeAutomationJob(listJobs(), automation.id);
  const nextRuns = (Array.isArray(tasks) ? tasks : [tasks]).map((task) => task?.getNextRun?.()).filter(Boolean);
  const entries = automation.mode === "calendar" ? listCalendarEntries().filter((entry) => entry.automationId === automation.id) : [];
  return {
    ...automation,
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
  const assets = job.assets ? Object.fromEntries(Object.entries(job.assets).map(([key, asset]) => [key, { name: asset.name, url: `/jobs/${job.id}/assets/${key}`, downloadUrl: `/jobs/${job.id}/assets/${key}?download=1` }])) : null;
  const request = job.request?.brandKit ? { ...job.request, brandKit: sanitizeBrandKitSnapshot(job.request.brandKit) } : job.request;
  return { ...job, request, assets };
}

function publicToolJob(job) {
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
  return { ...job, request, assets };
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

function setResponseHeaders(response, origin) {
  if (origin && allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,X-File-Name");
  response.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
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
