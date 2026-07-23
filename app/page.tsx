"use client";

import {
  Archive,
  CalendarClock,
  Check,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Library,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AutomationsView } from "./components/AutomationsView";
import { CreateView } from "./components/CreateView";
import { LibraryView } from "./components/LibraryView";
import { SettingsView } from "./components/SettingsView";
import { VideoDetailView } from "./components/VideoDetailView";
import { defaultTtsEngine } from "./lib/languages";
import { SERVICE_URL } from "./lib/service";
import type { LocalJob, TtsEngine, View } from "./lib/types";

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
  const [ideaFocus, setIdeaFocus] = useState("");
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
        body: JSON.stringify({ category, duration, language, focus: ideaFocus.trim() }),
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
        body: JSON.stringify({ category, duration, language, focus: ideaFocus.trim() }),
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
    setIdeaFocus("");
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
            ideaFocus={ideaFocus}
            setIdeaFocus={setIdeaFocus}
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
