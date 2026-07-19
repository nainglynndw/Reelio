"use client";

import {
  ArrowLeft,
  Archive,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudUpload,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  Gauge,
  Globe2,
  Languages,
  Library,
  Lightbulb,
  Menu,
  MessageSquareText,
  Mic2,
  MoreHorizontal,
  Newspaper,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

type View = "create" | "library" | "detail" | "automations" | "settings";
type TtsEngine = "kokoro" | "gemini" | "voxcpm2";
type PlatformPostCopy = { title: string; caption: string; description: string; tags: string[] };
type PublishResult = { status: string; id?: string; message?: string; url?: string; manageUrl?: string; publishId?: string; postIds?: string[]; tiktokStatus?: string; progress?: number; uploadedBytes?: number; bytesUploaded?: number; bytesTotal?: number; chunksUploaded?: number; chunksTotal?: number; etaSeconds?: number; processingStartedAt?: string; privacy?: string; requestedPrivacy?: string; publicRestricted?: boolean };

const SERVICE_URL = process.env.NEXT_PUBLIC_REELIO_SERVICE_URL ?? "http://127.0.0.1:8788";

type LocalJob = {
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

type ProviderHealth = { gemini: boolean; geminiTts: boolean; kokoro: boolean; voxcpm2: boolean; openrouter: boolean; pexels: boolean; youtube: boolean; tiktok: boolean; facebook: boolean; instagram: boolean };
type TtsHealth = { enabled?: boolean; ready?: boolean; modelLoaded?: boolean; loading?: boolean; provider?: string; model?: string; device?: string; error?: string | null };
type TextHealth = { ready?: boolean; provider?: string; preferred?: string; model?: string };
type YouTubeStatus = { connected: boolean; configured: boolean; hasAuthorization?: boolean; channelId?: string; channelTitle?: string; message?: string; redirectUri?: string };
type TikTokStatus = { connected: boolean; configured: boolean; hasAuthorization?: boolean; accountId?: string; displayName?: string; avatarUrl?: string; uploadReady?: boolean; message?: string; redirectUri?: string };
type FacebookStatus = { connected: boolean; configured: boolean; pageId?: string; pageName?: string; graphVersion?: string; message?: string };
type InstagramStatus = { connected: boolean; configured: boolean; accountId?: string; username?: string; graphVersion?: string; publicMediaBaseUrl?: string; message?: string };

type Platform = {
  id: string;
  label: string;
  short: string;
  tone: string;
};

type PublishingAccountReadiness = { ready: boolean; setupComplete: boolean; accountName?: string; reason: string };
type PublishingReadiness = { accounts: Record<string, PublishingAccountReadiness> };
type PlatformEligibility = { eligible: boolean; setupRequired: boolean; reason: string; requirements: string[] };

const platforms: Platform[] = [
  { id: "youtube", label: "YouTube Shorts", short: "YT", tone: "#ff3b4f" },
  { id: "tiktok", label: "TikTok", short: "TK", tone: "#18d9c5" },
  { id: "facebook", label: "Facebook Reels", short: "FB", tone: "#4b8cff" },
  { id: "instagram", label: "Instagram Reels", short: "IG", tone: "#f060a8" },
];

async function fetchPublishingReadiness(): Promise<PublishingReadiness> {
  const response = await fetch(`${SERVICE_URL}/publishing/readiness`);
  if (!response.ok) throw new Error("Publishing readiness could not be checked");
  return response.json() as Promise<PublishingReadiness>;
}

function platformEligibility(job: LocalJob, platformId: string, readiness: PublishingReadiness | null): PlatformEligibility {
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

function publishedPlatformLabel(result?: PublishResult) {
  if (!result) return null;
  if (result.status === "published") return "Published";
  if (result.status === "uploaded") return "Uploaded";
  if (result.status === "inbox") return "Inbox delivered";
  if (result.status === "processing" || result.status === "verifying") return "Processing";
  return null;
}

function platformManageUrl(platformId: string, result?: PublishResult) {
  if (!result) return null;
  if (result.manageUrl) return result.manageUrl;
  if (platformId === "youtube" && result.id) return `https://studio.youtube.com/video/${result.id}/edit`;
  if (platformId === "tiktok") return "https://www.tiktok.com/tiktokstudio/content";
  if (platformId === "facebook" || platformId === "instagram") return "https://business.facebook.com/latest/content";
  return result.url ?? null;
}

const voiceLanguages = [
  "Arabic", "Burmese", "Chinese", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Malay", "Norwegian",
  "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Swedish", "Tagalog", "Thai", "Turkish", "Vietnamese",
];
const speechLanguages = [...voiceLanguages].sort();
const geminiSpeechLanguages = new Set(speechLanguages.filter((language) => !["Khmer", "Tagalog"].includes(language)));

function defaultTtsEngine(language: string): TtsEngine {
  return language === "English" ? "kokoro" : "voxcpm2";
}

function ttsEngineOptions(language: string): Array<{ value: TtsEngine; label: string }> {
  if (language === "English") return [
    { value: "kokoro", label: "Kokoro — local" },
    { value: "gemini", label: "Gemini TTS — cloud" },
  ];
  const options: Array<{ value: TtsEngine; label: string }> = [{ value: "voxcpm2", label: "VoxCPM2 — local" }];
  if (geminiSpeechLanguages.has(language)) options.push({ value: "gemini", label: "Gemini TTS — cloud" });
  return options;
}

function ttsEngineLabel(engine: TtsEngine | undefined, language: string) {
  const value = engine ?? defaultTtsEngine(language);
  return value === "kokoro" ? "Kokoro" : value === "voxcpm2" ? "VoxCPM2" : "Gemini TTS";
}

function jobTtsEngineLabel(job: LocalJob) {
  if (job.request.ttsEngine) return ttsEngineLabel(job.request.ttsEngine, job.request.language);
  const provider = String(job.metadata?.voiceProvider ?? "");
  if (/voxcpm/i.test(provider)) return "VoxCPM2";
  if (/gemini|google/i.test(provider)) return "Gemini TTS";
  if (/kokoro/i.test(provider)) return "Kokoro";
  return ttsEngineLabel(undefined, job.request.language);
}

const workflowSteps = [
  "Writing retention-first script",
  "Generating voice, caption timing & music",
  "Finding licensed stock clips",
  "Rendering platform-ready versions",
];

export default function Home() {
  const [view, setView] = useState<View>("create");
  const [mobileNav, setMobileNav] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState("Curious science");
  const [duration, setDuration] = useState("90 sec");
  const [language, setLanguage] = useState("English");
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>("kokoro");
  const [subtitleLanguage, setSubtitleLanguage] = useState("English");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([
    "youtube",
    "tiktok",
    "facebook",
    "instagram",
  ]);
  const [suggesting, setSuggesting] = useState(false);
  const [newsLoading, setNewsLoading] = useState(false);
  const [ideaMode, setIdeaMode] = useState<"ai" | "studio" | "news" | null>(null);
  const [generating, setGenerating] = useState(false);
  const [stoppingGeneration, setStoppingGeneration] = useState(false);
  const [step, setStep] = useState(0);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [completedJob, setCompletedJob] = useState<LocalJob | null>(null);
  const [selectedJob, setSelectedJob] = useState<LocalJob | null>(null);
  const [serviceReady, setServiceReady] = useState(false);
  const [automationOn, setAutomationOn] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch(`${SERVICE_URL}/health`).then((response) => setServiceReady(response.ok)).catch(() => setServiceReady(false));
    fetch(`${SERVICE_URL}/jobs`).then((response) => response.json()).then((value: { jobs?: LocalJob[] }) => {
      const jobs = value.jobs ?? [];
      const active = jobs.find((job) => job.state === "running" || job.state === "queued");
      if (active) {
        setPrompt(active.request.prompt);
        setCategory(active.request.category);
        setDuration(active.request.duration);
        setLanguage(active.request.language);
        setTtsEngine(active.request.ttsEngine ?? defaultTtsEngine(active.request.language));
        setSubtitleLanguage(active.request.subtitleLanguage);
        setGenerating(true);
        setActiveJobId(active.id);
        setRenderProgress(active.progress ?? 0);
        setRenderMessage(active.message ?? "Resuming local render");
        setStep(stageStep(active.stage));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        const response = await fetch(`${SERVICE_URL}/jobs/${activeJobId}`);
        if (!response.ok) throw new Error("Local renderer unavailable");
        const { job } = await response.json() as { job: LocalJob };
        if (cancelled) return;
        setRenderProgress((current) => Math.max(current, job.progress ?? 0));
        setRenderMessage(job.message ?? "Rendering");
        setStep((current) => Math.max(current, stageStep(job.stage)));
        if (job.state === "completed") {
          setGenerating(false);
          setCompletedJob(job);
          setActiveJobId(null);
          setToast("Real video package is ready for review");
        } else if (job.state === "failed") {
          setGenerating(false);
          setActiveJobId(null);
          setToast(job.error ? `Render failed: ${job.error.slice(0, 110)}` : "Rendering failed");
        } else if (job.state === "stopped") {
          setGenerating(false);
          setStoppingGeneration(false);
          setActiveJobId(null);
          setRenderMessage(job.message);
          setToast("Generation stopped and local models unloaded");
        }
      } catch {
        setGenerating(false);
        setActiveJobId(null);
        setServiceReady(false);
        setToast("Local renderer stopped. Restart npm run dev and retry.");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function suggestIdea() {
    setSuggesting(true);
    setIdeaMode(null);
    try {
      const response = await fetch(`${SERVICE_URL}/idea`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, duration, language }),
      });
      if (!response.ok) throw new Error("Suggestion unavailable");
      const result = (await response.json()) as { idea: string; mode?: "ai" | "studio" };
      setPrompt(result.idea);
      setIdeaMode(result.mode ?? "ai");
      setToast("Fresh idea added to your brief");
    } catch {
      if (language.toLowerCase() === "english") {
        setPrompt("Explain the surprising reason your brain remembers unfinished tasks, using a coffee-shop story, one practical example, and a simple challenge viewers can try today.");
        setIdeaMode("studio");
        setToast("Studio idea added to your brief");
      } else setToast(`Add a Gemini API key in Settings for ${language} ideas`);
    } finally {
      setSuggesting(false);
    }
  }

  async function getLatestNews() {
    setNewsLoading(true);
    setIdeaMode(null);
    try {
      const response = await fetch(`${SERVICE_URL}/news`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, duration, language }),
      });
      if (!response.ok) throw new Error("Latest news unavailable");
      const result = (await response.json()) as { idea: string; sources?: Array<{ title: string; url: string }> };
      setPrompt(result.idea);
      setIdeaMode("news");
      setToast(`Latest sourced story added${result.sources?.length ? ` • ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}` : ""}`);
    } catch {
      setToast("Could not verify a current story. Try again.");
    } finally {
      setNewsLoading(false);
    }
  }

  async function startGeneration() {
    if (generating || activeJobId) {
      setToast("A video is already generating. Wait for it to finish.");
      return;
    }
    if (!prompt.trim()) {
      setToast("Add an idea or ask AI to suggest one first");
      return;
    }
    setStep(0);
    setRenderProgress(2);
    setRenderMessage("Starting the local renderer");
    setCompletedJob(null);
    setGenerating(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, category, duration, language, ttsEngine, subtitleLanguage, platforms: selectedPlatforms }),
      });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Local renderer unavailable");
      const job = result.job;
      setActiveJobId(job.id);
      setServiceReady(true);
      setToast("Real generation workflow started");
    } catch (error) {
      setGenerating(false);
      setToast(error instanceof Error ? error.message : "Could not start video generation");
    }
  }

  async function stopGeneration() {
    if (!activeJobId || stoppingGeneration) return;
    setStoppingGeneration(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${activeJobId}/stop`, { method: "POST" });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Generation could not be stopped");
      setGenerating(false);
      setActiveJobId(null);
      setRenderMessage(result.job.message);
      setToast("Generation stopped and local model memory released");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Generation could not be stopped");
    } finally {
      setStoppingGeneration(false);
    }
  }

  function togglePlatform(id: string) {
    setSelectedPlatforms((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function changeSpeechLanguage(value: string) {
    setLanguage(value);
    setTtsEngine(defaultTtsEngine(value));
  }

  function openJob(job: LocalJob) {
    setSelectedJob(job);
    setView("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openCreatedJob(job: LocalJob) {
    if (job.state === "queued" || job.state === "running") {
      setActiveJobId(job.id);
      setGenerating(true);
      setRenderProgress(job.progress ?? 0);
      setRenderMessage(job.message ?? "Waiting for the local renderer");
      setStep(stageStep(job.stage));
    }
    openJob(job);
  }

  function beginNewVideo() {
    if (generating || activeJobId) {
      setView("create");
      setMobileNav(false);
      setToast("A video is generating. Finish it before starting another.");
      return;
    }
    setView("create");
    setMobileNav(false);
    setPrompt("");
    setCategory("Curious science");
    setDuration("90 sec");
    setLanguage("English");
    setTtsEngine("kokoro");
    setSubtitleLanguage("English");
    setSelectedPlatforms(["youtube", "tiktok", "facebook", "instagram"]);
    setSuggesting(false);
    setIdeaMode(null);
    setGenerating(false);
    setStep(0);
    setRenderProgress(0);
    setRenderMessage("");
    setActiveJobId(null);
    setCompletedJob(null);
    setSelectedJob(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.4} /></div>
          <div>
            <strong>Reelio</strong>
            <span>AI Video Studio</span>
          </div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={19} /></button>
        </div>

        <button className="new-video-button" onClick={beginNewVideo}>
          <Plus size={18} /> New video
        </button>

        <nav aria-label="Main navigation">
          <NavButton icon={<WandSparkles size={18} />} label="Create" active={view === "create"} onClick={() => { setView("create"); setMobileNav(false); }} />
          <NavButton icon={<Library size={18} />} label="Video library" active={view === "library" || view === "detail"} onClick={() => { setView("library"); setMobileNav(false); }} />
          <NavButton icon={<CalendarClock size={18} />} label="Automations" active={view === "automations"} badge="Live" onClick={() => { setView("automations"); setMobileNav(false); }} />
        </nav>

        <div className="sidebar-section-label">Workspace</div>
        <nav aria-label="Workspace navigation">
          <NavButton icon={<FolderOpen size={18} />} label="Brand assets" onClick={() => setToast("Brand assets are planned for the next build")} />
          <NavButton icon={<Archive size={18} />} label="Archive" onClick={() => setToast("Archive is empty")} />
        </nav>

        <div className="sidebar-bottom">
          <NavButton icon={<Settings size={18} />} label="Settings" active={view === "settings"} onClick={() => { setView("settings"); setMobileNav(false); }} />
          <NavButton icon={<CircleHelp size={18} />} label="Help center" onClick={() => setToast("Help center is coming soon")} />
          <div className="usage-card">
            <div><span>Monthly render time</span><strong>46 / 120 min</strong></div>
            <div className="usage-track"><span /></div>
            <small>Resets in 12 days</small>
          </div>
          <div className="profile-row">
            <div className="avatar">NL</div>
            <div><strong>Creator workspace</strong><span>Local on this Mac</span></div>
            <MoreHorizontal size={18} />
          </div>
        </div>
      </aside>

      {mobileNav && <button className="sidebar-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <section className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="crumb"><span>Studio</span><ChevronRight size={14} /><strong>{viewLabel(view)}</strong></div>
          <div className="topbar-actions">
            <div className={`system-pill ${serviceReady ? "" : "offline"}`}><span className="status-dot" /> {serviceReady ? "Renderer ready" : "Renderer offline"}</div>
            <button className="icon-button" aria-label="Search"><Search size={19} /></button>
            <button className="icon-button" aria-label="Notifications"><Zap size={18} /></button>
          </div>
        </header>

        {view === "create" && (
          <CreateView
            prompt={prompt}
            setPrompt={setPrompt}
            category={category}
            setCategory={setCategory}
            duration={duration}
            setDuration={setDuration}
            language={language}
            setLanguage={changeSpeechLanguage}
            ttsEngine={ttsEngine}
            setTtsEngine={(value) => setTtsEngine(value as TtsEngine)}
            subtitleLanguage={subtitleLanguage}
            setSubtitleLanguage={setSubtitleLanguage}
            selectedPlatforms={selectedPlatforms}
            togglePlatform={togglePlatform}
            suggesting={suggesting}
            suggestIdea={suggestIdea}
            newsLoading={newsLoading}
            getLatestNews={getLatestNews}
            ideaMode={ideaMode}
            generating={generating}
            step={step}
            renderProgress={renderProgress}
            renderMessage={renderMessage}
            completedJob={completedJob}
            openJob={openJob}
            startGeneration={startGeneration}
            stopGeneration={stopGeneration}
            stoppingGeneration={stoppingGeneration}
          />
        )}
        {view === "library" && <LibraryView onNewVideo={beginNewVideo} onOpenJob={openJob} onOpenSettings={() => { setView("settings"); window.setTimeout(() => document.getElementById("publishing-accounts")?.scrollIntoView({ behavior: "smooth" }), 50); }} setToast={setToast} />}
        {view === "detail" && selectedJob && <VideoDetailView key={selectedJob.id} job={selectedJob} generationLocked={Boolean(activeJobId) || generating} onBack={() => setView("library")} onOpenSettings={() => { setView("settings"); window.setTimeout(() => document.getElementById("publishing-accounts")?.scrollIntoView({ behavior: "smooth" }), 50); }} onJobCreated={openCreatedJob} setToast={setToast} />}
        {view === "automations" && <AutomationsView automationOn={automationOn} setAutomationOn={setAutomationOn} setToast={setToast} />}
        {view === "settings" && <SettingsView setToast={setToast} />}
      </section>

      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </main>
  );
}

function NavButton({ icon, label, active, count, badge, onClick }: { icon: React.ReactNode; label: string; active?: boolean; count?: string; badge?: string; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      {icon}<span>{label}</span>{count && <small>{count}</small>}{badge && <em>{badge}</em>}
    </button>
  );
}

function CreateView(props: {
  prompt: string;
  setPrompt: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  duration: string;
  setDuration: (value: string) => void;
  language: string;
  setLanguage: (value: string) => void;
  ttsEngine: TtsEngine;
  setTtsEngine: (value: string) => void;
  subtitleLanguage: string;
  setSubtitleLanguage: (value: string) => void;
  selectedPlatforms: string[];
  togglePlatform: (id: string) => void;
  suggesting: boolean;
  suggestIdea: () => void;
  newsLoading: boolean;
  getLatestNews: () => void;
  ideaMode: "ai" | "studio" | "news" | null;
  generating: boolean;
  step: number;
  renderProgress: number;
  renderMessage: string;
  completedJob: LocalJob | null;
  openJob: (job: LocalJob) => void;
  startGeneration: () => void | Promise<void>;
  stopGeneration: () => void | Promise<void>;
  stoppingGeneration: boolean;
}) {
  return (
    <div className="content-wrap create-page">
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow"><span /> RETENTION-FIRST CREATOR</div>
          <h1>Turn an idea into a reel people finish.</h1>
          <p>AI writes, finds visuals, voices, captions, and prepares every platform version.</p>
        </div>
        <button className="draft-button"><CloudUpload size={17} /> Saved locally</button>
      </div>

      <div className="creator-grid">
        <section className="composer-card">
          <div className="composer-topline">
            <div><MessageSquareText size={18} /><span>Describe your video</span></div>
            {props.ideaMode && <span className="idea-source"><Sparkles size={13} /> {props.ideaMode === "news" ? "Latest news" : props.ideaMode === "ai" ? "AI idea" : "Studio idea"}</span>}
          </div>
          <div className="prompt-box">
            <textarea
              aria-label="Video idea"
              value={props.prompt}
              onChange={(event) => props.setPrompt(event.target.value)}
              placeholder="Tell me what you want your audience to learn…"
              maxLength={700}
            />
            <div className="prompt-footer">
              <span>{props.prompt.length}/700</span>
              <div className="idea-actions">
                <button className="ai-suggest-button news-button" onClick={props.getLatestNews} disabled={props.newsLoading || props.suggesting} data-testid="latest-news">
                  {props.newsLoading ? <RefreshCw size={16} className="spin" /> : <Newspaper size={16} />}
                  {props.newsLoading ? "Searching…" : "Latest news"}
                  <span className="news-chip">LIVE</span>
                </button>
                <button className="ai-suggest-button" onClick={props.suggestIdea} disabled={props.suggesting || props.newsLoading} data-testid="ai-suggest">
                  {props.suggesting ? <RefreshCw size={16} className="spin" /> : <Lightbulb size={16} />}
                  {props.suggesting ? "Thinking…" : "Suggest an idea"}
                  <span className="ai-chip">AI</span>
                </button>
              </div>
            </div>
          </div>

          <div className="assistant-note">
            <div className="assistant-avatar"><Bot size={17} /></div>
            <div>
              <strong>I’ll ask before I guess.</strong>
              <p>If the topic, audience, or goal is unclear, the script workflow pauses for one focused question.</p>
            </div>
          </div>

          <div className="form-section">
            <div className="section-title"><span>Creative direction</span><small>Used by the AI idea generator</small></div>
            <div className="field-grid">
              <SelectField icon={<Sparkles size={16} />} label="Topic lane" value={props.category} onChange={props.setCategory} options={["Curious science", "Psychology", "Business", "History", "Technology", "Wellness"]} />
              <SelectField icon={<Clock3 size={16} />} label="Target duration" value={props.duration} onChange={props.setDuration} options={["60 sec", "75 sec", "90 sec", "2 min", "Up to 3 min"]} />
              <SelectField icon={<Mic2 size={16} />} label="Speech / transcript language" value={props.language} onChange={props.setLanguage} options={speechLanguages} />
              <SelectField icon={<Zap size={16} />} label="Voice engine" value={props.ttsEngine} onChange={props.setTtsEngine} options={ttsEngineOptions(props.language)} />
              <SelectField icon={<Languages size={16} />} label="Subtitle language" value={props.subtitleLanguage} onChange={props.setSubtitleLanguage} options={voiceLanguages} />
            </div>
          </div>

          <div className="form-section platform-section">
            <div className="section-title"><span>Prepare for</span><button onClick={() => platforms.forEach((p) => !props.selectedPlatforms.includes(p.id) && props.togglePlatform(p.id))}>Select all</button></div>
            <div className="platform-grid">
              {platforms.map((platform) => {
                const checked = props.selectedPlatforms.includes(platform.id);
                return (
                  <button key={platform.id} className={`platform-choice ${checked ? "selected" : ""}`} onClick={() => props.togglePlatform(platform.id)}>
                    <PlatformLogo platform={platform} />
                    <span>{platform.label}</span>
                    <i>{checked && <Check size={13} />}</i>
                  </button>
                );
              })}
            </div>
          </div>

          {props.generating && (
            <div className="generation-status">
              <div className="generation-head"><span><Sparkles size={16} /> {props.renderMessage || "Building your reel"}</span><strong>{props.renderProgress}%</strong></div>
              <div className="generation-track"><span style={{ width: `${props.renderProgress}%` }} /></div>
              <div className="generation-steps">
                {workflowSteps.map((item, index) => <span key={item} className={index <= props.step ? "done" : ""}>{index < props.step ? <Check size={12} /> : index === props.step ? <RefreshCw size={12} className="spin" /> : <span className="step-dot" />}{item}</span>)}
              </div>
            </div>
          )}

          {props.completedJob?.assets && (
            <div className="completed-package">
              <div><span><Check size={16} /> Real video package ready</span><strong>{Math.round(props.completedJob.metadata?.durationSeconds ?? 0)} sec</strong></div>
              <div className="asset-actions">
                <a href={`${SERVICE_URL}${props.completedJob.assets.final.downloadUrl}`}><Download size={14} /> Final MP4</a>
                <a href={`${SERVICE_URL}${props.completedJob.assets.clean.downloadUrl}`}><Film size={14} /> Clean video</a>
                <a href={`${SERVICE_URL}${props.completedJob.assets.captions.downloadUrl}`}><Languages size={14} /> SRT</a>
                <a href={`${SERVICE_URL}${props.completedJob.assets.transcript.downloadUrl}`}><MessageSquareText size={14} /> Transcript</a>
                {props.completedJob.assets.thumbnail && <a href={`${SERVICE_URL}${props.completedJob.assets.thumbnail.downloadUrl}`}><Download size={14} /> Thumbnail</a>}
              </div>
              <button className="package-detail-button" onClick={() => props.openJob(props.completedJob!)}><ChevronRight size={16} /> View video details</button>
              <button onClick={() => props.openJob(props.completedJob!)}><ShieldCheck size={16} /> Review and choose publishing platforms</button>
            </div>
          )}

          <button className={`generate-button ${props.generating ? "stop-generation-button" : ""}`} onClick={props.generating ? props.stopGeneration : props.startGeneration} disabled={props.stoppingGeneration}>
            {props.generating ? (props.stoppingGeneration ? <RefreshCw size={18} className="spin" /> : <X size={18} />) : <WandSparkles size={18} />}
            {props.generating ? (props.stoppingGeneration ? "Stopping and unloading…" : "Stop & unload models") : "Generate video package"}
            {!props.generating && <span>⌘ ↵</span>}
          </button>
        </section>

      </div>
    </div>
  );
}

function SelectField({ icon, label, value, options, onChange, disabled = false }: { icon: React.ReactNode; label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="select-field">
      <span>{icon}{label}</span>
      <div><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => typeof option === "string" ? <option key={option} value={option}>{option}</option> : <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div>
    </label>
  );
}

function PlatformLogo({ platform }: { platform: Platform }) {
  const icon = platform.id === "youtube" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 7.7v8.6L16.7 12 9.2 7.7Z" /></svg>
    : platform.id === "tiktok" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.1 3h3c.4 2.1 1.7 3.5 3.9 3.8v3.1a8 8 0 0 1-3.9-1.2v6.4a5.4 5.4 0 1 1-4.7-5.3V13a2.3 2.3 0 1 0 1.7 2.2V3Z" /></svg>
    : platform.id === "facebook" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.8 21v-8h2.8l.4-3h-3.2V8.1c0-.9.3-1.5 1.6-1.5h1.7V3.9c-.3 0-1.5-.1-2.8-.1-2.8 0-4.7 1.7-4.7 4.9V10H6.5v3h3.1v8h4.2Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="4.5" /><circle cx="12" cy="12" r="3.4" /><circle className="instagram-dot" cx="17.2" cy="6.9" r="1" /></svg>;
  return <span className={`platform-logo ${platform.id}`} role="img" aria-label={`${platform.label} icon`}>{icon}</span>;
}

function LibraryView({ onNewVideo, onOpenJob, onOpenSettings, setToast }: { onNewVideo: () => void; onOpenJob: (job: LocalJob) => void; onOpenSettings: () => void; setToast: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [localJobs, setLocalJobs] = useState<LocalJob[]>([]);
  const [readiness, setReadiness] = useState<PublishingReadiness | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const refreshJobs = () => fetch(`${SERVICE_URL}/jobs`).then((response) => response.json()).then((value: { jobs?: LocalJob[] }) => setLocalJobs(value.jobs ?? [])).catch(() => setLocalJobs([]));
  useEffect(() => { void refreshJobs(); void fetchPublishingReadiness().then(setReadiness).catch(() => setReadiness(null)); }, []);
  const filteredJobs = localJobs.filter((job) => job.request.prompt.toLowerCase().includes(query.toLowerCase()));

  async function deleteVideo(job: LocalJob) {
    const confirmed = window.confirm(`Permanently delete “${job.metadata?.title ?? job.request.prompt.slice(0, 70)}” and every local video, audio, subtitle, transcript, thumbnail, clip, and metadata file?`);
    if (!confirmed) return;
    setDeletingId(job.id);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${job.id}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Video could not be deleted");
      setLocalJobs((jobs) => jobs.filter((item) => item.id !== job.id));
      setToast("Video and all local assets deleted");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Video could not be deleted");
    } finally {
      setDeletingId(null);
    }
  }
  return (
    <div className="content-wrap library-page">
      <div className="page-heading">
        <div><div className="eyebrow"><span /> CONTENT LIBRARY</div><h1>Every reel, language, and upload.</h1><p>Review modular assets and publish status from one place.</p></div>
        <button className="primary-small" onClick={onNewVideo}><Plus size={17} /> New video</button>
      </div>
      <div className="library-toolbar">
        <label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search videos" /></label>
        <div><button className="filter-active">All videos <span>{localJobs.length}</span></button><button onClick={onOpenSettings}><Settings size={13} /> Manage platforms</button><button onClick={refreshJobs}><RefreshCw size={13} /> Refresh</button></div>
      </div>
      {filteredJobs.length > 0 && <div className="real-jobs">
        <div className="real-jobs-title"><span><Zap size={14} /> Local renders</span><small>Durable jobs from this Mac</small></div>
        {filteredJobs.map((job) => { const eligible = platforms.filter((platform) => platformEligibility(job, platform.id, readiness).eligible); const published = platforms.map((platform) => ({ platform, label: publishedPlatformLabel(job.publishResults?.[platform.id]) })).filter((item) => item.label); return <div className="real-job-row" key={job.id}>
          <span className={`real-job-icon ${job.state}`}><Film size={16} /></span>
          <span><strong>{job.metadata?.title ?? job.request.prompt.slice(0, 70)}</strong><small>{job.request.language} {jobTtsEngineLabel(job)} voice • {job.request.subtitleLanguage} captions • curated music</small><span className="library-platform-summary"><span><b>Eligible</b>{eligible.length ? eligible.map((platform) => <em key={platform.id} title={`${platform.label}: ready to upload`}><PlatformLogo platform={platform} /><span className="sr-only">{platform.label}</span></em>) : <i>None</i>}</span><span><b>Published</b>{published.length ? published.map(({ platform, label }) => <em className="published" key={platform.id} title={`${platform.label}: ${label}`}><PlatformLogo platform={platform} /><span>{label}</span></em>) : <i>None</i>}</span></span></span>
          <span className={`status-label ${job.state === "completed" ? "published" : job.state === "failed" || job.state === "stopped" ? "rendering" : "ready"}`}><i />{job.state === "running" ? `${job.progress}% ${job.message}` : job.state}</span>
          <span className="real-job-actions">
            <button onClick={() => onOpenJob(job)}>View details</button>
            {job.assets?.final && <a href={`${SERVICE_URL}${job.assets.final.downloadUrl}`} aria-label="Download final MP4"><Download size={14} /></a>}
            <button className="delete-video-button" onClick={() => deleteVideo(job)} disabled={deletingId === job.id || job.state === "running" || job.state === "queued"} title={job.state === "running" || job.state === "queued" ? "Wait for rendering to finish" : "Delete video and every local asset"}><Trash2 size={13} /> {deletingId === job.id ? "Deleting…" : "Delete"}</button>
          </span>
        </div>; })}
      </div>}
      {filteredJobs.length === 0 && <div className="empty-library"><Film size={28} /><strong>{query ? "No matching videos" : "Your video library is empty"}</strong><p>{query ? "Try a different search." : "Generate a new video package and it will appear here."}</p><button className="primary-small" onClick={() => setView("create")}><Plus size={16} /> Create video</button></div>}
    </div>
  );
}

type DetailTab = "overview" | "transcript" | "captions" | "assets" | "publishing";

function VideoDetailView({ job, generationLocked, onBack, onOpenSettings, onJobCreated, setToast }: { job: LocalJob; generationLocked: boolean; onBack: () => void; onOpenSettings: () => void; onJobCreated: (job: LocalJob) => void; setToast: (value: string) => void }) {
  const [currentJob, setCurrentJob] = useState(job);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [transcript, setTranscript] = useState("");
  const [captions, setCaptions] = useState("");
  const [newSpeechLanguage, setNewSpeechLanguage] = useState(job.request.language);
  const [newTtsEngine, setNewTtsEngine] = useState<TtsEngine>(job.request.ttsEngine ?? defaultTtsEngine(job.request.language));
  const [newSubtitleLanguage, setNewSubtitleLanguage] = useState(job.request.subtitleLanguage);
  const [versionCreating, setVersionCreating] = useState(false);
  const [publishSelection, setPublishSelection] = useState(job.request.platforms);
  const [publishing, setPublishing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [publishResults, setPublishResults] = useState(currentJob.publishResults ?? {});
  const [readiness, setReadiness] = useState<PublishingReadiness | null>(null);
  const [checkingTikTokStatus, setCheckingTikTokStatus] = useState(false);
  const [tiktokAutoChecks, setTikTokAutoChecks] = useState(0);
  const isDemo = currentJob.id.startsWith("demo-");
  const title = currentJob.metadata?.title ?? currentJob.request.prompt;
  const score = currentJob.metadata?.retentionPreflight?.score ?? 0;
  const durationSeconds = Math.round(currentJob.metadata?.durationSeconds ?? 0);
  const renderLocked = generationLocked || currentJob.state === "running" || currentJob.state === "queued";
  const eligibilityByPlatform = Object.fromEntries(platforms.map((platform) => [platform.id, platformEligibility(currentJob, platform.id, readiness)])) as Record<string, PlatformEligibility>;

  function changeVersionSpeechLanguage(value: string) {
    setNewSpeechLanguage(value);
    setNewTtsEngine(defaultTtsEngine(value));
  }

  useEffect(() => {
    if (isDemo || currentJob.state === "completed" || currentJob.state === "failed" || currentJob.state === "stopped") return;
    const poll = async () => {
      try {
        const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}`);
        if (!response.ok) return;
        const { job: refreshed } = await response.json() as { job: LocalJob };
        setCurrentJob(refreshed);
        if (refreshed.state === "completed") setToast("New language version is ready");
        if (refreshed.state === "stopped") setToast("Generation stopped and local models unloaded");
      } catch {}
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => window.clearInterval(timer);
  }, [currentJob.id, currentJob.state, isDemo, setToast]);

  useEffect(() => {
    if (!currentJob.assets) return;
    if (currentJob.assets.transcript) fetch(`${SERVICE_URL}${currentJob.assets.transcript.url}`).then((response) => response.text()).then(setTranscript).catch(() => setTranscript("Transcript could not be loaded."));
    if (currentJob.assets.captions) fetch(`${SERVICE_URL}${currentJob.assets.captions.url}`).then((response) => response.text()).then(setCaptions).catch(() => setCaptions("Captions could not be loaded."));
  }, [currentJob.id, currentJob.assets]);

  useEffect(() => {
    void fetchPublishingReadiness().then((value) => {
      setReadiness(value);
      setPublishSelection((selected) => selected.filter((id) => platformEligibility(job, id, value).eligible));
    }).catch(() => setReadiness(null));
  }, [job]);

  useEffect(() => {
    if (!publishing || isDemo) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}`);
        if (!response.ok || cancelled) return;
        const { job: refreshed } = await response.json() as { job: LocalJob };
        setCurrentJob(refreshed);
        setPublishResults(refreshed.publishResults ?? {});
      } catch {}
    };
    void poll();
    const timer = window.setInterval(poll, 650);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentJob.id, isDemo, publishing]);

  useEffect(() => {
    if (publishResults.tiktok?.status !== "processing" || !eligibilityByPlatform.tiktok?.eligible || publishing || checkingTikTokStatus || tiktokAutoChecks >= 20) return;
    const timer = window.setTimeout(async () => {
      setCheckingTikTokStatus(true);
      setTikTokAutoChecks((count) => count + 1);
      try {
        const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platforms: ["tiktok"] }) });
        const result = await response.json() as { error?: string; results?: Record<string, PublishResult> };
        if (!response.ok) throw new Error(result.error ?? "TikTok status check failed");
        const results = result.results ?? {};
        setPublishResults(results);
        setCurrentJob((value) => ({ ...value, publishResults: results }));
        if (results.tiktok?.status === "inbox") setToast("TikTok confirmed delivery to your inbox");
        else if (results.tiktok?.status === "published") setToast("TikTok confirms the video was published");
        else if (results.tiktok?.status === "failed") setToast(results.tiktok.message ?? "TikTok processing failed");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "TikTok status check failed");
      } finally {
        setCheckingTikTokStatus(false);
      }
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [checkingTikTokStatus, currentJob.id, eligibilityByPlatform.tiktok?.eligible, publishResults.tiktok?.status, publishResults.tiktok?.tiktokStatus, publishing, setToast, tiktokAutoChecks]);

  async function createLanguageVersion() {
    if (isDemo) {
      setToast("Generate a real video first, then add language versions");
      return;
    }
    if (renderLocked) {
      setToast("Wait for the current video to finish before generating another version");
      return;
    }
    setVersionCreating(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...currentJob.request, language: newSpeechLanguage, ttsEngine: newTtsEngine, subtitleLanguage: newSubtitleLanguage }),
      });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Language generation failed");
      const created = result.job;
      setToast(`${newSpeechLanguage} ${ttsEngineLabel(newTtsEngine, newSpeechLanguage)} voice + ${newSubtitleLanguage} subtitles started`);
      onJobCreated(created);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not start the language version");
    } finally {
      setVersionCreating(false);
    }
  }

  function togglePublishPlatform(id: string) {
    if (!eligibilityByPlatform[id]?.eligible) return;
    setPublishSelection((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  }

  async function copyPlatformKit(platform: Platform) {
    const copy = currentJob.metadata?.platformCopy?.[platform.id];
    if (!copy) return setToast("Publishing copy is not available for this older video");
    const text = `TITLE\n${copy.title}\n\nCAPTION\n${copy.caption}\n\nDESCRIPTION\n${copy.description}\n\nTAGS\n${copy.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`;
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${platform.label} post kit copied`);
    } catch {
      setToast("Copy failed. Download publishing-copy.json from Assets.");
    }
  }

  async function runPublish(platformIds: string[], reuploadPlatforms: string[] = []) {
    if (isDemo || !currentJob.assets?.final || platformIds.length === 0 || currentJob.reviewState !== "approved") return;
    setPublishResults((previous) => ({ ...previous, ...Object.fromEntries(platformIds.map((id) => {
      const checkingExisting = previous[id]?.status === "processing" && !reuploadPlatforms.includes(id);
      return [id, { status: checkingExisting ? "verifying" : "starting", progress: checkingExisting ? 100 : 0, message: checkingExisting ? "Checking TikTok delivery status…" : reuploadPlatforms.includes(id) ? "Preparing a new upload…" : "Starting upload…", publishId: checkingExisting ? previous[id]?.publishId : undefined }];
    })) }));
    setPublishing(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: platformIds, reuploadPlatforms }),
      });
      const result = await response.json() as { error?: string; results?: Record<string, PublishResult> };
      if (!response.ok) throw new Error(result.error ?? "Publishing failed");
      const results = result.results ?? {};
      setPublishResults(results);
      setCurrentJob((value) => ({ ...value, publishResults: results }));
      const attemptedResults = Object.entries(results).filter(([id]) => platformIds.includes(id));
      const failures = attemptedResults.filter(([, item]) => !["uploaded", "published", "inbox", "processing"].includes(item.status));
      const delivered = attemptedResults.filter(([, item]) => ["uploaded", "published", "inbox"].includes(item.status));
      const processing = attemptedResults.filter(([, item]) => item.status === "processing");
      if (failures.length) setToast(failures.map(([id, item]) => `${platforms.find((platform) => platform.id === id)?.label ?? id}: ${item.message ?? "upload failed"}`).join(" • "));
      else if (processing.length) setToast("The file reached TikTok and is processing. Use Check TikTok status shortly.");
      else if (delivered.length) setToast(delivered.map(([id]) => `${platforms.find((platform) => platform.id === id)?.label ?? id} ${reuploadPlatforms.includes(id) ? "re-uploaded as a new post" : "confirmed"}`).join(" • "));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Publishing could not start. Check account credentials.");
    } finally {
      setPublishing(false);
    }
  }

  async function publish() {
    await runPublish(publishSelection);
  }

  async function reupload(platform: Platform) {
    const result = publishResults[platform.id];
    if (!result || !["uploaded", "published", "inbox"].includes(result.status) || publishing) return;
    const confirmed = window.confirm(`Upload this same video to ${platform.label} again as a new post? The existing platform copy will not be changed or deleted.`);
    if (!confirmed) return;
    await runPublish([platform.id], [platform.id]);
  }

  async function setReviewDecision(decision: "approved" | "rejected") {
    if (isDemo) return;
    setReviewing(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Review could not be saved");
      setCurrentJob(result.job);
      setToast(decision === "approved" ? "Video approved for publishing" : "Video returned for changes");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Review could not be saved");
    } finally {
      setReviewing(false);
    }
  }

  async function retryJob() {
    if (isDemo || (currentJob.state !== "failed" && currentJob.state !== "stopped")) return;
    setRetrying(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}/retry`, { method: "POST" });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Retry could not start");
      setToast("Failed job queued for retry");
      onJobCreated(result.job);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Retry could not start");
    } finally {
      setRetrying(false);
    }
  }

  async function stopCurrentJob() {
    if (isDemo || (currentJob.state !== "running" && currentJob.state !== "queued") || stopping) return;
    setStopping(true);
    try {
      const response = await fetch(`${SERVICE_URL}/jobs/${currentJob.id}/stop`, { method: "POST" });
      const result = await response.json() as { error?: string; job?: LocalJob };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Generation could not be stopped");
      setCurrentJob(result.job);
      setToast("Generation stopped and local model memory released");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Generation could not be stopped");
    } finally {
      setStopping(false);
    }
  }

  const detailTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "transcript", label: "Transcript" },
    { id: "captions", label: "Subtitles" },
    { id: "assets", label: "Assets" },
    { id: "publishing", label: "Publishing" },
  ];

  return (
    <div className="content-wrap detail-page">
      <button className="detail-back" onClick={onBack}><ArrowLeft size={16} /> Back to video library</button>
      <div className="detail-heading">
        <div><div className="eyebrow"><span /> VIDEO DETAIL</div><h1>{title}</h1><p>{currentJob.request.category} • Created {new Date(currentJob.createdAt).toLocaleDateString()}</p></div>
        <div className="detail-heading-actions">
          <span className={`detail-state ${currentJob.state}`}><i />{currentJob.state === "running" ? `${currentJob.progress}% rendering` : currentJob.state}</span>
          {(currentJob.state === "running" || currentJob.state === "queued") && !isDemo && <button className="stop-job-button" onClick={stopCurrentJob} disabled={stopping}><X size={15} /> {stopping ? "Stopping…" : "Stop & unload"}</button>}
          {(currentJob.state === "failed" || currentJob.state === "stopped") && !isDemo && <button className="retry-job-button" onClick={retryJob} disabled={retrying || generationLocked}><RefreshCw size={15} /> {retrying ? "Retrying…" : generationLocked ? "Generation busy" : "Retry render"}</button>}
          {currentJob.assets?.final && <a href={`${SERVICE_URL}${currentJob.assets.final.downloadUrl}`}><Download size={15} /> Download final</a>}
        </div>
      </div>

      {currentJob.state === "running" || currentJob.state === "queued" ? <div className="detail-progress"><span><RefreshCw size={15} className="spin" /> {currentJob.message}</span><strong>{currentJob.progress}%</strong><i><span style={{ width: `${currentJob.progress}%` }} /></i></div> : null}
      {currentJob.state === "failed" && <div className="detail-error"><X size={17} /><span><strong>Rendering failed</strong><small>{currentJob.error ?? "The local worker could not finish this render."}</small></span></div>}
      {currentJob.state === "stopped" && <div className="detail-error stopped"><X size={17} /><span><strong>Generation stopped</strong><small>Local model processes were terminated and their memory was released.</small></span></div>}

      <div className="detail-hero-grid">
        <section className="detail-video-card">
          {currentJob.assets?.final ? <video key={currentJob.assets.final.url} controls playsInline preload="metadata" src={`${SERVICE_URL}${currentJob.assets.final.url}`}>Your browser cannot play this video.</video> : <div className="detail-placeholder"><div className="scene-orb orb-one" /><div className="scene-grid" /><Play size={34} fill="currentColor" /><strong>{isDemo ? "Showcase preview" : "Video is being prepared"}</strong><span>{isDemo ? "Generate a real version to play and download it." : currentJob.message}</span></div>}
          <div className="detail-video-meta"><span><Film size={14} /> 9:16 • {currentJob.metadata?.resolution ?? "1080x1920"}</span><span><Clock3 size={14} /> {durationSeconds || "—"} sec</span><span><Gauge size={14} /> {score || "—"}/100</span></div>
          {currentJob.assets?.thumbnail && <a className="thumbnail-download" href={`${SERVICE_URL}${currentJob.assets.thumbnail.downloadUrl}`}><span className="thumbnail-image" role="img" aria-label="Generated video thumbnail" style={{ backgroundImage: `url(${SERVICE_URL}${currentJob.assets.thumbnail.url})` }} /><span><strong>Generated thumbnail</strong><small>Vertical cover • JPG</small></span><Download size={16} /></a>}
        </section>

        <aside className="language-version-card">
          <div className="detail-card-title"><Languages size={19} /><div><strong>Create language version</strong><span>Choose local or Gemini voice generation</span></div></div>
          <SelectField icon={<Mic2 size={15} />} label="Speech / transcript language" value={newSpeechLanguage} onChange={changeVersionSpeechLanguage} options={speechLanguages} disabled={renderLocked} />
          <SelectField icon={<Zap size={15} />} label="Voice engine" value={newTtsEngine} onChange={(value) => setNewTtsEngine(value as TtsEngine)} options={ttsEngineOptions(newSpeechLanguage)} disabled={renderLocked} />
          <SelectField icon={<Languages size={15} />} label="Subtitle language" value={newSubtitleLanguage} onChange={setNewSubtitleLanguage} options={voiceLanguages} disabled={renderLocked} />
          <button className="language-create" onClick={createLanguageVersion} disabled={versionCreating || renderLocked}><WandSparkles size={16} /> {versionCreating ? "Starting…" : renderLocked ? `Generating… ${currentJob.progress}%` : "Generate language version"}</button>
          <div className="current-version"><span>Current version</span><strong>{currentJob.request.language} {jobTtsEngineLabel(currentJob)} voice</strong><strong>{currentJob.request.subtitleLanguage} subtitles</strong></div>
        </aside>
      </div>

      <section className="detail-workspace">
        <div className="detail-tabs" role="tablist">{detailTabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>

        {tab === "overview" && <div className="overview-grid">
          <div className="overview-card"><h3>Package summary</h3><dl><div><dt>Voice / transcript</dt><dd>{currentJob.request.language}</dd></div><div><dt>Voice engine</dt><dd>{currentJob.metadata?.voiceProvider ?? "Pending"}</dd></div><div><dt>Subtitle language</dt><dd>{currentJob.request.subtitleLanguage}</dd></div><div><dt>Music</dt><dd>Curated intro, ducked bed, ending lift</dd></div><div><dt>Visual source</dt><dd>{currentJob.metadata?.visualSource ?? "Pending"}</dd></div><div><dt>Output</dt><dd>Vertical H.264 + AAC</dd></div></dl></div>
          <div className="overview-card"><h3>Retention preflight</h3><div className="retention-detail-score"><strong>{score || "—"}</strong><span>/100</span></div><ul><li><Check size={14} /> Hook at {currentJob.metadata?.retentionPreflight?.hookWithinSeconds ?? "—"}s</li><li><Check size={14} /> Visual change every {currentJob.metadata?.retentionPreflight?.averageVisualChangeSeconds ?? "—"}s</li><li><Check size={14} /> High-contrast safe-zone subtitles</li><li><Check size={14} /> No intro before the hook</li><li><Check size={14} /> {durationSeconds >= 60 ? "60-second retention target covered" : "Short test render"}</li></ul></div>
          <div className="overview-card wide"><h3>Original brief</h3><p>{currentJob.request.prompt}</p>{currentJob.metadata?.tags?.length ? <div className="tag-list">{currentJob.metadata.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}</div>
        </div>}

        {tab === "transcript" && <TextAssetPanel title={`${currentJob.request.language} transcript`} text={transcript} empty={isDemo ? "Generate a real version to create its matching transcript." : "Transcript will appear when rendering finishes."} download={currentJob.assets?.transcript ? `${SERVICE_URL}${currentJob.assets.transcript.downloadUrl}` : undefined} />}
        {tab === "captions" && <TextAssetPanel title={`${currentJob.request.subtitleLanguage} subtitle file`} text={captions} empty={isDemo ? "Generate a real version to create readable timed subtitles." : "Subtitles will appear when rendering finishes."} download={currentJob.assets?.captions ? `${SERVICE_URL}${currentJob.assets.captions.downloadUrl}` : undefined} />}

        {tab === "assets" && <div className="asset-grid">{currentJob.assets ? Object.entries(currentJob.assets).map(([key, asset]) => <a key={key} href={`${SERVICE_URL}${asset.downloadUrl}`}><span><Film size={17} /><strong>{key === "clean" ? "Clean background video" : key === "final" ? "Final video + subtitles" : key === "thumbnail" ? "Social thumbnail" : key.charAt(0).toUpperCase() + key.slice(1)}</strong></span><small>{asset.name}</small><Download size={16} /></a>) : <div className="detail-empty">Assets appear after the real rendering job completes.</div>}</div>}

        {tab === "publishing" && <div className="publishing-panel">
          <div className="publishing-intro"><div><h3>Upload everywhere at once</h3><p>Use the generated post kit, review it, then choose where to upload.</p></div>{currentJob.reviewState === "approved" ? <span className="approval-complete"><Check size={13} /> Approved</span> : <ShieldCheck size={23} />}</div>
          <div className="platform-copy-grid">{platforms.map((platform) => <PlatformCopyCard key={platform.id} platform={platform} copy={currentJob.metadata?.platformCopy?.[platform.id]} onCopy={() => copyPlatformKit(platform)} />)}</div>
          {!isDemo && currentJob.reviewState !== "approved" && <div className={`review-approval ${currentJob.reviewState ?? "pending"}`}><span><ShieldCheck size={18} /><span><strong>{currentJob.reviewState === "rejected" ? "Changes requested" : "Approval required"}</strong><small>Confirm facts, licensing, captions, and account policy before upload.</small></span></span><div><button onClick={() => setReviewDecision("rejected")} disabled={reviewing}>Reject</button><button className="approve" onClick={() => setReviewDecision("approved")} disabled={reviewing}><Check size={14} /> {reviewing ? "Saving…" : "Approve"}</button></div></div>}
          <div className="publish-check-grid">{platforms.map((platform) => {
            const checked = publishSelection.includes(platform.id);
            const result = publishResults[platform.id];
            const eligibility = eligibilityByPlatform[platform.id];
            const successful = Boolean(result && ["uploaded", "published", "inbox"].includes(result.status));
            const active = Boolean(result && ["starting", "uploading", "verifying", "processing"].includes(result.status));
            const manageUrl = successful || result?.status === "processing" ? platformManageUrl(platform.id, result) : null;
            const label = !result ? eligibility.eligible ? "Eligible • Not uploaded" : "Not eligible" : result.status === "failed" ? "Upload failed" : result.status === "needs_credentials" ? "Connection required" : result.status === "inbox" ? "Delivered to TikTok inbox" : result.status === "processing" ? "Uploaded • TikTok processing" : result.status === "verifying" ? "Upload complete • verifying" : result.status === "uploading" ? `Uploading ${result.progress ?? 0}%` : result.status === "starting" ? "Starting upload" : result.status === "uploaded" && result.privacy ? `Uploaded • ${result.privacy}` : result.status === "published" && result.privacy ? `Published • ${result.privacy}` : result.status;
            const progressDetail = result?.status === "uploading" ? `${formatFileSize(result.bytesUploaded)} of ${formatFileSize(result.bytesTotal)}${result.etaSeconds ? ` • about ${formatEta(result.etaSeconds)} left` : ""}` : result?.status === "starting" ? "Preparing resumable upload…" : result?.status === "verifying" || result?.status === "processing" ? platform.id === "tiktok" ? "Waiting for TikTok • usually under 1 minute" : "Upload complete • confirming visibility" : "";
            return <article className={`publish-platform-option ${checked ? "selected" : ""} ${eligibility.eligible ? "eligible" : "ineligible"}`} key={platform.id}>
              <button className={`platform-select-button ${checked ? "selected" : ""} ${result?.status ?? ""}`} disabled={!eligibility.eligible || publishing || (platform.id === "tiktok" && checkingTikTokStatus)} onClick={() => togglePublishPlatform(platform.id)}>
                <PlatformLogo platform={platform} /><span><strong>{platform.label}</strong><small>{label}</small></span><i aria-label={checked ? "Selected for upload" : "Not selected"}>{checked && <Check size={13} />}</i>
                {active && <div className="platform-upload-progress"><span><b style={{ width: `${result?.progress ?? 0}%` }} /></span><small>{progressDetail}</small></div>}
                {result?.message && !active && <em className={successful && !result?.publicRestricted ? "success" : ""}>{result.message}</em>}
              </button>
              {(manageUrl || successful) && <div className="platform-result-actions">
                {manageUrl && <a href={manageUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Manage on platform</a>}
                {successful && <button onClick={() => void reupload(platform)} disabled={publishing || checkingTikTokStatus}><RefreshCw size={12} /> Re-upload as new</button>}
              </div>}
              {!eligibility.eligible && <div className="platform-ineligible-reason"><span><X size={12} /> {eligibility.reason}</span>{eligibility.setupRequired && <button onClick={onOpenSettings}><Settings size={12} /> Open Settings</button>}<details><summary>Requirements</summary><ul>{eligibility.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></details></div>}
            </article>;
          })}</div>
          {publishResults.youtube?.publicRestricted && publishResults.youtube.id && <div className="youtube-visibility-action"><span><CircleHelp size={13} /> This YouTube upload is private</span><a href={`https://studio.youtube.com/video/${publishResults.youtube.id}/edit`} target="_blank" rel="noreferrer">Make public in YouTube Studio <ChevronRight size={12} /></a></div>}
          <button className="publish-all-button" onClick={publish} disabled={publishing || checkingTikTokStatus || isDemo || !currentJob.assets?.final || publishSelection.length === 0 || currentJob.reviewState !== "approved"}><CloudUpload size={17} /> {publishing ? "Uploading and verifying…" : checkingTikTokStatus ? "Checking TikTok status…" : publishSelection.length === 1 && publishSelection[0] === "tiktok" && publishResults.tiktok?.status === "processing" ? "Check TikTok status" : currentJob.reviewState !== "approved" && !isDemo ? "Approve before uploading" : `Upload to ${publishSelection.length} selected platform${publishSelection.length === 1 ? "" : "s"}`}</button>
          {isDemo && <p className="publish-note">Generate a real video package before publishing.</p>}
        </div>}
      </section>
    </div>
  );
}

function TextAssetPanel({ title, text, empty, download }: { title: string; text: string; empty: string; download?: string }) {
  return <div className="text-asset-panel"><div><h3>{title}</h3>{download && <a href={download}><Download size={14} /> Download</a>}</div><pre>{text || empty}</pre><small>Transcript and subtitle timings are generated from the same narration source.</small></div>;
}

function PlatformCopyCard({ platform, copy, onCopy }: { platform: Platform; copy?: PlatformPostCopy; onCopy: () => void }) {
  return <article className="platform-copy-card"><header><PlatformLogo platform={platform} /><strong>{platform.label} post kit</strong><button onClick={onCopy} disabled={!copy}>Copy all</button></header>{copy ? <><div><small>Title</small><p>{copy.title}</p></div><div><small>Caption</small><p>{copy.caption}</p></div><div><small>Description</small><p>{copy.description}</p></div><div><small>Tags</small><p>{copy.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}</p></div></> : <p className="copy-empty">Generate a new video to create platform-specific title, caption, description, and tags.</p>}</article>;
}

function formatFileSize(bytes?: number) {
  if (!bytes || bytes < 0) return "—";
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}

function formatEta(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  return `${Math.ceil(seconds / 60)} min`;
}

function AutomationsView({ automationOn, setAutomationOn, setToast }: { automationOn: boolean; setAutomationOn: (value: boolean) => void; setToast: (value: string) => void }) {
  const [automationId, setAutomationId] = useState<string | null>(null);
  async function toggleSchedule() {
    try {
      if (!automationId) {
        const response = await fetch(`${SERVICE_URL}/automations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Daily knowledge drop",
            cron: "30 8 * * 1-5",
            timezone: "Asia/Bangkok",
            enabled: true,
            requireReview: true,
            template: {
              prompt: "Create a surprising, useful knowledge reel about science, psychology, technology, or history.",
              category: "Curious science",
              duration: "60–90 sec",
              language: "English",
              subtitleLanguage: "Thai",
              platforms: ["youtube", "tiktok", "facebook", "instagram"],
            },
          }),
        });
        if (!response.ok) throw new Error("Could not create schedule");
        const { automation } = await response.json() as { automation: { id: string } };
        setAutomationId(automation.id);
        setAutomationOn(true);
        setToast("Weekday 08:30 automation enabled");
      } else {
        const next = !automationOn;
        const response = await fetch(`${SERVICE_URL}/automations/${automationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
        if (!response.ok) throw new Error("Could not update schedule");
        setAutomationOn(next);
        setToast(next ? "Automation resumed" : "Automation paused");
      }
    } catch {
      setToast("Local automation worker is not available");
    }
  }
  return (
    <div className="content-wrap automation-page">
      <div className="page-heading"><div><div className="eyebrow"><span /> WORKFLOW AUTOMATION</div><h1>Build once. Publish on rhythm.</h1><p>Cron, webhook, and AI-agent triggers use the same durable generation jobs.</p></div><button className="primary-small" onClick={toggleSchedule}><Plus size={17} /> Add schedule</button></div>
      <div className="automation-banner"><div><Bot size={24} /><span><strong>Local automation worker is live</strong><p>Ideas → scripts → clips → languages → approvals → publishing are independent resumable jobs.</p></span></div><em>ACTIVE</em></div>
      <div className="automation-grid">
        {automationId ? <section className="schedule-card">
          <div className="schedule-head"><div className="schedule-icon"><CalendarClock size={20} /></div><div><strong>Daily knowledge drop</strong><span>{automationOn ? "Active schedule" : "Paused schedule"}</span></div><button className={`toggle ${automationOn ? "on" : ""}`} onClick={toggleSchedule}><span /></button></div>
          <div className="flow-line"><FlowNode icon={<Lightbulb size={17} />} title="AI idea" note="Science & psychology" /><ChevronRight size={16} /><FlowNode icon={<WandSparkles size={17} />} title="Generate" note="75-second reel" /><ChevronRight size={16} /><FlowNode icon={<ShieldCheck size={17} />} title="Review" note="Approval required" /><ChevronRight size={16} /><FlowNode icon={<CloudUpload size={17} />} title="Publish" note="4 platforms" /></div>
          <div className="schedule-details"><span><Clock3 size={15} /> Every weekday at 08:30</span><span><Globe2 size={15} /> Asia/Bangkok</span><span><Languages size={15} /> EN + TH subtitles</span></div>
        </section> : <section className="schedule-card schedule-empty"><CalendarClock size={25} /><strong>No schedules configured</strong><span>Use Add schedule when you are ready to automate new videos.</span></section>}
        <aside className="automation-guardrails"><h3>Required before auto-publish</h3>{["Provider credentials connected", "Channel-level content policy", "Monetization preflight passed", "Retry and failure notifications", "Human approval can be enabled"].map((item, index) => <div key={item}><span className={index < 2 ? "ready" : ""}>{index < 2 ? <Check size={13} /> : index + 1}</span>{item}</div>)}</aside>
      </div>
      <div className="jobs-card"><div className="jobs-head"><div><strong>Recent workflow jobs</strong><span>Designed for cron, webhook, or AI-agent triggers</span></div><button><RefreshCw size={15} /> Refresh</button></div><div className="jobs-empty"><strong>No workflow jobs yet</strong><span>New scheduled and agent-triggered jobs will appear here.</span></div></div>
    </div>
  );
}

function FlowNode({ icon, title, note }: { icon: React.ReactNode; title: string; note: string }) {
  return <div className="flow-node"><i>{icon}</i><span><strong>{title}</strong><small>{note}</small></span></div>;
}

function SettingsView({ setToast }: { setToast: (value: string) => void }) {
  const [showSecret, setShowSecret] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [pexelsKey, setPexelsKey] = useState("");
  const [textModel, setTextModel] = useState("google/gemma-4-31b-it:free");
  const [youtubeClientId, setYoutubeClientId] = useState("");
  const [youtubeClientSecret, setYoutubeClientSecret] = useState("");
  const [youtubeGuide, setYoutubeGuide] = useState(false);
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeStatus | null>(null);
  const [checkingYoutube, setCheckingYoutube] = useState(false);
  const [connectingYoutube, setConnectingYoutube] = useState(false);
  const [tiktokClientKey, setTiktokClientKey] = useState("");
  const [tiktokClientSecret, setTiktokClientSecret] = useState("");
  const [tiktokGuide, setTiktokGuide] = useState(false);
  const [tiktokStatus, setTiktokStatus] = useState<TikTokStatus | null>(null);
  const [checkingTiktok, setCheckingTiktok] = useState(false);
  const [connectingTiktok, setConnectingTiktok] = useState(false);
  const [facebookGuide, setFacebookGuide] = useState(false);
  const [facebookStatus, setFacebookStatus] = useState<FacebookStatus | null>(null);
  const [checkingFacebook, setCheckingFacebook] = useState(false);
  const [savingFacebook, setSavingFacebook] = useState(false);
  const [facebookPageId, setFacebookPageId] = useState("");
  const [facebookPageAccessToken, setFacebookPageAccessToken] = useState("");
  const [instagramGuide, setInstagramGuide] = useState(false);
  const [instagramStatus, setInstagramStatus] = useState<InstagramStatus | null>(null);
  const [checkingInstagram, setCheckingInstagram] = useState(false);
  const [savingInstagram, setSavingInstagram] = useState(false);
  const [instagramAccountId, setInstagramAccountId] = useState("");
  const [metaUserAccessToken, setMetaUserAccessToken] = useState("");
  const [metaGraphVersion, setMetaGraphVersion] = useState("");
  const [publicMediaBaseUrl, setPublicMediaBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [ttsHealth, setTtsHealth] = useState<TtsHealth | null>(null);
  const [voxHealth, setVoxHealth] = useState<TtsHealth | null>(null);
  const [textHealth, setTextHealth] = useState<TextHealth | null>(null);
  const checkHealth = () => fetch(`${SERVICE_URL}/health`).then((response) => response.json()).then((value: { providers?: ProviderHealth; tts?: TtsHealth; voxcpm2?: TtsHealth; text?: TextHealth }) => { setHealth(value.providers ?? null); setTtsHealth(value.tts ?? null); setVoxHealth(value.voxcpm2 ?? null); setTextHealth(value.text ?? null); setToast("Provider status refreshed"); }).catch(() => { setHealth(null); setTtsHealth(null); setVoxHealth(null); setTextHealth(null); setToast("Local worker is offline"); });
  useEffect(() => {
    fetch(`${SERVICE_URL}/health`).then((response) => response.json()).then((value: { providers?: ProviderHealth; tts?: TtsHealth; voxcpm2?: TtsHealth; text?: TextHealth }) => { setHealth(value.providers ?? null); setTtsHealth(value.tts ?? null); setVoxHealth(value.voxcpm2 ?? null); setTextHealth(value.text ?? null); }).catch(() => { setHealth(null); setTtsHealth(null); setVoxHealth(null); setTextHealth(null); });
    fetch(`${SERVICE_URL}/oauth/youtube/status`).then((response) => response.json()).then((value: YouTubeStatus) => setYoutubeStatus(value)).catch(() => setYoutubeStatus(null));
    fetch(`${SERVICE_URL}/oauth/tiktok/status`).then((response) => response.json()).then((value: TikTokStatus) => setTiktokStatus(value)).catch(() => setTiktokStatus(null));
    fetch(`${SERVICE_URL}/publishing/facebook/status`).then((response) => response.json()).then((value: FacebookStatus) => setFacebookStatus(value)).catch(() => setFacebookStatus(null));
    fetch(`${SERVICE_URL}/publishing/instagram/status`).then((response) => response.json()).then((value: InstagramStatus) => setInstagramStatus(value)).catch(() => setInstagramStatus(null));
    const receiveOAuth = (event: MessageEvent) => {
      if (event.data?.type === "reelio-youtube-oauth") {
        setToast(event.data.message ?? (event.data.ok ? "YouTube connected" : "YouTube connection failed"));
        fetch(`${SERVICE_URL}/oauth/youtube/status`).then((response) => response.json()).then((value: YouTubeStatus) => setYoutubeStatus(value)).catch(() => setYoutubeStatus(null));
      }
      if (event.data?.type === "reelio-tiktok-oauth") {
        setToast(event.data.message ?? (event.data.ok ? "TikTok connected" : "TikTok connection failed"));
        fetch(`${SERVICE_URL}/oauth/tiktok/status`).then((response) => response.json()).then((value: TikTokStatus) => setTiktokStatus(value)).catch(() => setTiktokStatus(null));
      }
    };
    window.addEventListener("message", receiveOAuth);
    return () => window.removeEventListener("message", receiveOAuth);
  }, [setToast]);

  async function checkYouTube(showGuideWhenMissing = true) {
    setCheckingYoutube(true);
    try {
      const response = await fetch(`${SERVICE_URL}/oauth/youtube/status`);
      const result = await response.json() as YouTubeStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "YouTube connection could not be checked");
      setYoutubeStatus(result);
      if (result.connected) setToast(`${result.channelTitle ?? "YouTube"} is connected and ready`);
      else {
        setToast(result.message ?? "YouTube is not connected");
        if (showGuideWhenMissing) setYoutubeGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "YouTube connection could not be checked");
      if (showGuideWhenMissing) setYoutubeGuide(true);
    } finally { setCheckingYoutube(false); }
  }

  async function connectYouTube() {
    const popup = window.open("about:blank", "reelio-youtube-oauth", "popup,width=560,height=760");
    setConnectingYoutube(true);
    try {
      if (youtubeClientId.trim() || youtubeClientSecret.trim()) {
        if (!youtubeClientId.trim() || !youtubeClientSecret.trim()) throw new Error("Enter both the Google client ID and client secret.");
        const saved = await fetch(`${SERVICE_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ googleClientId: youtubeClientId.trim(), googleClientSecret: youtubeClientSecret.trim(), youtubePrivacy: "public" }),
        });
        const savedResult = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedResult.error ?? "YouTube credentials could not be saved");
        setYoutubeClientId(""); setYoutubeClientSecret("");
      } else if (!youtubeStatus?.configured) throw new Error("Enter the Google client ID and client secret.");
      const response = await fetch(`${SERVICE_URL}/oauth/youtube/start`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error ?? "YouTube authorization could not start");
      if (!popup) throw new Error("Allow pop-ups for Reelio, then press Connect YouTube again.");
      popup.location.href = result.authUrl;
      setToast("Complete Google authorization in the new window");
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : "YouTube authorization could not start");
    } finally { setConnectingYoutube(false); }
  }

  async function checkTikTok(showGuideWhenMissing = true) {
    setCheckingTiktok(true);
    try {
      const response = await fetch(`${SERVICE_URL}/oauth/tiktok/status`);
      const result = await response.json() as TikTokStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "TikTok connection could not be checked");
      setTiktokStatus(result);
      if (result.connected) setToast(`${result.displayName ?? "TikTok"} is connected for draft uploads`);
      else {
        setToast(result.message ?? "TikTok is not connected");
        if (showGuideWhenMissing) setTiktokGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "TikTok connection could not be checked");
      if (showGuideWhenMissing) setTiktokGuide(true);
    } finally { setCheckingTiktok(false); }
  }

  async function connectTikTok() {
    const popup = window.open("about:blank", "reelio-tiktok-oauth", "popup,width=560,height=760");
    setConnectingTiktok(true);
    try {
      if (tiktokClientKey.trim() || tiktokClientSecret.trim()) {
        if (!tiktokClientKey.trim() || !tiktokClientSecret.trim()) throw new Error("Enter both the TikTok client key and client secret.");
        const saved = await fetch(`${SERVICE_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tiktokClientKey: tiktokClientKey.trim(), tiktokClientSecret: tiktokClientSecret.trim() }),
        });
        const savedResult = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedResult.error ?? "TikTok credentials could not be saved");
        setTiktokClientKey(""); setTiktokClientSecret("");
      } else if (!tiktokStatus?.configured) throw new Error("Enter the TikTok client key and client secret.");
      const response = await fetch(`${SERVICE_URL}/oauth/tiktok/start`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error ?? "TikTok authorization could not start");
      if (!popup) throw new Error("Allow pop-ups for Reelio, then press Connect TikTok again.");
      popup.location.href = result.authUrl;
      setToast("Complete TikTok authorization in the new window");
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : "TikTok authorization could not start");
    } finally { setConnectingTiktok(false); }
  }

  async function checkFacebook(showGuideWhenMissing = true) {
    setCheckingFacebook(true);
    try {
      const response = await fetch(`${SERVICE_URL}/publishing/facebook/status`);
      const result = await response.json() as FacebookStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Facebook Page connection could not be checked");
      setFacebookStatus(result);
      if (result.connected) setToast(`${result.pageName ?? "Facebook Page"} is connected and ready for Reels`);
      else {
        setToast(result.message ?? "Facebook Page is not connected");
        if (showGuideWhenMissing) setFacebookGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Facebook Page connection could not be checked");
      if (showGuideWhenMissing) setFacebookGuide(true);
    } finally { setCheckingFacebook(false); }
  }

  async function saveAndCheckFacebook() {
    setSavingFacebook(true);
    try {
      if (!facebookPageId.trim() || !facebookPageAccessToken.trim() || !metaGraphVersion.trim()) throw new Error("Enter the Page ID, Page access token, and Graph API version.");
      const response = await fetch(`${SERVICE_URL}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facebookPageId: facebookPageId.trim(), facebookPageAccessToken: facebookPageAccessToken.trim(), metaGraphVersion: metaGraphVersion.trim() }),
      });
      const saved = await response.json() as { error?: string };
      if (!response.ok) throw new Error(saved.error ?? "Facebook Page credentials could not be saved");
      setFacebookPageId(""); setFacebookPageAccessToken(""); setMetaGraphVersion("");
      const statusResponse = await fetch(`${SERVICE_URL}/publishing/facebook/status`);
      const status = await statusResponse.json() as FacebookStatus & { error?: string };
      if (!statusResponse.ok) throw new Error(status.error ?? "Facebook Page connection could not be checked");
      setFacebookStatus(status);
      if (!status.connected) throw new Error(status.message ?? "Meta did not accept the Facebook Page credentials");
      setToast(`${status.pageName ?? "Facebook Page"} is connected and ready for Reels`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Facebook Page setup failed");
    } finally { setSavingFacebook(false); }
  }

  async function checkInstagram(showGuideWhenMissing = true) {
    setCheckingInstagram(true);
    try {
      const response = await fetch(`${SERVICE_URL}/publishing/instagram/status`);
      const result = await response.json() as InstagramStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Instagram connection could not be checked");
      setInstagramStatus(result);
      if (result.connected) setToast(`${result.username ?? "Instagram Professional account"} is connected and ready for Reels`);
      else {
        setToast(result.message ?? "Instagram is not connected");
        if (showGuideWhenMissing) setInstagramGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Instagram connection could not be checked");
      if (showGuideWhenMissing) setInstagramGuide(true);
    } finally { setCheckingInstagram(false); }
  }

  async function saveAndCheckInstagram() {
    setSavingInstagram(true);
    try {
      if (!instagramAccountId.trim() || !metaUserAccessToken.trim() || !metaGraphVersion.trim() || !publicMediaBaseUrl.trim()) throw new Error("Enter the Instagram account ID, Meta user token, Graph API version, and public media URL.");
      const response = await fetch(`${SERVICE_URL}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: instagramAccountId.trim(), metaUserAccessToken: metaUserAccessToken.trim(), metaGraphVersion: metaGraphVersion.trim(), publicMediaBaseUrl: publicMediaBaseUrl.trim() }),
      });
      const saved = await response.json() as { error?: string };
      if (!response.ok) throw new Error(saved.error ?? "Instagram credentials could not be saved");
      setInstagramAccountId(""); setMetaUserAccessToken(""); setMetaGraphVersion(""); setPublicMediaBaseUrl("");
      const statusResponse = await fetch(`${SERVICE_URL}/publishing/instagram/status`);
      const status = await statusResponse.json() as InstagramStatus & { error?: string };
      if (!statusResponse.ok) throw new Error(status.error ?? "Instagram connection could not be checked");
      setInstagramStatus(status);
      if (!status.connected) throw new Error(status.message ?? "Meta did not accept the Instagram credentials");
      setToast(`${status.username ?? "Instagram Professional account"} is connected and ready for Reels`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Instagram setup failed");
    } finally { setSavingInstagram(false); }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        reelioTextProvider: "google",
        geminiTextModel: "gemini-3.5-flash",
        geminiTtsModel: "gemini-3.1-flash-tts-preview",
        geminiTtsVoice: "Puck",
        kokoroVoice: "af_heart",
        kokoroSpeed: "1.15",
        openrouterTextModel: textModel,
        openrouterFallbackModel: "google/gemma-4-26b-a4b-it:free",
      };
      if (geminiKey.trim()) payload.geminiApiKey = geminiKey.trim();
      if (openRouterKey.trim()) payload.openrouterApiKey = openRouterKey.trim();
      if (pexelsKey.trim()) payload.pexelsApiKey = pexelsKey.trim();
      if (youtubeClientId.trim()) payload.googleClientId = youtubeClientId.trim();
      if (youtubeClientSecret.trim()) payload.googleClientSecret = youtubeClientSecret.trim();
      if (tiktokClientKey.trim()) payload.tiktokClientKey = tiktokClientKey.trim();
      if (tiktokClientSecret.trim()) payload.tiktokClientSecret = tiktokClientSecret.trim();
      if (facebookPageId.trim()) payload.facebookPageId = facebookPageId.trim();
      if (facebookPageAccessToken.trim()) payload.facebookPageAccessToken = facebookPageAccessToken.trim();
      if (instagramAccountId.trim()) payload.instagramAccountId = instagramAccountId.trim();
      if (metaUserAccessToken.trim()) payload.metaUserAccessToken = metaUserAccessToken.trim();
      if (metaGraphVersion.trim()) payload.metaGraphVersion = metaGraphVersion.trim();
      if (publicMediaBaseUrl.trim()) payload.publicMediaBaseUrl = publicMediaBaseUrl.trim();
      const response = await fetch(`${SERVICE_URL}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Settings could not be saved");
      setGeminiKey(""); setOpenRouterKey(""); setPexelsKey(""); setYoutubeClientId(""); setYoutubeClientSecret(""); setTiktokClientKey(""); setTiktokClientSecret(""); setFacebookPageId(""); setFacebookPageAccessToken(""); setInstagramAccountId(""); setMetaUserAccessToken(""); setMetaGraphVersion(""); setPublicMediaBaseUrl("");
      setToast("Settings saved securely on this Mac");
      window.setTimeout(checkHealth, 100);
    } catch (error) { setToast(error instanceof Error ? error.message : "Settings could not be saved"); }
    finally { setSaving(false); }
  }
  return (
    <div className="content-wrap settings-page">
      <div className="page-heading"><div><div className="eyebrow"><span /> LOCAL SETTINGS</div><h1>Connect your creative stack.</h1><p>Secrets are written to a private local file and never stored in browser storage.</p></div><button className="primary-small" onClick={saveSettings} disabled={saving}><Check size={17} /> {saving ? "Saving…" : "Save settings"}</button></div>
      <div className="settings-grid">
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon openrouter"><Sparkles size={20} /></div><div><strong>Google Gemini — text, translation, and multilingual voice</strong><span>Scripts • translation • selectable Gemini TTS narration</span></div><em className={health?.gemini ? "connected" : ""}><i /> {health?.gemini ? "Connected" : "Key required"}</em></div>
          <label className="secret-field"><span>Gemini API key</span><div><input type={showSecret ? "text" : "password"} placeholder={health?.gemini ? "Connected — enter only to replace" : "Paste Google AI Studio API key"} value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div><small>Used for scripts, translation, current-news grounding, and optional Gemini TTS. Saved only in .env.local.</small></label>
          <div className="local-model-summary"><span><strong>gemini-3.5-flash</strong><small>Factual master scripts and translation</small></span><span><strong>gemini-3.1-flash-tts-preview</strong><small>Puck voice • multilingual energetic narration</small></span></div>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh Gemini status</button>
        </section>
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon kokoro"><Mic2 size={20} /></div><div><strong>Kokoro — local English voice</strong><span>Default for English • Gemini remains optional</span></div><em className={health?.kokoro ? "connected" : ""}><i /> {ttsHealth?.ready ? "Ready" : "Setup required"}</em></div>
          <div className="local-model-summary"><span><strong>Kokoro-82M v1.0</strong><small>af_heart voice • 1.15× energetic pacing</small></span><span><strong>Curated music suite</strong><small>Intro sting • ducked bed • ending lift</small></span></div>
          {ttsHealth?.error && <p className="model-error">{ttsHealth.error}</p>}
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh Kokoro status</button>
        </section>
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon kokoro"><Languages size={20} /></div><div><strong>VoxCPM2 — local multilingual voice</strong><span>Default for non-English • Gemini remains optional</span></div><em className={health?.voxcpm2 ? "connected" : ""}><i /> {voxHealth?.ready ? "Ready" : voxHealth?.loading ? "Downloading" : "Setup required"}</em></div>
          <div className="local-model-summary"><span><strong>OpenBMB/VoxCPM2</strong><small>30 languages • local Metal acceleration on Apple Silicon</small></span><span><strong>One-time setup</strong><small>Run npm run voxcpm2:setup</small></span></div>
          {voxHealth?.error && <p className="model-error">{voxHealth.error}</p>}
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh VoxCPM2 status</button>
        </section>
        <section className="settings-card">
          <div className="settings-title"><div className="provider-icon openrouter"><Sparkles size={20} /></div><div><strong>OpenRouter — text fallback</strong><span>Used only when Gemini is unavailable • {textHealth?.provider === "openrouter" ? textHealth.model : "Gemma fallback"}</span></div><em className={health?.openrouter ? "connected" : ""}><i /> {health?.openrouter ? "Connected" : "Not configured"}</em></div>
          <label className="secret-field"><span>API key</span><div><input type={showSecret ? "text" : "password"} placeholder={health?.openrouter ? "Connected — enter only to replace" : "Paste OpenRouter API key"} value={openRouterKey} onChange={(event) => setOpenRouterKey(event.target.value)} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div><small>Saved to .env.local with owner-only file permissions.</small></label>
          <label className="model-field"><span>Text model</span><select value={textModel} onChange={(event) => setTextModel(event.target.value)}><option>google/gemma-4-31b-it:free</option><option>openrouter/free</option></select></label>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh status</button>
        </section>
        <section className="settings-card">
          <div className="settings-title"><div className="provider-icon pexels"><Film size={20} /></div><div><strong>Pexels</strong><span>Free licensed stock video</span></div><em className={health?.pexels ? "connected" : ""}><i /> {health?.pexels ? "Connected" : "Motion fallback"}</em></div>
          <label className="secret-field"><span>API key</span><div><input type="password" placeholder={health?.pexels ? "Connected — enter only to replace" : "Paste Pexels API key"} value={pexelsKey} onChange={(event) => setPexelsKey(event.target.value)} autoComplete="off" /></div><small>Clip credits and license metadata will be kept with each project.</small></label>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh status</button>
        </section>
        <section className="settings-card wide-settings" id="publishing-accounts">
          <div className="settings-title"><div className="provider-icon social"><CloudUpload size={20} /></div><div><strong>Publishing accounts</strong><span>Connect each destination independently</span></div></div>
          <div className="connector-list">{platforms.map((platform) => {
            if (platform.id === "youtube") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{youtubeStatus?.channelTitle ?? platform.label}</strong><small>{youtubeStatus?.connected ? "Verified channel • upload access ready" : youtubeStatus?.message ?? "Google OAuth setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setYoutubeGuide(true)} aria-label="Open YouTube setup guide" title="YouTube setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkYouTube(true)} disabled={checkingYoutube}>{checkingYoutube ? "Checking…" : youtubeStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            if (platform.id === "tiktok") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{tiktokStatus?.displayName ?? platform.label}</strong><small>{tiktokStatus?.connected ? "Verified account • draft upload ready" : tiktokStatus?.message ?? "Content Posting API setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setTiktokGuide(true)} aria-label="Open TikTok setup guide" title="TikTok setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkTikTok(true)} disabled={checkingTiktok}>{checkingTiktok ? "Checking…" : tiktokStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            if (platform.id === "facebook") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{facebookStatus?.pageName ?? platform.label}</strong><small>{facebookStatus?.connected ? "Verified Page • Reels publishing ready" : facebookStatus?.message ?? "Facebook Page setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setFacebookGuide(true)} aria-label="Open Facebook Page setup guide" title="Facebook Page setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkFacebook(true)} disabled={checkingFacebook}>{checkingFacebook ? "Checking…" : facebookStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{instagramStatus?.username ?? platform.label}</strong><small>{instagramStatus?.connected ? "Verified Professional account • Reels publishing ready" : instagramStatus?.message ?? "Instagram Professional setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setInstagramGuide(true)} aria-label="Open Instagram setup guide" title="Instagram setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkInstagram(true)} disabled={checkingInstagram}>{checkingInstagram ? "Checking…" : instagramStatus?.connected ? "Check" : "Set up"}</button></div></div>;
          })}</div>
        </section>
      </div>
      {youtubeGuide && <YouTubeSetupGuide status={youtubeStatus} clientId={youtubeClientId} clientSecret={youtubeClientSecret} setClientId={setYoutubeClientId} setClientSecret={setYoutubeClientSecret} showSecret={showSecret} setShowSecret={setShowSecret} connecting={connectingYoutube} onConnect={() => void connectYouTube()} onCheck={() => void checkYouTube(false)} onClose={() => setYoutubeGuide(false)} />}
      {tiktokGuide && <TikTokSetupGuide status={tiktokStatus} clientKey={tiktokClientKey} clientSecret={tiktokClientSecret} setClientKey={setTiktokClientKey} setClientSecret={setTiktokClientSecret} showSecret={showSecret} setShowSecret={setShowSecret} connecting={connectingTiktok} onConnect={() => void connectTikTok()} onCheck={() => void checkTikTok(false)} onClose={() => setTiktokGuide(false)} />}
      {facebookGuide && <FacebookSetupGuide status={facebookStatus} pageId={facebookPageId} pageAccessToken={facebookPageAccessToken} graphVersion={metaGraphVersion} setPageId={setFacebookPageId} setPageAccessToken={setFacebookPageAccessToken} setGraphVersion={setMetaGraphVersion} showSecret={showSecret} setShowSecret={setShowSecret} saving={savingFacebook} onSave={() => void saveAndCheckFacebook()} onCheck={() => void checkFacebook(false)} onClose={() => setFacebookGuide(false)} />}
      {instagramGuide && <InstagramSetupGuide status={instagramStatus} accountId={instagramAccountId} userAccessToken={metaUserAccessToken} graphVersion={metaGraphVersion} publicMediaBaseUrl={publicMediaBaseUrl} setAccountId={setInstagramAccountId} setUserAccessToken={setMetaUserAccessToken} setGraphVersion={setMetaGraphVersion} setPublicMediaBaseUrl={setPublicMediaBaseUrl} showSecret={showSecret} setShowSecret={setShowSecret} saving={savingInstagram} onSave={() => void saveAndCheckInstagram()} onCheck={() => void checkInstagram(false)} onClose={() => setInstagramGuide(false)} />}
    </div>
  );
}

function SetupOverview({ time, prerequisites, result }: { time: string; prerequisites: string[]; result: string }) {
  return <div className="setup-overview"><div><strong>Before you start</strong><ul>{prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>What to expect</strong><p><Clock3 size={13} /> About {time}</p><p><ShieldCheck size={13} /> {result}</p></div></div>;
}

function SetupDone({ children }: { children: React.ReactNode }) {
  return <p className="setup-done"><Check size={13} /> <span><b>You are done with this step when:</b> {children}</span></p>;
}

function CopyCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return <div className="copy-code"><code>{value}</code><button onClick={() => void copy()}>{copied ? <><Check size={13} /> Copied</> : "Copy"}</button></div>;
}

function SetupTroubleshooting({ issues }: { issues: Array<{ title: string; fix: string }> }) {
  return <details className="setup-troubleshooting"><summary><CircleHelp size={16} /><span><strong>Something not working?</strong><small>Open common errors and exact fixes</small></span><ChevronDown size={15} /></summary><div>{issues.map((issue) => <p key={issue.title}><b>{issue.title}</b><span>{issue.fix}</span></p>)}</div></details>;
}

function YouTubeSetupGuide({ status, clientId, clientSecret, setClientId, setClientSecret, showSecret, setShowSecret, connecting, onConnect, onCheck, onClose }: { status: YouTubeStatus | null; clientId: string; clientSecret: string; setClientId: (value: string) => void; setClientSecret: (value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void; connecting: boolean; onConnect: () => void; onCheck: () => void; onClose: () => void }) {
  const redirectUri = status?.redirectUri ?? "http://127.0.0.1:8788/oauth/youtube/callback";
  return <div className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="youtube-setup-title"><div className="setup-dialog">
    <header><div><PlatformLogo platform={platforms[0]} /><span><strong id="youtube-setup-title">Connect YouTube</strong><small>One-time Google Cloud and OAuth setup</small></span></div><button onClick={onClose} aria-label="Close YouTube setup"><X size={18} /></button></header>
    {status?.connected && <div className="connection-success"><ShieldCheck size={18} /><span><strong>{status.channelTitle} is connected</strong><small>Reelio verified upload access for this channel.</small></span></div>}
    <SetupOverview time="10–15 minutes" prerequisites={["A Google account that owns or manages a YouTube channel", "Access to Google Cloud Console", "Reelio running on this Mac while you connect"]} result="Reelio receives a refresh token and can upload to the selected channel." />
    <ol className="setup-steps">
      <li><span>1</span><div><strong>Confirm the correct YouTube channel</strong><ul className="setup-actions"><li>Open YouTube and sign in with the Google account you want Reelio to use.</li><li>Click your profile picture and confirm the channel name. Create a channel first if YouTube asks you to.</li></ul><a href="https://www.youtube.com/account" target="_blank" rel="noreferrer">Open YouTube account <ExternalLink size={13} /></a><SetupDone>The channel name you expect is visible in YouTube.</SetupDone></div></li>
      <li><span>2</span><div><strong>Create or select a Google Cloud project</strong><ul className="setup-actions"><li>Open the project page and click <b>Create project</b>.</li><li>Name it <b>Reelio</b>, create it, then use the project selector at the top to make sure Reelio is selected.</li></ul><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Open Google Cloud projects <ExternalLink size={13} /></a><SetupDone>The top bar in Google Cloud shows your Reelio project.</SetupDone></div></li>
      <li><span>3</span><div><strong>Enable YouTube Data API v3</strong><ul className="setup-actions"><li>Open the API page while the Reelio project is selected.</li><li>Press <b>Enable</b>. If the button says <b>Manage</b>, it is already enabled.</li></ul><a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Open YouTube Data API v3 <ExternalLink size={13} /></a><SetupDone>The page shows “API enabled.”</SetupDone></div></li>
      <li><span>4</span><div><strong>Set up Google Auth Platform</strong><ul className="setup-actions"><li>Open Google Auth Platform → <b>Branding</b>. Enter app name <b>Reelio</b>, your support email, and developer email.</li><li>Open <b>Audience</b>. Choose <b>External</b> for a personal Google account. Leave the app in Testing while only you use it.</li><li>Open <b>Data Access</b> and add <code>youtube.upload</code> and <code>youtube.readonly</code> if Google asks you to declare scopes.</li></ul><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Open Google Auth Platform <ExternalLink size={13} /></a><SetupDone>Branding, Audience, and contact information are saved.</SetupDone></div></li>
      <li><span>5</span><div><strong>Add yourself as a test user</strong><ul className="setup-actions"><li>Go to Google Auth Platform → <b>Audience</b> → <b>Test users</b>.</li><li>Click <b>Add users</b> and enter the exact Google email that owns the YouTube channel.</li><li>Save. This prevents the “developer-approved testers only” 403 error.</li></ul><SetupDone>Your Google email appears in the Test users list.</SetupDone></div></li>
      <li><span>6</span><div><strong>Create the OAuth client</strong><ul className="setup-actions"><li>Open <b>Clients</b> → <b>Create client</b>.</li><li>Application type: <b>Web application</b>. Name: <b>Reelio local app</b>.</li><li>Under <b>Authorized redirect URIs</b>, click <b>Add URI</b> and paste the value below exactly. Do not add a trailing slash.</li></ul><CopyCode value={redirectUri} /><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Open OAuth clients <ExternalLink size={13} /></a><SetupDone>Google shows a Client ID ending in <code>apps.googleusercontent.com</code> and a Client secret.</SetupDone></div></li>
      <li><span>7</span><div><strong>Paste the credentials and connect</strong><ul className="setup-actions"><li>Copy the Client ID and Client secret from Google into the fields below.</li><li>Press <b>Save &amp; connect YouTube</b>.</li><li>In Google&apos;s window, choose the correct account, press <b>Continue</b>, allow access, and wait for “YouTube connected.”</li></ul><div className="youtube-credential-grid"><label><span>Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "…apps.googleusercontent.com"} autoComplete="off" /></label><label><span>Client secret</span><div><input type={showSecret ? "text" : "password"} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "Google OAuth client secret"} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div></label></div><SetupDone>This guide shows the connected channel name in green.</SetupDone></div></li>
    </ol>
    <div className="youtube-setup-note"><CircleHelp size={16} /><p><b>Testing versus production:</b> test users can connect immediately. Google restricts videos uploaded by unverified API projects created after July 28, 2020 to private viewing. Public API uploads require Google&apos;s YouTube API audit; changing Reelio&apos;s privacy setting cannot bypass it.</p></div>
    <SetupTroubleshooting issues={[{ title: "Error 403: access_denied", fix: "Add the exact Google account under Google Auth Platform → Audience → Test users, then connect again." }, { title: "redirect_uri_mismatch", fix: `Edit the Web OAuth client and add exactly ${redirectUri}. Check http, 127.0.0.1, port 8788, path, and trailing slash.` }, { title: "Connected account has no channel", fix: "Open YouTube with that Google account and create/select its channel, then reconnect." }, { title: "Upload is private", fix: "This is a Google audit restriction for unverified YouTube API projects, not a Reelio upload setting." }]} />
    <footer><button className="secondary-action" onClick={onCheck}><RefreshCw size={15} /> Check connection</button><button className="youtube-connect-button" onClick={onConnect} disabled={connecting || status?.connected}>{status?.connected ? <><Check size={16} /> Connected</> : connecting ? <><RefreshCw className="spin" size={16} /> Starting…</> : <><Play size={16} /> {status?.configured && !clientId && !clientSecret ? "Connect YouTube" : "Save & connect YouTube"}</>}</button></footer>
  </div></div>;
}

function TikTokSetupGuide({ status, clientKey, clientSecret, setClientKey, setClientSecret, showSecret, setShowSecret, connecting, onConnect, onCheck, onClose }: { status: TikTokStatus | null; clientKey: string; clientSecret: string; setClientKey: (value: string) => void; setClientSecret: (value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void; connecting: boolean; onConnect: () => void; onCheck: () => void; onClose: () => void }) {
  const redirectUri = status?.redirectUri ?? "http://127.0.0.1:8788/oauth/tiktok/callback";
  return <div className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="tiktok-setup-title"><div className="setup-dialog">
    <header><div><PlatformLogo platform={platforms[1]} /><span><strong id="tiktok-setup-title">Connect TikTok</strong><small>Login Kit Desktop • Content Posting Upload API</small></span></div><button onClick={onClose} aria-label="Close TikTok setup"><X size={18} /></button></header>
    {status?.connected && <div className="connection-success"><ShieldCheck size={18} /><span><strong>{status.displayName} is connected</strong><small>Reelio verified profile and draft-upload access.</small></span></div>}
    <SetupOverview time="15–25 minutes" prerequisites={["A TikTok account you can use as a Sandbox target user", "A TikTok for Developers account", "A public HTTPS website for app information, such as https://nainglin.com/nika/"]} result="Reelio uploads a draft; you finish and publish it from TikTok’s inbox." />
    <ol className="setup-steps">
      <li><span>1</span><div><strong>Create the TikTok developer app</strong><ul className="setup-actions"><li>Sign in to TikTok for Developers and open <b>Manage apps</b>.</li><li>Click <b>Connect an app</b> or <b>Create app</b>. Use app name <b>Reelio</b>.</li><li>For the official website field, enter a real public HTTPS page such as <code>https://nainglin.com/nika/</code>. Do not enter the localhost callback here.</li></ul><a href="https://developers.tiktok.com/apps/" target="_blank" rel="noreferrer">Open TikTok developer apps <ExternalLink size={13} /></a><SetupDone>You can open Reelio&apos;s app dashboard and see a Client key.</SetupDone></div></li>
      <li><span>2</span><div><strong>Use the Sandbox while the app is unapproved</strong><ul className="setup-actions"><li>Open the app, then find <b>Sandbox</b> in the app dashboard.</li><li>Add your TikTok account as a Sandbox target user and accept the invitation in TikTok.</li><li>Use that same account when Reelio opens the authorization window.</li></ul><SetupDone>The account appears as an active Sandbox target user.</SetupDone></div></li>
      <li><span>3</span><div><strong>Add the Desktop platform</strong><ul className="setup-actions"><li>In the app dashboard, open <b>Platform configuration</b> and add <b>Desktop</b>.</li><li>The public <b>Web/Desktop URL</b> must begin with HTTPS; use your official website.</li><li>Desktop OAuth is different: its redirect URI may use <code>http://127.0.0.1</code> because the callback returns to the app running on your Mac.</li></ul><SetupDone>Desktop is listed under the app&apos;s platforms.</SetupDone></div></li>
      <li><span>4</span><div><strong>Add and configure Login Kit</strong><ul className="setup-actions"><li>Click <b>Add products</b> → <b>Login Kit</b>.</li><li>Open Login Kit configuration and add the exact redirect URI below.</li><li>Do not change 127.0.0.1 to localhost, add parameters, or add a trailing slash.</li></ul><CopyCode value={redirectUri} /><a href="https://developers.tiktok.com/doc/login-kit-desktop/" target="_blank" rel="noreferrer">Open Desktop Login Kit instructions <ExternalLink size={13} /></a><SetupDone>The redirect URI is saved under Desktop Login Kit.</SetupDone></div></li>
      <li><span>5</span><div><strong>Add Content Posting API</strong><ul className="setup-actions"><li>Click <b>Add products</b> → <b>Content Posting API</b>.</li><li>Enable the <b>Upload API</b>, which sends drafts to the user&apos;s TikTok inbox.</li><li>Request or enable scopes <code>user.info.basic</code> and <code>video.upload</code>. Reelio does not currently require <code>video.publish</code>.</li></ul><a href="https://developers.tiktok.com/products/content-posting-api/" target="_blank" rel="noreferrer">Open Content Posting API <ExternalLink size={13} /></a><SetupDone>Content Posting API and <code>video.upload</code> appear in the app configuration.</SetupDone></div></li>
      <li><span>6</span><div><strong>Copy the Client key and Client secret</strong><ul className="setup-actions"><li>Open <b>Manage apps</b> → Reelio → <b>Basic information</b>.</li><li>Copy <b>Client key</b>.</li><li>Press <b>Show</b> beside <b>Client secret</b> and copy it. Never paste the secret into a public form or demo recording.</li></ul><div className="youtube-credential-grid"><label><span>Client key</span><input value={clientKey} onChange={(event) => setClientKey(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "TikTok client key"} autoComplete="off" /></label><label><span>Client secret</span><div><input type={showSecret ? "text" : "password"} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "TikTok client secret"} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div></label></div><SetupDone>Both credential fields are filled.</SetupDone></div></li>
      <li><span>7</span><div><strong>Connect the Sandbox TikTok account</strong><ul className="setup-actions"><li>Press <b>Save &amp; connect TikTok</b> below.</li><li>In TikTok&apos;s window, sign in with the accepted Sandbox target account.</li><li>Approve basic profile and upload permission, then return to Reelio.</li></ul><SetupDone>The account name appears in green with “draft upload ready.”</SetupDone></div></li>
      <li><span>8</span><div><strong>Test the complete draft flow</strong><ul className="setup-actions"><li>In a finished Reelio video, select TikTok and press upload.</li><li>Wait until Reelio says <b>Delivered to TikTok inbox</b>.</li><li>Open TikTok on your phone → <b>Inbox</b> → system notification, finish editing, and publish.</li></ul><SetupDone>The draft opens in TikTok and can be posted by the creator.</SetupDone></div></li>
    </ol>
    <div className="youtube-setup-note tiktok-note"><CircleHelp size={16} /><p><b>Why Reelio sends a draft:</b> the approved Upload API uses <code>video.upload</code> and requires the creator to finish posting in TikTok. Fully automatic Direct Post uses <code>video.publish</code>, mandatory creator-info UI, explicit consent, and a separate TikTok audit. Unaudited Direct Post content is restricted to private.</p></div>
    <SetupTroubleshooting issues={[{ title: "Refresh token is invalid or expired", fix: "Open this guide and connect TikTok again with the Sandbox target account. Reelio will replace the expired refresh token." }, { title: "Redirect URI is rejected", fix: `Confirm Desktop—not Web—is configured and save exactly ${redirectUri}. The public Web/Desktop URL is a separate HTTPS website field.` }, { title: "scope_not_authorized or video.upload missing", fix: "Add Content Posting API, enable Upload API, enable video.upload, then reconnect so the new permission is included in the token." }, { title: "Upload succeeded but nothing is public", fix: "This is expected for Upload API. Open the TikTok inbox notification and complete the post manually." }, { title: "Too many pending shares", fix: "TikTok allows at most five pending uploads in 24 hours. Finish or clear pending drafts, then retry later." }]} />
    <footer><button className="secondary-action" onClick={onCheck}><RefreshCw size={15} /> Check connection</button><button className="youtube-connect-button tiktok-connect-button" onClick={onConnect} disabled={connecting || status?.connected}>{status?.connected ? <><Check size={16} /> Connected</> : connecting ? <><RefreshCw className="spin" size={16} /> Starting…</> : <><Play size={16} /> {status?.configured && !clientKey && !clientSecret ? "Connect TikTok" : "Save & connect TikTok"}</>}</button></footer>
  </div></div>;
}

function FacebookSetupGuide({ status, pageId, pageAccessToken, graphVersion, setPageId, setPageAccessToken, setGraphVersion, showSecret, setShowSecret, saving, onSave, onCheck, onClose }: { status: FacebookStatus | null; pageId: string; pageAccessToken: string; graphVersion: string; setPageId: (value: string) => void; setPageAccessToken: (value: string) => void; setGraphVersion: (value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void; saving: boolean; onSave: () => void; onCheck: () => void; onClose: () => void }) {
  return <div className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="facebook-setup-title"><div className="setup-dialog">
    <header><div><PlatformLogo platform={platforms[2]} /><span><strong id="facebook-setup-title">Connect Facebook Page</strong><small>Meta Page token • Facebook Reels Publishing API</small></span></div><button onClick={onClose} aria-label="Close Facebook Page setup"><X size={18} /></button></header>
    {status?.connected && <div className="connection-success"><ShieldCheck size={18} /><span><strong>{status.pageName} is connected</strong><small>Reelio verified this Page ID and Page access token with Meta.</small></span></div>}
    <SetupOverview time="15–25 minutes" prerequisites={["A Facebook Page—not a personal profile", "Facebook access with full control of that Page", "A Meta developer account and a Meta app"]} result="Reelio verifies a Page access token and publishes Reels to that Page." />
    <div className="id-explainer"><strong>Do not mix up these IDs</strong><span><b>App ID</b> identifies your developer app. Never paste it as Page ID.</span><span><b>Page ID</b> identifies the Facebook Page that receives the Reel.</span><span><b>Page access token</b> authorizes Reelio to act as that same Page.</span></div>
    <ol className="setup-steps">
      <li><span>1</span><div><strong>Confirm Page access</strong><ul className="setup-actions"><li>Open Meta Business Settings → <b>Accounts</b> → <b>Pages</b>.</li><li>Select the Page. Confirm your Facebook profile has <b>Full control</b>, or at least permission to create and manage Page content.</li><li>If the Page is missing, add it to the correct Business Portfolio first.</li></ul><a href="https://business.facebook.com/settings/pages/" target="_blank" rel="noreferrer">Open Pages in Business Settings <ExternalLink size={13} /></a><SetupDone>The Page appears and your profile has content-management access.</SetupDone></div></li>
      <li><span>2</span><div><strong>Create or open the Meta app</strong><ul className="setup-actions"><li>Open Meta for Developers → <b>My Apps</b>.</li><li>Create an app and choose the Business portfolio that owns the Page, or open your existing Reelio app.</li><li>For testing, keep the app in <b>Development</b> mode. Only app administrators, developers, and testers can authorize it.</li></ul><a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Open Meta developer apps <ExternalLink size={13} /></a><SetupDone>The Reelio app dashboard opens and shows its App ID.</SetupDone></div></li>
      <li><span>3</span><div><strong>Add the Page-management use case</strong><ul className="setup-actions"><li>In the app dashboard, click <b>Add use cases</b>.</li><li>Add <b>Manage everything on your Page</b> or the equivalent Pages API use case.</li><li>Open the use case&apos;s permissions/customization screen and confirm Pages API is available.</li></ul><SetupDone>The Page-management use case is listed on the app dashboard.</SetupDone></div></li>
      <li><span>4</span><div><strong>Generate a User access token for testing</strong><ul className="setup-actions"><li>Open Graph API Explorer.</li><li>In the <b>Meta App</b> selector, choose your Reelio app—not “Graph API Explorer.”</li><li>Choose <b>User Token</b>, then add <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_posts</code>, and <code>business_management</code>.</li><li><code>business_management</code> is needed when the Page is owned or managed through a Meta Business Portfolio.</li><li>Press <b>Generate Access Token</b>, choose your Facebook account, and approve every requested Page and business permission.</li></ul><a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Open Graph API Explorer <ExternalLink size={13} /></a><SetupDone>Explorer shows a User access token created for the Reelio app with all four permissions granted.</SetupDone></div></li>
      <li><span>5</span><div><strong>Ask Meta for your Pages</strong><ul className="setup-actions"><li>In Graph API Explorer, keep the method set to <b>GET</b>.</li><li>In the request path box, enter the exact text below and press <b>Submit</b>.</li><li>Explorer sends the selected User token separately; the request returns the Pages that token is allowed to manage.</li><li>The <code>tasks</code> field helps confirm the account can create Page content.</li></ul><CopyCode value="me/accounts?fields=name,access_token,tasks" /><SetupDone>You see your Page&apos;s <code>id</code>, <code>name</code>, <code>access_token</code>, and <code>tasks</code> in one response object.</SetupDone></div></li>
      <li><span>6</span><div><strong>If the response says <code>data: []</code></strong><ul className="setup-actions"><li>The query worked, but the current User token cannot see a Page.</li><li>Open your Facebook Page → <b>Settings</b> → <b>Page setup</b> → <b>Page access</b>. Your personal Facebook profile must appear under <b>People with Facebook access</b> and have full control, or have a content-creation task.</li><li>In Graph API Explorer, confirm <b>Nika Sharing</b> is selected under Meta App and <b>User Token</b> is selected—not App Token or Page Token.</li><li>Press <b>Generate Access Token</b> again after selecting <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_posts</code>, and <code>business_management</code>. Approve access to the Page and Business Portfolio when Facebook asks.</li><li>Run <code>me/permissions</code> and confirm all four permissions show <code>status: granted</code>, then repeat step 5.</li></ul><SetupDone>The Page appears inside the <code>data</code> array.</SetupDone></div></li>
      <li><span>7</span><div><strong>Copy the Page ID and Page token from the same object</strong><ul className="setup-actions"><li>Copy <code>id</code> into <b>Facebook Page ID</b>.</li><li>Copy <code>access_token</code> from that same object into <b>Page access token</b>.</li><li>Confirm the returned <code>tasks</code> include content creation or full control.</li><li>Do not copy the App ID from the developer dashboard or the User token shown at the top of Explorer.</li></ul><div className="setup-example"><b>Response shape</b><code>{`{ "id": "{PAGE_ID}", "name": "{PAGE_NAME}", "access_token": "{PAGE_ACCESS_TOKEN}", "tasks": ["CREATE_CONTENT"] }`}</code></div><SetupDone>The ID and token came from the same Page object.</SetupDone></div></li>
      <li><span>8</span><div><strong>Enter the Graph version and verify</strong><ul className="setup-actions"><li>Use the current version shown in Graph API Explorer, for example <code>v25.0</code>.</li><li>Fill all three fields below and press <b>Save &amp; check Facebook</b>.</li><li>Reelio calls Meta as the saved Page and confirms that the returned ID exactly matches.</li></ul><div className="youtube-credential-grid facebook-credential-grid"><label><span>Facebook Page ID</span><input value={pageId} onChange={(event) => setPageId(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "Numeric Page ID"} autoComplete="off" /></label><label><span>Graph API version</span><input value={graphVersion} onChange={(event) => setGraphVersion(event.target.value)} placeholder={status?.graphVersion ?? "Example: v25.0"} autoComplete="off" /></label><label className="full"><span>Page access token</span><div><input type={showSecret ? "text" : "password"} value={pageAccessToken} onChange={(event) => setPageAccessToken(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "Paste the Page access token"} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div></label></div><SetupDone>The Page name appears in green with “Reels publishing ready.”</SetupDone></div></li>
      <li><span>9</span><div><strong>Prepare production access</strong><ul className="setup-actions"><li>Graph API Explorer tokens are useful for testing but may expire.</li><li>For a public multi-user app, request Advanced Access for the Page permissions, complete Business Verification if Meta requires it, and pass App Review.</li><li>Your review recording must show authorization, Page selection, a real Reel upload, and the resulting Page post.</li></ul><SetupDone>Your own app authorization issues a durable token and approved users can connect.</SetupDone></div></li>
    </ol>
    <div className="youtube-setup-note facebook-note"><CircleHelp size={16} /><p><b>Testing versus production:</b> while the Meta app is in Development mode, only people assigned an app role can authorize it. Graph API Explorer is suitable for proving the integration; production users require your app&apos;s own Facebook Login flow, the approved Page permissions, and durable token handling.</p></div>
    <SetupTroubleshooting issues={[{ title: "The Page list is empty", fix: "Add business_management when the Page belongs to a Business Portfolio, generate a new User token, approve business access, and retry me/accounts." }, { title: "Unsupported post request / object does not exist", fix: "The Page ID is often actually the Meta App ID, or the token cannot access that Page. Run /me/accounts and use the Page id from its response." }, { title: "Token does not belong to this Page ID", fix: "Copy id and access_token from the same object in GET /me/accounts. Do not combine values from different Pages or token types." }, { title: "pages_manage_posts is not available", fix: "Select your own Meta app in Graph API Explorer and add the Page-management use case. Also confirm your Facebook account has full Page control." }, { title: "Works for developer but not another user", fix: "Development mode only permits app-role users. Add the person as a tester for testing, or complete Advanced Access and App Review for production." }, { title: "Connection worked and later expired", fix: "Generate a new token and save it again. For production, replace the temporary Explorer token flow with durable user/Page token handling." }]} />
    <footer><button className="secondary-action" onClick={onCheck} disabled={saving}><RefreshCw size={15} /> Check connection</button><button className="youtube-connect-button facebook-connect-button" onClick={onSave} disabled={saving || status?.connected && !pageId && !pageAccessToken && !graphVersion}>{status?.connected && !pageId && !pageAccessToken && !graphVersion ? <><Check size={16} /> Connected</> : saving ? <><RefreshCw className="spin" size={16} /> Checking…</> : <><ShieldCheck size={16} /> Save & check Facebook</>}</button></footer>
  </div></div>;
}

function InstagramSetupGuide({ status, accountId, userAccessToken, graphVersion, publicMediaBaseUrl, setAccountId, setUserAccessToken, setGraphVersion, setPublicMediaBaseUrl, showSecret, setShowSecret, saving, onSave, onCheck, onClose }: { status: InstagramStatus | null; accountId: string; userAccessToken: string; graphVersion: string; publicMediaBaseUrl: string; setAccountId: (value: string) => void; setUserAccessToken: (value: string) => void; setGraphVersion: (value: string) => void; setPublicMediaBaseUrl: (value: string) => void; showSecret: boolean; setShowSecret: (value: boolean) => void; saving: boolean; onSave: () => void; onCheck: () => void; onClose: () => void }) {
  return <div className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="instagram-setup-title"><div className="setup-dialog">
    <header><div><PlatformLogo platform={platforms[3]} /><span><strong id="instagram-setup-title">Connect Instagram</strong><small>Professional account • Instagram Reels Publishing API</small></span></div><button onClick={onClose} aria-label="Close Instagram setup"><X size={18} /></button></header>
    {status?.connected && <div className="connection-success"><ShieldCheck size={18} /><span><strong>{status.username} is connected</strong><small>Reelio verified the account ID, Meta token, and public media URL configuration.</small></span></div>}
    <SetupOverview time="20–30 minutes, plus public media hosting" prerequisites={["An Instagram Business or Creator account", "A Facebook Page linked to that Instagram account", "A Meta app and a public HTTPS route that can serve Reelio MP4 files"]} result="Meta verifies the Professional account and can fetch and publish finished Reels." />
    <div className="id-explainer instagram-id-explainer"><strong>Instagram uses three different identifiers</strong><span><b>Facebook Page ID</b> is the linked Page.</span><span><b>Instagram account ID</b> is <code>instagram_business_account.id</code>; paste this into Reelio.</span><span><b>@username</b> is only the visible profile name and cannot replace the numeric account ID.</span></div>
    <ol className="setup-steps">
      <li><span>1</span><div><strong>Convert Instagram to a Professional account</strong><ul className="setup-actions"><li>In the Instagram mobile app, open Profile → menu → <b>Settings and activity</b>.</li><li>Open <b>Account type and tools</b> → <b>Switch to professional account</b>.</li><li>Choose <b>Creator</b> or <b>Business</b> and finish the setup. Personal accounts cannot use this publishing API.</li></ul><SetupDone>Instagram settings show Creator or Business as the account type.</SetupDone></div></li>
      <li><span>2</span><div><strong>Link Instagram to the correct Facebook Page</strong><ul className="setup-actions"><li>Open Meta Business Settings → <b>Accounts</b> → <b>Instagram accounts</b>.</li><li>Click <b>Add</b>, sign in to Instagram, and connect the Professional account.</li><li>Assign it to the same Facebook Page and Business Portfolio used by your Meta app.</li></ul><a href="https://business.facebook.com/settings/instagram-accounts/" target="_blank" rel="noreferrer">Open Instagram accounts in Business Settings <ExternalLink size={13} /></a><SetupDone>The Instagram account and connected Facebook Page appear in the same business.</SetupDone></div></li>
      <li><span>3</span><div><strong>Add Instagram publishing to the Meta app</strong><ul className="setup-actions"><li>Open the same Meta app used for Facebook Page publishing.</li><li>Click <b>Add use cases</b> or <b>Add products</b> and add the Instagram API with Facebook Login.</li><li>Keep the app in Development mode for your own app-role testing.</li></ul><a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Open Meta developer apps <ExternalLink size={13} /></a><SetupDone>The app dashboard shows the Instagram API use case/product.</SetupDone></div></li>
      <li><span>4</span><div><strong>Create the correct Meta User token</strong><ul className="setup-actions"><li>Open Graph API Explorer and select your Reelio Meta app.</li><li>Choose <b>User Token</b>.</li><li>Add <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>instagram_basic</code>, and <code>instagram_content_publish</code>.</li><li>Generate the token, choose the Facebook account that manages the linked Page, and approve every permission.</li></ul><a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Open Graph API Explorer <ExternalLink size={13} /></a><SetupDone>Explorer displays a User token containing all four permissions.</SetupDone></div></li>
      <li><span>5</span><div><strong>Find the numeric Instagram account ID</strong><ul className="setup-actions"><li>Submit the request below in Graph API Explorer.</li><li>Find the object for the Facebook Page linked in step 2.</li><li>Copy the nested <code>instagram_business_account.id</code>. Do not copy the outer Page <code>id</code>.</li></ul><CopyCode value="GET /me/accounts?fields=id,name,instagram_business_account" /><div className="setup-example"><b>Copy the nested value</b><code>{`{ "id": "FACEBOOK_PAGE_ID", "instagram_business_account": { "id": "COPY_THIS_INSTAGRAM_ID" } }`}</code></div><SetupDone>You have the numeric nested Instagram account ID.</SetupDone></div></li>
      <li><span>6</span><div><strong>Prepare the public media URL</strong><ul className="setup-actions"><li>Instagram does not accept a video uploaded directly from this local browser. Meta&apos;s server downloads the MP4 from a URL.</li><li>The URL must use HTTPS, be reachable without login, return the actual MP4 bytes, and support Reelio&apos;s path <code>/jobs/&lt;job-id&gt;/assets/final</code>.</li><li>A normal website page such as <code>https://nainglin.com/nika/</code> is not sufficient by itself. It must proxy or host Reelio&apos;s generated media files.</li><li>Do not use localhost, 127.0.0.1, a private LAN address, or a URL requiring cookies.</li></ul><SetupDone>Opening a completed job&apos;s final asset URL in a private browser downloads or plays the MP4 without signing in.</SetupDone></div></li>
      <li><span>7</span><div><strong>Paste all four values into Reelio</strong><ul className="setup-actions"><li>Instagram account ID: nested ID from step 5.</li><li>Graph API version: the current version in Explorer, such as <code>v25.0</code>.</li><li>Meta user access token: token generated in step 4.</li><li>Public media base URL: HTTPS prefix from step 6, without a trailing slash.</li></ul><div className="youtube-credential-grid instagram-credential-grid"><label><span>Instagram account ID</span><input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "Instagram Professional account ID"} autoComplete="off" /></label><label><span>Graph API version</span><input value={graphVersion} onChange={(event) => setGraphVersion(event.target.value)} placeholder={status?.graphVersion ?? "Example: v25.0"} autoComplete="off" /></label><label className="full"><span>Meta user access token</span><div><input type={showSecret ? "text" : "password"} value={userAccessToken} onChange={(event) => setUserAccessToken(event.target.value)} placeholder={status?.configured ? "Saved — enter only to replace" : "Meta user access token"} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div></label><label className="full"><span>Public media base URL</span><input value={publicMediaBaseUrl} onChange={(event) => setPublicMediaBaseUrl(event.target.value)} placeholder={status?.publicMediaBaseUrl ?? "https://your-domain.example/media"} autoComplete="url" /></label></div><SetupDone>All fields are filled with values from the same Meta setup.</SetupDone></div></li>
      <li><span>8</span><div><strong>Save, verify, and test a Reel</strong><ul className="setup-actions"><li>Press <b>Save &amp; check Instagram</b>. Reelio verifies the token can read that exact Instagram account.</li><li>Generate a short test video and confirm its public final-asset URL works.</li><li>Approve the video, select Instagram, and upload. Meta first creates a media container, processes it, then publishes it.</li></ul><SetupDone>The Instagram username appears in green and the test Reel appears on the profile.</SetupDone></div></li>
      <li><span>9</span><div><strong>Prepare production access</strong><ul className="setup-actions"><li>Temporary Graph API Explorer tokens are for testing. Production needs durable token handling.</li><li>Request Advanced Access for <code>instagram_basic</code>, <code>instagram_content_publish</code>, and required Page permissions.</li><li>Complete Business Verification and App Review when Meta requests them. Record the entire connect → select media → publish → resulting Reel flow.</li></ul><SetupDone>Non-role users can authorize the live app and publish successfully.</SetupDone></div></li>
    </ol>
    <div className="youtube-setup-note instagram-note"><CircleHelp size={16} /><p><b>The public media route is mandatory:</b> the connection check can verify your account and URL format, but only a real test upload proves Meta can download that specific video. Reelio publishes 9:16 MP4 with H.264 video, AAC audio, and a supported duration/frame rate.</p></div>
    <SetupTroubleshooting issues={[{ title: "instagram_business_account is missing", fix: "The Instagram profile is personal, is not linked to that Page, or your Facebook account lacks access. Complete steps 1 and 2, then generate a new token." }, { title: "Invalid OAuth access token / permissions error", fix: "Select the Reelio app in Graph API Explorer, enable all four listed permissions, generate a new User token, and save it again." }, { title: "Meta can verify the account but upload fails", fix: "Open the exact final video URL in a private browser. It must be public HTTPS and return video/mp4 directly without login, HTML, redirect loops, or an expired link." }, { title: "Object with ID does not exist", fix: "Use the nested instagram_business_account.id, not the Facebook Page ID, Meta App ID, or @username." }, { title: "Works only for app administrators", fix: "That is expected in Development mode. Add testers for testing or complete Advanced Access, Business Verification, and App Review." }]} />
    <footer><button className="secondary-action" onClick={onCheck} disabled={saving}><RefreshCw size={15} /> Check connection</button><button className="youtube-connect-button instagram-connect-button" onClick={onSave} disabled={saving || status?.connected && !accountId && !userAccessToken && !graphVersion && !publicMediaBaseUrl}>{status?.connected && !accountId && !userAccessToken && !graphVersion && !publicMediaBaseUrl ? <><Check size={16} /> Connected</> : saving ? <><RefreshCw className="spin" size={16} /> Checking…</> : <><ShieldCheck size={16} /> Save & check Instagram</>}</button></footer>
  </div></div>;
}

function viewLabel(view: View) {
  if (view === "create") return "New video";
  if (view === "library") return "Video library";
  if (view === "detail") return "Video detail";
  if (view === "automations") return "Automations";
  return "Settings";
}

function stageStep(stage: string) {
  if (stage === "script") return 0;
  if (stage === "voice" || stage === "music") return 1;
  if (stage === "stock-search") return 2;
  return 3;
}
