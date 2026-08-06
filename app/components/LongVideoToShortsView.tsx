"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  Languages,
  Link2,
  LoaderCircle,
  Mic2,
  Play,
  RefreshCw,
  Scissors,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defaultTtsEngine, speechLanguages, ttsEngineOptions, voiceLanguages } from "../lib/languages";
import { narrators } from "../lib/narrators";
import { platforms } from "../lib/platforms";
import { serviceFetch, SERVICE_URL } from "../lib/service";
import type { LocalJob, NarratorId, ToolJob, TtsEngine } from "../lib/types";
import { PlatformLogo, SelectField } from "./common";

type InputReference = { uploadId?: string; toolJobId?: string; assetKey?: string };
type Framing = "left" | "center" | "right" | "fit";
type HighlightCandidate = {
  id: string;
  selected: boolean;
  title: string;
  hook: string;
  description: string;
  start: number;
  end: number;
  duration: number;
  score: number;
  reason: string;
  transcript: string;
  framing: Framing;
};

export function LongVideoToShortsView({
  authenticated,
  onRequireAuthentication,
  onBackToModes,
  onOpenJob,
  onOpenSettings,
  setToast,
}: {
  authenticated: boolean;
  onRequireAuthentication: () => boolean;
  onBackToModes: () => void;
  onOpenJob: (job: LocalJob) => void;
  onOpenSettings: () => void;
  setToast: (value: string) => void;
}) {
  const [sourceMode, setSourceMode] = useState<"upload" | "url">("upload");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourcePreview, setSourcePreview] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [captionLanguage, setCaptionLanguage] = useState("en");
  const [maxClips, setMaxClips] = useState(5);
  const [minClipSeconds, setMinClipSeconds] = useState(25);
  const [maxClipSeconds, setMaxClipSeconds] = useState(60);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [cloudConsent, setCloudConsent] = useState(false);
  const [mediaReference, setMediaReference] = useState<InputReference | null>(null);
  const [analysisReference, setAnalysisReference] = useState<InputReference | null>(null);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);
  const [analysisJob, setAnalysisJob] = useState<ToolJob | null>(null);
  const [renderJob, setRenderJob] = useState<ToolJob | null>(null);
  const [candidates, setCandidates] = useState<HighlightCandidate[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [prepareMessage, setPrepareMessage] = useState("");
  const [captions, setCaptions] = useState(true);
  const [applyBrandKit, setApplyBrandKit] = useState(true);
  const [speechLanguage, setSpeechLanguage] = useState("English");
  const [subtitleLanguage, setSubtitleLanguage] = useState("English");
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>("kokoro");
  const [narratorId, setNarratorId] = useState<NarratorId>("maya");
  const [selectedPlatforms, setSelectedPlatforms] = useState(["youtube", "tiktok", "facebook", "instagram"]);
  const [mixOriginalAudio, setMixOriginalAudio] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [transitions, setTransitions] = useState(false);
  const [remixConfirmed, setRemixConfirmed] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [showcaseSaving, setShowcaseSaving] = useState(false);

  const selectedCount = candidates.filter((candidate) => candidate.selected).length;
  const stage = renderJob?.state === "completed"
    ? "complete"
    : renderJobId || renderJob?.state === "running" || renderJob?.state === "queued"
      ? "rendering"
      : candidates.length
        ? "review"
        : analysisJobId || analysisJob?.state === "running" || analysisJob?.state === "queued" || preparing
          ? "analyzing"
          : "source";

  function restoreAnalysisRequest(job: ToolJob) {
    const media = job.request.inputs.media;
    if (media) setMediaReference(media);
    const options = job.request.options;
    setWorkflowId(typeof options.workflowId === "string" ? options.workflowId : "");
    setRightsConfirmed(options.rightsConfirmed === true);
    setCloudConsent(options.cloudConsent === true);
  }

  function restoreRenderRequest(job: ToolJob) {
    const media = job.request.inputs.media;
    const analysis = job.request.inputs.analysis;
    if (media) setMediaReference(media);
    if (analysis) setAnalysisReference(analysis);
    const requested = job.request.options.candidates;
    if (Array.isArray(requested)) setCandidates(requested.map(normalizeCandidate));
    setRightsConfirmed(job.request.options.rightsConfirmed === true);
    setCloudConsent(job.request.options.cloudConsent !== false);
    setCaptions(job.request.options.captions !== false);
    setApplyBrandKit(job.request.options.applyBrandKit !== false);
    const nextSpeechLanguage = typeof job.request.options.speechLanguage === "string" ? job.request.options.speechLanguage : "English";
    setSpeechLanguage(nextSpeechLanguage);
    setSubtitleLanguage(typeof job.request.options.subtitleLanguage === "string" ? job.request.options.subtitleLanguage : nextSpeechLanguage);
    setTtsEngine(["kokoro", "gemini", "voxcpm2"].includes(String(job.request.options.ttsEngine)) ? job.request.options.ttsEngine as TtsEngine : defaultTtsEngine(nextSpeechLanguage));
    setNarratorId(["maya", "theo", "nova", "ellis"].includes(String(job.request.options.narratorId)) ? job.request.options.narratorId as NarratorId : "maya");
    setSelectedPlatforms(Array.isArray(job.request.options.platforms) ? job.request.options.platforms.map(String) : ["youtube", "tiktok", "facebook", "instagram"]);
    setMixOriginalAudio(job.request.options.mixOriginalAudio !== false);
    setMirror(job.request.options.mirror === true);
    setTransitions(job.request.options.transitions === true);
    setRemixConfirmed(job.request.options.remixConfirmed === true);
  }

  function applyAnalysisResult(job: ToolJob) {
    setAnalysisJob(job);
    setAnalysisReference({ toolJobId: job.id, assetKey: "analysis" });
    const rawCandidates = job.metadata?.candidates;
    if (Array.isArray(rawCandidates)) setCandidates(rawCandidates.map(normalizeCandidate));
  }

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    serviceFetch(`${SERVICE_URL}/tool-jobs`)
      .then((response) => response.json())
      .then((result: { jobs?: ToolJob[] }) => {
        if (cancelled) return;
        const recent = (result.jobs ?? [])
          .filter((job) => ["long-video-analyze", "long-video-render"].includes(job.request.toolId))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const active = recent.find((job) => job.state === "queued" || job.state === "running");
        const resumableAnalysis = !active ? recent.find((job) => {
          if (job.request.toolId !== "long-video-analyze" || job.state !== "completed") return false;
          const workflow = String(job.request.options.workflowId || "");
          return workflow && !recent.some((candidate) =>
            candidate.request.toolId === "long-video-render"
            && String(candidate.request.options.workflowId || "") === workflow);
        }) : null;
        const current = active ?? resumableAnalysis;
        if (!current) return;
        if (current.request.toolId === "long-video-render") {
          setRenderJob(current);
          setRenderJobId(current.id);
          restoreRenderRequest(current);
        } else {
          setAnalysisJob(current);
          restoreAnalysisRequest(current);
          if (current.state === "completed") applyAnalysisResult(current);
          else setAnalysisJobId(current.id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  useEffect(() => {
    if (!analysisJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await fetchToolJob(analysisJobId);
        if (cancelled) return;
        setAnalysisJob(job);
        if (job.state === "completed") {
          setAnalysisJobId(null);
          applyAnalysisResult(job);
          setToast("Highlight analysis is ready for your review");
        } else if (job.state === "failed" || job.state === "stopped") {
          setAnalysisJobId(null);
          setToast(job.error || "Highlight analysis stopped");
        }
      } catch (error) {
        if (!cancelled) setToast(error instanceof Error ? error.message : "Could not read highlight progress");
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [analysisJobId, setToast]);

  useEffect(() => {
    if (!renderJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await fetchToolJob(renderJobId);
        if (cancelled) return;
        setRenderJob(job);
        if (job.state === "completed") {
          setRenderJobId(null);
          setToast("Your reviewed shorts are ready");
        } else if (job.state === "failed" || job.state === "stopped") {
          setRenderJobId(null);
          setToast(job.error || "Short rendering stopped");
        }
      } catch (error) {
        if (!cancelled) setToast(error instanceof Error ? error.message : "Could not read render progress");
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [renderJobId, setToast]);

  async function startAnalysis() {
    if (!authenticated) return void onRequireAuthentication();
    if (!rightsConfirmed) return setToast("Confirm your rights to edit and publish this source");
    if (!cloudConsent) return setToast("Confirm Gemini cloud processing before analysis");
    if (sourceMode === "upload" && !sourceFile) return setToast("Choose a long video first");
    if (sourceMode === "url" && !sourceUrl.trim()) return setToast("Paste a public video URL first");
    if (maxClipSeconds < minClipSeconds) return setToast("Maximum clip length must be longer than the minimum");

    const nextWorkflowId = crypto.randomUUID();
    setWorkflowId(nextWorkflowId);
    setPreparing(true);
    setCandidates([]);
    setAnalysisJob(null);
    setRenderJob(null);
    setAnalysisReference(null);
    try {
      let media: InputReference;
      let subtitles: InputReference | null = null;
      if (sourceMode === "upload") {
        setPrepareMessage("Uploading the source to your private Reelio data folder");
        media = { uploadId: await uploadInput(sourceFile!) };
      } else {
        setPrepareMessage("Importing the public source and checking for existing captions");
        const downloadPromise = createToolJob("download-media", {}, { url: sourceUrl.trim() });
        const captionsPromise = createToolJob("extract-web-captions", {}, {
          url: sourceUrl.trim(),
          language: captionLanguage.trim().toLowerCase() || "en",
        }).then((job) => waitForToolJob(job.id)).catch(() => null);
        const download = await waitForToolJob((await downloadPromise).id, (job) => setPrepareMessage(job.message));
        if (download.state !== "completed") throw new Error(download.error || "The public video could not be imported");
        media = { toolJobId: download.id, assetKey: "video" };
        const captionJob = await captionsPromise;
        if (captionJob?.state === "completed") subtitles = { toolJobId: captionJob.id, assetKey: "subtitles" };
      }
      setMediaReference(media);
      setPrepareMessage("Queueing transcript and highlight analysis");
      const inputs: Record<string, InputReference> = { media };
      if (subtitles) inputs.subtitles = subtitles;
      const job = await createToolJob("long-video-analyze", inputs, {
        rightsConfirmed: true,
        cloudConsent: true,
        sourceLanguage: sourceLanguage === "auto" && subtitles ? captionLanguage : sourceLanguage,
        maxClips,
        minClipSeconds,
        maxClipSeconds,
        workflowId: nextWorkflowId,
      });
      setAnalysisJob(job);
      setAnalysisJobId(job.id);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Long-video analysis could not start");
    } finally {
      setPreparing(false);
      setPrepareMessage("");
    }
  }

  async function renderShorts() {
    if (!authenticated) return void onRequireAuthentication();
    if (!mediaReference || !analysisReference) return setToast("The source analysis must finish before rendering");
    if (!selectedCount) return setToast("Select at least one highlight");
    if ((mirror || transitions) && !remixConfirmed) return setToast("Confirm the optional creative remix edits before rendering");
    try {
      const job = await createToolJob("long-video-render", {
        media: mediaReference,
        analysis: analysisReference,
      }, {
        rightsConfirmed: true,
        remixConfirmed,
        candidates,
        captions,
        applyBrandKit,
        packageTreatment: true,
        cloudConsent,
        speechLanguage,
        subtitleLanguage,
        ttsEngine,
        narratorId,
        platforms: selectedPlatforms,
        category: "Source recap",
        mixOriginalAudio,
        mirror,
        transitions,
        workflowId,
      });
      setRenderJob(job);
      setRenderJobId(job.id);
      setToast(`${selectedCount} reviewed short${selectedCount === 1 ? "" : "s"} added to the render queue`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The shorts could not be queued");
    }
  }

  async function stopJob(jobId: string | null) {
    if (!authenticated) return void onRequireAuthentication();
    if (!jobId) return;
    try {
      const response = await serviceFetch(`${SERVICE_URL}/tool-jobs/${jobId}/stop`, { method: "POST" });
      const result = await response.json() as { job?: ToolJob; error?: string };
      if (!response.ok) throw new Error(result.error || "The job could not be stopped");
      if (jobId === analysisJobId) {
        setAnalysisJobId(null);
        if (result.job) setAnalysisJob(result.job);
      }
      if (jobId === renderJobId) {
        setRenderJobId(null);
        if (result.job) setRenderJob(result.job);
      }
      setToast("Job stopped");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The job could not be stopped");
    }
  }

  function updateCandidate(index: number, update: Partial<HighlightCandidate>) {
    setCandidates((current) => current.map((candidate, candidateIndex) => candidateIndex === index
      ? { ...candidate, ...update, duration: Number(((update.end ?? candidate.end) - (update.start ?? candidate.start)).toFixed(3)) }
      : candidate));
  }

  function changeSpeechLanguage(value: string) {
    setSpeechLanguage(value);
    const options = ttsEngineOptions(value);
    if (!options.some((option) => option.value === ttsEngine)) setTtsEngine(defaultTtsEngine(value));
  }

  function togglePlatform(id: string) {
    setSelectedPlatforms((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function openPackageJob(jobId: string) {
    if (!authenticated) return void onRequireAuthentication();
    try {
      const response = await serviceFetch(`${SERVICE_URL}/jobs/${jobId}`);
      const result = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !result.job) throw new Error(result.error || "The publishing package is unavailable");
      onOpenJob(result.job);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The publishing package is unavailable");
    }
  }

  function upgradeLegacyBatch() {
    setRenderJob(null);
    setRenderJobId(null);
    setToast("Approved cuts restored. Choose narration, languages, and publishing treatment.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function moveCandidate(index: number, direction: -1 | 1) {
    setCandidates((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function resetWorkflow() {
    if (sourcePreview) URL.revokeObjectURL(sourcePreview);
    setSourceFile(null);
    setSourceUrl("");
    setMediaReference(null);
    setAnalysisReference(null);
    setAnalysisJobId(null);
    setRenderJobId(null);
    setAnalysisJob(null);
    setRenderJob(null);
    setCandidates([]);
    setRightsConfirmed(false);
    setCloudConsent(false);
    setSpeechLanguage("English");
    setSubtitleLanguage("English");
    setTtsEngine("kokoro");
    setNarratorId("maya");
    setSelectedPlatforms(["youtube", "tiktok", "facebook", "instagram"]);
    setMixOriginalAudio(true);
    setMirror(false);
    setTransitions(false);
    setRemixConfirmed(false);
    setWorkflowId("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function chooseSourceFile(file: File | null) {
    if (sourcePreview) URL.revokeObjectURL(sourcePreview);
    setSourceFile(file);
    setSourcePreview(file ? URL.createObjectURL(file) : "");
  }

  async function useAsLongVideoShowcase() {
    if (!authenticated) return void onRequireAuthentication();
    if (!renderJob) return;
    setShowcaseSaving(true);
    try {
      const response = await serviceFetch(`${SERVICE_URL}/mode-previews/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modeId: "long-video-shorts", ownerId: renderJob.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The showcase could not be updated");
      setToast("URL → shorts showcase updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The showcase could not be updated");
    } finally {
      setShowcaseSaving(false);
    }
  }

  const outputAssets = useMemo(() => Object.entries(renderJob?.assets ?? {})
    .filter(([key, asset]) => /^short\d+$/.test(key) && asset.type === "video"), [renderJob]);
  const completePackages = renderJob?.metadata?.packageTreatment === true;
  const packageJobIds = useMemo(() => new Map(
    (Array.isArray(renderJob?.metadata?.clips) ? renderJob.metadata.clips as Array<Record<string, unknown>> : [])
      .filter((clip) => typeof clip.assetKey === "string" && typeof clip.jobId === "string")
      .map((clip) => [String(clip.assetKey), String(clip.jobId)]),
  ), [renderJob]);

  return (
    <div className="content-wrap long-video-page">
      <button className="mode-back-button" onClick={onBackToModes}><ArrowLeft size={15} /> All creation modes</button>

      <div className="long-video-hero">
        <div>
          <div className="eyebrow"><span /> LONG VIDEO TO SHORTS</div>
          <h1>Find the moments worth keeping.</h1>
          <p>Import licensed footage, let Gemini Flash-Lite find complete moments, then approve every script, cut, narrator, language, and publishing package before production.</p>
        </div>
        <div className="long-video-pipeline" aria-label="Workflow progress">
          {["Source", "AI analysis", "Review cuts", "Produce"].map((label, index) => {
            const activeIndex = stage === "source" ? 0 : stage === "analyzing" ? 1 : stage === "review" ? 2 : 3;
            return <span className={index <= activeIndex ? "active" : ""} key={label}><i>{index < activeIndex ? <Check size={12} /> : index + 1}</i>{label}</span>;
          })}
        </div>
      </div>

      {stage === "source" && <section className="long-video-source-card">
        <div className="long-video-source-heading">
          <div><strong>Add your source</strong><span>Existing captions are used first. Gemini transcription runs only when captions are unavailable.</span></div>
          <span><ShieldCheck size={14} /> Consent required</span>
        </div>
        <div className="source-mode-tabs">
          <button className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}><Upload size={16} /> Upload video</button>
          <button className={sourceMode === "url" ? "active" : ""} onClick={() => setSourceMode("url")}><Link2 size={16} /> Public URL</button>
        </div>
        {sourceMode === "upload" ? <label className={`long-video-dropzone ${sourceFile ? "has-file" : ""}`}>
          <input type="file" accept="video/*" onChange={(event) => chooseSourceFile(event.target.files?.[0] ?? null)} />
          <i>{sourceFile ? <CheckCircle2 size={25} /> : <Film size={25} />}</i>
          <strong>{sourceFile ? sourceFile.name : "Choose a long video"}</strong>
          <span>{sourceFile ? formatBytes(sourceFile.size) : "MP4, MOV, WebM, MKV, or another FFmpeg-supported video"}</span>
        </label> : <div className="long-video-url-input">
          <label><span>Public video webpage or direct-media URL</span><div><Link2 size={17} /><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" /></div></label>
          <p>Public HTTPS sources only. Login-protected, private, DRM-protected, playlists, and unsupported sites cannot be imported.</p>
        </div>}

        <div className="long-video-analysis-options">
          <label><span>Source speech language</span><select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}><option value="auto">Auto detect</option>{speechLanguages.map((language) => <option key={language}>{language}</option>)}</select></label>
          {sourceMode === "url" && <label><span>Caption language code</span><input value={captionLanguage} onChange={(event) => setCaptionLanguage(event.target.value)} placeholder="en" /></label>}
          <label><span>Number of candidates</span><input type="number" min="1" max="10" value={maxClips} onChange={(event) => setMaxClips(Number(event.target.value))} /></label>
          <label><span>Minimum length</span><div><input type="number" min="15" max="60" value={minClipSeconds} onChange={(event) => setMinClipSeconds(Number(event.target.value))} /><em>sec</em></div></label>
          <label><span>Maximum length</span><div><input type="number" min="30" max="120" value={maxClipSeconds} onChange={(event) => setMaxClipSeconds(Number(event.target.value))} /><em>sec</em></div></label>
        </div>

        {(sourcePreview || (mediaReference?.toolJobId && sourceMode === "url")) && <video className="long-video-source-preview" controls preload="metadata" src={sourcePreview || `${SERVICE_URL}/tool-jobs/${mediaReference?.toolJobId}/assets/video`} />}

        <div className="long-video-consents">
          <Consent checked={rightsConfirmed} onChange={setRightsConfirmed} title="I own or am licensed to edit and publish this source" description="Reelio does not grant rights to third-party footage, music, voices, logos, or people shown in the video." />
          <Consent checked={cloudConsent} onChange={setCloudConsent} title="I consent to Gemini cloud processing" description="When captions are unavailable, compressed audio is sent for transcription. The reviewed transcript may also be used for highlight selection, translation, Gemini voice generation when selected, and publishing copy." />
        </div>
        <button className="long-video-primary" onClick={startAnalysis}><Sparkles size={17} /> Analyze and find highlights</button>
        <button className="long-video-settings-link" onClick={onOpenSettings}><Settings size={14} /> Gemini API and transcription settings</button>
      </section>}

      {stage === "analyzing" && <ProgressCard
        icon={<LoaderCircle className="spin" size={23} />}
        title={preparing ? "Preparing your source" : "Finding complete short-video moments"}
        message={prepareMessage || analysisJob?.message || "The analysis job is waiting for an available model worker."}
        progress={preparing ? 8 : analysisJob?.progress ?? 2}
        detail="The job is durable. You can leave this page and return while Reelio continues."
        onStop={() => stopJob(analysisJobId)}
        stoppable={Boolean(analysisJobId)}
      />}

      {stage === "review" && <section className="long-video-review">
        <header>
          <div><div className="eyebrow"><span /> HUMAN REVIEW</div><h2>Approve the story, not just the timestamps.</h2><p>Edit in/out points, hooks, order, and framing. Nothing renders until you approve it.</p></div>
          <span>{selectedCount} of {candidates.length} selected</span>
        </header>
        <div className="highlight-list">
          {candidates.map((candidate, index) => <article className={`highlight-card ${candidate.selected ? "selected" : ""}`} key={candidate.id}>
            <div className="highlight-select-row">
              <button className={`highlight-check ${candidate.selected ? "checked" : ""}`} onClick={() => updateCandidate(index, { selected: !candidate.selected })}>{candidate.selected && <Check size={13} />}</button>
              <span>Candidate {String(index + 1).padStart(2, "0")}</span>
              <strong>{Math.round(candidate.score)} / 100</strong>
              <div><button aria-label="Move up" disabled={index === 0} onClick={() => moveCandidate(index, -1)}><ArrowUp size={14} /></button><button aria-label="Move down" disabled={index === candidates.length - 1} onClick={() => moveCandidate(index, 1)}><ArrowDown size={14} /></button></div>
            </div>
            <div className="highlight-fields">
              <label className="wide"><span>Editorial title</span><input value={candidate.title} onChange={(event) => updateCandidate(index, { title: event.target.value })} maxLength={80} /></label>
              <label className="wide"><span>Opening hook</span><input value={candidate.hook} onChange={(event) => updateCandidate(index, { hook: event.target.value })} maxLength={120} /></label>
              <label className="wide"><span>Publishing description</span><textarea value={candidate.description} onChange={(event) => updateCandidate(index, { description: event.target.value })} maxLength={520} /></label>
              <label><span>Start</span><input type="number" min="0" step="0.1" value={candidate.start} onChange={(event) => updateCandidate(index, { start: Number(event.target.value) })} /></label>
              <label><span>End</span><input type="number" min="0" step="0.1" value={candidate.end} onChange={(event) => updateCandidate(index, { end: Number(event.target.value) })} /></label>
              <label><span>Vertical framing</span><select value={candidate.framing} onChange={(event) => updateCandidate(index, { framing: event.target.value as Framing })}><option value="center">Center crop</option><option value="left">Favor left</option><option value="right">Favor right</option><option value="fit">Fit with blurred fill</option></select></label>
            </div>
            <label className="highlight-transcript-editor">
              <span><Play size={13} /> Reviewed narration script <small>{formatClock(candidate.start)}–{formatClock(candidate.end)} · {Math.max(0, candidate.end - candidate.start).toFixed(1)} sec</small></span>
              <textarea value={candidate.transcript} onChange={(event) => updateCandidate(index, { transcript: event.target.value })} maxLength={20_000} />
            </label>
            <p className="highlight-reason"><Sparkles size={13} /> {candidate.reason}</p>
          </article>)}
        </div>

        <div className="short-output-options">
          <div><strong>Complete publishing treatment</strong><span>Every selected highlight becomes its own reviewable video package, not just an edited clip.</span></div>
          <div className="long-video-package-settings">
            <SelectField icon={<Mic2 size={14} />} label="Speech / transcript language" value={speechLanguage} onChange={changeSpeechLanguage} options={speechLanguages} />
            <SelectField icon={<Sparkles size={14} />} label="Voice engine" value={ttsEngine} onChange={(value) => setTtsEngine(value as TtsEngine)} options={ttsEngineOptions(speechLanguage)} />
            <label><span><Mic2 size={14} /> Narrator</span><select value={narratorId} onChange={(event) => setNarratorId(event.target.value as NarratorId)}>{narrators.map((narrator) => <option value={narrator.id} key={narrator.id}>{narrator.name} · {narrator.role}</option>)}</select></label>
            <SelectField icon={<Languages size={14} />} label="Subtitle language" value={subtitleLanguage} onChange={setSubtitleLanguage} options={voiceLanguages} />
          </div>
          <div className="long-video-platforms">
            <span>Prepare publishing packages for</span>
            <div>{platforms.map((platform) => <button className={selectedPlatforms.includes(platform.id) ? "selected" : ""} onClick={() => togglePlatform(platform.id)} key={platform.id}><PlatformLogo platform={platform} /><span>{platform.label}</span>{selectedPlatforms.includes(platform.id) && <Check size={12} />}</button>)}</div>
          </div>
          <Consent checked={captions} onChange={setCaptions} title="Burn readable captions" description="Uses the source transcript and preserves the speaker’s meaning." />
          <Consent checked={mixOriginalAudio} onChange={setMixOriginalAudio} title="Keep low source ambience under the narrator" description="Preserves context such as room tone or crowd sound while the selected narrator remains clear." />
          <Consent checked={applyBrandKit} onChange={setApplyBrandKit} title="Apply active Brand Kit" description="Adds your saved colors, logo, intro, outro, and music where configured." />
          <Consent checked={mirror} onChange={setMirror} title="Mirror the picture" description="Optional composition choice. This is not a rights or content-policy workaround." />
          <Consent checked={transitions} onChange={setTransitions} title="Add short fade transitions" description="Adds a brief opening and closing fade to each approved excerpt." />
          {(mirror || transitions) && <Consent checked={remixConfirmed} onChange={setRemixConfirmed} title="I approve these creative remix edits" description="I understand these edits do not create ownership, permission, originality, or policy compliance." emphasis />}
        </div>
        <div className="long-video-review-actions">
          <button onClick={resetWorkflow}><RefreshCw size={15} /> Start over</button>
          <button className="long-video-primary" onClick={renderShorts} disabled={!selectedCount || !selectedPlatforms.length}><Scissors size={17} /> Produce {selectedCount} publish-ready short{selectedCount === 1 ? "" : "s"}</button>
        </div>
      </section>}

      {stage === "rendering" && <ProgressCard
        icon={<Scissors size={23} />}
        title="Producing complete short-video packages"
        message={renderJob?.message || "The render is waiting for an available media worker."}
        progress={renderJob?.progress ?? 2}
        detail={`${selectedCount} reviewed short${selectedCount === 1 ? "" : "s"} · ${speechLanguage} ${ttsEngine} voice · ${subtitleLanguage} captions · ${selectedPlatforms.length} publishing destination${selectedPlatforms.length === 1 ? "" : "s"}`}
        onStop={() => stopJob(renderJobId)}
        stoppable={Boolean(renderJobId)}
      />}

      {stage === "complete" && <section className="long-video-complete">
        <header><i><CheckCircle2 size={25} /></i><div><div className="eyebrow"><span /> {completePackages ? "PUBLISHING PACKAGES READY" : "LEGACY SHORTS READY"}</div><h2>{outputAssets.length} reviewed short{outputAssets.length === 1 ? "" : "s"} ready.</h2><p>{completePackages ? "Each result opens with its editorial thumbnail and title for 1.5 seconds, followed by narration, captions, clean master, transcript, publishing copy, and platform review." : "These clips were rendered before complete publishing treatment was added. Reelio upgrades their Library copies with titled thumbnail intros and publishing review."}</p></div></header>
        <div className="short-output-grid">{outputAssets.map(([key, asset], index) => <article key={key}>
          <video controls preload="metadata" poster={renderJob?.assets?.[`${key}Thumbnail`]?.url ? `${SERVICE_URL}${renderJob.assets[`${key}Thumbnail`].url}` : undefined} src={`${SERVICE_URL}${asset.url}`} />
          <div><span>Short {String(index + 1).padStart(2, "0")}</span><strong>{asset.name}</strong><small>{completePackages ? "Voice · captions · thumbnail · publishing copy" : "Legacy edited clip · no publishing package"}</small>{packageJobIds.get(key) && <button onClick={() => void openPackageJob(packageJobIds.get(key)!)}>Review & publish</button>}<a href={`${SERVICE_URL}${asset.downloadUrl}`}><Download size={14} /> Download MP4</a></div>
        </article>)}</div>
        <div className="long-video-review-actions"><button onClick={onBackToModes}><ArrowLeft size={15} /> Creation modes</button><button onClick={useAsLongVideoShowcase} disabled={showcaseSaving}><Clapperboard size={15} /> {showcaseSaving ? "Updating showcase…" : "Use as mode showcase"}</button>{!completePackages && <button className="long-video-primary" onClick={upgradeLegacyBatch}><Sparkles size={15} /> Upgrade publishing treatment</button>}<button className={completePackages ? "long-video-primary" : ""} onClick={resetWorkflow}><RefreshCw size={15} /> Create another set</button></div>
      </section>}

      {(analysisJob?.state === "failed" || renderJob?.state === "failed") && !analysisJobId && !renderJobId && <section className="long-video-error">
        <strong>{analysisJob?.state === "failed" ? "Analysis failed" : "Render failed"}</strong>
        <p>{analysisJob?.state === "failed" ? analysisJob.error : renderJob?.error}</p>
        <button onClick={resetWorkflow}><RefreshCw size={15} /> Start again</button>
      </section>}
    </div>
  );
}

function Consent({ checked, onChange, title, description, emphasis = false }: { checked: boolean; onChange: (value: boolean) => void; title: string; description: string; emphasis?: boolean }) {
  return <label className={`long-video-consent ${emphasis ? "emphasis" : ""}`}><button type="button" className={checked ? "checked" : ""} onClick={() => onChange(!checked)}>{checked && <Check size={12} />}</button><span><strong>{title}</strong><small>{description}</small></span></label>;
}

function ProgressCard({ icon, title, message, progress, detail, onStop, stoppable }: { icon: React.ReactNode; title: string; message: string; progress: number; detail: string; onStop: () => void; stoppable: boolean }) {
  return <section className="long-video-progress"><i>{icon}</i><div><span>{Math.max(0, Math.min(100, Math.round(progress)))}%</span><h2>{title}</h2><p>{message}</p><div className="long-video-progress-track"><b style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} /></div><small>{detail}</small>{stoppable && <button onClick={onStop}><Square size={13} /> Stop job</button>}</div></section>;
}

function normalizeCandidate(value: unknown, index = 0): HighlightCandidate {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const start = Number(candidate.start) || 0;
  const end = Number(candidate.end) || Math.max(8, start + 30);
  return {
    id: String(candidate.id || `highlight-${index + 1}`),
    selected: candidate.selected !== false,
    title: String(candidate.title || `Highlight ${index + 1}`),
    hook: String(candidate.hook || ""),
    description: String(candidate.description || ""),
    start,
    end,
    duration: Number(candidate.duration) || end - start,
    score: Number(candidate.score) || 70,
    reason: String(candidate.reason || ""),
    transcript: String(candidate.transcript || ""),
    framing: ["left", "center", "right", "fit"].includes(String(candidate.framing)) ? candidate.framing as Framing : "center",
  };
}

async function uploadInput(file: File) {
  const response = await serviceFetch(`${SERVICE_URL}/tool-inputs`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json() as { input?: { id: string }; error?: string };
  if (!response.ok || !result.input) throw new Error(result.error || "The source video could not be uploaded");
  return result.input.id;
}

async function createToolJob(toolId: string, inputs: Record<string, InputReference>, options: Record<string, unknown>) {
  const response = await serviceFetch(`${SERVICE_URL}/tool-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolId, inputs, options }),
  });
  const result = await response.json() as { job?: ToolJob; error?: string };
  if (!response.ok || !result.job) throw new Error(result.error || "The tool job could not be created");
  return result.job;
}

async function fetchToolJob(jobId: string) {
  const response = await serviceFetch(`${SERVICE_URL}/tool-jobs/${jobId}`);
  const result = await response.json() as { job?: ToolJob; error?: string };
  if (!response.ok || !result.job) throw new Error(result.error || "The tool job is unavailable");
  return result.job;
}

async function waitForToolJob(jobId: string, onProgress?: (job: ToolJob) => void) {
  for (;;) {
    const job = await fetchToolJob(jobId);
    onProgress?.(job);
    if (["completed", "failed", "stopped"].includes(job.state)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 900));
  }
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
