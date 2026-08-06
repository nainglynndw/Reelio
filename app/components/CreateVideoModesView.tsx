"use client";

import {
  ArrowRight,
  Check,
  Clapperboard,
  FileSearch,
  Film,
  Link2,
  MessageSquareText,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  Trophy,
} from "lucide-react";
import { useEffect, useState } from "react";
import { serviceFetch, SERVICE_URL } from "../lib/service";

type ModePreview = { slot: string; label: string; title: string; url: string };
type ModePreviewInput = { kind: "prompt" | "url" | "upload"; label: string; value: string; url?: string };
type ModePreviewResponse = {
  concept?: string;
  inputs?: Record<string, ModePreviewInput | null>;
  modes?: Record<string, ModePreview[]>;
};

const videoModes = [
  {
    id: "message-conversation",
    name: "Message Conversation",
    eyebrow: "Available now",
    description: "Author a fictional phone conversation, control every message and pause, preview the exact webpage, then record it as a vertical story.",
    result: "One animated 9:16 conversation video with optional message sounds or character voices, thumbnail, transcript, captions, publishing copy, and reusable project data.",
    icon: MessagesSquare,
    available: true,
    outputCount: "1 conversation video",
  },
  {
    id: "prompt-video",
    name: "Prompt to Video",
    eyebrow: "Available now",
    description: "Start with an idea, then review the research-backed script, narrator, visual themes, and exact storyboard before rendering.",
    result: "One finished 9:16 narrated video with captions, thumbnail, clean master, transcript, and platform publishing copy.",
    icon: Sparkles,
    available: true,
    outputCount: "1 generated video",
  },
  {
    id: "long-video-shorts",
    name: "Long Video to Shorts",
    eyebrow: "Available now",
    description: "Upload a long recording or use an authorized public video source, review coherent moments selected with Gemini Flash-Lite, then choose narration and publishing treatment.",
    result: "Several complete video packages—each with an original editorial thumbnail title, a 1.5-second title-card opening, voice-over, translation, captions, clean master, transcript, Brand Kit treatment, publishing copy, and platform review.",
    icon: Film,
    available: true,
    outputCount: "4 generated shorts",
  },
  {
    id: "sports-highlights",
    name: "Sports Highlights",
    eyebrow: "Planned mode",
    description: "Use licensed match footage to assemble important moments, preserve the action, and add a selected narrator and publishing treatment.",
    result: "A paced highlight reel with approved events, narrator commentary, original-audio mixing, captions, and a social thumbnail.",
    icon: Trophy,
    available: false,
    outputCount: "1 generated highlight reel",
  },
  {
    id: "documentary-recap",
    name: "Documentary & Case Recap",
    eyebrow: "Planned mode",
    description: "Build a factual recap from reviewed articles, documents, or authorized media while keeping claims tied to their sources.",
    result: "A sourced documentary-style reel with an approved script, safe visuals, narration, captions, citations, and publishing copy.",
    icon: FileSearch,
    available: false,
    outputCount: "1 generated recap video",
  },
] as const;

export function CreateVideoModesView({ onOpenPromptVideo, onOpenLongVideo, onOpenMessageConversation }: { onOpenPromptVideo: () => void; onOpenLongVideo: () => void; onOpenMessageConversation: () => void }) {
  const [previews, setPreviews] = useState<ModePreviewResponse>({});

  useEffect(() => {
    let cancelled = false;
    serviceFetch(`${SERVICE_URL}/mode-previews`)
      .then((response) => response.json())
      .then((value: ModePreviewResponse) => { if (!cancelled) setPreviews(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="content-wrap create-video-modes-page">
      <div className="page-heading mode-page-heading">
        <div>
          <div className="eyebrow"><span /> CREATE VIDEO</div>
          <h1>Choose how you want to create.</h1>
          <p>Each mode starts from a different source and produces a clearly defined video package.</p>
        </div>
        <span className="mode-availability"><Check size={13} /> 3 modes available</span>
      </div>

      <section className="video-mode-grid" aria-label="Video creation modes">
        {videoModes.map((mode) => {
          const Icon = mode.icon;
          const modePreviews = previews.modes?.[mode.id] ?? [];
          const modeInput = previews.inputs?.[mode.id] ?? null;
          return (
            <article className={`video-mode-card ${mode.available ? "available" : "planned"}`} key={mode.id}>
              <header>
                <i><Icon size={22} /></i>
                <span className={mode.available ? "available" : ""}>{mode.eyebrow}</span>
              </header>
              <div className="video-mode-copy">
                <h2>{mode.name}</h2>
                <p>{mode.description}</p>
              </div>
              <div className="video-mode-result">
                <span><Clapperboard size={14} /> Expected result</span>
                <p>{mode.result}</p>
              </div>
              <div className={`mode-showcase-flow ${modePreviews.length ? "ready" : ""}`}>
                <section className="mode-showcase-input">
                  <header className="mode-showcase-stage">
                    <b>1</b>
                    <span><small>FROM</small><strong>{modeInput?.label ?? (mode.id === "long-video-shorts" ? "Source video" : mode.id === "message-conversation" ? "Conversation script" : "Creative brief")}</strong></span>
                    <i>{modeInput?.kind === "url" ? <Link2 size={17} /> : <MessageSquareText size={17} />}</i>
                  </header>
                  {modeInput ? <>
                    {modeInput.kind === "url" && modeInput.url
                      ? <a className="mode-showcase-source" href={modeInput.url} target="_blank" rel="noreferrer">
                        <span>Public YouTube source</span>
                        <strong>{modeInput.value}</strong>
                        <small>Open original source <ArrowRight size={12} /></small>
                      </a>
                      : <blockquote>{modeInput.value}</blockquote>}
                  </> : <div className="mode-showcase-empty">
                    <span>{mode.id === "long-video-shorts" ? "A long video URL or upload will appear here." : mode.id === "message-conversation" ? "The approved fictional conversation will appear here." : "The exact prompt or reviewed source will appear here."}</span>
                  </div>}
                </section>
                <div className="mode-showcase-connector" aria-hidden="true">
                  <span>GENERATES</span>
                  <ArrowRight size={17} />
                </div>
                <section className={`video-mode-preview ${modePreviews.length > 1 ? "multi" : "single"}`}>
                  <header className="mode-showcase-stage">
                    <b>2</b>
                    <span><small>TO</small><strong>{mode.outputCount}</strong></span>
                    <i><Film size={17} /></i>
                  </header>
                  {modePreviews.length ? <div>
                    {modePreviews.map((preview) => <figure key={preview.slot}>
                      <video src={`${SERVICE_URL}${preview.url}`} muted loop autoPlay playsInline preload="metadata" aria-label={`${mode.name}: ${preview.title || preview.label}`} />
                      <figcaption><span>{preview.label}</span>{preview.title && <strong>{preview.title}</strong>}</figcaption>
                    </figure>)}
                  </div> : <div className="mode-preview-pending"><Film size={18} /><span>{mode.available ? "Choose a finished result as this mode’s showcase" : "Showcase arrives with this mode"}</span></div>}
                </section>
              </div>
              {mode.available ? (
                <button onClick={mode.id === "long-video-shorts" ? onOpenLongVideo : mode.id === "message-conversation" ? onOpenMessageConversation : onOpenPromptVideo}>
                  Start {mode.name} <ArrowRight size={15} />
                </button>
              ) : (
                <button disabled><ShieldCheck size={14} /> Coming soon</button>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
