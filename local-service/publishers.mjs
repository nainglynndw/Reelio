import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { getTikTokAccessToken } from "./tiktok-oauth.mjs";

export async function publishJob(job, platformIds, onProgress = async () => {}, options = {}) {
  if (!job.assets?.final?.file) throw new Error("Final video is not available.");
  const results = {};
  const reuploadPlatforms = new Set(options.reuploadPlatforms ?? []);
  for (const platformId of platformIds) {
    try {
      const mediaIssue = publishingMediaIssue(job, platformId);
      if (mediaIssue) throw new Error(mediaIssue);
      await onProgress(platformId, { status: "starting", progress: 0, message: `Starting ${platformId} upload…` });
      if (platformId === "youtube") results.youtube = await uploadYouTube(job, (result) => onProgress(platformId, result), reuploadPlatforms.has(platformId));
      else if (platformId === "tiktok") results.tiktok = await uploadTikTokInbox(job, (result) => onProgress(platformId, result), reuploadPlatforms.has(platformId));
      else if (platformId === "facebook") results.facebook = await uploadFacebookReel(job, (result) => onProgress(platformId, result), reuploadPlatforms.has(platformId));
      else if (platformId === "instagram") results.instagram = await uploadInstagramReel(job);
      else results[platformId] = { status: "unsupported", message: "No connector is registered for this platform." };
    } catch (error) {
      results[platformId] = { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    await onProgress(platformId, results[platformId]);
  }
  return results;
}

export function publishingMediaIssue(job, platformId) {
  const duration = Number(job.metadata?.durationSeconds ?? 0);
  const [width, height] = String(job.metadata?.resolution ?? "1080x1920").split("x").map(Number);
  const frameRate = Number(job.metadata?.frameRate ?? 30);
  if (job.state !== "completed" || !job.assets?.final?.file) return "Finish rendering the final MP4 first.";
  if (platformId === "youtube") {
    if (height < width) return "YouTube Shorts must be square or vertical.";
    if (!duration || duration > 180) return "YouTube Shorts must be 3 minutes or shorter.";
  }
  if (platformId === "tiktok") {
    if (!duration || duration > 600) return "TikTok Upload API accepts videos up to 10 minutes.";
    if (width < 360 || height < 360 || width > 4096 || height > 4096) return "TikTok requires each video dimension to be between 360 and 4096 pixels.";
    if (frameRate < 23 || frameRate > 60) return "TikTok requires a frame rate between 23 and 60 FPS.";
  }
  if (platformId === "facebook") {
    if (height < width) return "Reelio's Facebook Reels connector requires a vertical or square video.";
    if (duration < 3 || duration > 90) return "Reelio's Facebook Reels connector supports 3–90 seconds.";
  }
  if (platformId === "instagram") {
    if (height < width) return "Reelio's Instagram Reels connector requires a vertical or square video.";
    if (duration < 3 || duration > 900) return "Instagram Reels API accepts videos from 3 seconds to 15 minutes.";
    if (frameRate < 23 || frameRate > 60) return "Instagram Reels requires a frame rate between 23 and 60 FPS.";
  }
  return null;
}

async function uploadYouTube(job, onProgress, forceReupload = false) {
  const token = await googleAccessToken();
  if (!token) return needsCredentials("Set YOUTUBE_ACCESS_TOKEN or Google OAuth refresh credentials.");
  const requestedPrivacy = process.env.YOUTUBE_PRIVACY ?? "public";
  const previous = job.publishResults?.youtube;
  if (!forceReupload && previous?.id && ["uploaded", "published"].includes(previous.status)) {
    await onProgress({ ...previous, status: "verifying", progress: 100, message: "Checking YouTube visibility…" });
    return reconcileExistingYouTubeUpload(token, previous, requestedPrivacy);
  }
  const copy = postCopy(job, "youtube");
  const fileSize = (await stat(job.assets.final.file)).size;
  const metadata = {
    snippet: {
      title: copy.title,
      description: `${copy.caption}\n\n${copy.description}`,
      tags: copy.tags,
      categoryId: process.env.YOUTUBE_CATEGORY_ID ?? "27",
      defaultLanguage: languageCode(job.request.language),
    },
    status: {
      privacyStatus: requestedPrivacy,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    },
  };
  await onProgress({ status: "starting", progress: 0, bytesUploaded: 0, bytesTotal: fileSize, message: "Starting resumable YouTube upload…" });
  const metadataBody = JSON.stringify(metadata);
  const session = await fetchWithTimeout("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "Content-Length": String(Buffer.byteLength(metadataBody)), "X-Upload-Content-Length": String(fileSize), "X-Upload-Content-Type": "video/mp4" },
    body: metadataBody,
  }, 60_000);
  const sessionError = await session.json().catch(() => ({}));
  if (!session.ok) throw new Error(apiMessage(sessionError, "YouTube resumable upload could not start."));
  const uploadUrl = session.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL.");

  const ranges = buildYouTubeUploadPlan(fileSize);
  const chunksTotal = ranges.length;
  const uploadStartedAt = Date.now();
  let result = {};
  for (const [index, { start, end }] of ranges.entries()) {
    const length = end - start + 1;
    const upload = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "video/mp4", "Content-Length": String(length), "Content-Range": `bytes ${start}-${end}/${fileSize}` },
      body: createReadStream(job.assets.final.file, { start, end }),
      duplex: "half",
      redirect: "manual",
    }, 300_000);
    if (upload.status !== 308 && !upload.ok) {
      const detail = await upload.json().catch(() => ({}));
      throw new Error(apiMessage(detail, `YouTube upload failed on chunk ${index + 1}/${chunksTotal}.`));
    }
    const bytesUploaded = end + 1;
    const elapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.1);
    const bytesPerSecond = bytesUploaded / elapsedSeconds;
    const etaSeconds = Math.max(0, Math.ceil((fileSize - bytesUploaded) / bytesPerSecond));
    const progress = Math.min(100, Math.round((bytesUploaded / fileSize) * 100));
    await onProgress({ status: progress === 100 ? "verifying" : "uploading", progress, bytesUploaded, bytesTotal: fileSize, chunksUploaded: index + 1, chunksTotal, etaSeconds, message: progress === 100 ? "Upload complete. Verifying YouTube visibility…" : `Uploading chunk ${index + 1} of ${chunksTotal}…` });
    if (upload.status !== 308) result = await upload.json().catch(() => ({}));
  }
  if (!result.id) throw new Error("YouTube completed the transfer without returning a video ID.");
  const thumbnail = await uploadYouTubeThumbnail(token, result.id, job.assets.thumbnail?.file);
  const verified = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(result.id)}`, { headers: { Authorization: `Bearer ${token}` } }, 30_000);
  const verifiedResult = await verified.json().catch(() => ({}));
  const actualPrivacy = verifiedResult.items?.[0]?.status?.privacyStatus ?? result.status?.privacyStatus ?? requestedPrivacy;
  const publicRestricted = requestedPrivacy === "public" && actualPrivacy !== "public";
  return { status: actualPrivacy === "public" ? "published" : "uploaded", id: result.id, url: `https://youtu.be/${result.id}`, manageUrl: `https://studio.youtube.com/video/${result.id}/edit`, privacy: actualPrivacy, requestedPrivacy, publicRestricted, thumbnail, message: publicRestricted ? "YouTube kept this video private. The Google API project needs a YouTube audit before API uploads can be public." : `YouTube confirmed this video is ${actualPrivacy}.` };
}

async function reconcileExistingYouTubeUpload(token, previous, requestedPrivacy) {
  let actualPrivacy = await getYouTubePrivacy(token, previous.id) ?? previous.privacy ?? "private";
  let updateError = "";
  if (actualPrivacy !== requestedPrivacy) {
    const response = await fetchWithTimeout("https://www.googleapis.com/youtube/v3/videos?part=status", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ id: previous.id, status: { privacyStatus: requestedPrivacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: true } }),
    }, 30_000);
    const result = await response.json().catch(() => ({}));
    if (response.ok) actualPrivacy = result.status?.privacyStatus ?? await getYouTubePrivacy(token, previous.id) ?? actualPrivacy;
    else updateError = apiMessage(result, "YouTube would not change the video's visibility.");
  }
  const publicRestricted = requestedPrivacy === "public" && actualPrivacy !== "public";
  const scopeMissing = /insufficient authentication scopes/i.test(updateError);
  return { ...previous, manageUrl: `https://studio.youtube.com/video/${previous.id}/edit`, status: actualPrivacy === "public" ? "published" : "uploaded", privacy: actualPrivacy, requestedPrivacy, publicRestricted, message: publicRestricted ? scopeMissing ? "The current YouTube authorization can upload but cannot change this existing video's privacy. Make it public in YouTube Studio; future uploads will request public." : `${updateError || "YouTube kept this video private."} Complete the YouTube API audit or publish it manually in YouTube Studio.` : `YouTube confirmed this video is ${actualPrivacy}.` };
}

async function getYouTubePrivacy(token, videoId) {
  const response = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${token}` } }, 30_000);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiMessage(result, "YouTube visibility check failed."));
  return result.items?.[0]?.status?.privacyStatus ?? null;
}

export function buildYouTubeUploadPlan(videoSize, chunkSize = 8 * 1024 * 1024) {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw new Error("YouTube video size is invalid.");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize % (256 * 1024) !== 0) throw new Error("YouTube upload chunks must be a positive multiple of 256 KB.");
  return Array.from({ length: Math.ceil(videoSize / chunkSize) }, (_, index) => ({ start: index * chunkSize, end: Math.min(videoSize - 1, (index + 1) * chunkSize - 1) }));
}

async function uploadTikTokInbox(job, onProgress, forceReupload = false) {
  const token = await getTikTokAccessToken();
  if (!token) return needsCredentials("Connect TikTok in Settings with the video.upload scope.");
  const previous = job.publishResults?.tiktok;
  if (!forceReupload && previous?.publishId && ["processing", "inbox", "published"].includes(previous.status)) {
    if (previous.status !== "processing") return { ...previous, manageUrl: "https://www.tiktok.com/tiktokstudio/content" };
    await onProgress({ ...previous, status: "verifying", progress: 100, message: "Checking whether TikTok delivered the video to your inbox…" });
    return tiktokUploadResult(token, previous.publishId, previous.uploadedBytes);
  }
  const size = (await stat(job.assets.final.file)).size;
  const plan = buildTikTokUploadPlan(size);
  await onProgress({ status: "starting", progress: 0, bytesUploaded: 0, bytesTotal: size, chunksUploaded: 0, chunksTotal: plan.ranges.length, message: "Preparing a secure TikTok upload…" });
  const init = await fetchWithTimeout("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.ranges.length } }),
  });
  const initResult = await init.json();
  if (!init.ok || initResult.error?.code !== "ok") throw new Error(apiMessage(initResult, "TikTok upload initialization failed."));
  const uploadStartedAt = Date.now();
  for (const [index, range] of plan.ranges.entries()) {
    const length = range.end - range.start + 1;
    const upload = await fetchWithTimeout(initResult.data.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(length), "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
      body: createReadStream(job.assets.final.file, { start: range.start, end: range.end }),
      duplex: "half",
    }, 300_000);
    if (!upload.ok) {
      const detail = (await upload.text().catch(() => "")).trim();
      throw new Error(`TikTok media upload failed on chunk ${index + 1}/${plan.ranges.length} (${upload.status})${detail ? `: ${detail}` : "."}`);
    }
    const bytesUploaded = range.end + 1;
    const elapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.1);
    const bytesPerSecond = bytesUploaded / elapsedSeconds;
    const etaSeconds = Math.max(0, Math.ceil((size - bytesUploaded) / bytesPerSecond));
    const progress = Math.min(100, Math.round((bytesUploaded / size) * 100));
    await onProgress({ status: progress === 100 ? "verifying" : "uploading", progress, bytesUploaded, bytesTotal: size, chunksUploaded: index + 1, chunksTotal: plan.ranges.length, etaSeconds, publishId: initResult.data.publish_id, message: progress === 100 ? "Upload complete. Waiting for TikTok confirmation…" : `Uploading chunk ${index + 1} of ${plan.ranges.length}…` });
  }
  return waitForTikTokInbox(token, initResult.data.publish_id, size, onProgress);
}

export function buildTikTokUploadPlan(videoSize) {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw new Error("TikTok video size is invalid.");
  const maxWholeUpload = 64_000_000;
  if (videoSize <= maxWholeUpload) return { chunkSize: videoSize, ranges: [{ start: 0, end: videoSize - 1 }] };
  const chunkSize = Math.min(maxWholeUpload, Math.max(10_000_000, Math.ceil(videoSize / 1000)));
  const totalChunkCount = Math.floor(videoSize / chunkSize);
  if (totalChunkCount < 1 || totalChunkCount > 1000) throw new Error("TikTok video cannot be split into an accepted number of chunks.");
  const ranges = Array.from({ length: totalChunkCount }, (_, index) => ({
    start: index * chunkSize,
    end: index === totalChunkCount - 1 ? videoSize - 1 : (index + 1) * chunkSize - 1,
  }));
  const finalRange = ranges.at(-1);
  const finalSize = finalRange.end - finalRange.start + 1;
  if (finalSize > 128_000_000) throw new Error("TikTok's final upload chunk would exceed 128 MB.");
  return { chunkSize, ranges };
}

async function waitForTikTokInbox(token, publishId, uploadedBytes, onProgress) {
  let latest;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await delay(2500);
    latest = await fetchTikTokPublishStatus(token, publishId);
    await onProgress({ status: "verifying", progress: 100, publishId, tiktokStatus: latest.status, bytesUploaded: latest.uploaded_bytes ?? uploadedBytes, bytesTotal: uploadedBytes, message: `TikTok is processing the upload${attempt ? ` • ${Math.round(attempt * 2.5)} seconds` : ""}…` });
    if (["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"].includes(latest.status)) break;
  }
  return tiktokStatusResult(latest, publishId, uploadedBytes);
}

async function tiktokUploadResult(token, publishId, uploadedBytes) {
  return tiktokStatusResult(await fetchTikTokPublishStatus(token, publishId), publishId, uploadedBytes);
}

async function fetchTikTokPublishStatus(token, publishId) {
  const response = await fetchWithTimeout("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error?.code !== "ok") throw new Error(apiMessage(result, "TikTok upload status check failed."));
  return result.data ?? {};
}

function tiktokStatusResult(data, publishId, uploadedBytes) {
  if (data.status === "FAILED") throw new Error(`TikTok rejected the uploaded video${data.fail_reason ? `: ${data.fail_reason}` : "."}`);
  if (data.status === "SEND_TO_USER_INBOX") return { status: "inbox", publishId, manageUrl: "https://www.tiktok.com/tiktokstudio/content", tiktokStatus: data.status, uploadedBytes: data.uploaded_bytes ?? uploadedBytes, message: "TikTok confirmed delivery to your inbox. Open TikTok to finish editing and publish." };
  if (data.status === "PUBLISH_COMPLETE") return { status: "published", publishId, manageUrl: "https://www.tiktok.com/tiktokstudio/content", tiktokStatus: data.status, uploadedBytes: data.uploaded_bytes ?? uploadedBytes, postIds: data.publicaly_available_post_id ?? [], message: "TikTok confirms the draft was published." };
  return { status: "processing", progress: 100, publishId, manageUrl: "https://www.tiktok.com/tiktokstudio/content", tiktokStatus: data.status ?? "PROCESSING_UPLOAD", uploadedBytes: data.uploaded_bytes ?? uploadedBytes, bytesTotal: uploadedBytes, processingStartedAt: new Date().toISOString(), message: "Upload complete. TikTok is processing it; this usually takes under 1 minute, but can take longer." };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadFacebookReel(job, onProgress = async () => {}, forceReupload = false) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const version = process.env.META_GRAPH_VERSION;
  if (!pageId || !token || !version) return needsCredentials("Set FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN, and META_GRAPH_VERSION.");
  const previous = job.publishResults?.facebook;
  if (!forceReupload && previous?.id && previous.status === "processing") {
    return waitForFacebookReel(version, previous.id, token, onProgress);
  }
  const pageCheck = await fetchWithTimeout(`https://graph.facebook.com/${version}/me?fields=id,name`, { headers: { Authorization: `Bearer ${token}` } }, 20_000);
  const page = await pageCheck.json().catch(() => ({}));
  if (!pageCheck.ok) throw new Error(apiMessage(page, "Facebook Page token verification failed."));
  if (String(page.id) !== String(pageId)) throw new Error("The Facebook Page ID and Page access token belong to different Pages. Copy both from the same /me/accounts entry.");
  const base = `https://graph.facebook.com/${version}/${pageId}/video_reels`;
  await onProgress({ status: "starting", progress: 5, message: "Creating a Facebook Reel upload session…" });
  const start = await fetchWithTimeout(`${base}?upload_phase=start&access_token=${encodeURIComponent(token)}`, { method: "POST" });
  const startResult = await readApiPayload(start);
  if (!start.ok) throw new Error(apiMessage(startResult, responseFallback(start, "Facebook Reel initialization failed.")));
  if (!startResult.upload_url || !startResult.video_id) throw new Error("Facebook created an incomplete Reel upload session. Retry the upload.");
  const size = (await stat(job.assets.final.file)).size;
  await onProgress({ status: "uploading", progress: 0, bytesUploaded: 0, bytesTotal: size, message: "Uploading the video file to Facebook…" });
  const upload = await fetchWithTimeout(startResult.upload_url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, "Content-Type": "application/octet-stream", offset: "0", file_size: String(size), "Content-Length": String(size) },
    body: facebookUploadBody(job.assets.final.file, size, onProgress),
    duplex: "half",
  }, 300_000);
  const uploadResult = await readApiPayload(upload);
  if (!upload.ok) throw new Error(apiMessage(uploadResult, responseFallback(upload, "Facebook Reel upload failed.")));
  if (uploadResult.success === false) throw new Error(apiMessage(uploadResult, "Facebook rejected the video transfer."));
  await onProgress({ status: "verifying", progress: 100, bytesUploaded: size, bytesTotal: size, message: "Upload complete. Asking Facebook to publish the Reel…" });
  const copy = postCopy(job, "facebook");
  const finishParams = new URLSearchParams({ upload_phase: "finish", video_id: startResult.video_id, video_state: "PUBLISHED", description: `${copy.caption}\n\n${copy.description}`, access_token: token });
  const finish = await fetchWithTimeout(`${base}?${finishParams}`, { method: "POST" });
  const finishResult = await readApiPayload(finish);
  if (!finish.ok) throw new Error(apiMessage(finishResult, responseFallback(finish, "Facebook Reel publish failed.")));
  return waitForFacebookReel(version, startResult.video_id, token, onProgress);
}

async function* facebookUploadBody(file, size, onProgress) {
  let bytesUploaded = 0;
  let lastReportedAt = 0;
  const startedAt = Date.now();
  for await (const chunk of createReadStream(file)) {
    bytesUploaded += chunk.length;
    const now = Date.now();
    if (bytesUploaded === size || now - lastReportedAt >= 250) {
      lastReportedAt = now;
      const progress = Math.min(99, Math.round((bytesUploaded / size) * 100));
      const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.1);
      const bytesPerSecond = bytesUploaded / elapsedSeconds;
      const etaSeconds = Math.max(0, Math.ceil((size - bytesUploaded) / bytesPerSecond));
      await onProgress({ status: "uploading", progress, bytesUploaded, bytesTotal: size, etaSeconds, message: "Uploading the video file to Facebook…" });
    }
    yield chunk;
  }
}

async function waitForFacebookReel(version, videoId, token, onProgress) {
  const deadline = Date.now() + 120_000;
  let latest = {};
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ fields: "status", access_token: token });
    const response = await fetchWithTimeout(`https://graph.facebook.com/${version}/${videoId}?${params}`, {}, 20_000);
    latest = await readApiPayload(response);
    if (!response.ok) throw new Error(apiMessage(latest, responseFallback(response, "Facebook Reel status check failed.")));
    const status = latest.status ?? {};
    const videoStatus = String(status.video_status ?? "processing").toLowerCase();
    const processingStatus = String(status.processing_phase?.status ?? "").toLowerCase();
    const publishingStatus = String(status.publishing_phase?.status ?? "").toLowerCase();
    const failed = [videoStatus, processingStatus, publishingStatus].some((value) => ["error", "failed", "expired"].includes(value));
    if (failed) throw new Error(status.processing_phase?.error?.message ?? status.publishing_phase?.error?.message ?? `Facebook could not process the Reel (${videoStatus}).`);
    const processingProgress = Number(status.processing_progress ?? 0);
    await onProgress({ status: "processing", progress: 100, id: videoId, processingProgress, manageUrl: "https://business.facebook.com/latest/content", message: `Facebook is processing the Reel${processingProgress ? ` • ${processingProgress}%` : ""}…` });
    if (publishingStatus === "complete" || ["published", "ready"].includes(videoStatus)) {
      return { status: "published", id: videoId, manageUrl: "https://business.facebook.com/latest/content", message: "Facebook confirms the Reel is published.", response: latest };
    }
    await delay(3_000);
  }
  return { status: "processing", progress: 100, id: videoId, manageUrl: "https://business.facebook.com/latest/content", message: "The upload is complete. Facebook is still processing the Reel; use Check Facebook status shortly.", response: latest };
}

async function uploadInstagramReel(job) {
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID;
  const token = process.env.META_USER_ACCESS_TOKEN;
  const version = process.env.META_GRAPH_VERSION;
  const publicBase = process.env.PUBLIC_MEDIA_BASE_URL?.replace(/\/$/, "");
  if (!accountId || !token || !version) return needsCredentials("Set INSTAGRAM_ACCOUNT_ID, META_USER_ACCESS_TOKEN, and META_GRAPH_VERSION.");
  if (!publicBase) return { status: "exported", message: "Instagram requires a public video URL. Set PUBLIC_MEDIA_BASE_URL or upload the exported MP4 manually." };
  const videoUrl = `${publicBase}/jobs/${job.id}/assets/final`;
  const copy = postCopy(job, "instagram");
  const createParams = new URLSearchParams({ media_type: "REELS", video_url: videoUrl, caption: `${copy.caption}\n\n${copy.description}`, share_to_feed: "true", access_token: token });
  const create = await fetchWithTimeout(`https://graph.facebook.com/${version}/${accountId}/media?${createParams}`, { method: "POST" });
  const createResult = await create.json();
  if (!create.ok) throw new Error(apiMessage(createResult, "Instagram container creation failed."));
  const publishParams = new URLSearchParams({ creation_id: createResult.id, access_token: token });
  await waitForInstagramContainer(version, createResult.id, token);
  const publish = await fetchWithTimeout(`https://graph.facebook.com/${version}/${accountId}/media_publish?${publishParams}`, { method: "POST" });
  const publishResult = await publish.json();
  if (!publish.ok) throw new Error(apiMessage(publishResult, "Instagram publish failed. The media container may still be processing; retry shortly."));
  return { status: "published", id: publishResult.id, manageUrl: "https://business.facebook.com/latest/content" };
}

export async function googleAccessToken() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) return process.env.YOUTUBE_ACCESS_TOKEN || null;
  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(apiMessage(result, "Google token refresh failed."));
  return result.access_token;
}

function needsCredentials(message) {
  return { status: "needs_credentials", message };
}

function postCopy(job, platformId) {
  const generated = job.metadata?.platformCopy?.[platformId];
  if (generated) return generated;
  return {
    title: job.metadata?.title ?? "Reelio knowledge video",
    caption: job.metadata?.description ?? "Generated with Reelio",
    description: job.metadata?.description ?? "Generated with Reelio",
    tags: job.metadata?.tags ?? [],
  };
}

async function uploadYouTubeThumbnail(token, videoId, file) {
  if (!file) return "not_available";
  const size = (await stat(file)).size;
  const response = await fetchWithTimeout(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(size) },
    body: createReadStream(file),
    duplex: "half",
  }, 120_000);
  return response.ok ? "uploaded" : "failed";
}

function apiMessage(value, fallback) {
  const error = value?.error;
  const message = error?.message ?? value?.error_description ?? value?.message ?? fallback;
  const details = [];
  if (error?.code != null) details.push(`Meta code ${error.code}`);
  if (error?.error_subcode != null) details.push(`subcode ${error.error_subcode}`);
  if (error?.type) details.push(error.type);
  if (error?.fbtrace_id) details.push(`trace ${error.fbtrace_id}`);
  return details.length ? `${message} (${details.join(" • ")})` : message;
}

async function readApiPayload(response) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return { message: text.replace(/\s+/g, " ").trim().slice(0, 500) }; }
}

function responseFallback(response, message) {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return `${message} Meta returned no error message (HTTP ${status}).`;
}

function languageCode(language = "English") {
  const map = { english: "en", burmese: "my", thai: "th", spanish: "es", japanese: "ja" };
  return map[language.toLowerCase()] ?? "en";
}

async function waitForInstagramContainer(version, creationId, token) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ fields: "status_code,status", access_token: token });
    const response = await fetchWithTimeout(`https://graph.facebook.com/${version}/${creationId}?${params}`, {}, 20_000);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiMessage(result, "Instagram container status check failed."));
    if (result.status_code === "FINISHED") return;
    if (result.status_code === "ERROR" || result.status_code === "EXPIRED") throw new Error(result.status ?? "Instagram media processing failed.");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Instagram media processing timed out. Retry publishing shortly.");
}

async function fetchWithTimeout(url, options, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Platform request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
