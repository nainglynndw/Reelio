"use client";

import { Download, Film, Plus, RefreshCw, Search, Settings, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { jobTtsEngineLabel } from "../lib/languages";
import { platformEligibility, platforms, publishedPlatformLabel } from "../lib/platforms";
import { fetchPublishingReadiness, SERVICE_URL } from "../lib/service";
import type { LocalJob, PublishingReadiness } from "../lib/types";
import { PlatformLogo } from "./common";

export function LibraryView({ onNewVideo, onOpenJob, onOpenSettings, setToast }: { onNewVideo: () => void; onOpenJob: (job: LocalJob) => void; onOpenSettings: () => void; setToast: (value: string) => void }) {
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
          <span><strong>{job.metadata?.title ?? job.request.prompt.slice(0, 70)}</strong><small>{job.metadata?.narrator ?? "Default narrator"} • {job.request.language} {jobTtsEngineLabel(job)} • {job.request.subtitleLanguage} captions</small><span className="library-platform-summary"><span><b>Eligible</b>{eligible.length ? eligible.map((platform) => <em key={platform.id} title={`${platform.label}: ready to upload`}><PlatformLogo platform={platform} /><span className="sr-only">{platform.label}</span></em>) : <i>None</i>}</span><span><b>Published</b>{published.length ? published.map(({ platform, label }) => <em className="published" key={platform.id} title={`${platform.label}: ${label}`}><PlatformLogo platform={platform} /><span>{label}</span></em>) : <i>None</i>}</span></span></span>
          <span className={`status-label ${job.state === "completed" ? "published" : job.state === "failed" || job.state === "stopped" ? "rendering" : "ready"}`}><i />{job.state === "running" ? `${job.progress}% ${job.message}` : job.state}</span>
          <span className="real-job-actions">
            <button onClick={() => onOpenJob(job)}>View details</button>
            {job.assets?.final && <a href={`${SERVICE_URL}${job.assets.final.downloadUrl}`} aria-label="Download final MP4"><Download size={14} /></a>}
            <button className="delete-video-button" onClick={() => deleteVideo(job)} disabled={deletingId === job.id || job.state === "running" || job.state === "queued"} title={job.state === "running" || job.state === "queued" ? "Wait for rendering to finish" : "Delete video and every local asset"}><Trash2 size={13} /> {deletingId === job.id ? "Deleting…" : "Delete"}</button>
          </span>
        </div>; })}
      </div>}
      {filteredJobs.length === 0 && <div className="empty-library"><Film size={28} /><strong>{query ? "No matching videos" : "Your video library is empty"}</strong><p>{query ? "Try a different search." : "Generate a new video package and it will appear here."}</p><button className="primary-small" onClick={onNewVideo}><Plus size={16} /> Create video</button></div>}
    </div>
  );
}
