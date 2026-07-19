import { config as loadEnv } from "dotenv";
import { createReadStream } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import cron from "node-cron";
import { allowedOrigin, HttpError, parseByteRange, readJsonBody } from "./http-utils.mjs";
import { renderJob, ffmpegPath } from "./pipeline.mjs";
import { publishJob } from "./publishers.mjs";
import {
  addAutomation,
  addJob,
  getAutomation,
  getJob,
  getRoot,
  initializeStore,
  listAutomations,
  listJobs,
  patchAutomation,
  patchJob,
  removeJob,
} from "./store.mjs";
import { cleanText, normalizePlatforms, normalizeVideoRequest, validateTimezone, ValidationError } from "./validation.mjs";
import { getKokoroHealth } from "./kokoro-client.mjs";
import { getGeminiTtsHealth } from "./gemini-tts-client.mjs";
import { getVoxCpmHealth } from "./voxcpm-client.mjs";
import { generateGroundedText, generateText, textProviderConfig, validateGeminiApiKey } from "./text-provider.mjs";
import { saveLocalSettings } from "./settings-store.mjs";
import { IDEA_SYSTEM_PROMPT, NEWS_RESEARCH_SYSTEM_PROMPT, NEWS_SYSTEM_PROMPT, normalizeIdeaOutput, studioIdea } from "./idea-generator.mjs";
import { assertJobActive, JobStoppedError, runWithJobControl, stopAllJobExecutions, stopJobExecution } from "./job-control.mjs";
import { finishYouTubeOAuth, startYouTubeOAuth, youtubeConnectionStatus, YouTubeOAuthError, youtubeOAuthConfig } from "./youtube-oauth.mjs";
import { finishTikTokOAuth, startTikTokOAuth, tiktokConnectionStatus, TikTokOAuthError, tiktokOAuthConfig } from "./tiktok-oauth.mjs";

loadEnv({ path: [".env.local", ".env"], quiet: true });

const port = Number(process.env.REELIO_SERVICE_PORT ?? 8788);
const maxBodyBytes = Number(process.env.REELIO_MAX_BODY_BYTES ?? 65_536);
const allowedOrigins = new Set((process.env.REELIO_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((value) => value.trim()).filter(Boolean));
const queue = [];
const schedules = new Map();
const stopRequests = new Set();
let working = false;
let shuttingDown = false;

const store = await initializeStore();
queue.push(...store.recoveredJobIds);
for (const automation of listAutomations()) registerSchedule(automation);
if (queue.length) void workQueue();

const server = http.createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  setResponseHeaders(response, requestOrigin);
  if (!allowedOrigin(requestOrigin, allowedOrigins)) return json(response, 403, { error: "Origin is not allowed." });
  if (request.method === "OPTIONS") return end(response, 204);
  const url = new URL(request.url, `http://${request.headers.host ?? `localhost:${port}`}`);

  try {
    if (shuttingDown && request.method !== "GET") return json(response, 503, { error: "The local worker is shutting down." });
    if (request.method === "GET" && url.pathname === "/health") {
      const gemini = await validateGeminiApiKey();
      const tts = await getKokoroHealth();
      const voxcpm2 = await getVoxCpmHealth();
      const geminiTts = getGeminiTtsHealth();
      const text = { ...textProviderConfig(), googleReady: gemini.ready };
      return json(response, 200, {
        ok: true,
        service: "Reelio local worker",
        version: "1.0.0",
        uptimeSeconds: Math.round(process.uptime()),
        queue: { waiting: queue.length, working },
        ffmpeg: Boolean(ffmpegPath),
        providers: {
          gemini: gemini.ready,
          geminiTts: gemini.ready && geminiTts.ready,
          kokoro: tts.ready,
          voxcpm2: voxcpm2.ready,
          openrouter: Boolean(process.env.OPENROUTER_API_KEY),
          pexels: Boolean(process.env.PEXELS_API_KEY),
          youtube: Boolean(process.env.YOUTUBE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN),
          tiktok: Boolean(process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_REFRESH_TOKEN),
          facebook: Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.META_GRAPH_VERSION),
          instagram: Boolean(process.env.INSTAGRAM_ACCOUNT_ID && process.env.META_USER_ACCESS_TOKEN && process.env.META_GRAPH_VERSION && process.env.PUBLIC_MEDIA_BASE_URL),
        },
        tts,
        voxcpm2,
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
          facebook: { ready: facebook.connected, setupComplete: facebook.configured, accountName: facebook.pageName, reason: facebook.connected ? "Facebook Page token verified." : facebook.message },
          instagram: { ready: instagram.connected, setupComplete: instagram.configured, accountName: instagram.username, reason: instagram.connected ? "Instagram Professional account verified." : instagram.message },
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/publishing/facebook/status") {
      return json(response, 200, await facebookConnectionStatus());
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
      const generated = await generateText({
        system: IDEA_SYSTEM_PROMPT,
        user: `Suggest one fact-safe subject for category "${category}" and a ${duration} knowledge video. Write the idea value in ${language}.`,
        maxTokens: 160,
        temperature: 0.65,
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
      const today = new Date().toISOString().slice(0, 10);
      const research = await generateGroundedText({
        system: NEWS_RESEARCH_SYSTEM_PROMPT,
        user: `Today is ${today}. Research current ${category} news now for a factual knowledge video.`,
        maxTokens: 650,
        temperature: 0.2,
        recentDays: 7,
      });
      if (!research) throw new ValidationError("Add a Gemini API key in Settings to search current news.", 503);
      if (!research.sources?.length) throw new ValidationError("No verified recent story was found. Try again.", 502);
      const generated = await generateText({
        system: NEWS_SYSTEM_PROMPT,
        user: `Today is ${today}. Create one ${duration} idea in ${language} using only this source-grounded research:\n\n${research.text}`,
        maxTokens: 220,
        temperature: 0.25,
      });
      const idea = normalizeIdeaOutput(generated?.text);
      if (!idea) throw new ValidationError("No usable current-news idea was produced. Try again.", 502);
      return json(response, 200, { idea, mode: "news", provider: generated.provider, model: generated.model, sources: research.sources });
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
      await patchJob(job.id, { publishState: hasIssues ? "completed_with_issues" : "completed", publishResults: mergedResults });
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

    if (request.method === "GET" && url.pathname === "/automations") return json(response, 200, { automations: listAutomations() });
    if (request.method === "POST" && url.pathname === "/automations") {
      const body = await readJsonBody(request, maxBodyBytes);
      if (!cron.validate(body.cron ?? "")) return json(response, 400, { error: "Invalid cron expression." });
      const now = new Date().toISOString();
      const automation = await addAutomation({
        id: crypto.randomUUID(),
        name: cleanText(body.name ?? "Scheduled knowledge reel", "Automation name", 1, 100),
        enabled: body.enabled !== false,
        cron: body.cron,
        timezone: validateTimezone(body.timezone),
        template: normalizeVideoRequest(body.template),
        requireReview: body.requireReview !== false,
        createdAt: now,
        updatedAt: now,
      });
      registerSchedule(automation);
      return json(response, 201, { automation });
    }
    const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/);
    if (request.method === "PATCH" && automationMatch) {
      const current = getAutomation(automationMatch[1]);
      if (!current) return json(response, 404, { error: "Automation not found." });
      const body = await readJsonBody(request, maxBodyBytes);
      if (body.cron && !cron.validate(body.cron)) return json(response, 400, { error: "Invalid cron expression." });
      const patch = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.cron) patch.cron = body.cron;
      if (body.timezone) patch.timezone = validateTimezone(body.timezone);
      if (body.name) patch.name = cleanText(body.name, "Automation name", 1, 100);
      if (body.template) patch.template = normalizeVideoRequest(body.template);
      if (typeof body.requireReview === "boolean") patch.requireReview = body.requireReview;
      const updated = await patchAutomation(current.id, patch);
      registerSchedule(updated);
      return json(response, 200, { automation: updated });
    }
    return json(response, 404, { error: "Route not found." });
  } catch (error) {
    const status = error instanceof ValidationError || error instanceof HttpError || error instanceof YouTubeOAuthError || error instanceof TikTokOAuthError ? error.status : 500;
    const message = status >= 500 ? "The local worker could not complete this request." : error.message;
    if (status >= 500) process.stderr.write(`[reelio] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return json(response, status, { error: message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`Reelio local worker: http://127.0.0.1:${actualPort}\n`);
});

async function enqueue(request, trigger) {
  if (trigger?.type === "manual" && listJobs().some((job) => job.state === "running" || job.state === "queued")) {
    throw new ValidationError("Another video is already generating. Wait for it to finish before starting a new one.", 409);
  }
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    state: "queued",
    stage: "idea",
    progress: 0,
    message: "Waiting for the local renderer",
    request: normalizeVideoRequest(request),
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

async function workQueue() {
  if (working) return;
  working = true;
  while (queue.length) {
    const id = queue.shift();
    const job = getJob(id);
    if (!job || job.state === "stopped") continue;
    await patchJob(id, { state: "running", attempt: job.attempt + 1, error: null });
    try {
      const result = await runWithJobControl(id, async () => {
        if (stopRequests.delete(id)) throw new JobStoppedError();
        return renderJob(job, (stage, progress, message) => {
          assertJobActive();
          return patchJob(id, { stage, progress, message });
        });
      });
      stopRequests.delete(id);
      await patchJob(id, { ...result, state: "completed", stage: "review", progress: 100, message: "Video package ready for review" });
    } catch (error) {
      const stopRequested = stopRequests.delete(id);
      if (error instanceof JobStoppedError || stopRequested) {
        await patchJob(id, { state: "stopped", stage: "stopped", error: null, message: "Generation stopped; local models unloaded" });
      } else {
        await patchJob(id, { state: "failed", progress: 100, error: error instanceof Error ? error.message : String(error), message: "Rendering failed" });
      }
    }
  }
  working = false;
}

function registerSchedule(automation) {
  schedules.get(automation.id)?.stop();
  schedules.delete(automation.id);
  if (!automation.enabled || !cron.validate(automation.cron)) return;
  try {
    const task = cron.schedule(automation.cron, () => {
      void enqueue(automation.template, { type: "cron", automationId: automation.id, expression: automation.cron, timezone: automation.timezone });
    }, { timezone: validateTimezone(automation.timezone), noOverlap: true });
    schedules.set(automation.id, task);
  } catch (error) {
    process.stderr.write(`[reelio] Automation ${automation.id} disabled in memory: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function publicJob(job) {
  const assets = job.assets ? Object.fromEntries(Object.entries(job.assets).map(([key, asset]) => [key, { name: asset.name, url: `/jobs/${job.id}/assets/${key}`, downloadUrl: `/jobs/${job.id}/assets/${key}?download=1` }])) : null;
  return { ...job, assets };
}

function setResponseHeaders(response, origin) {
  if (origin && allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");
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

async function facebookConnectionStatus() {
  const pageId = process.env.FACEBOOK_PAGE_ID?.trim();
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim();
  const graphVersion = process.env.META_GRAPH_VERSION?.trim();
  const configured = Boolean(pageId && token && graphVersion);
  if (!configured) return { connected: false, configured: false, pageId: pageId || null, graphVersion: graphVersion || null, message: "Add a Facebook Page ID, Page access token, and Graph API version." };
  if (!/^v\d+\.\d+$/.test(graphVersion)) return { connected: false, configured: true, pageId, graphVersion, message: "Graph API version must look like v23.0." };
  try {
    const fields = new URLSearchParams({ fields: "id,name" });
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/me?${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { connected: false, configured: true, pageId, graphVersion, message: result?.error?.message ?? "Meta rejected the Facebook Page credentials." };
    if (String(result.id) !== pageId) return { connected: false, configured: true, pageId, graphVersion, message: "The saved token does not belong to this Facebook Page ID. Copy the Page id and access_token from the same GET /me/accounts entry." };
    return { connected: true, configured: true, pageId, pageName: result.name ?? "Facebook Page", graphVersion, message: "Facebook Page token verified." };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { connected: false, configured: true, pageId, graphVersion, message: timedOut ? "Facebook connection check timed out. Try again." : "Facebook connection could not be checked." };
  }
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
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".m4a")) return "audio/mp4";
  if (file.endsWith(".mp3")) return "audio/mpeg";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".srt")) return "application/x-subrip; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[reelio] ${signal}: finishing shutdown\n`);
  for (const schedule of schedules.values()) schedule.stop();
  stopAllJobExecutions();
  server.close(() => process.exit(0));
  const timeout = Number(process.env.REELIO_SHUTDOWN_TIMEOUT_MS ?? 10_000);
  setTimeout(() => process.exit(1), timeout).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
