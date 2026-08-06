"use client";

import {
  AudioLines,
  Check,
  Clock3,
  Download,
  FileAudio,
  FileText,
  Film,
  Languages,
  Mic2,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Video,
  WandSparkles,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defaultTtsEngine, speechLanguages, ttsEngineOptions, voiceLanguages } from "../lib/languages";
import { narrators } from "../lib/narrators";
import { serviceFetch, SERVICE_URL } from "../lib/service";
import type { NarratorId, ToolJob, TtsEngine } from "../lib/types";

type ToolId = "chop" | "download-media" | "extract-audio" | "extract-subtitles" | "extract-web-captions" | "long-video-analyze" | "long-video-render" | "transcribe" | "translate" | "speech-synthesis" | "video-synthesis";
type InputKind = "video" | "audio" | "media" | "subtitles" | "analysis";
type ToolDefinition = {
  id: ToolId;
  name: string;
  short: string;
  description: string;
  inputs: Array<{ id: InputKind; label: string; accepts: string; artifactTypes: string[] }>;
  icon: React.ReactNode;
  aiLabel: string;
  aiKind: "none" | "local" | "cloud" | "mixed" | "utility";
};
type ToolHealth = {
  providers?: { gemini?: boolean; geminiTts?: boolean; openrouter?: boolean; kokoro?: boolean; voxcpm2?: boolean };
  stt?: { ready?: boolean; provider?: string; model?: string; error?: string | null };
  webMedia?: { ready?: boolean };
  tts?: { ready?: boolean };
  voxcpm2?: { ready?: boolean };
};
type AiRequirement = {
  kind: ToolDefinition["aiKind"];
  title: string;
  description: string;
  status: string;
  ready?: boolean;
  setupCommand?: string;
  settings?: boolean;
};

const tools: ToolDefinition[] = [
  { id: "chop", name: "Chop", short: "Split long videos", description: "Cut a long video into 3-minute clips with a 5-second overlap.", aiLabel: "No AI", aiKind: "none", icon: <Scissors size={20} />, inputs: [{ id: "video", label: "Long video", accepts: "video/*", artifactTypes: ["video"] }] },
  { id: "download-media", name: "Download video from link", short: "Video webpage to local file", description: "Paste a public video webpage or direct-media URL. Reelio detects the site and saves the video locally.", aiLabel: "No AI · setup", aiKind: "utility", icon: <Link2 size={20} />, inputs: [] },
  { id: "extract-audio", name: "Generate audio", short: "Extract a soundtrack", description: "Create a clean WAV or M4A audio file from any video.", aiLabel: "No AI", aiKind: "none", icon: <FileAudio size={20} />, inputs: [{ id: "video", label: "Video", accepts: "video/*", artifactTypes: ["video"] }] },
  { id: "extract-subtitles", name: "Extract subtitle track", short: "Embedded captions to SRT", description: "Copy an existing text subtitle track from a video without speech recognition.", aiLabel: "No AI", aiKind: "none", icon: <FileText size={20} />, inputs: [{ id: "video", label: "Video with subtitles", accepts: "video/*", artifactTypes: ["video"] }] },
  { id: "extract-web-captions", name: "Extract captions from link", short: "Existing web captions to SRT", description: "Save existing manual or automatic captions from a supported public link.", aiLabel: "No AI · setup", aiKind: "utility", icon: <FileText size={20} />, inputs: [] },
  { id: "long-video-analyze", name: "Find short highlights", short: "Long video to review plan", description: "Transcribe licensed footage and use Gemini Flash-Lite to find coherent candidate moments.", aiLabel: "Gemini AI", aiKind: "cloud", icon: <Sparkles size={20} />, inputs: [{ id: "media", label: "Long video", accepts: "video/*", artifactTypes: ["video"] }] },
  { id: "long-video-render", name: "Render reviewed shorts", short: "Highlight plan to vertical MP4s", description: "Render all selected candidates from a highlight analysis as captioned vertical videos.", aiLabel: "No AI", aiKind: "none", icon: <Film size={20} />, inputs: [
    { id: "media", label: "Long video", accepts: "video/*", artifactTypes: ["video"] },
    { id: "analysis", label: "Highlight analysis", accepts: ".json,application/json", artifactTypes: ["analysis"] },
  ] },
  { id: "transcribe", name: "Generate subtitle", short: "Speech to timed text", description: "Transcribe audio or video into an SRT file and plain transcript.", aiLabel: "AI transcription", aiKind: "mixed", icon: <FileText size={20} />, inputs: [{ id: "media", label: "Audio or video", accepts: "audio/*,video/*", artifactTypes: ["audio", "video"] }] },
  { id: "translate", name: "Translate", short: "Preserve subtitle timing", description: "Translate every subtitle cue into a selected language.", aiLabel: "API key", aiKind: "cloud", icon: <Languages size={20} />, inputs: [{ id: "subtitles", label: "SRT or VTT subtitles", accepts: ".srt,.vtt,text/vtt,application/x-subrip", artifactTypes: ["subtitles"] }] },
  { id: "speech-synthesis", name: "Speech synthesis", short: "Subtitles to narration", description: "Create timed speech using Kokoro, VoxCPM2, or Gemini.", aiLabel: "AI voice", aiKind: "mixed", icon: <Mic2 size={20} />, inputs: [{ id: "subtitles", label: "Translated subtitles", accepts: ".srt,.vtt,text/vtt,application/x-subrip", artifactTypes: ["subtitles"] }] },
  { id: "video-synthesis", name: "Video synthesis", short: "Build the language version", description: "Combine source video, translated audio, and translated subtitles.", aiLabel: "No AI", aiKind: "none", icon: <Video size={20} />, inputs: [
    { id: "video", label: "Source video", accepts: "video/*", artifactTypes: ["video"] },
    { id: "audio", label: "Translated audio", accepts: "audio/*", artifactTypes: ["audio"] },
    { id: "subtitles", label: "Translated subtitles", accepts: ".srt,.vtt,text/vtt,application/x-subrip", artifactTypes: ["subtitles"] },
  ] },
];

export function ToolsView({ authenticated, onRequireAuthentication, setToast, onOpenSettings }: {
  authenticated: boolean;
  onRequireAuthentication: () => boolean;
  setToast: (value: string) => void;
  onOpenSettings: () => void;
}) {
  const [selectedId, setSelectedId] = useState<ToolId>("chop");
  const [jobs, setJobs] = useState<ToolJob[]>([]);
  const [files, setFiles] = useState<Partial<Record<InputKind, File>>>({});
  const [artifactRefs, setArtifactRefs] = useState<Partial<Record<InputKind, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [health, setHealth] = useState<ToolHealth | null>(null);
  const [clipSeconds, setClipSeconds] = useState("180");
  const [overlapSeconds, setOverlapSeconds] = useState("5");
  const [mediaUrl, setMediaUrl] = useState("");
  const [captionUrl, setCaptionUrl] = useState("");
  const [captionLanguage, setCaptionLanguage] = useState("en");
  const [subtitleTrack, setSubtitleTrack] = useState("1");
  const [audioFormat, setAudioFormat] = useState("wav");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [targetLanguage, setTargetLanguage] = useState("Thai");
  const [speechLanguage, setSpeechLanguage] = useState("English");
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>("kokoro");
  const [narratorId, setNarratorId] = useState<NarratorId>("maya");
  const [speechSpeed, setSpeechSpeed] = useState("1.1");
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [applyBrandKit, setApplyBrandKit] = useState(true);
  const [longRightsConfirmed, setLongRightsConfirmed] = useState(false);
  const [longCloudConsent, setLongCloudConsent] = useState(false);
  const [longMaxClips, setLongMaxClips] = useState("5");
  const [longMinSeconds, setLongMinSeconds] = useState("25");
  const [longMaxSeconds, setLongMaxSeconds] = useState("60");
  const [longCaptions, setLongCaptions] = useState(true);
  const [longMirror, setLongMirror] = useState(false);
  const [longTransitions, setLongTransitions] = useState(false);
  const [longRemixConfirmed, setLongRemixConfirmed] = useState(false);
  const selected = tools.find((tool) => tool.id === selectedId)!;
  const aiRequirement = toolAiRequirement(selectedId, ttsEngine, health);
  const runUnavailable = aiRequirement.ready === false;

  const refreshJobs = async () => {
    if (!authenticated) return void onRequireAuthentication();
    try {
      const response = await serviceFetch(`${SERVICE_URL}/tool-jobs`);
      const result = await response.json() as { jobs?: ToolJob[] };
      if (response.ok) setJobs(result.jobs ?? []);
    } catch {}
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => serviceFetch(`${SERVICE_URL}/tool-jobs`).then((response) => response.json()).then((result: { jobs?: ToolJob[] }) => {
      if (!cancelled) setJobs(result.jobs ?? []);
    }).catch(() => {});
    const loadHealth = () => serviceFetch(`${SERVICE_URL}/health`).then((response) => response.json()).then((result: ToolHealth) => {
      if (!cancelled) setHealth(result);
    }).catch(() => {});
    const kickoff = authenticated ? window.setTimeout(load, 0) : undefined;
    const healthKickoff = window.setTimeout(loadHealth, 0);
    const timer = authenticated ? window.setInterval(load, 1200) : undefined;
    const clear = !authenticated ? window.setTimeout(() => setJobs([]), 0) : undefined;
    return () => {
      cancelled = true;
      if (kickoff !== undefined) window.clearTimeout(kickoff);
      window.clearTimeout(healthKickoff);
      if (timer !== undefined) window.clearInterval(timer);
      if (clear !== undefined) window.clearTimeout(clear);
    };
  }, [authenticated]);

  function selectTool(toolId: ToolId) {
    setSelectedId(toolId);
    setFiles({});
    setArtifactRefs({});
    setLongRightsConfirmed(false);
    setLongCloudConsent(false);
    setLongRemixConfirmed(false);
  }

  const reusableAssets = useMemo(() => jobs.flatMap((job) => job.state === "completed" && job.assets
    ? Object.entries(job.assets).map(([key, asset]) => ({ job, key, asset }))
    : []), [jobs]);

  function chooseFile(input: InputKind, file?: File) {
    setFiles((current) => ({ ...current, [input]: file }));
    if (file) setArtifactRefs((current) => ({ ...current, [input]: "" }));
  }

  function chooseArtifact(input: InputKind, value: string) {
    setArtifactRefs((current) => ({ ...current, [input]: value }));
    if (value) setFiles((current) => ({ ...current, [input]: undefined }));
  }

  async function runTool() {
    if (!authenticated) return void onRequireAuthentication();
    setSubmitting(true);
    try {
      const inputs: Record<string, { uploadId?: string; toolJobId?: string; assetKey?: string }> = {};
      for (const input of selected.inputs) {
        const file = files[input.id];
        const artifact = artifactRefs[input.id];
        if (file) {
          const response = await serviceFetch(`${SERVICE_URL}/tool-inputs`, {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
            body: file,
          });
          const result = await response.json() as { input?: { id: string }; error?: string };
          if (!response.ok || !result.input) throw new Error(result.error ?? `${input.label} could not be uploaded`);
          inputs[input.id] = { uploadId: result.input.id };
        } else if (artifact) {
          const [toolJobId, assetKey] = artifact.split("::");
          inputs[input.id] = { toolJobId, assetKey };
        } else {
          throw new Error(`Choose ${input.label.toLowerCase()}.`);
        }
      }
      const response = await serviceFetch(`${SERVICE_URL}/tool-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: selected.id, inputs, options: toolOptions(selected.id) }),
      });
      const result = await response.json() as { job?: ToolJob; error?: string };
      if (!response.ok || !result.job) throw new Error(result.error ?? "Tool job could not be created");
      setJobs((current) => [result.job!, ...current.filter((job) => job.id !== result.job!.id)]);
      setFiles({});
      setArtifactRefs({});
      setToast(`${selected.name} added to the queue`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Tool job could not be created");
    } finally {
      setSubmitting(false);
    }
  }

  function toolOptions(toolId: ToolId) {
    if (toolId === "chop") return { clipSeconds: Number(clipSeconds), overlapSeconds: Number(overlapSeconds) };
    if (toolId === "download-media") return { url: mediaUrl };
    if (toolId === "extract-audio") return { format: audioFormat };
    if (toolId === "extract-subtitles") return { trackIndex: Math.max(0, Number(subtitleTrack) - 1) };
    if (toolId === "extract-web-captions") return { url: captionUrl, language: captionLanguage };
    if (toolId === "long-video-analyze") return { rightsConfirmed: longRightsConfirmed, cloudConsent: longCloudConsent, sourceLanguage, maxClips: Number(longMaxClips), minClipSeconds: Number(longMinSeconds), maxClipSeconds: Number(longMaxSeconds) };
    if (toolId === "long-video-render") return { rightsConfirmed: longRightsConfirmed, remixConfirmed: longRemixConfirmed, captions: longCaptions, mirror: longMirror, transitions: longTransitions, applyBrandKit };
    if (toolId === "transcribe") return { sourceLanguage };
    if (toolId === "translate") return { targetLanguage };
    if (toolId === "speech-synthesis") return { language: speechLanguage, ttsEngine, narratorId, speed: Number(speechSpeed) };
    return { burnSubtitles, applyBrandKit };
  }

  async function jobAction(job: ToolJob, action: "stop" | "retry" | "delete") {
    if (!authenticated) return void onRequireAuthentication();
    try {
      const response = await serviceFetch(`${SERVICE_URL}/tool-jobs/${job.id}${action === "retry" ? "/retry" : action === "stop" ? "/stop" : ""}`, { method: action === "delete" ? "DELETE" : "POST" });
      const result = await response.json() as { job?: ToolJob; error?: string };
      if (!response.ok) throw new Error(result.error ?? `Could not ${action} tool job`);
      if (action === "delete") setJobs((current) => current.filter((item) => item.id !== job.id));
      else if (result.job) setJobs((current) => current.map((item) => item.id === job.id ? result.job! : item));
      setToast(action === "retry" ? "Tool job queued again" : action === "stop" ? (result.job?.state === "running" ? "Stopping tool job…" : "Tool job stopped") : "Tool job removed");
    } catch (error) {
      setToast(error instanceof Error ? error.message : `Could not ${action} tool job`);
    }
  }

  function changeSpeechLanguage(language: string) {
    setSpeechLanguage(language);
    setTtsEngine(defaultTtsEngine(language));
  }

  return (
    <div className="content-wrap tools-page">
      <div className="page-heading">
        <div><div className="eyebrow"><span /> MODULAR WORKFLOW</div><h1>Use exactly the tool you need.</h1><p>Run several jobs, reuse their outputs, or build a complete language-version chain.</p></div>
        <div className="tool-queue-summary"><span><i className="running" />{jobs.filter((job) => job.state === "running").length} running</span><span><i />{jobs.filter((job) => job.state === "queued").length} queued</span></div>
      </div>

      <div className="tools-layout">
        <section className="tool-catalog">
          <div className="tools-section-heading"><strong>Tools</strong><small>Choose one function</small></div>
          <div className="tool-card-grid">{tools.map((tool, index) => <button key={tool.id} className={`tool-card ${selectedId === tool.id ? "selected" : ""}`} aria-current={selectedId === tool.id ? "true" : undefined} onClick={() => selectTool(tool.id)}>
            <span className="tool-card-number">{String(index + 1).padStart(2, "0")}</span><i>{tool.icon}</i><span><strong>{tool.name}</strong><small>{tool.short}<b className={`tool-ai-label ${tool.aiKind}`}>{tool.aiLabel}</b></small></span>
          </button>)}</div>
        </section>

        <section className="tool-runner-card">
          <header><i>{selected.icon}</i><div><strong>{selected.name}</strong><span>{selected.description}</span></div></header>
          <div className="tool-input-stack">{selected.inputs.map((input) => {
            const available = reusableAssets.filter(({ asset }) => input.artifactTypes.includes(asset.type ?? ""));
            const file = files[input.id];
            return <div className="tool-input-card" key={input.id}>
              <label><span><Upload size={15} /><strong>{input.label}</strong></span><input type="file" accept={input.accepts} onChange={(event) => chooseFile(input.id, event.target.files?.[0])} /><em>{file ? file.name : "Choose file"}</em></label>
              {available.length > 0 && <div className="artifact-picker"><span>or reuse an output</span><select value={artifactRefs[input.id] ?? ""} onChange={(event) => chooseArtifact(input.id, event.target.value)}><option value="">Select previous output…</option>{available.map(({ job, key, asset }) => <option key={`${job.id}-${key}`} value={`${job.id}::${key}`}>{toolName(job.request.toolId)} · {asset.name}</option>)}</select></div>}
            </div>;
          })}</div>

          <div className="tool-options">
            {selectedId === "chop" && <><OptionNumber label="Clip length" suffix="seconds" value={clipSeconds} setValue={setClipSeconds} min="10" max="180" /><OptionNumber label="Overlap" suffix="seconds" value={overlapSeconds} setValue={setOverlapSeconds} min="0" max="30" /></>}
            {selectedId === "download-media" && <><OptionText label="Video webpage or media link" value={mediaUrl} setValue={setMediaUrl} placeholder="Paste a YouTube, Facebook, Vimeo, TikTok, X, Instagram, or media URL" type="url" /><LinkToolNote text="The link can be a normal video webpage; it does not need to point directly to an MP4. Public, non-DRM sources supported by the installed extractor work without platform OAuth. Use only media you have permission to save." /></>}
            {selectedId === "extract-audio" && <OptionSelect label="Output format" value={audioFormat} setValue={setAudioFormat} options={[["wav", "WAV · editing quality"], ["m4a", "M4A · compact"]]} />}
            {selectedId === "extract-subtitles" && <OptionNumber label="Subtitle track" suffix="track number" value={subtitleTrack} setValue={setSubtitleTrack} min="1" max="32" />}
            {selectedId === "extract-web-captions" && <><OptionText label="Video webpage or media link" value={captionUrl} setValue={setCaptionUrl} placeholder="Paste a supported video webpage URL" type="url" /><OptionText label="Caption language code" value={captionLanguage} setValue={setCaptionLanguage} placeholder="en, my, th…" /><LinkToolNote text="The extractor opens the webpage and saves captions already exposed by that site. It does not require a direct file URL, transcribe audio, or load an ML model." /></>}
            {selectedId === "long-video-analyze" && <><OptionSelect label="Speech language" value={sourceLanguage} setValue={setSourceLanguage} options={[["auto", "Auto detect"], ...speechLanguages.map((language) => [language, language])]} /><OptionNumber label="Candidates" suffix="clips" value={longMaxClips} setValue={setLongMaxClips} min="1" max="10" /><OptionNumber label="Minimum length" suffix="seconds" value={longMinSeconds} setValue={setLongMinSeconds} min="15" max="60" /><OptionNumber label="Maximum length" suffix="seconds" value={longMaxSeconds} setValue={setLongMaxSeconds} min="30" max="120" /><ToolCheck checked={longRightsConfirmed} setChecked={setLongRightsConfirmed} title="I own or am licensed to use this source" detail="Required before source analysis." /><ToolCheck checked={longCloudConsent} setChecked={setLongCloudConsent} title="I consent to Gemini cloud processing" detail="Audio may be sent for transcription; timed text is sent for highlight selection." /></>}
            {selectedId === "long-video-render" && <><ToolCheck checked={longRightsConfirmed} setChecked={setLongRightsConfirmed} title="I own or am licensed to use this source" detail="Required before rendering." /><ToolCheck checked={longCaptions} setChecked={setLongCaptions} title="Burn captions into each short" detail="Uses the source-aligned transcript." /><ToolCheck checked={applyBrandKit} setChecked={setApplyBrandKit} title="Apply active Brand Kit" detail="Uses the saved production preset." /><ToolCheck checked={longMirror} setChecked={setLongMirror} title="Mirror the picture" detail="Optional composition choice; not a policy workaround." /><ToolCheck checked={longTransitions} setChecked={setLongTransitions} title="Add fade transitions" detail="Adds brief opening and closing fades." />{(longMirror || longTransitions) && <ToolCheck checked={longRemixConfirmed} setChecked={setLongRemixConfirmed} title="I approve the creative remix edits" detail="These edits do not create rights or policy compliance." />}</>}
            {selectedId === "transcribe" && <OptionSelect label="Speech language" value={sourceLanguage} setValue={setSourceLanguage} options={[["auto", "Auto detect"], ...speechLanguages.map((language) => [language, language])]} />}
            {selectedId === "translate" && <OptionSelect label="Translate to" value={targetLanguage} setValue={setTargetLanguage} options={voiceLanguages.map((language) => [language, language])} />}
            {selectedId === "speech-synthesis" && <><OptionSelect label="Speech language" value={speechLanguage} setValue={changeSpeechLanguage} options={speechLanguages.map((language) => [language, language])} /><OptionSelect label="Voice engine" value={ttsEngine} setValue={(value) => setTtsEngine(value as TtsEngine)} options={ttsEngineOptions(speechLanguage).map((option) => typeof option === "string" ? [option, option] : [option.value, option.label])} /><OptionSelect label="Narrator" value={narratorId} setValue={(value) => setNarratorId(value as NarratorId)} options={narrators.map((narrator) => [narrator.id, `${narrator.name} · ${narrator.role}`])} /><OptionNumber label="Speech speed" suffix="×" value={speechSpeed} setValue={setSpeechSpeed} min="0.8" max="1.4" step="0.05" /></>}
            {selectedId === "video-synthesis" && <><label className="tool-check-option"><button type="button" className={burnSubtitles ? "checked" : ""} onClick={() => setBurnSubtitles((value) => !value)}>{burnSubtitles && <Check size={12} />}</button><span><strong>Burn subtitles into video</strong><small>Creates a ready-to-share MP4 with visible captions.</small></span></label><label className="tool-check-option"><button type="button" className={applyBrandKit ? "checked" : ""} onClick={() => setApplyBrandKit((value) => !value)}>{applyBrandKit && <Check size={12} />}</button><span><strong>Apply active Brand Kit</strong><small>Adds saved style, logo, intro, outro, and background music.</small></span></label></>}
          </div>

          {aiRequirement.kind !== "none" && <div className={`tool-ai-notice ${aiRequirement.kind} ${runUnavailable ? "missing" : ""}`} title={aiRequirement.description}>
            <span><i /> <strong>{aiRequirement.title}</strong></span>
            {aiRequirement.setupCommand && <code>{aiRequirement.setupCommand}</code>}
            <em className={aiRequirement.ready ? "ready" : aiRequirement.ready === false ? "missing" : ""}>{aiRequirement.status}</em>
            {aiRequirement.settings && <button onClick={onOpenSettings}>Settings</button>}
          </div>}

          <button className="run-tool-button" onClick={runTool} disabled={submitting || runUnavailable}>{submitting ? <RefreshCw className="spin" size={17} /> : <WandSparkles size={17} />}{submitting ? "Uploading inputs…" : runUnavailable ? "Setup required before running" : `Run ${selected.name}`}</button>
          <p className="tool-runner-note"><Sparkles size={13} /> New jobs queue immediately. Media jobs can run together; local AI jobs run one at a time to protect memory.</p>
        </section>
      </div>

      <section className="tool-jobs-section">
        <div className="tools-section-heading"><strong>Tool jobs</strong><small>{jobs.length ? "Live queue and reusable outputs" : "Your modular outputs will appear here"}</small><button onClick={() => void refreshJobs()}><RefreshCw size={13} /> Refresh</button></div>
        {jobs.length ? <div className="tool-job-list">{jobs.map((job) => <ToolJobRow key={job.id} job={job} onAction={jobAction} />)}</div> : <div className="tools-empty"><AudioLines size={24} /><strong>No tool jobs yet</strong><span>Choose a tool, add its inputs, and run it.</span></div>}
      </section>
    </div>
  );
}

function ToolJobRow({ job, onAction }: { job: ToolJob; onAction: (job: ToolJob, action: "stop" | "retry" | "delete") => void }) {
  const icon = job.request.toolId === "chop" ? <Scissors size={16} /> : job.request.toolId === "download-media" ? <Link2 size={16} /> : job.request.toolId === "extract-audio" || job.request.toolId === "speech-synthesis" ? <FileAudio size={16} /> : ["translate", "transcribe", "extract-subtitles", "extract-web-captions"].includes(job.request.toolId) ? <FileText size={16} /> : <Film size={16} />;
  const active = job.state === "running" || job.state === "queued";
  return <article className={`tool-job-row ${job.state}`}>
    <i className="tool-job-icon">{icon}</i>
    <div className="tool-job-copy"><span><strong>{toolName(job.request.toolId)}</strong><em className={job.state}>{job.state}</em></span><small>{job.error ?? job.message}</small>{job.state === "running" && <div className="tool-job-progress"><span style={{ width: `${job.progress}%` }} /><b>{job.progress}%</b></div>}</div>
    <div className="tool-job-assets">{job.assets ? Object.entries(job.assets).map(([key, asset]) => <a key={key} href={`${SERVICE_URL}${asset.downloadUrl}`}><Download size={12} />{asset.name}</a>) : <span><Clock3 size={12} /> {active ? "Output pending" : "No output"}</span>}</div>
    <div className="tool-job-actions">{active ? <button onClick={() => onAction(job, "stop")}><Square size={11} /> Stop</button> : <>{(job.state === "failed" || job.state === "stopped") && <button onClick={() => onAction(job, "retry")}><RefreshCw size={11} /> Retry</button>}<button className="delete" onClick={() => onAction(job, "delete")}><Trash2 size={11} /></button></>}</div>
  </article>;
}

function OptionNumber({ label, suffix, value, setValue, min, max, step = "1" }: { label: string; suffix: string; value: string; setValue: (value: string) => void; min: string; max: string; step?: string }) {
  return <label className="tool-option"><span>{label}</span><div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => setValue(event.target.value)} /><em>{suffix}</em></div></label>;
}

function OptionSelect({ label, value, setValue, options }: { label: string; value: string; setValue: (value: string) => void; options: string[][] }) {
  return <label className="tool-option"><span>{label}</span><select value={value} onChange={(event) => setValue(event.target.value)}>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></label>;
}

function OptionText({ label, value, setValue, placeholder, type = "text" }: { label: string; value: string; setValue: (value: string) => void; placeholder: string; type?: "text" | "url" }) {
  return <label className="tool-option tool-option-text"><span>{label}</span><input type={type} value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} /></label>;
}

function LinkToolNote({ text }: { text: string }) {
  return <div className="tool-link-note"><Link2 size={13} /><span>{text}</span></div>;
}

function ToolCheck({ checked, setChecked, title, detail }: { checked: boolean; setChecked: (value: boolean) => void; title: string; detail: string }) {
  return <label className="tool-check-option"><button type="button" className={checked ? "checked" : ""} onClick={() => setChecked(!checked)}>{checked && <Check size={12} />}</button><span><strong>{title}</strong><small>{detail}</small></span></label>;
}

function toolName(id: string) {
  return tools.find((tool) => tool.id === id)?.name ?? id;
}

function toolAiRequirement(toolId: ToolId, ttsEngine: TtsEngine, health: ToolHealth | null): AiRequirement {
  if (toolId === "download-media" || toolId === "extract-web-captions") {
    const ready = health ? Boolean(health.webMedia?.ready) : undefined;
    return {
      kind: "utility",
      title: "Local link utility · no AI or API key",
      description: "Uses the locally installed downloader. No ML model or platform OAuth is used.",
      status: ready === undefined ? "Checking setup…" : ready ? "Ready" : "Not installed",
      ready,
      setupCommand: ready === false ? "npm run webmedia:setup" : undefined,
    };
  }
  if (toolId === "transcribe") {
    const ready = health ? Boolean(health.stt?.ready) : undefined;
    const local = health?.stt?.provider === "faster-whisper";
    return {
      kind: local ? "local" : "cloud",
      title: local ? "Local AI · audio stays on this Mac" : "Gemini cloud transcription · audio sent to Google",
      description: local
        ? "Uses faster-whisper on this Mac. Your audio stays local."
        : `Uses ${health?.stt?.model ?? "Gemini Flash-Lite"} on a normalized audio-only copy. The remote file is deleted after transcription.`,
      status: ready === undefined ? "Checking setup…" : ready ? (local ? "Model ready" : "Gemini connected") : (local ? "Not installed" : "Gemini key missing"),
      ready,
      setupCommand: local && ready === false ? "npm run stt:setup" : undefined,
      settings: !local,
    };
  }
  if (toolId === "long-video-analyze") {
    const ready = health ? Boolean(health.providers?.gemini) : undefined;
    return {
      kind: "cloud",
      title: "Gemini Flash-Lite · audio or transcript sent to Google",
      description: "Existing captions are preferred. Without captions, Gemini transcribes a compressed audio copy before analyzing the timed transcript.",
      status: ready === undefined ? "Checking key…" : ready ? "Gemini connected" : "Gemini key missing",
      ready,
      settings: true,
    };
  }
  if (toolId === "translate") {
    const ready = health ? Boolean(health.providers?.gemini || health.providers?.openrouter) : undefined;
    return {
      kind: "cloud",
      title: "Cloud AI · text sent to provider",
      description: "Uses Gemini or OpenRouter. Subtitle text is sent to the selected cloud provider.",
      status: ready === undefined ? "Checking key…" : ready ? "Provider connected" : "API key missing",
      ready,
      settings: true,
    };
  }
  if (toolId === "speech-synthesis" && ttsEngine === "gemini") {
    const ready = health ? Boolean(health.providers?.geminiTts) : undefined;
    return {
      kind: "cloud",
      title: "Gemini cloud AI · text sent to Google",
      description: "Subtitle text is sent to Google Gemini to generate speech.",
      status: ready === undefined ? "Checking key…" : ready ? "Gemini connected" : "Gemini key missing",
      ready,
      settings: true,
    };
  }
  if (toolId === "speech-synthesis") {
    const kokoro = ttsEngine === "kokoro";
    const ready = health ? Boolean(kokoro ? health.tts?.ready : health.voxcpm2?.ready) : undefined;
    return {
      kind: "local",
      title: `${kokoro ? "Kokoro" : "VoxCPM2"} local AI · stays on this Mac`,
      description: "Speech is generated on this Mac and subtitle text stays local.",
      status: ready === undefined ? "Checking setup…" : ready ? "Model ready" : "Setup required",
      ready,
      setupCommand: ready === false ? `npm run ${kokoro ? "kokoro" : "voxcpm2"}:setup` : undefined,
    };
  }
  return {
    kind: "none",
    title: "No AI or API key",
    description: "Runs locally with FFmpeg. Your media stays on this Mac.",
    status: "Ready",
    ready: true,
  };
}
