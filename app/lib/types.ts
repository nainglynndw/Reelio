export type View = "create" | "library" | "detail" | "automations" | "settings";
export type TtsEngine = "kokoro" | "gemini" | "voxcpm2";
export type PlatformPostCopy = { title: string; caption: string; description: string; tags: string[] };
export type PublishResult = { status: string; id?: string; message?: string; url?: string; manageUrl?: string; publishId?: string; postIds?: string[]; tiktokStatus?: string; progress?: number; processingProgress?: number; uploadedBytes?: number; bytesUploaded?: number; bytesTotal?: number; chunksUploaded?: number; chunksTotal?: number; etaSeconds?: number; processingStartedAt?: string; privacy?: string; requestedPrivacy?: string; publicRestricted?: boolean };

export type LocalJob = {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped";
  stage: string;
  progress: number;
  message: string;
  error?: string;
  request: { prompt: string; category: string; duration: string; language: string; ttsEngine?: TtsEngine; subtitleLanguage: string; platforms: string[] };
  assets?: Record<string, { name: string; url: string; downloadUrl: string }> | null;
  metadata?: {
    title?: string;
    description?: string;
    tags?: string[];
    durationSeconds?: number;
    resolution?: string;
    frameRate?: number;
    narrationLanguage?: string;
    subtitleLanguage?: string;
    voiceProvider?: string;
    visualSource?: string;
    platformCopy?: Record<string, PlatformPostCopy>;
    retentionPreflight?: {
      score?: number;
      hookWithinSeconds?: number;
      averageVisualChangeSeconds?: number;
      highContrastCaptions?: boolean;
      noIntroBeforeHook?: boolean;
    };
  };
  publishResults?: Record<string, PublishResult>;
  reviewState?: "pending" | "approved" | "rejected";
  reviewedAt?: string;
  createdAt: string;
};

export type ProviderHealth = { gemini: boolean; geminiTts: boolean; kokoro: boolean; voxcpm2: boolean; openrouter: boolean; pexels: boolean; youtube: boolean; tiktok: boolean; facebook: boolean; instagram: boolean };
export type TtsHealth = { enabled?: boolean; ready?: boolean; modelLoaded?: boolean; loading?: boolean; provider?: string; model?: string; device?: string; error?: string | null };
export type TextHealth = { ready?: boolean; provider?: string; preferred?: string; model?: string };
export type YouTubeStatus = { connected: boolean; configured: boolean; hasAuthorization?: boolean; channelId?: string; channelTitle?: string; message?: string; redirectUri?: string };
export type TikTokStatus = { connected: boolean; configured: boolean; hasAuthorization?: boolean; accountId?: string; displayName?: string; avatarUrl?: string; uploadReady?: boolean; message?: string; redirectUri?: string };
export type FacebookStatus = { connected: boolean; configured: boolean; hasAuthorization?: boolean; pageId?: string; pageName?: string; graphVersion?: string; needsPageSelection?: boolean; pages?: Array<{ id: string; name: string }>; redirectUri?: string; message?: string };
export type InstagramStatus = { connected: boolean; configured: boolean; accountId?: string; username?: string; graphVersion?: string; publicMediaBaseUrl?: string; message?: string };

export type Platform = {
  id: string;
  label: string;
  short: string;
  tone: string;
};

export type PublishingAccountReadiness = { ready: boolean; setupComplete: boolean; accountName?: string; reason: string };
export type PublishingReadiness = { accounts: Record<string, PublishingAccountReadiness> };
export type PlatformEligibility = { eligible: boolean; setupRequired: boolean; reason: string; requirements: string[] };
