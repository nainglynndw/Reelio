import type { LocalJob, Platform, PlatformEligibility, PublishResult, PublishingReadiness } from "./types";

export const platforms: Platform[] = [
  { id: "youtube", label: "YouTube Shorts", short: "YT", tone: "#ff3b4f" },
  { id: "tiktok", label: "TikTok", short: "TK", tone: "#18d9c5" },
  { id: "facebook", label: "Facebook Reels", short: "FB", tone: "#4b8cff" },
  { id: "instagram", label: "Instagram Reels", short: "IG", tone: "#f060a8" },
];

export function platformEligibility(job: LocalJob, platformId: string, readiness: PublishingReadiness | null): PlatformEligibility {
  if (!readiness) return { eligible: false, setupRequired: false, reason: "Checking publishing setup…", requirements: [] };
  const account = readiness?.accounts?.[platformId];
  const duration = Number(job.metadata?.durationSeconds ?? 0);
  const [width, height] = String(job.metadata?.resolution ?? "1080x1920").split("x").map(Number);
  const frameRate = Number(job.metadata?.frameRate ?? 30);
  const rendered = job.state === "completed" && Boolean(job.assets?.final);
  const verticalOrSquare = Number.isFinite(width) && Number.isFinite(height) && height >= width;
  const dimensionsValid = width >= 360 && height >= 360 && width <= 4096 && height <= 4096;
  const failures: string[] = [];
  const requirements: string[] = [];

  if (!rendered) failures.push("Finish rendering the final MP4 first.");
  if (platformId === "youtube") {
    requirements.push("Connected YouTube channel", "Square or vertical video", "Maximum 3 minutes", "Rights-cleared audio for monetization");
    if (!verticalOrSquare) failures.push("YouTube Shorts must be square or vertical.");
    if (!duration || duration > 180) failures.push("YouTube Shorts must be 3 minutes or shorter.");
  } else if (platformId === "tiktok") {
    requirements.push("TikTok video.upload permission", "MP4 H.264", "23–60 FPS", "360–4096 px", "Maximum 10 minutes / 4 GB");
    if (!duration || duration > 600) failures.push("TikTok Upload API accepts videos up to 10 minutes.");
    if (!dimensionsValid) failures.push("TikTok requires each dimension to be between 360 and 4096 pixels.");
    if (frameRate < 23 || frameRate > 60) failures.push("TikTok requires a frame rate between 23 and 60 FPS.");
  } else if (platformId === "facebook") {
    requirements.push("Facebook Page credentials", "Vertical H.264 + AAC", "3–90 seconds", "Rights-cleared audio");
    if (!verticalOrSquare) failures.push("Reelio's Facebook Reels connector requires a vertical or square video.");
    if (duration < 3 || duration > 90) failures.push("Reelio's Facebook Reels connector supports 3–90 seconds.");
  } else if (platformId === "instagram") {
    requirements.push("Instagram Professional account", "Public media URL", "Vertical H.264 + AAC", "3 seconds–15 minutes", "23–60 FPS");
    if (!verticalOrSquare) failures.push("Reelio's Instagram Reels connector requires a vertical or square video.");
    if (duration < 3 || duration > 900) failures.push("Instagram Reels API accepts videos from 3 seconds to 15 minutes.");
    if (frameRate < 23 || frameRate > 60) failures.push("Instagram Reels requires a frame rate between 23 and 60 FPS.");
  }

  if (!account?.ready) return { eligible: false, setupRequired: true, reason: account?.reason ?? "Check this publishing account in Settings.", requirements };
  if (failures.length) return { eligible: false, setupRequired: false, reason: failures[0], requirements };
  return { eligible: true, setupRequired: false, reason: "Ready to upload.", requirements };
}

export function publishedPlatformLabel(result?: PublishResult) {
  if (!result) return null;
  if (result.status === "published") return "Published";
  if (result.status === "uploaded") return "Uploaded";
  if (result.status === "inbox") return "Inbox delivered";
  if (result.status === "processing" || result.status === "verifying") return "Processing";
  return null;
}

export function platformManageUrl(platformId: string, result?: PublishResult) {
  if (!result) return null;
  if (result.manageUrl) return result.manageUrl;
  if (platformId === "youtube" && result.id) return `https://studio.youtube.com/video/${result.id}/edit`;
  if (platformId === "tiktok") return "https://www.tiktok.com/tiktokstudio/content";
  if (platformId === "facebook" || platformId === "instagram") return "https://business.facebook.com/latest/content";
  return result.url ?? null;
}
