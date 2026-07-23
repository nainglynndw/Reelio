"use client";

import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudUpload,
  Download,
  ExternalLink,
  Film,
  Gauge,
  Languages,
  Mic2,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { defaultTtsEngine, jobTtsEngineLabel, speechLanguages, ttsEngineLabel, ttsEngineOptions, voiceLanguages } from "../lib/languages";
import { platformEligibility, platformManageUrl, platforms } from "../lib/platforms";
import { fetchPublishingReadiness, SERVICE_URL } from "../lib/service";
import type { LocalJob, Platform, PlatformEligibility, PlatformPostCopy, PublishResult, PublishingReadiness, TtsEngine } from "../lib/types";
import { PlatformLogo, SelectField } from "./common";

type DetailTab = "overview" | "transcript" | "captions" | "assets" | "publishing";

export function VideoDetailView({ job, generationLocked, onBack, onOpenSettings, onJobCreated, setToast }: { job: LocalJob; generationLocked: boolean; onBack: () => void; onOpenSettings: () => void; onJobCreated: (job: LocalJob) => void; setToast: (value: string) => void }) {
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
      return [id, { ...previous[id], status: checkingExisting ? "verifying" : "starting", progress: checkingExisting ? 100 : 0, message: checkingExisting ? `Checking ${platforms.find((platform) => platform.id === id)?.label ?? id} status…` : reuploadPlatforms.includes(id) ? "Preparing a new upload…" : "Starting upload…" }];
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
      else if (processing.length) setToast(processing.map(([id]) => `${platforms.find((platform) => platform.id === id)?.label ?? id} received the file and is processing it`).join(" • "));
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
            const label = !result ? eligibility.eligible ? "Eligible • Not uploaded" : "Not eligible" : result.status === "failed" ? "Upload failed" : result.status === "needs_credentials" ? "Connection required" : result.status === "inbox" ? "Delivered to TikTok inbox" : result.status === "processing" ? `Uploaded • ${platform.label} processing` : result.status === "verifying" ? "Upload complete • verifying" : result.status === "uploading" ? `Uploading ${result.progress ?? 0}%` : result.status === "starting" ? "Starting upload" : result.status === "uploaded" && result.privacy ? `Uploaded • ${result.privacy}` : result.status === "published" && result.privacy ? `Published • ${result.privacy}` : result.status;
            const progressDetail = result?.status === "uploading" ? `${formatFileSize(result.bytesUploaded)} of ${formatFileSize(result.bytesTotal)}${result.etaSeconds ? ` • about ${formatEta(result.etaSeconds)} left` : ""}` : result?.status === "starting" ? "Preparing upload…" : result?.status === "verifying" ? `Checking ${platform.label} status…` : result?.status === "processing" ? platform.id === "tiktok" ? "Waiting for TikTok • usually under 1 minute" : platform.id === "facebook" ? `${result.message ?? "Facebook is processing the Reel…"}` : "Upload complete • platform processing" : "";
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
          <button className="publish-all-button" onClick={publish} disabled={publishing || checkingTikTokStatus || isDemo || !currentJob.assets?.final || publishSelection.length === 0 || currentJob.reviewState !== "approved"}><CloudUpload size={17} /> {publishing ? "Uploading and verifying…" : checkingTikTokStatus ? "Checking TikTok status…" : publishSelection.length === 1 && publishResults[publishSelection[0]]?.status === "processing" ? `Check ${platforms.find((platform) => platform.id === publishSelection[0])?.label ?? "platform"} status` : currentJob.reviewState !== "approved" && !isDemo ? "Approve before uploading" : `Upload to ${publishSelection.length} selected platform${publishSelection.length === 1 ? "" : "s"}`}</button>
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
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}

function formatEta(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  return `${Math.ceil(seconds / 60)} min`;
}
