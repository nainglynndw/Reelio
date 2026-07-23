"use client";

import {
  Bot,
  Check,
  ChevronRight,
  Clock3,
  CloudUpload,
  Download,
  Film,
  Languages,
  Lightbulb,
  MessageSquareText,
  Mic2,
  Newspaper,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { speechLanguages, ttsEngineOptions, voiceLanguages } from "../lib/languages";
import { platforms } from "../lib/platforms";
import { SERVICE_URL } from "../lib/service";
import type { LocalJob, TtsEngine } from "../lib/types";
import { PlatformLogo, SelectField } from "./common";

export const workflowSteps = [
  "Writing retention-first script",
  "Generating voice, caption timing & music",
  "Finding licensed stock clips",
  "Rendering platform-ready versions",
];

// Shown when the brief is empty. The script writer treats this text as the fact source, so the
// placeholder nudges users toward a specific, structured brief for a more accurate video.
const DESCRIPTION_PLACEHOLDER = `What should this video cover? Be specific — the AI only states facts you provide or safe general knowledge.

• Topic & angle (plus the hook)
• Key facts or points to include
• The takeaway for viewers

Example: How 3I/ATLAS — an interstellar comet found in 2025 — was discovered, why its path is hyperbolic, and what it reveals about other star systems.`;

export function CreateView(props: {
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
  ideaFocus: string;
  setIdeaFocus: (value: string) => void;
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
              placeholder={DESCRIPTION_PLACEHOLDER}
              maxLength={700}
            />
            <div className="prompt-footer">
              <span>{props.prompt.length}/700</span>
            </div>
          </div>

          <section className="idea-helper">
            <div className="idea-helper-head">
              <Lightbulb size={15} />
              <strong>Need an idea?</strong>
              <small>Give AI a topic and it writes the brief above — or leave blank to use your Topic lane.</small>
            </div>
            <div className="idea-helper-row">
              <label className="idea-helper-input">
                <Sparkles size={15} />
                <input
                  aria-label="Specific topic for AI"
                  value={props.ideaFocus}
                  onChange={(event) => props.setIdeaFocus(event.target.value)}
                  placeholder="Optional topic — e.g. why the sky is blue"
                  maxLength={200}
                />
              </label>
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
          </section>

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
