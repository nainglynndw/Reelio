"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clapperboard,
  Clock3,
  FileText,
  Film,
  Languages,
  Lightbulb,
  Mic2,
  Newspaper,
  Pencil,
  RefreshCw,
  Settings,
  Sparkles,
  Upload,
  Volume2,
  WandSparkles,
  Zap,
} from "lucide-react";
import { useRef, useState } from "react";
import { speechLanguages, ttsEngineOptions, voiceLanguages } from "../lib/languages";
import { narrators } from "../lib/narrators";
import { platforms } from "../lib/platforms";
import { scriptStyles } from "../lib/script-styles";
import { SERVICE_URL } from "../lib/service";
import type { LocalJob, NarratorId, ScriptStyle, TtsEngine, VisualCandidate, VisualSelection, VisualTheme } from "../lib/types";
import { PlatformLogo, SelectField } from "./common";

const guidedSteps = [
  { label: "Brief", detail: "Topic and direction" },
  { label: "Script", detail: "Generate and approve" },
  { label: "Production", detail: "Voice and captions" },
  { label: "Review", detail: "Confirm and create" },
];

export function GuidedCreateView(props: {
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
  suggestIdea: () => void | Promise<void>;
  newsLoading: boolean;
  getLatestNews: () => void | Promise<void>;
  generating: boolean;
  stoppingGeneration: boolean;
  renderProgress: number;
  renderMessage: string;
  completedJob: LocalJob | null;
  startGeneration: (approvedScript?: string, visualThemes?: VisualTheme[], visualSelections?: VisualSelection[], scriptStyle?: ScriptStyle, narratorId?: NarratorId) => void | Promise<void>;
  stopGeneration: () => void | Promise<void>;
  openJob: (job: LocalJob) => void;
  onCreateAnother: () => void;
  onOpenSettings: () => void;
  setToast: (value: string) => void;
  defaultNarratorId: NarratorId;
}) {
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [script, setScript] = useState("");
  const [scriptStyle, setScriptStyle] = useState<ScriptStyle>("clear-explainer");
  const [narratorId, setNarratorId] = useState<NarratorId>(props.defaultNarratorId);
  const [voicePreviewText, setVoicePreviewText] = useState("");
  const [voicePreviews, setVoicePreviews] = useState<Array<{
    url: string;
    cached: boolean;
    usesApi: boolean;
    provider: string;
    narrator: string;
    narratorId: NarratorId;
    language: string;
    ttsEngine: TtsEngine;
    text: string;
  }>>([]);
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false);
  const [voicePreviewTranslating, setVoicePreviewTranslating] = useState(false);
  const [confirmPreviewTranslation, setConfirmPreviewTranslation] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [scriptMode, setScriptMode] = useState<"ai" | "studio" | null>(null);
  const [manualEditorOpen, setManualEditorOpen] = useState(false);
  const [pendingBriefAction, setPendingBriefAction] = useState<"idea" | "news" | null>(null);
  const [visualThemes, setVisualThemes] = useState<VisualTheme[]>([]);
  const [visualThemeMode, setVisualThemeMode] = useState<"ai" | "studio" | null>(null);
  const [generatingThemes, setGeneratingThemes] = useState(false);
  const [visualCandidates, setVisualCandidates] = useState<Record<number, VisualCandidate[]>>({});
  const [visualSelections, setVisualSelections] = useState<VisualSelection[]>([]);
  const [customVideoPreviews, setCustomVideoPreviews] = useState<Record<number, { url: string; name: string }>>({});
  const [customVideoAssets, setCustomVideoAssets] = useState<Record<number, { uploadId: string; fileName: string }>>({});
  const [customVideoUploading, setCustomVideoUploading] = useState<Record<number, boolean>>({});
  const [storyboardLoading, setStoryboardLoading] = useState(false);
  const [storyboardSearched, setStoryboardSearched] = useState(false);
  const [stockProviders, setStockProviders] = useState<Record<string, { configured: boolean; available: boolean; returned: boolean }>>({});
  const stockSearchPageRef = useRef(1);
  const scriptWords = script.trim() ? script.trim().split(/\s+/).length : 0;
  const minimumWords = minimumGuidedWords(props.duration);
  const briefReady = props.prompt.trim().length >= 3;
  const aiTopicReady = props.ideaFocus.trim().length >= 3;
  const scriptReady = scriptWords >= minimumWords;
  const productionSettingsReady = Boolean(
    props.language
    && props.subtitleLanguage
    && ttsEngineOptions(props.language).some((option) => option.value === props.ttsEngine)
  );
  const themesReady = visualThemesReady(visualThemes);
  const storyboardReady = themesReady
    && visualSelections.length === visualThemes.length
    && visualThemes.every((_, themeIndex) => visualSelections.some((selection) => selection.themeIndex === themeIndex));
  const selectedPexelsCount = visualSelections.filter((selection) => selection.mode === "media" && (selection.provider ?? "pexels") === "pexels").length;
  const selectedPixabayCount = visualSelections.filter((selection) => selection.mode === "media" && selection.provider === "pixabay").length;
  const selectedCustomCount = visualSelections.filter((selection) => selection.mode === "custom").length;
  const selectedMotionCount = visualSelections.filter((selection) => selection.mode === "motion").length;
  const stockConfigured = Object.values(stockProviders).some((provider) => provider.configured);
  const stockAvailable = Object.values(stockProviders).some((provider) => provider.available);
  const failedStockProviders = Object.entries(stockProviders).filter(([, status]) => status.configured && !status.available).map(([provider]) => provider === "pixabay" ? "Pixabay" : "Pexels");
  const selectedScriptStyle = scriptStyles.find((option) => option.id === scriptStyle) ?? scriptStyles[0];
  const selectedNarrator = narrators.find((narrator) => narrator.id === narratorId) ?? narrators[0];
  const approvedPreviewLine = firstVoicePreviewSentence(script);
  const effectivePreviewText = props.language === "English" ? approvedPreviewLine : voicePreviewText.trim();
  const voicePreview = voicePreviews.find((preview) =>
    preview.narratorId === narratorId
    && preview.language === props.language
    && preview.ttsEngine === props.ttsEngine
    && preview.text === effectivePreviewText
  ) ?? null;
  const productionReady = productionSettingsReady && Boolean(selectedNarrator) && themesReady && storyboardReady;

  function clearVoicePreview(clearTranslatedText = false) {
    setConfirmPreviewTranslation(false);
    if (clearTranslatedText) setVoicePreviewText("");
  }

  function changeSpeechLanguage(value: string) {
    props.setLanguage(value);
    clearVoicePreview(true);
  }

  function changeVoiceEngine(value: string) {
    props.setTtsEngine(value);
    clearVoicePreview();
  }

  function changeNarrator(value: NarratorId) {
    setNarratorId(value);
    clearVoicePreview();
  }

  function clearStoryboard() {
    stockSearchPageRef.current = 1;
    setVisualCandidates({});
    setVisualSelections([]);
    setCustomVideoPreviews((current) => {
      Object.values(current).forEach((preview) => URL.revokeObjectURL(preview.url));
      return {};
    });
    setCustomVideoAssets({});
    setCustomVideoUploading({});
    setStoryboardLoading(false);
    setStoryboardSearched(false);
    setStockProviders({});
  }

  function changeScriptStyle(value: ScriptStyle) {
    if (value === scriptStyle) return;
    setScriptStyle(value);
    if (!script && !visualThemes.length) return;
    setScript("");
    clearVoicePreview(true);
    setScriptMode(null);
    setManualEditorOpen(false);
    setVisualThemes([]);
    setVisualThemeMode(null);
    clearStoryboard();
    setFurthestStep(1);
    const selected = scriptStyles.find((option) => option.id === value);
    props.setToast(`${selected?.label ?? "Script style"} selected — generate a new script`);
  }

  function moveTo(next: number) {
    if (next > step) {
      const prerequisites = [
        briefReady ? null : "Add a clear video brief before continuing",
        scriptReady ? null : `The ${props.duration} script needs at least ${minimumWords} words`,
        !productionSettingsReady
          ? "Choose a speech language, compatible voice engine, and subtitle language"
          : !themesReady
            ? "Generate themes with AI or open the local storyboard before continuing"
            : storyboardReady ? null : "Choose stock footage, your own video, or a motion background for every visual theme",
      ];
      const firstInvalidStep = prerequisites.slice(0, next).findIndex(Boolean);
      if (firstInvalidStep >= 0) {
        props.setToast(prerequisites[firstInvalidStep]!);
        setStep(firstInvalidStep);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
    }
    setStep(next);
    setFurthestStep((current) => Math.max(current, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updatePrompt(value: string) {
    props.setPrompt(value);
    setScript("");
    clearVoicePreview(true);
    setScriptMode(null);
    setManualEditorOpen(false);
    setVisualThemes([]);
    setVisualThemeMode(null);
    clearStoryboard();
    setFurthestStep(0);
  }

  function continueFromBrief() {
    moveTo(1);
  }

  function prepareBriefAction(action: "idea" | "news") {
    if (!aiTopicReady) {
      props.setToast("Enter a specific AI topic first");
      document.getElementById("guided-ai-topic")?.focus();
      return;
    }
    setPendingBriefAction(action);
  }

  function confirmBriefAction() {
    const action = pendingBriefAction;
    if (!action) return;
    setPendingBriefAction(null);
    setScript("");
    clearVoicePreview(true);
    setScriptMode(null);
    setManualEditorOpen(false);
    setVisualThemes([]);
    setVisualThemeMode(null);
    clearStoryboard();
    setFurthestStep(0);
    if (action === "idea") void props.suggestIdea();
    else void props.getLatestNews();
  }

  async function generateScript() {
    if (props.prompt.trim().length < 3) {
      props.setToast("Add a clear video brief first");
      moveTo(0);
      return;
    }
    setDrafting(true);
    try {
      const response = await fetch(`${SERVICE_URL}/script-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: props.prompt,
          category: props.category,
          duration: props.duration,
          language: props.language,
          ttsEngine: props.ttsEngine,
          subtitleLanguage: props.subtitleLanguage,
          platforms: props.selectedPlatforms,
          scriptStyle,
        }),
      });
      const result = await response.json() as { script?: string; mode?: "ai" | "studio"; error?: string };
      if (!response.ok || !result.script) throw new Error(result.error ?? "Script draft could not be generated");
      setScript(result.script);
      clearVoicePreview(true);
      setScriptMode(result.mode ?? "ai");
      setManualEditorOpen(true);
      setVisualThemes([]);
      setVisualThemeMode(null);
      clearStoryboard();
      setFurthestStep((current) => Math.max(current, 1));
      props.setToast(result.mode === "studio" ? "Built-in script draft ready" : "AI script draft ready for review");
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "Script draft could not be generated");
    } finally {
      setDrafting(false);
    }
  }

  function approveScript() {
    moveTo(2);
  }

  async function translateVoicePreview() {
    setConfirmPreviewTranslation(false);
    setVoicePreviewTranslating(true);
    try {
      const response = await fetch(`${SERVICE_URL}/voice-preview-translation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: approvedPreviewLine, targetLanguage: props.language }),
      });
      const result = await response.json() as { text?: string; error?: string };
      if (!response.ok || !result.text) throw new Error(result.error ?? "The sample line could not be translated");
      setVoicePreviewText(result.text);
      props.setToast(`${props.language} sample line ready`);
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "The sample line could not be translated");
    } finally {
      setVoicePreviewTranslating(false);
    }
  }

  async function generateVoiceSample() {
    if (effectivePreviewText.length < 3) {
      props.setToast(props.language === "English" ? "The approved script needs a complete first sentence" : `Write or translate one ${props.language} sample sentence first`);
      return;
    }
    setVoicePreviewLoading(true);
    try {
      const response = await fetch(`${SERVICE_URL}/voice-previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: effectivePreviewText,
          language: props.language,
          ttsEngine: props.ttsEngine,
          narratorId,
        }),
      });
      const result = await response.json() as { url?: string; cached?: boolean; usesApi?: boolean; provider?: string; narrator?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? "The voice sample could not be generated");
      const preview = {
        url: result.url,
        cached: Boolean(result.cached),
        usesApi: Boolean(result.usesApi),
        provider: result.provider ?? voiceEngineName(props.ttsEngine),
        narrator: result.narrator ?? selectedNarrator.name,
        narratorId,
        language: props.language,
        ttsEngine: props.ttsEngine,
        text: effectivePreviewText,
      };
      setVoicePreviews((current) => [
        ...current.filter((item) => !(
          item.narratorId === preview.narratorId
          && item.language === preview.language
          && item.ttsEngine === preview.ttsEngine
          && item.text === preview.text
        )),
        preview,
      ].slice(-12));
      props.setToast(result.cached ? "Cached voice sample ready" : `${selectedNarrator.name} voice sample ready`);
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "The voice sample could not be generated");
    } finally {
      setVoicePreviewLoading(false);
    }
  }

  async function generateVisualThemes() {
    if (!scriptReady) {
      props.setToast(`The ${props.duration} script needs at least ${minimumWords} words`);
      moveTo(1);
      return;
    }
    setGeneratingThemes(true);
    try {
      const response = await fetch(`${SERVICE_URL}/visual-themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, category: props.category }),
      });
      const result = await response.json() as { themes?: VisualTheme[]; mode?: "ai" | "studio"; error?: string };
      if (!response.ok || !result.themes?.length) throw new Error(result.error ?? "Visual themes could not be generated");
      setVisualThemes(result.themes);
      setVisualThemeMode(result.mode ?? "ai");
      clearStoryboard();
      props.setToast(result.mode === "studio" ? "Built-in visual themes ready for review" : "AI visual themes ready for review");
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "Visual themes could not be generated");
    } finally {
      setGeneratingThemes(false);
    }
  }

  function updateVisualTheme(index: number, update: Partial<VisualTheme>) {
    setVisualThemes((current) => current.map((theme, themeIndex) => themeIndex === index ? { ...theme, ...update } : theme));
    clearStoryboard();
  }

  async function openLocalStoryboard() {
    if (!scriptReady) {
      props.setToast(`The ${props.duration} script needs at least ${minimumWords} words`);
      moveTo(1);
      return;
    }
    setGeneratingThemes(true);
    try {
      const response = await fetch(`${SERVICE_URL}/visual-themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, category: props.category, localOnly: true }),
      });
      const result = await response.json() as { themes?: VisualTheme[]; error?: string };
      if (!response.ok || !result.themes?.length) throw new Error(result.error ?? "Local storyboard could not be prepared");
      setVisualThemes(result.themes);
      setVisualThemeMode("studio");
      clearStoryboard();
      await findStoryboardFootage(result.themes);
      window.setTimeout(() => document.getElementById("guided-storyboard")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "Local storyboard could not be prepared");
    } finally {
      setGeneratingThemes(false);
    }
  }

  async function findStoryboardFootage(themes = visualThemes, showDifferentResults = false) {
    if (!visualThemesReady(themes)) {
      props.setToast("Review the visual theme titles and searches first");
      return;
    }
    const page = showDifferentResults ? Math.min(20, stockSearchPageRef.current + 1) : stockSearchPageRef.current;
    setStoryboardLoading(true);
    try {
      const response = await fetch(`${SERVICE_URL}/visual-candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themes, page }),
      });
      const result = await response.json() as {
        providerReady?: boolean;
        page?: number;
        providers?: Record<string, { configured: boolean; available: boolean; returned: boolean }>;
        groups?: Array<{ themeIndex: number; candidates: VisualCandidate[] }>;
        error?: string;
      };
      if (!response.ok || !result.groups) throw new Error(result.error ?? "Footage choices could not be loaded");
      stockSearchPageRef.current = result.page ?? page;
      setVisualCandidates(Object.fromEntries(result.groups.map((group) => [group.themeIndex, group.candidates])));
      setVisualSelections((current) => current.filter((selection) => selection.mode === "custom"));
      setStoryboardSearched(true);
      setStockProviders(result.providers ?? {});
      const returnedProviders = Object.entries(result.providers ?? {}).filter(([, status]) => status.returned).map(([provider]) => provider === "pixabay" ? "Pixabay" : "Pexels");
      const failedProviders = Object.entries(result.providers ?? {}).filter(([, status]) => status.configured && !status.available).map(([provider]) => provider === "pixabay" ? "Pixabay" : "Pexels");
      if (returnedProviders.length) {
        props.setToast(`Footage ready from ${returnedProviders.join(" + ")}${failedProviders.length ? ` — ${failedProviders.join(" + ")} unavailable, fallback applied` : ""}`);
      } else if (result.providerReady) {
        props.setToast("The configured stock providers returned no usable matches — choose your own videos or motion backgrounds");
      } else {
        props.setToast("No stock provider is connected — choose your own videos, motion backgrounds, or open Settings");
      }
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "Footage choices could not be loaded");
    } finally {
      setStoryboardLoading(false);
    }
  }

  function selectVisualCandidate(themeIndex: number, candidate: VisualCandidate) {
    setVisualSelections((current) => [
      ...current.filter((selection) => selection.themeIndex !== themeIndex),
      {
        themeIndex,
        mode: "media",
        provider: candidate.provider,
        mediaId: candidate.id,
        mediaType: candidate.type,
        mediaUrl: candidate.mediaUrl,
        sourceUrl: candidate.sourceUrl,
        creator: candidate.creator,
        query: candidate.query,
      } satisfies VisualSelection,
    ].sort((a, b) => a.themeIndex - b.themeIndex));
  }

  function selectMotionBackground(themeIndex: number) {
    setVisualSelections((current) => [
      ...current.filter((selection) => selection.themeIndex !== themeIndex),
      { themeIndex, mode: "motion" as const },
    ].sort((a, b) => a.themeIndex - b.themeIndex));
  }

  function selectExistingCustomVideo(themeIndex: number) {
    const asset = customVideoAssets[themeIndex];
    if (!asset) {
      props.setToast("Choose your video file again");
      return;
    }
    setVisualSelections((current) => [
      ...current.filter((selection) => selection.themeIndex !== themeIndex),
      {
        themeIndex,
        mode: "custom",
        uploadId: asset.uploadId,
        fileName: asset.fileName,
      } satisfies VisualSelection,
    ].sort((a, b) => a.themeIndex - b.themeIndex));
  }

  async function selectCustomVideo(themeIndex: number, file?: File) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    const supportedExtensions = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]);
    if ((!file.type.startsWith("video/") && !supportedExtensions.has(extension ?? "")) || file.size <= 0) {
      props.setToast("Choose a supported, non-empty video file");
      return;
    }
    setCustomVideoUploading((current) => ({ ...current, [themeIndex]: true }));
    try {
      const response = await fetch(`${SERVICE_URL}/tool-inputs`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const result = await response.json() as {
        input?: { id: string; name: string; bytes: number; mediaType: string };
        error?: string;
      };
      if (!response.ok || !result.input) throw new Error(result.error ?? "Video could not be uploaded");
      const previewUrl = URL.createObjectURL(file);
      setCustomVideoPreviews((current) => {
        const previous = current[themeIndex];
        if (previous) URL.revokeObjectURL(previous.url);
        return { ...current, [themeIndex]: { url: previewUrl, name: result.input!.name } };
      });
      setCustomVideoAssets((current) => ({
        ...current,
        [themeIndex]: { uploadId: result.input!.id, fileName: result.input!.name },
      }));
      setVisualSelections((current) => [
        ...current.filter((selection) => selection.themeIndex !== themeIndex),
        {
          themeIndex,
          mode: "custom",
          uploadId: result.input.id,
          fileName: result.input.name,
        } satisfies VisualSelection,
      ].sort((a, b) => a.themeIndex - b.themeIndex));
      props.setToast(`"${result.input.name}" selected for theme ${themeIndex + 1}`);
    } catch (error) {
      props.setToast(error instanceof Error ? error.message : "Video could not be uploaded");
    } finally {
      setCustomVideoUploading((current) => ({ ...current, [themeIndex]: false }));
    }
  }

  function queueVideo() {
    if (!briefReady) {
      props.setToast("Add a clear video brief before continuing");
      moveTo(0);
      return;
    }
    if (!scriptReady) {
      props.setToast(`The ${props.duration} script needs at least ${minimumWords} words`);
      moveTo(1);
      return;
    }
    if (!productionSettingsReady) {
      props.setToast("Choose a speech language, compatible voice engine, and subtitle language");
      moveTo(2);
      return;
    }
    if (!themesReady) {
      props.setToast("Generate and review the visual themes before continuing");
      moveTo(2);
      return;
    }
    if (!storyboardReady) {
      props.setToast("Choose stock footage, your own video, or a motion background for every visual theme");
      moveTo(2);
      return;
    }
    void props.startGeneration(script, visualThemes, visualSelections, scriptStyle, narratorId);
  }

  function createAnotherVideo() {
    setStep(0);
    setFurthestStep(0);
    setScript("");
    setScriptStyle("clear-explainer");
    setNarratorId("maya");
    setVoicePreviewText("");
    setVoicePreviews([]);
    setVoicePreviewLoading(false);
    setVoicePreviewTranslating(false);
    setConfirmPreviewTranslation(false);
    setDrafting(false);
    setScriptMode(null);
    setManualEditorOpen(false);
    setPendingBriefAction(null);
    setVisualThemes([]);
    setVisualThemeMode(null);
    setGeneratingThemes(false);
    clearStoryboard();
    props.onCreateAnother();
  }

  return (
    <div className="content-wrap guided-create-page">
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow"><span /> GUIDED VIDEO CREATOR</div>
          <h1>Build the video one decision at a time.</h1>
          <p>Prepare the brief, approve the exact script, then choose production settings before rendering.</p>
        </div>
        <span className="guided-step-count">Step {step + 1} of {guidedSteps.length}</span>
      </div>

      <nav className="guided-stepper" aria-label="Guided creation progress">
        {guidedSteps.map((item, index) => (
          <button
            key={item.label}
            className={`${index === step ? "active" : ""} ${index < step || index <= furthestStep ? "available" : ""}`}
            disabled={index > furthestStep}
            aria-current={index === step ? "step" : undefined}
            onClick={() => index <= furthestStep && moveTo(index)}
          >
            <i>{index + 1}</i>
            <span><strong>{item.label}</strong><small>{item.detail}</small></span>
          </button>
        ))}
      </nav>

      <section className="guided-card">
        {step === 0 && (
          <>
            <GuidedSectionHeader number="01" title="Start with a clear brief" detail="Write the direction yourself, or use an optional AI helper after choosing a specific topic." />
            <label className="guided-brief-field">
              <span>Write your video brief</span>
              <textarea id="guided-brief" value={props.prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder="Describe the topic, hook, important facts, audience, and takeaway…" maxLength={700} />
              <small>{props.prompt.length}/700</small>
            </label>
            <div className="guided-inline-fields">
              <SelectField icon={<Sparkles size={15} />} label="Topic lane" value={props.category} onChange={(value) => { props.setCategory(value); setScript(""); setScriptMode(null); setManualEditorOpen(false); setVisualThemes([]); setVisualThemeMode(null); clearStoryboard(); setFurthestStep(0); }} options={["Curious science", "Psychology", "Business", "History", "Technology", "Wellness"]} />
              <SelectField icon={<Clock3 size={15} />} label="Target duration" value={props.duration} onChange={(value) => { props.setDuration(value); setScript(""); setScriptMode(null); setManualEditorOpen(false); setVisualThemes([]); setVisualThemeMode(null); clearStoryboard(); setFurthestStep(0); }} options={["60 sec", "75 sec", "90 sec", "2 min", "Up to 3 min"]} />
            </div>
            <section className="guided-ai-brief-helper">
              <header>
                <span><Sparkles size={14} /><strong>Optional AI brief helper</strong></span>
                <em>Uses API tokens</em>
              </header>
              <label className="guided-focus-field">
                <span>AI topic <b>Required</b></span>
                <input
                  id="guided-ai-topic"
                  value={props.ideaFocus}
                  onChange={(event) => { props.setIdeaFocus(event.target.value); setPendingBriefAction(null); }}
                  placeholder="Be specific, e.g. how reusable rockets reduce launch costs"
                  maxLength={200}
                />
                <small>{aiTopicReady ? "The AI will stay focused on this topic." : "Enter a specific topic to unlock the AI actions."}</small>
              </label>
              <div className="guided-ai-token-note"><Zap size={12} /><span>These actions send your topic to the configured AI provider and consume API tokens. No request is sent until you confirm.</span></div>
              <div className="guided-ai-brief-actions">
                <button disabled={!aiTopicReady || props.suggesting || props.newsLoading} onClick={() => prepareBriefAction("idea")}>{props.suggesting ? <RefreshCw className="spin" size={14} /> : <Lightbulb size={14} />} Suggest an idea</button>
                <button disabled={!aiTopicReady || props.newsLoading || props.suggesting} onClick={() => prepareBriefAction("news")}>{props.newsLoading ? <RefreshCw className="spin" size={14} /> : <Newspaper size={14} />} Find latest news</button>
              </div>
              {pendingBriefAction && (
                <div className="guided-ai-confirm" role="alert">
                  <span><strong>{pendingBriefAction === "idea" ? "Generate an idea with AI?" : "Research current news with AI?"}</strong><small>This will use API tokens and replace the current brief when a result is ready.</small></span>
                  <button onClick={() => setPendingBriefAction(null)}>Cancel</button>
                  <button onClick={confirmBriefAction}>Confirm and run</button>
                </div>
              )}
            </section>
            <GuidedFooter next="Continue to script" onNext={continueFromBrief} disabled={!briefReady} />
          </>
        )}

        {step === 1 && (
          <>
            <GuidedSectionHeader number="02" title="Approve the exact script" detail="Rendering will use this reviewed English master instead of writing another script later." />
            <div className="guided-brief-summary">
              <header>
                <span><FileText size={14} /><strong>Your brief</strong></span>
                <button onClick={() => moveTo(0)}>Edit brief</button>
              </header>
              <p>{props.prompt}</p>
              <footer><span>{props.category}</span><span>{props.duration}</span></footer>
            </div>
            <section className="guided-script-styles">
              <header>
                <span><strong>Script structure</strong><small>Choose how the story unfolds.</small></span>
                <em>No tokens until Generate</em>
              </header>
              <div role="radiogroup" aria-label="Script structure">
                {scriptStyles.map((option) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scriptStyle === option.id}
                    className={scriptStyle === option.id ? "selected" : ""}
                    key={option.id}
                    onClick={() => changeScriptStyle(option.id)}
                  >
                    {scriptStyle === option.id && <Check size={11} />}
                    {option.label}
                  </button>
                ))}
              </div>
              <p><strong>{selectedScriptStyle.label}</strong><span>{selectedScriptStyle.detail}</span></p>
            </section>
            <div className="guided-ai-note">
              <Sparkles size={15} />
              <span><strong>Research-backed AI script draft</strong><small>Uses several AI passes and more tokens. Gemini also searches grounded sources when available; OpenRouter falls back to the reviewed brief.</small></span>
              <button onClick={props.onOpenSettings}><Settings size={12} /> Settings</button>
            </div>
            {!script && !manualEditorOpen ? (
              <div className="guided-script-empty">
                <i><WandSparkles size={20} /></i>
                <div><strong>Turn this brief into a script</strong><p>Generate a complete {props.duration} draft, then review and edit every word before continuing.</p></div>
                <button onClick={generateScript} disabled={drafting}>{drafting ? <RefreshCw className="spin" size={15} /> : <WandSparkles size={15} />}{drafting ? "Generating script…" : "Generate script"}</button>
                <button className="guided-write-manually" onClick={() => setManualEditorOpen(true)}>Write it myself</button>
              </div>
            ) : (
              <>
                <div className="guided-script-toolbar">
                  <span>{scriptMode === "studio" ? "Built-in draft" : scriptMode === "ai" ? "AI draft" : "Your script"}</span>
                  <button onClick={generateScript} disabled={drafting}>{drafting ? <RefreshCw className="spin" size={14} /> : <WandSparkles size={14} />}Regenerate</button>
                </div>
                <label className="guided-script-field">
                  <textarea autoFocus={!script} value={script} onChange={(event) => { setManualEditorOpen(true); setScript(event.target.value); clearVoicePreview(true); setVisualThemes([]); setVisualThemeMode(null); clearStoryboard(); }} placeholder="Write or paste your script here." maxLength={4000} />
                  <small>{scriptWords ? `${scriptWords} words · minimum ${minimumWords}` : `English master · minimum ${minimumWords} words`} · {script.length}/4000</small>
                </label>
              </>
            )}
            <GuidedFooter back="Back to brief" next="Approve and continue" onBack={() => moveTo(0)} onNext={approveScript} disabled={!scriptReady} />
          </>
        )}

        {step === 2 && (
          <>
            <GuidedSectionHeader number="03" title="Choose production settings" detail="Recommended defaults are already selected and can be changed before rendering." />
            <div className="guided-production-grid">
              <SelectField icon={<Mic2 size={15} />} label="Speech language" value={props.language} onChange={changeSpeechLanguage} options={speechLanguages} />
              <SelectField icon={<Zap size={15} />} label="Voice engine" value={props.ttsEngine} onChange={changeVoiceEngine} options={ttsEngineOptions(props.language)} />
              <SelectField icon={<Languages size={15} />} label="Subtitle language" value={props.subtitleLanguage} onChange={props.setSubtitleLanguage} options={voiceLanguages} />
            </div>
            <section className="guided-narrators">
              <header>
                <span><Mic2 size={15} /><span><strong>Choose your narrator</strong><small>One consistent personality, matched to the selected voice engine.</small></span></span>
                <em>Selection uses no tokens</em>
              </header>
              <div role="radiogroup" aria-label="Video narrator">
                {narrators.map((narrator) => {
                  const selected = narrator.id === narratorId;
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`guided-narrator-card narrator-${narrator.id} ${selected ? "selected" : ""}`}
                      key={narrator.id}
                      onClick={() => changeNarrator(narrator.id)}
                    >
                      <span className="guided-narrator-head">
                        <i>{narrator.initial}</i>
                        <span><strong>{narrator.name}</strong><small>{narrator.role}</small></span>
                        {selected && <em><Check size={10} /> Selected</em>}
                      </span>
                      <q>{narrator.sampleLine}</q>
                      <span className="guided-narrator-traits">
                        <small>{narrator.voice}</small><small>{narrator.tone}</small><small>{narrator.character}</small><small>{narrator.pace}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="guided-voice-preview">
                <header>
                  <span><Volume2 size={14} /><span><strong>Hear {selectedNarrator.name} on your script</strong><small>Creates a 5–8 second sample from the approved opening line.</small></span></span>
                  <em className={props.ttsEngine === "gemini" ? "api" : "local"}>{props.ttsEngine === "gemini" ? "Gemini · API key + tokens" : "Local · no API tokens"}</em>
                </header>
                {props.language === "English" ? (
                  <p>“{approvedPreviewLine || "Approve a script to prepare its opening line."}”</p>
                ) : (
                  <label>
                    <span>Sample sentence in {props.language}</span>
                    <textarea
                      value={voicePreviewText}
                      onChange={(event) => { setVoicePreviewText(event.target.value); clearVoicePreview(); }}
                      placeholder={`Write one natural sentence in ${props.language}, or translate the English opening with AI.`}
                      maxLength={240}
                    />
                    <small>{voicePreviewText.length}/240 · This exact text is synthesized.</small>
                  </label>
                )}
                {props.language !== "English" && !confirmPreviewTranslation && (
                  <button className="guided-preview-translate" onClick={() => setConfirmPreviewTranslation(true)} disabled={voicePreviewTranslating}>
                    <Languages size={12} />{voicePreviewTranslating ? "Translating…" : "Translate opening with AI"}
                  </button>
                )}
                {confirmPreviewTranslation && (
                  <div className="guided-preview-confirm">
                    <span><strong>Use AI translation?</strong><small>The opening line will be sent to your configured provider and use API tokens.</small></span>
                    <span><button onClick={() => setConfirmPreviewTranslation(false)}>Cancel</button><button onClick={translateVoicePreview}>Confirm and translate</button></span>
                  </div>
                )}
                <div className="guided-preview-actions">
                  <button onClick={generateVoiceSample} disabled={voicePreviewLoading || voicePreviewTranslating || effectivePreviewText.length < 3}>
                    {voicePreviewLoading ? <RefreshCw className="spin" size={13} /> : <Volume2 size={13} />}
                    {voicePreviewLoading ? "Generating sample…" : voicePreview ? "Generate updated sample" : "Generate voice sample"}
                  </button>
                  <small>{props.ttsEngine === "gemini" ? "Requires a configured Gemini API key. " : ""}A saved sample appears only for the narrator who generated it, returns when that narrator is selected again, and remains cached for free replay.</small>
                </div>
                {voicePreview && (
                  <div className="guided-preview-player" aria-label={`${voicePreview.narrator} voice sample`}>
                    <audio key={voicePreview.url} controls preload="metadata" src={`${SERVICE_URL}${voicePreview.url}`} />
                    <span>
                      <strong>{voicePreview.narrator} · {voicePreview.provider}</strong>
                      <small>{voicePreview.cached ? "Reused cached sample" : "New sample generated"} · {voicePreview.language} · Final-video pacing may vary slightly.</small>
                    </span>
                  </div>
                )}
              </div>
            </section>
            <section className="guided-visual-themes">
              <header>
                <span><Clapperboard size={15} /><span><strong>Visual themes</strong><small>Keep consecutive stock clips aligned with the script’s broader story beats.</small></span></span>
                <em>AI plan · API tokens</em>
              </header>
              {!visualThemes.length ? (
                <div className="guided-theme-empty">
                  <span>Reelio will group the approved script into visual themes and create concrete stock-media search phrases for each one.</span>
                  <button onClick={generateVisualThemes} disabled={generatingThemes}>{generatingThemes ? <RefreshCw className="spin" size={14} /> : <Sparkles size={14} />}{generatingThemes ? "Generating themes…" : "Generate visual themes"}</button>
                  <small>Uses the configured AI provider and API tokens. A built-in plan is used when cloud AI is unavailable.</small>
                </div>
              ) : (
                <>
                  <div className="guided-theme-toolbar">
                    <span><Check size={12} /> {visualThemes.length} themes · {visualThemeMode === "studio" ? "built-in plan" : "AI plan"}</span>
                    <button onClick={generateVisualThemes} disabled={generatingThemes}>{generatingThemes ? <RefreshCw className="spin" size={12} /> : <RefreshCw size={12} />} Regenerate</button>
                  </div>
                  <div className="guided-theme-list">
                    {visualThemes.map((theme, themeIndex) => (
                      <div className="guided-theme-card" key={`${theme.startSegment}-${theme.endSegment}`}>
                        <header><span>Theme {themeIndex + 1}</span><small>Script lines {theme.startSegment + 1}–{theme.endSegment + 1}</small></header>
                        <input aria-label={`Theme ${themeIndex + 1} title`} value={theme.title} onChange={(event) => updateVisualTheme(themeIndex, { title: event.target.value })} maxLength={80} />
                        <div>
                          <span>Stock searches</span>
                          {theme.queries.map((query, queryIndex) => (
                            <input
                              key={queryIndex}
                              aria-label={`Theme ${themeIndex + 1} search ${queryIndex + 1}`}
                              value={query}
                              onChange={(event) => updateVisualTheme(themeIndex, { queries: theme.queries.map((item, itemIndex) => itemIndex === queryIndex ? event.target.value : item) })}
                              maxLength={90}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <section className="guided-storyboard" id="guided-storyboard">
              <header>
                <span><Film size={15} /><span><strong>Visual storyboard</strong><small>Approve each theme’s footage. Stock media from <a href="https://www.pexels.com" target="_blank" rel="noreferrer">Pexels</a> and <a href="https://pixabay.com" target="_blank" rel="noreferrer">Pixabay</a>.</small></span></span>
                <em>No AI tokens</em>
              </header>
              {!themesReady ? (
                <div className="guided-storyboard-empty">
                  <span>Skip AI theme generation and open footage choices immediately. Reelio will group the approved script locally, then show stock clips, custom-video uploads, and motion backgrounds.</span>
                  <button onClick={openLocalStoryboard} disabled={generatingThemes || storyboardLoading}>
                    {generatingThemes || storyboardLoading ? <RefreshCw className="spin" size={14} /> : <Film size={14} />}
                    {generatingThemes || storyboardLoading ? "Opening storyboard…" : "Open storyboard without AI"}
                  </button>
                  <small>No text-provider call and no AI tokens. Stock-provider searches still require a configured Pexels or Pixabay key.</small>
                </div>
              ) : !storyboardSearched ? (
                <div className="guided-storyboard-empty">
                  <span>Load the storyboard, then choose a result from any connected stock provider, your own video file, or a motion background for every theme.</span>
                  <button onClick={() => void findStoryboardFootage()} disabled={storyboardLoading}>
                    {storyboardLoading ? <RefreshCw className="spin" size={14} /> : <Film size={14} />}
                    {storyboardLoading ? "Finding footage…" : "Find matching footage"}
                  </button>
                  <small>This searches connected stock providers and does not call an AI provider.</small>
                </div>
              ) : (
                <>
                  <div className="guided-storyboard-toolbar">
                    <span className={storyboardReady ? "ready" : ""}>
                      {storyboardReady ? <Check size={12} /> : <Film size={12} />}
                      {visualSelections.length} of {visualThemes.length} themes approved
                    </span>
                    <div>
                      {(!stockConfigured || !stockAvailable) && <button onClick={props.onOpenSettings}><Settings size={12} /> Stock settings</button>}
                      <button onClick={() => void findStoryboardFootage(visualThemes, true)} disabled={storyboardLoading}>
                        <RefreshCw className={storyboardLoading ? "spin" : ""} size={12} /> Show different clips
                      </button>
                    </div>
                  </div>
                  {(!stockConfigured || !stockAvailable || failedStockProviders.length > 0) && (
                    <div className="guided-storyboard-warning">
                      {!stockConfigured
                        ? "No stock provider is connected. Your own video files and motion backgrounds remain available for every theme."
                        : !stockAvailable
                          ? "The configured stock providers could not return data. Your own video files and motion backgrounds remain available."
                          : `${failedStockProviders.join(" and ")} could not return data, so Reelio used the other connected provider.`}
                    </div>
                  )}
                  <div className="guided-storyboard-list">
                    {visualThemes.map((theme, themeIndex) => {
                      const selected = visualSelections.find((selection) => selection.themeIndex === themeIndex);
                      const candidates = visualCandidates[themeIndex] ?? [];
                      const customPreview = customVideoPreviews[themeIndex];
                      const customSelected = selected?.mode === "custom";
                      const customUploading = Boolean(customVideoUploading[themeIndex]);
                      return (
                        <article className="guided-storyboard-theme" key={`${theme.startSegment}-${theme.endSegment}`}>
                          <header>
                            <span><i>{themeIndex + 1}</i><strong>{theme.title}</strong></span>
                            <small>{selected ? "Approved" : "Choose one"}</small>
                          </header>
                          <div className="guided-storyboard-options">
                            {candidates.map((candidate) => {
                              const isSelected = selected?.mode === "media" && selected.mediaId === candidate.id;
                              return (
                                <button
                                  type="button"
                                  className={`guided-storyboard-option ${isSelected ? "selected" : ""}`}
                                  aria-pressed={isSelected}
                                  key={candidate.id}
                                  onClick={() => selectVisualCandidate(themeIndex, candidate)}
                                >
                                  <span className="guided-storyboard-image" style={{ backgroundImage: `url(${JSON.stringify(candidate.previewUrl)})` }} />
                                  <span><strong>{candidate.providerLabel} {candidate.type === "video" ? "video" : "photo"}</strong><small>{candidate.creator} · {candidate.query}</small></span>
                                  {isSelected && <i><Check size={11} /> Selected</i>}
                                </button>
                              );
                            })}
                            {customPreview ? (
                              <div className={`guided-storyboard-option custom has-upload ${customSelected ? "selected" : ""} ${customUploading ? "uploading" : ""}`}>
                                <button
                                  type="button"
                                  className="guided-storyboard-custom-select"
                                  aria-pressed={customSelected}
                                  disabled={customUploading}
                                  onClick={() => selectExistingCustomVideo(themeIndex)}
                                >
                                  <span className="guided-storyboard-custom"><video src={customPreview.url} muted playsInline preload="metadata" /></span>
                                  <span><strong>{customUploading ? "Uploading…" : "Your video"}</strong><small>{customPreview.name}</small></span>
                                </button>
                                <label className="guided-storyboard-custom-edit" aria-label={`Replace your video for ${theme.title}`} title="Replace video">
                                  <input
                                    type="file"
                                    accept="video/*,.mkv,.avi"
                                    disabled={customUploading}
                                    onChange={(event) => {
                                      const file = event.currentTarget.files?.[0];
                                      event.currentTarget.value = "";
                                      void selectCustomVideo(themeIndex, file);
                                    }}
                                  />
                                  <Pencil size={11} />
                                </label>
                                {customSelected && <i><Check size={11} /> Selected</i>}
                              </div>
                            ) : (
                              <label className={`guided-storyboard-option custom ${customUploading ? "uploading" : ""}`} aria-label={`Choose your own video for ${theme.title}`}>
                                <span className="guided-storyboard-custom">
                                  <input
                                    type="file"
                                    accept="video/*,.mkv,.avi"
                                    disabled={customUploading}
                                    onChange={(event) => {
                                      const file = event.currentTarget.files?.[0];
                                      event.currentTarget.value = "";
                                      void selectCustomVideo(themeIndex, file);
                                    }}
                                  />
                                  <i>{customUploading ? <RefreshCw className="spin" size={18} /> : <Upload size={18} />}</i>
                                </span>
                                <span><strong>{customUploading ? "Uploading…" : "Choose your video"}</strong><small>Upload a video file from this device.</small></span>
                              </label>
                            )}
                            <button
                              type="button"
                              className={`guided-storyboard-option motion ${selected?.mode === "motion" ? "selected" : ""}`}
                              aria-pressed={selected?.mode === "motion"}
                              onClick={() => selectMotionBackground(themeIndex)}
                            >
                              <span className="guided-storyboard-motion"><i /><i /><i /></span>
                              <span><strong>Motion background</strong><small>Animated color, texture, and movement generated locally.</small></span>
                              {selected?.mode === "motion" && <i><Check size={11} /> Selected</i>}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
            <div className="guided-platforms">
              <div><strong>Prepare platform packages</strong><small>Select any number of destinations</small></div>
              <div>{platforms.map((platform) => {
                const selected = props.selectedPlatforms.includes(platform.id);
                return <button key={platform.id} className={selected ? "selected" : ""} onClick={() => props.togglePlatform(platform.id)}><PlatformLogo platform={platform} /><span>{platform.label}</span><i>{selected && <Check size={11} />}</i></button>;
              })}</div>
            </div>
            <GuidedFooter back="Back to script" next="Review video" onBack={() => moveTo(1)} onNext={() => moveTo(3)} disabled={!productionReady} />
          </>
        )}

        {step === 3 && (
          <>
            <GuidedSectionHeader number="04" title="Review and create your video" detail="Check the final choices, then start creating the finished video." />
            <div className="guided-review-grid">
              <ReviewItem label="Topic" value={props.prompt} />
              <ReviewItem label="Duration" value={props.duration} />
              <ReviewItem label="Speech" value={`${props.language} · ${voiceEngineName(props.ttsEngine)}`} />
              <ReviewItem label="Narrator" value={`${selectedNarrator.name} · ${selectedNarrator.role}`} />
              <ReviewItem label="Subtitles" value={props.subtitleLanguage} />
              <ReviewItem label="Platforms" value={props.selectedPlatforms.length ? props.selectedPlatforms.map((id) => platforms.find((platform) => platform.id === id)?.label ?? id).join(", ") : "Assets only"} />
              <ReviewItem label="Script" value={`${scriptWords} reviewed words`} />
              <ReviewItem label="Script style" value={selectedScriptStyle.label} />
              <ReviewItem label="Visual plan" value={`${visualThemes.length} reviewed themes`} />
              <ReviewItem label="Storyboard" value={`${selectedCustomCount} custom · ${selectedPexelsCount} Pexels · ${selectedPixabayCount} Pixabay · ${selectedMotionCount} motion`} />
            </div>
            <details className="guided-script-preview"><summary>View approved script</summary><p>{script}</p></details>
            <details className="guided-theme-preview"><summary>View visual themes</summary><div>{visualThemes.map((theme) => <span key={`${theme.startSegment}-${theme.endSegment}`}><strong>{theme.title}</strong><small>{theme.queries.join(" · ")}</small></span>)}</div></details>
            <details className="guided-storyboard-preview"><summary>View approved storyboard</summary><div>{visualThemes.map((theme, themeIndex) => {
              const selection = visualSelections.find((item) => item.themeIndex === themeIndex);
              const description = selection?.mode === "media"
                ? `${selection.provider === "pixabay" ? "Pixabay" : "Pexels"} ${selection.mediaType === "video" ? "video" : "photo"} · ${selection.creator}`
                : selection?.mode === "custom"
                  ? `Your video · ${selection.fileName}`
                  : "Local motion background";
              return <span key={`${theme.startSegment}-${theme.endSegment}`}><strong>{theme.title}</strong><small>{description}</small></span>;
            })}</div></details>
            <div className="guided-cloud-summary"><Sparkles size={14} /><span><strong>AI usage</strong><small>The approved script, visual themes, and storyboard prevent new writing or visual-planning calls during rendering. Translation or Gemini voice may still use configured cloud providers.</small></span></div>

            {props.generating && <div className="guided-render-status"><span><RefreshCw className="spin" size={14} /> {props.renderMessage || "Building your video"}</span><strong>{props.renderProgress}%</strong><i><b style={{ width: `${props.renderProgress}%` }} /></i></div>}
            {props.completedJob?.assets ? (
              <div className="guided-after-complete">
                <span><Check size={15} /><span><strong>Your video is ready</strong><small>Review the finished package or begin a new guided video.</small></span></span>
                <div>
                  <button onClick={() => props.openJob(props.completedJob!)}>View finished video <ArrowRight size={14} /></button>
                  <button onClick={createAnotherVideo}><WandSparkles size={14} /> Create another video</button>
                </div>
              </div>
            ) : (
              <div className="guided-final-actions">
                <button className="guided-back-button" onClick={() => moveTo(2)}><ArrowLeft size={14} /> Back</button>
                <button className={props.generating ? "guided-stop-button" : "guided-queue-button"} disabled={props.stoppingGeneration} onClick={() => props.generating ? void props.stopGeneration() : queueVideo()}>
                  {props.generating ? <RefreshCw className={props.stoppingGeneration ? "spin" : ""} size={15} /> : <WandSparkles size={15} />}
                  {props.generating ? (props.stoppingGeneration ? "Stopping…" : "Stop generation") : "Create video"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function GuidedSectionHeader({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <header className="guided-section-header"><span>{number}</span><div><h2>{title}</h2><p>{detail}</p></div></header>;
}

function GuidedFooter({ back, next, onBack, onNext, disabled = false }: { back?: string; next: string; onBack?: () => void; onNext: () => void; disabled?: boolean }) {
  return <footer className="guided-footer">{onBack && <button className="guided-back-button" onClick={onBack}><ArrowLeft size={14} /> {back}</button>}<button className="guided-next-button" disabled={disabled} onClick={onNext}>{next} <ArrowRight size={14} /></button></footer>;
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function voiceEngineName(engine: TtsEngine) {
  return engine === "kokoro" ? "Kokoro" : engine === "voxcpm2" ? "VoxCPM2" : "Gemini TTS";
}

function firstVoicePreviewSentence(value: string) {
  const clean = value.replace(/\[(?:pause|beat|breath)\]/gi, " ").replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^(.+?[.!?…။])(?:\s|$)/)?.[1] ?? clean;
  if (sentence.length <= 220) return sentence;
  const shortened = sentence.slice(0, 219).replace(/\s+\S*$/, "").trim();
  return `${shortened || sentence.slice(0, 219)}…`;
}

function minimumGuidedWords(duration: string) {
  const targetSeconds = duration === "60 sec" ? 60
    : duration === "75 sec" ? 75
      : duration === "90 sec" ? 90
        : duration === "2 min" ? 120
          : 122.4;
  return Math.max(18, Math.floor(Math.round(targetSeconds * 2.45) * 0.92));
}

function visualThemesReady(themes: VisualTheme[]) {
  return themes.length >= 2 && themes.every((theme) =>
    theme.title.trim().length >= 2
    && theme.queries.length >= 1
    && theme.queries.every((query) => query.trim().length >= 2)
  );
}
