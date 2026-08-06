"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Film,
  LoaderCircle,
  MessageCircleMore,
  Mic2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultTtsEngine, speechLanguages, ttsEngineOptions } from "../lib/languages";
import { narrators } from "../lib/narrators";
import { platforms } from "../lib/platforms";
import { serviceFetch, SERVICE_URL } from "../lib/service";
import type {
  ConversationAsset,
  ConversationDraft,
  ConversationEvent,
  ConversationEventType,
  ConversationParticipant,
  ConversationStoryPitch,
  LocalJob,
  NarratorId,
  TtsEngine,
} from "../lib/types";

type Step = "setup" | "write" | "timing" | "preview";
type StarterMode = "own" | "guided" | "surprise";
const starterOptions = {
  relationships: ["You choose", "Close friends", "Couple", "Siblings", "Coworkers", "Former friends", "Strangers"],
  genres: ["You choose", "Comedy", "Mystery", "Drama", "Wholesome", "Suspense"],
  situations: ["You choose", "Unexpected discovery", "Misunderstanding", "Risky request", "Hidden mistake", "Old promise", "Wrong recipient"],
  endings: ["You choose", "Revealing twist", "Reconciliation", "Difficult decision", "Comic reversal", "Cliffhanger"],
} as const;
const eventTypes: Array<{ id: ConversationEventType; label: string }> = [
  { id: "text", label: "Text / emoji" },
  { id: "image", label: "Image / GIF" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Voice note" },
  { id: "typing", label: "Typing" },
  { id: "notification", label: "Notification" },
  { id: "battery", label: "Low battery" },
  { id: "call", label: "Call" },
  { id: "chat-switch", label: "Switch chat" },
  { id: "system", label: "System" },
  { id: "date", label: "Date" },
];

export function MessageConversationView({
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
  const [step, setStep] = useState<Step>("setup");
  const [draft, setDraft] = useState<ConversationDraft | null>(null);
  const draftRef = useRef<ConversationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderJob, setRenderJob] = useState<LocalJob | null>(null);
  const [starterMode, setStarterMode] = useState<StarterMode>("guided");
  const [premise, setPremise] = useState("");
  const [genre, setGenre] = useState("social chat story");
  const [tone, setTone] = useState("tense, intimate, and natural");
  const [ending, setEnding] = useState("end on a reveal that changes how the opening message feels");
  const [starterRelationship, setStarterRelationship] = useState("You choose");
  const [starterGenre, setStarterGenre] = useState("You choose");
  const [starterSituation, setStarterSituation] = useState("You choose");
  const [starterEnding, setStarterEnding] = useState("You choose");
  const [storyPitches, setStoryPitches] = useState<ConversationStoryPitch[]>([]);
  const [selectedPitchId, setSelectedPitchId] = useState("");
  const [starterGenerating, setStarterGenerating] = useState(false);
  const [starterMessage, setStarterMessage] = useState("");
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [previewAudioState, setPreviewAudioState] = useState<"idle" | "suspended" | "running" | "unavailable">("idle");
  const [lastPreviewSound, setLastPreviewSound] = useState("");
  const [previewSpeed, setPreviewSpeed] = useState(1);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [rendererReady, setRendererReady] = useState<boolean | null>(null);
  const [voiceSample, setVoiceSample] = useState("");
  const [voiceSampling, setVoiceSampling] = useState(false);
  const [translateLanguage, setTranslateLanguage] = useState("Spanish");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const historyRef = useRef<ConversationDraft[]>([]);
  const futureRef = useRef<ConversationDraft[]>([]);
  const savePromiseRef = useRef<Promise<ConversationDraft | null> | null>(null);
  const previewAudioRef = useRef<AudioContext | null>(null);
  const previewMutedRef = useRef(false);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { previewMutedRef.current = previewMuted; }, [previewMuted]);
  useEffect(() => () => { void previewAudioRef.current?.close(); }, []);

  const preparePreviewAudio = useCallback(() => {
    const AudioContextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      setPreviewAudioState("unavailable");
      return null;
    }
    const context = previewAudioRef.current ?? new AudioContextClass();
    previewAudioRef.current = context;
    setPreviewAudioState(context.state === "running" ? "running" : "suspended");
    if (context.state === "suspended") {
      void context.resume().then(() => setPreviewAudioState(context.state === "running" ? "running" : "suspended"));
    }
    return context;
  }, []);

  const playPreviewSound = useCallback((kind: "outgoing" | "incoming" | "read" | "call" | "notification" | "battery" | "switch") => {
    const current = draftRef.current;
    if (previewMutedRef.current || !current || current.audio.mode === "silent" || current.audio.sfxVolume <= 0) return;
    const context = preparePreviewAudio();
    if (!context) return;
    setLastPreviewSound(kind);
    const profiles: Record<typeof kind, Array<[number, number, number, OscillatorType, number]>> = {
      outgoing: [[0, 780, 0.075, "sine", 0.34], [0.046, 1_080, 0.12, "sine", 0.42]],
      incoming: [[0, 820, 0.1, "sine", 0.4], [0.058, 610, 0.15, "sine", 0.46]],
      read: [[0, 1_120, 0.055, "sine", 0.22], [0.052, 1_360, 0.085, "sine", 0.28]],
      call: [[0, 620, 0.2, "sine", 0.32], [0.18, 780, 0.24, "sine", 0.28]],
      notification: [[0, 880, 0.09, "sine", 0.35], [0.09, 1_180, 0.14, "sine", 0.31]],
      battery: [[0, 410, 0.11, "sine", 0.24], [0.145, 330, 0.18, "sine", 0.3]],
      switch: [[0, 520, 0.05, "sine", 0.12]],
    };
    const now = context.currentTime + 0.005;
    for (const [offset, frequency, duration, type, level] of profiles[kind]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + offset;
      const end = start + duration;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, current.audio.sfxVolume * level), start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.01);
    }
  }, [preparePreviewAudio]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    let cancelled = false;
    Promise.all([
      serviceFetch(`${SERVICE_URL}/conversation-drafts`).then((response) => response.json() as Promise<{ drafts?: ConversationDraft[] }>),
      serviceFetch(`${SERVICE_URL}/health`).then((response) => response.json() as Promise<{ conversationRenderer?: { ready?: boolean } }>).catch(() => ({})),
    ]).then(async ([draftResult, health]) => {
      if (cancelled) return;
      const renderer = (health as { conversationRenderer?: { enabled?: boolean; ready?: boolean } }).conversationRenderer;
      setRendererReady(Boolean(renderer?.enabled !== false && renderer?.ready));
      let next = draftResult.drafts?.[0] ?? null;
      if (!next) {
        const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const value = await response.json() as { draft?: ConversationDraft; error?: string };
        if (!response.ok || !value.draft) throw new Error(value.error || "Conversation draft could not be created");
        next = value.draft;
      }
      if (!cancelled) {
        setDraft(next);
        setPreviewRevision(next.revision);
      }
    }).catch((error) => {
      if (!cancelled) setToast(error instanceof Error ? error.message : "Conversation editor could not open");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authenticated, setToast]);

  const persistDraft = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return null;
    if (savePromiseRef.current) return savePromiseRef.current;
    setSaving(true);
    const snapshot = structuredClone(current);
    const promise = serviceFetch(`${SERVICE_URL}/conversation-drafts/${snapshot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    }).then(async (response) => {
      const value = await response.json() as { draft?: ConversationDraft; error?: string };
      if (!response.ok || !value.draft) throw new Error(value.error || "Conversation could not be saved");
      const latest = draftRef.current;
      if (latest && latest.id === snapshot.id) {
        const unchanged = draftFingerprint(latest) === draftFingerprint(snapshot);
        const merged = unchanged ? value.draft : { ...latest, revision: value.draft.revision, validation: value.draft.validation, updatedAt: value.draft.updatedAt };
        draftRef.current = merged;
        setDraft(merged);
        setDirty(!unchanged);
      }
      return value.draft;
    }).catch((error) => {
      setToast(error instanceof Error ? error.message : "Conversation could not be saved");
      return null;
    }).finally(() => {
      savePromiseRef.current = null;
      setSaving(false);
    });
    savePromiseRef.current = promise;
    return promise;
  }, [setToast]);

  useEffect(() => {
    if (!dirty || !draft) return;
    const timer = window.setTimeout(() => void persistDraft(), 850);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, persistDraft]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "reelio-conversation-ready") {
        setPreviewDuration(Number(event.data.durationMs ?? 0));
        setPreviewTime(0);
      }
      if (event.data?.type === "reelio-conversation-time") {
        setPreviewTime(Number(event.data.ms ?? 0));
        setPreviewDuration(Number(event.data.durationMs ?? 0));
      }
      if (event.data?.type === "reelio-conversation-ended") setPreviewPlaying(false);
      if (event.data?.type === "reelio-conversation-sfx" && ["outgoing", "incoming", "read", "call", "notification", "battery", "switch"].includes(event.data.kind)) {
        playPreviewSound(event.data.kind as "outgoing" | "incoming" | "read" | "call" | "notification" | "battery" | "switch");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [playPreviewSound]);

  const renderJobId = renderJob?.id;
  const renderJobState = renderJob?.state;
  useEffect(() => {
    if (!renderJobId || !renderJobState || !["queued", "running"].includes(renderJobState)) return;
    let cancelled = false;
    const poll = async () => {
      const response = await serviceFetch(`${SERVICE_URL}/jobs/${renderJobId}`);
      const value = await response.json() as { job?: LocalJob; error?: string };
      if (cancelled || !value.job) return;
      setRenderJob(value.job);
      if (value.job.state === "completed") {
        setRendering(false);
        setToast("Message Conversation video is ready");
      } else if (value.job.state === "failed" || value.job.state === "stopped") {
        setRendering(false);
        setToast(value.job.error || value.job.message);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1_200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [renderJobId, renderJobState, setToast]);

  const durationMs = useMemo(() => draft ? estimateDuration(draft.events) : 0, [draft]);
  const isValidDuration = durationMs >= 6_000;
  const assetsComplete = !draft || draft.events.every((event) => !["image", "video", "audio"].includes(event.type) || Boolean(event.assetId))
    && (!["image", "motion"].includes(draft.appearance.background.type) || Boolean(draft.appearance.background.assetId))
    && (draft.audio.musicSource !== "upload" || Boolean(draft.audio.musicAssetId))
    && (draft.audio.musicSource !== "brand" || draft.applyBrandKit);
  const characterVoicesValid = !draft || draft.audio.mode !== "characters"
    || draft.participants.length <= 4 && new Set(draft.participants.map((item) => item.narratorId)).size === draft.participants.length;

  function updateDraft(update: (current: ConversationDraft) => ConversationDraft, recordHistory = true) {
    setDraft((current) => {
      if (!current) return current;
      if (recordHistory) {
        historyRef.current = [...historyRef.current.slice(-39), structuredClone(current)];
        futureRef.current = [];
      }
      const next = update(structuredClone(current));
      next.approved = false;
      draftRef.current = next;
      setDirty(true);
      return next;
    });
  }

  function undo() {
    const previous = historyRef.current.pop();
    if (!previous || !draft) return;
    futureRef.current.push(structuredClone(draft));
    previous.revision = draft.revision;
    previous.approved = false;
    setDraft(previous);
    setDirty(true);
  }

  function redo() {
    const next = futureRef.current.pop();
    if (!next || !draft) return;
    historyRef.current.push(structuredClone(draft));
    next.revision = draft.revision;
    next.approved = false;
    setDraft(next);
    setDirty(true);
  }

  async function saveAndRefreshPreview() {
    const saved = await persistDraft();
    if (saved) {
      setPreviewRevision(saved.revision);
      setToast(`Preview updated to revision ${saved.revision}`);
    }
  }

  function useGuidedStarter() {
    const relationship = starterRelationship === "You choose" ? "Two people with unfinished history" : {
      "Close friends": "Two close friends",
      Couple: "A couple",
      Siblings: "Two siblings",
      Coworkers: "Two coworkers",
      "Former friends": "Two former friends",
      Strangers: "Two strangers",
    }[starterRelationship] ?? "Two people";
    const situation = {
      "Unexpected discovery": "one finds evidence that contradicts a story they both accepted",
      Misunderstanding: "a small misunderstanding exposes a larger assumption neither had questioned",
      "Risky request": "one asks for a favor that becomes harder to justify with every reply",
      "Hidden mistake": "an ordinary mistake reveals that one person has been hiding a second problem",
      "Old promise": "an old promise becomes relevant in a way neither expected",
      "Wrong recipient": "a message reaches the one person who was never meant to see it",
      "You choose": "an ordinary message uncovers a specific problem neither can ignore",
    }[starterSituation] ?? "an ordinary message uncovers a specific problem neither can ignore";
    const endingDirection = {
      "Revealing twist": "a final concrete detail changes the meaning of the opening message",
      Reconciliation: "they make one believable choice that begins repairing the relationship",
      "Difficult decision": "the phone owner must make a clear decision with a real cost",
      "Comic reversal": "the apparent problem reverses for an earned, character-based reason",
      Cliffhanger: "the last incoming message creates one precise unanswered consequence",
      "You choose": "the final exchange changes what one participant will do next",
    }[starterEnding] ?? "the final exchange changes what one participant will do next";
    setPremise(`${relationship} begin messaging when ${situation}; the exchange escalates through specific discoveries until ${endingDirection}.`);
    setGenre(starterGenre === "You choose" ? "social chat story" : starterGenre);
    setTone(starterGenre === "Comedy"
      ? "dry, character-led, and naturally paced"
      : starterGenre === "Wholesome"
        ? "warm, understated, and sincere"
        : "natural, specific, and steadily escalating");
    setEnding(endingDirection);
    setSelectedPitchId("");
    setStarterMessage("Guided premise created locally. Edit anything below before generating the conversation.");
  }

  async function requestStoryPitches() {
    if (!draft || !onRequireAuthentication()) return;
    setStarterGenerating(true);
    setStarterMessage("");
    try {
      const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts/${draft.id}/story-starters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          relationship: starterRelationship,
          genre: starterGenre,
          situation: starterSituation,
          endingStyle: starterEnding,
          targetSeconds,
        }),
      });
      const value = await response.json() as {
        pitches?: ConversationStoryPitch[];
        mode?: "ai" | "curated";
        provider?: string;
        model?: string | null;
        message?: string;
        error?: string;
      };
      if (!response.ok || !value.pitches?.length) throw new Error(value.error || "Story ideas could not be generated");
      setStoryPitches(value.pitches);
      setSelectedPitchId("");
      setStarterMessage(value.message || (value.mode === "ai" ? "Three AI story ideas are ready." : "Three local story ideas are ready."));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Story ideas could not be generated");
    } finally {
      setStarterGenerating(false);
    }
  }

  function selectStoryPitch(pitch: ConversationStoryPitch) {
    setSelectedPitchId(pitch.id);
    setPremise(pitch.premise);
    setGenre(pitch.genre === "You choose" ? "social chat story" : pitch.genre);
    setTone(pitch.tone);
    setEnding(pitch.ending);
    setStarterMessage(`“${pitch.title}” selected. Review the editable details below before generating.`);
  }

  function applyPitchCast(pitch: ConversationStoryPitch) {
    if (!pitch.cast.length) return;
    updateDraft((next) => {
      const owner = pitch.cast.find((member) => member.isSelf) ?? pitch.cast[0];
      const others = pitch.cast.filter((member) => member !== owner);
      let otherIndex = 0;
      return {
        ...next,
        participants: next.participants.map((participant) => {
          const member = participant.isSelf ? owner : others[otherIndex++];
          if (!member?.name) return participant;
          return { ...participant, name: member.name, initials: initials(member.name) };
        }),
      };
    });
    setToast("Suggested fictional names applied; participant roles remain visible on the pitch");
  }

  async function generateDraft() {
    if (!draft || !onRequireAuthentication()) return;
    setGenerating(true);
    try {
      const saved = await persistDraft();
      const selectedPitch = storyPitches.find((pitch) => pitch.id === selectedPitchId);
      const pitchOwner = selectedPitch?.cast.find((member) => member.isSelf) ?? selectedPitch?.cast[0];
      const pitchOthers = selectedPitch?.cast.filter((member) => member !== pitchOwner) ?? [];
      let pitchOtherIndex = 0;
      const participantRoles = draft.participants.map((participant) => ({
        participantId: participant.id,
        role: participant.isSelf ? pitchOwner?.role : pitchOthers[pitchOtherIndex++]?.role,
      })).filter((item) => item.role);
      const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts/${draft.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ premise, tone, ending, genre, targetSeconds, participantRoles }),
      });
      const value = await response.json() as { draft?: ConversationDraft; error?: string };
      if (!response.ok || !value.draft) throw new Error(value.error || "Conversation generation failed");
      historyRef.current.push(structuredClone(saved ?? draft));
      setDraft(value.draft);
      setDirty(false);
      setStep("write");
      setToast("AI conversation draft ready for full review");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Conversation generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function duplicateAndTranslate() {
    if (!draft || translateLanguage === draft.language) return;
    if (!window.confirm(`Send this fictional conversation text to the configured AI provider and create an editable ${translateLanguage} copy?`)) return;
    try {
      await persistDraft();
      const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts/${draft.id}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: translateLanguage, confirmed: true }),
      });
      const value = await response.json() as { draft?: ConversationDraft; error?: string };
      if (!response.ok || !value.draft) throw new Error(value.error || "Translation failed");
      historyRef.current = [];
      futureRef.current = [];
      setDraft(value.draft);
      setDirty(false);
      setStep("write");
      setToast(`${translateLanguage} conversation copy ready for review`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Translation failed");
    }
  }

  async function duplicateDraft() {
    if (!draft) return;
    try {
      await persistDraft();
      const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts/${draft.id}/duplicate`, { method: "POST" });
      const value = await response.json() as { draft?: ConversationDraft; error?: string };
      if (!response.ok || !value.draft) throw new Error(value.error || "Conversation could not be duplicated");
      historyRef.current = [];
      futureRef.current = [];
      setDraft(value.draft);
      setDirty(false);
      setStep("write");
      setToast("Editable conversation copy created");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Conversation could not be duplicated");
    }
  }

  function addParticipant() {
    if (!draft || draft.participants.length >= 12) return;
    const id = crypto.randomUUID();
    const narratorId = narrators[draft.participants.length % narrators.length].id;
    updateDraft((next) => {
      next.participants.push({ id, name: `Character ${next.participants.length + 1}`, initials: `C${next.participants.length + 1}`, color: "#e068a5", isSelf: false, narratorId });
      return next;
    });
  }

  function updateParticipant(id: string, patch: Partial<ConversationParticipant>) {
    updateDraft((next) => {
      next.participants = next.participants.map((item) => item.id === id ? { ...item, ...patch } : patch.isSelf ? { ...item, isSelf: false } : item);
      return next;
    });
  }

  function removeParticipant(id: string) {
    if (!draft || draft.participants.length <= 2 || draft.participants.some((item) => item.id === id && item.isSelf)) return;
    updateDraft((next) => {
      next.participants = next.participants.filter((item) => item.id !== id);
      next.events = next.events.filter((event) => event.participantId !== id).map((event) => ({
        ...event,
        reactions: event.reactions.filter((reaction) => reaction.participantId !== id),
      }));
      return next;
    });
  }

  function addEvent(type: ConversationEventType = "text") {
    if (!draft || draft.events.length >= 200) return;
    const participant = draft.participants.find((item) => !item.isSelf) ?? draft.participants[0];
    const next: ConversationEvent = {
      id: crypto.randomUUID(),
      type,
      participantId: ["system", "date", "battery", "chat-switch"].includes(type) ? null : participant.id,
      text: type === "date" ? "Today" : type === "call" ? "Phone call" : type === "chat-switch" ? "Another conversation" : ["text", "notification"].includes(type) ? "New message" : "",
      assetId: null,
      fileName: "",
      delayBeforeMs: 650,
      holdMs: type === "call" ? 8_000 : ["image", "video", "audio"].includes(type) ? 3_000 : type === "battery" ? 2_800 : type === "notification" ? 2_400 : type === "chat-switch" ? 700 : 1_500,
      typingMs: type === "text" ? 1_250 : 0,
      typingStyle: "natural",
      chatId: "primary",
      chatTitle: type === "chat-switch" ? "Another conversation" : "",
      displayTime: draft.clock.startTime,
      receipt: "none",
      replyToEventId: null,
      reactions: [],
      edited: false,
      deleted: false,
      playAudio: false,
      callState: type === "call" ? "incoming" : null,
      callDialogue: [],
      notificationTitle: type === "notification" ? participant.name : "",
      batteryLevel: type === "battery" ? 10 : null,
      charging: false,
    };
    updateDraft((value) => ({ ...value, events: [...value.events, next] }));
  }

  function updateEvent(id: string, patch: Partial<ConversationEvent>) {
    updateDraft((next) => {
      next.events = next.events.map((item) => item.id === id ? { ...item, ...patch } : item);
      return next;
    }, false);
  }

  function moveEvent(index: number, direction: -1 | 1) {
    if (!draft || index + direction < 0 || index + direction >= draft.events.length) return;
    updateDraft((next) => {
      const events = [...next.events];
      [events[index], events[index + direction]] = [events[index + direction], events[index]];
      next.events = events;
      return next;
    });
  }

  function duplicateEvent(event: ConversationEvent) {
    updateDraft((next) => {
      const index = next.events.findIndex((item) => item.id === event.id);
      next.events.splice(index + 1, 0, { ...structuredClone(event), id: crypto.randomUUID(), replyToEventId: null });
      return next;
    });
  }

  function deleteEvent(id: string) {
    if (!draft || draft.events.length <= 1) return;
    updateDraft((next) => {
      next.events = next.events.filter((item) => item.id !== id).map((item) => item.replyToEventId === id ? { ...item, replyToEventId: null } : item);
      return next;
    });
  }

  async function uploadDraftAsset(file: File, kind: ConversationAsset["kind"]) {
    if (!draft) return null;
    const response = await serviceFetch(`${SERVICE_URL}/conversation-drafts/${draft.id}/assets?kind=${kind}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const value = await response.json() as { asset?: ConversationAsset; error?: string };
    if (!response.ok || !value.asset) throw new Error(value.error || "Conversation media upload failed");
    setToast(`${value.asset.name} added locally`);
    return value.asset;
  }

  async function uploadEventAsset(event: ConversationEvent, file: File) {
    const kind = event.type === "audio" ? "audio" : event.type === "video" ? "video" : "image";
    try {
      const asset = await uploadDraftAsset(file, kind);
      if (asset) updateEvent(event.id, { assetId: asset.id, fileName: asset.name, holdMs: Math.max(event.holdMs, Math.round((asset.durationSeconds ?? 0) * 1_000)) });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Conversation media upload failed");
    }
  }

  async function uploadParticipantAvatar(participantId: string, file: File) {
    try {
      const asset = await uploadDraftAsset(file, "avatar");
      if (asset) updateParticipant(participantId, { avatarAssetId: asset.id });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Avatar upload failed");
    }
  }

  async function uploadBackground(file: File) {
    if (!draft) return;
    try {
      const kind = draft.appearance.background.type === "motion" ? "motion" : "background";
      const asset = await uploadDraftAsset(file, kind);
      if (asset) updateDraft((next) => ({
        ...next,
        appearance: { ...next.appearance, background: { ...next.appearance.background, assetId: asset.id } },
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Background upload failed");
    }
  }

  async function uploadMusic(file: File) {
    try {
      const asset = await uploadDraftAsset(file, "audio");
      if (asset) updateDraft((next) => ({
        ...next,
        audio: { ...next.audio, musicEnabled: true, musicSource: "upload", musicAssetId: asset.id },
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Conversation soundtrack upload failed");
    }
  }

  function applyAutomaticTiming() {
    if (!draft) return;
    const locale = ({ Thai: "th", Burmese: "my", Arabic: "ar", Hebrew: "he", Chinese: "zh", Japanese: "ja", Korean: "ko" } as Record<string, string>)[draft.language] ?? "en";
    const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(locale, { granularity: "grapheme" }) : null;
    updateDraft((next) => ({
      ...next,
      events: next.events.map((event) => {
        const graphemes = segmenter ? [...segmenter.segment(event.text || "")].length : Array.from(event.text || "").length;
        const slowScript = ["Thai", "Burmese", "Arabic", "Hebrew"].includes(next.language);
        const participant = next.participants.find((item) => item.id === event.participantId);
        const typingRates = participant?.isSelf
          ? { fast: 38, clean: 50, natural: 75, hesitant: 105 }
          : { fast: 55, clean: 75, natural: 110, hesitant: 155 };
        const typingStyle = event.typingStyle || (participant?.isSelf ? "fast" : "natural");
        const holdMs = ["image", "video", "audio", "call"].includes(event.type)
          ? Math.max(event.holdMs, 3_000)
          : event.type === "typing"
            ? Math.max(900, event.holdMs)
            : Math.max(1_200, Math.min(9_000, 850 + graphemes * (slowScript ? 105 : 78)));
        return {
          ...event,
          delayBeforeMs: event.type === "date" ? 250 : event.type === "chat-switch" ? 180 : 550,
          typingMs: event.type === "text" && !event.deleted
            ? Math.max(participant?.isSelf ? 500 : 700, Math.min(300_000, graphemes * typingRates[typingStyle]))
            : 0,
          typingStyle: event.type === "text" ? typingStyle : event.typingStyle,
          holdMs,
        };
      }),
    }));
  }

  async function sampleVoice() {
    if (!draft) return;
    const event = draft.events.find((item) => item.type === "text" && item.text.trim());
    if (!event) return setToast("Add a text message before sampling a voice");
    const participant = draft.participants.find((item) => item.id === event.participantId);
    const narratorId = draft.audio.mode === "characters" ? participant?.narratorId ?? "maya" : draft.audio.narratorId;
    setVoiceSampling(true);
    try {
      const response = await serviceFetch(`${SERVICE_URL}/voice-previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: event.text.slice(0, 240), language: draft.language, ttsEngine: draft.audio.ttsEngine, narratorId }),
      });
      const value = await response.json() as { url?: string; error?: string };
      if (!response.ok || !value.url) throw new Error(value.error || "Voice sample failed");
      setVoiceSample(`${SERVICE_URL}${value.url}`);
      setToast("Voice sample prepared from the first message");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Voice sample failed");
    } finally {
      setVoiceSampling(false);
    }
  }

  function sendPreview(type: string, extra: Record<string, unknown> = {}) {
    iframeRef.current?.contentWindow?.postMessage({ type, ...extra }, "*");
  }

  async function toggleApproval(approved: boolean) {
    if (!draft) return;
    const next = { ...draft, approved };
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    await persistDraft();
  }

  async function startRender() {
    if (!draft || !onRequireAuthentication()) return;
    if (!rendererReady) return setToast("Run npm run conversation:setup before final rendering");
    if (!draft.approved) return setToast("Approve the final conversation preview before rendering");
    if (!isValidDuration) return setToast("Conversation playback must be at least 6 seconds");
    if (!assetsComplete) return setToast("Add every selected local attachment and background before rendering");
    if (!characterVoicesValid) return setToast("Character mode needs two to four distinct voices");
    setRendering(true);
    try {
      const saved = await persistDraft();
      const current = saved ?? draftRef.current;
      if (!current?.approved) throw new Error("The latest revision needs approval before rendering");
      const response = await serviceFetch(`${SERVICE_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creationMode: "message-conversation", draftId: current.id, draftRevision: current.revision }),
      });
      const value = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !value.job) throw new Error(value.error || "Conversation render could not start");
      setRenderJob(value.job);
      setToast("Approved conversation queued for recording");
    } catch (error) {
      setRendering(false);
      setToast(error instanceof Error ? error.message : "Conversation render could not start");
    }
  }

  if (!authenticated) {
    return <div className="content-wrap conversation-mode-page"><button className="mode-back-button" onClick={onBackToModes}><ArrowLeft size={14} /> All video modes</button><div className="conversation-empty"><MessageCircleMore size={34} /><h1>Message Conversation</h1><p>Sign in to create durable fictional conversation drafts and render them locally.</p><button onClick={onRequireAuthentication}>Sign in to start</button></div></div>;
  }
  if (loading || !draft) {
    return <div className="content-wrap conversation-mode-page"><div className="conversation-loading"><LoaderCircle className="spin" /> Opening conversation studio…</div></div>;
  }

  return (
    <div className="content-wrap conversation-mode-page">
      <button className="mode-back-button" onClick={onBackToModes}><ArrowLeft size={14} /> All video modes</button>
      <div className="conversation-heading">
        <div><div className="eyebrow"><span /> MESSAGE CONVERSATION</div><h1>Write the chat. Control the reveal.</h1><p>Build a fictional phone conversation, play the exact webpage, then record it as a vertical video.</p></div>
        <div className="conversation-save-state"><Save size={14} /> {saving ? "Saving…" : dirty ? "Changes pending" : `Saved revision ${draft.revision}`}</div>
      </div>

      <nav className="conversation-stepper" aria-label="Conversation workflow">
        {([
          ["setup", "1", "Setup"],
          ["write", "2", "Write"],
          ["timing", "3", "Timing & audio"],
          ["preview", "4", "Preview & render"],
        ] as Array<[Step, string, string]>).map(([id, number, label]) => <button key={id} className={step === id ? "active" : ""} onClick={() => setStep(id)}><b>{number}</b><span>{label}</span><ChevronRight size={14} /></button>)}
      </nav>

      {step === "setup" && <div className="conversation-workspace setup">
        <section className="conversation-panel">
          <PanelTitle icon={<MessageCircleMore size={18} />} title="Story and phone" detail="Original Reelio styling with a mandatory fictional label." />
          <div className="conversation-form-grid">
            <Field label="Project title"><input value={draft.title} maxLength={100} onChange={(event) => updateDraft((next) => ({ ...next, title: event.target.value }), false)} /></Field>
            <Field label="Language"><select value={draft.language} onChange={(event) => updateDraft((next) => ({ ...next, language: event.target.value, audio: { ...next.audio, ttsEngine: defaultTtsEngine(event.target.value) } }))}>{speechLanguages.map((language) => <option key={language}>{language}</option>)}</select></Field>
            <Field label="Fictional date"><input type="date" value={draft.clock.startDate} onChange={(event) => updateDraft((next) => ({ ...next, clock: { ...next.clock, startDate: event.target.value } }), false)} /></Field>
            <Field label="Starting clock"><input type="time" value={draft.clock.startTime} onChange={(event) => updateDraft((next) => ({ ...next, clock: { ...next.clock, startTime: event.target.value } }), false)} /></Field>
            <Field label="Clock format"><select value={draft.clock.format} onChange={(event) => updateDraft((next) => ({ ...next, clock: { ...next.clock, format: event.target.value as "12h" | "24h" } }))}><option value="12h">12-hour</option><option value="24h">24-hour</option></select></Field>
            <Field label="Phone layout"><select value={draft.appearance.layout} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, layout: event.target.value as "screen" | "device" } }))}><option value="screen">Edge-to-edge screen</option><option value="device">Phone on background</option></select></Field>
            <Field label="Reelio theme"><select value={draft.appearance.theme} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, theme: event.target.value as ConversationDraft["appearance"]["theme"] } }))}><option value="reelio-dark">Reelio Dark</option><option value="reelio-light">Reelio Light</option><option value="minimal">Minimal</option><option value="brand">Brand Kit colors</option></select></Field>
            <Field label="Background"><select value={draft.appearance.background.type} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, background: { ...next.appearance.background, type: event.target.value as ConversationDraft["appearance"]["background"]["type"] } } }))}><option value="solid">Solid</option><option value="gradient">Gradient</option><option value="image">Local image</option><option value="motion">Local motion</option></select></Field>
            <Field label="Bubble shape"><select value={draft.appearance.bubbleStyle} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, bubbleStyle: event.target.value as ConversationDraft["appearance"]["bubbleStyle"] } }))}><option value="soft">Soft</option><option value="square">Square</option><option value="compact">Compact</option></select></Field>
            <Field label="Base color"><input className="conversation-color-input" type="color" value={draft.appearance.background.color} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, background: { ...next.appearance.background, color: event.target.value } } }), false)} /></Field>
            <Field label="Accent color"><input className="conversation-color-input" type="color" value={draft.appearance.background.accentColor} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, background: { ...next.appearance.background, accentColor: event.target.value } } }), false)} /></Field>
            {["image", "motion"].includes(draft.appearance.background.type) && <Field label="Local background"><label className={`event-upload ${draft.appearance.background.assetId ? "ready" : ""}`}><input type="file" accept={draft.appearance.background.type === "motion" ? "video/*" : "image/*"} onChange={(event) => event.target.files?.[0] && void uploadBackground(event.target.files[0])} /><Upload size={14} /><span>{draft.appearance.background.assetId ? "Background ready" : "Choose local file"}</span>{draft.appearance.background.assetId && <Check size={13} />}</label></Field>}
          </div>
          <label className="conversation-check"><input type="checkbox" checked={draft.applyBrandKit} onChange={(event) => updateDraft((next) => ({ ...next, applyBrandKit: event.target.checked }))} /><span><strong>Apply active Brand Kit</strong><small>Snapshots supported colors, font, logo, intro/outro, and music when rendering.</small></span></label>
          <div className="fiction-policy"><Check size={16} /><span><strong>Fiction-only mode</strong><small>“Fictional conversation · Reelio” stays visible in preview and final video.</small></span></div>
        </section>
        <section className="conversation-panel participants">
          <PanelTitle icon={<Users size={18} />} title={`Participants · ${draft.participants.length}/12`} detail="Choose exactly one phone owner." />
          {draft.participants.map((participant) => <div className="participant-row" key={participant.id}>
            <span className="participant-color" style={{ background: participant.color }}>{participant.initials}</span>
            <div><input value={participant.name} maxLength={40} onChange={(event) => updateParticipant(participant.id, { name: event.target.value, initials: initials(event.target.value) })} /><label><input type="radio" checked={participant.isSelf} onChange={() => updateParticipant(participant.id, { isSelf: true })} /> Phone owner</label></div>
            <input className="color-input" type="color" value={participant.color} onChange={(event) => updateParticipant(participant.id, { color: event.target.value })} />
            <label className="participant-upload" title="Upload local avatar"><input type="file" accept="image/*" onChange={(event) => event.target.files?.[0] && void uploadParticipantAvatar(participant.id, event.target.files[0])} /><Upload size={13} />{participant.avatarAssetId ? <Check size={12} /> : null}</label>
            <button onClick={() => removeParticipant(participant.id)} disabled={participant.isSelf || draft.participants.length <= 2} aria-label={`Remove ${participant.name}`}><Trash2 size={14} /></button>
          </div>)}
          <button className="conversation-add" onClick={addParticipant} disabled={draft.participants.length >= 12}><Plus size={15} /> Add participant</button>
        </section>
      </div>}

      {step === "write" && <div className="conversation-workspace write">
        <section className="conversation-panel ai-draft">
          <PanelTitle icon={<Bot size={18} />} title="Story starter" detail="Start with your idea, shape one from simple choices, or ask for three pitches." />
          <div className="story-starter-tabs" role="tablist" aria-label="Choose how to start the conversation story">
            <button className={starterMode === "own" ? "active" : ""} onClick={() => setStarterMode("own")} aria-pressed={starterMode === "own"}>I have an idea</button>
            <button className={starterMode === "guided" ? "active" : ""} onClick={() => setStarterMode("guided")} aria-pressed={starterMode === "guided"}>Help me shape it</button>
            <button className={starterMode === "surprise" ? "active" : ""} onClick={() => setStarterMode("surprise")} aria-pressed={starterMode === "surprise"}>Surprise me</button>
          </div>

          {starterMode === "own" && <div className="story-starter-note"><MessageCircleMore size={15} /><span><strong>Write only what you know</strong><small>A single situation is enough. Reelio will develop the beats after you review the premise.</small></span></div>}

          {starterMode === "guided" && <div className="story-guided">
            <p>Pick as much or as little as you want. “You choose” leaves that decision open.</p>
            <StarterChoice label="Relationship" value={starterRelationship} options={starterOptions.relationships} onChange={setStarterRelationship} />
            <StarterChoice label="Genre" value={starterGenre} options={starterOptions.genres} onChange={setStarterGenre} />
            <StarterChoice label="Situation" value={starterSituation} options={starterOptions.situations} onChange={setStarterSituation} />
            <StarterChoice label="Ending" value={starterEnding} options={starterOptions.endings} onChange={setStarterEnding} />
            <button className="story-guided-button" onClick={useGuidedStarter}><Sparkles size={15} /> Build editable premise <small>No AI tokens</small></button>
          </div>}

          {starterMode === "surprise" && <div className="story-surprise">
            <p>Reelio creates three different pitch cards first—not a conversation. Filters are optional.</p>
            <div className="story-surprise-filters">
              <label><span>Relationship</span><select value={starterRelationship} onChange={(event) => setStarterRelationship(event.target.value)}>{starterOptions.relationships.map((option) => <option key={option}>{option}</option>)}</select></label>
              <label><span>Genre</span><select value={starterGenre} onChange={(event) => setStarterGenre(event.target.value)}>{starterOptions.genres.map((option) => <option key={option}>{option}</option>)}</select></label>
            </div>
            <button className="story-surprise-button" onClick={() => void requestStoryPitches()} disabled={starterGenerating}>{starterGenerating ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {starterGenerating ? "Developing three pitches…" : storyPitches.length ? "Show three different ideas" : "Suggest three story ideas"} <small>AI action</small></button>
            {storyPitches.length > 0 && <div className="story-pitch-list">{storyPitches.map((pitch) => <article key={pitch.id} className={`story-pitch-card ${selectedPitchId === pitch.id ? "selected" : ""}`}>
              <header><span><strong>{pitch.title}</strong><small>{pitch.relationship} · {pitch.genre}</small></span>{selectedPitchId === pitch.id && <Check size={16} />}</header>
              <p>{pitch.premise}</p>
              {pitch.cast.length > 0 && <div className="story-pitch-cast">{pitch.cast.map((member) => <span key={`${pitch.id}-${member.name}`}><b>{member.name}</b><small>{member.role}</small></span>)}</div>}
              <footer><button onClick={() => selectStoryPitch(pitch)}>{selectedPitchId === pitch.id ? "Selected" : "Use this story"}</button>{pitch.cast.length > 0 && <button onClick={() => applyPitchCast(pitch)}>Apply names</button>}</footer>
            </article>)}</div>}
          </div>}

          {starterMessage && <div className="story-starter-status" role="status"><Check size={14} /> {starterMessage}</div>}
          <div className="story-draft-divider"><span>Editable story direction</span></div>
          <Field label="Premise"><textarea value={premise} maxLength={700} placeholder="Example: Two coworkers discover they sent the wrong document five minutes before a client call." onChange={(event) => setPremise(event.target.value)} /></Field>
          <Field label="Genre"><input value={genre} maxLength={80} onChange={(event) => setGenre(event.target.value)} /></Field>
          <Field label="Tone"><input value={tone} maxLength={80} onChange={(event) => setTone(event.target.value)} /></Field>
          <Field label="Desired ending"><textarea value={ending} maxLength={220} onChange={(event) => setEnding(event.target.value)} /></Field>
          <Field label="Approximate target length · seconds"><input type="number" min="15" step="5" value={targetSeconds} onChange={(event) => setTargetSeconds(Math.max(15, Number(event.target.value) || 15))} /><small className="field-help">This guides pacing only. Reelio will finish the story and does not impose a maximum render duration.</small></Field>
          <div className="conversation-generation-disclosure"><Bot size={14} /><span>This explicit AI action develops three competing story treatments, independently scores them, rejects a weak batch, writes only the winner, and runs genre plus first-time-viewer clarity edits. Reelio adds timing and phone behavior locally afterward. The result remains editable and unapproved.</span></div>
          <button className="conversation-ai-button" onClick={() => void generateDraft()} disabled={generating || premise.trim().length < 3}>{generating ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {generating ? "Competing, judging, writing, and auditing…" : "Generate quality-checked conversation"}</button>
          <div className="translate-row"><button onClick={() => void duplicateDraft()}><Copy size={14} /> Duplicate</button><select value={translateLanguage} onChange={(event) => setTranslateLanguage(event.target.value)}>{speechLanguages.filter((language) => language !== draft.language).map((language) => <option key={language}>{language}</option>)}</select><button onClick={() => void duplicateAndTranslate()}><Copy size={14} /> Duplicate & translate</button></div>
        </section>
        <section className="conversation-panel event-editor">
          <div className="event-editor-header"><PanelTitle icon={<MessageCircleMore size={18} />} title={`Conversation · ${draft.events.length}/200`} detail="Messages play in this exact order." /><div><button onClick={undo}>Undo</button><button onClick={redo}>Redo</button><button onClick={() => addEvent()}><Plus size={14} /> Message</button></div></div>
          <div className="event-list">
            {draft.events.map((event, index) => <ConversationEventEditor
              key={event.id}
              event={event}
              index={index}
              participants={draft.participants}
              priorEvents={draft.events.slice(0, index)}
              update={(patch) => updateEvent(event.id, patch)}
              move={(direction) => moveEvent(index, direction)}
              duplicate={() => duplicateEvent(event)}
              remove={() => deleteEvent(event.id)}
              upload={(file) => void uploadEventAsset(event, file)}
            />)}
          </div>
          <div className="event-type-bar">{eventTypes.map((type) => <button key={type.id} onClick={() => addEvent(type.id)}><Plus size={12} /> {type.label}</button>)}</div>
        </section>
      </div>}

      {step === "timing" && <div className="conversation-workspace timing">
        <section className="conversation-panel">
          <PanelTitle icon={<Clock3 size={18} />} title="Playback timing" detail="Displayed chat time and video playback time are independent." />
          <button className="conversation-auto-timing" onClick={applyAutomaticTiming}><Sparkles size={14} /> Apply faster Reelio timing</button>
          <div className={`duration-card ${isValidDuration ? "valid" : "invalid"}`}><Clock3 size={22} /><div><strong>{formatDuration(durationMs)}</strong><span>{draft.events.length} events · minimum 0:06 · no maximum</span></div>{isValidDuration ? <Check size={18} /> : <span>Adjust timing</span>}</div>
          <div className="timing-table">
            {draft.events.map((event, index) => <div key={event.id}><span>{index + 1}</span><strong>{event.text || event.fileName || event.type}</strong><label>Delay<input type="number" min="0" max="300000" step="100" value={event.delayBeforeMs} onChange={(e) => updateEvent(event.id, { delayBeforeMs: Number(e.target.value) })} /></label><label>Typing<input type="number" min="0" max="300000" step="100" value={event.typingMs} onChange={(e) => updateEvent(event.id, { typingMs: Number(e.target.value) })} /></label><label>Hold<input type="number" min="250" max="300000" step="100" value={event.holdMs} onChange={(e) => updateEvent(event.id, { holdMs: Number(e.target.value) })} /></label></div>)}
          </div>
        </section>
        <section className="conversation-panel">
          <PanelTitle icon={<Volume2 size={18} />} title="Audio treatment" detail="Local and API use is labeled before voice generation." />
          <div className="audio-mode-grid">{(["silent", "sfx", "narrator", "characters"] as const).map((mode) => <button key={mode} className={draft.audio.mode === mode ? "selected" : ""} onClick={() => updateDraft((next) => ({ ...next, audio: { ...next.audio, mode } }))}><strong>{mode === "sfx" ? "Message SFX" : mode === "characters" ? "Character voices" : titleCase(mode)}</strong><span>{mode === "silent" ? "Silent AAC compatibility track" : mode === "sfx" ? "Typing, send, receive, and call sounds" : mode === "narrator" ? "One voice reads every text bubble" : "A distinct voice for up to four participants"}</span></button>)}</div>
          {draft.audio.mode !== "silent" && <Field label={`Sound effects · ${Math.round(draft.audio.sfxVolume * 100)}%`}><input type="range" min="0" max="1" step="0.05" value={draft.audio.sfxVolume} onChange={(event) => updateDraft((next) => ({ ...next, audio: { ...next.audio, sfxVolume: Number(event.target.value) } }), false)} /></Field>}
          {["narrator", "characters"].includes(draft.audio.mode) && <>
            <Field label="Voice engine"><select value={draft.audio.ttsEngine} onChange={(event) => updateDraft((next) => ({ ...next, audio: { ...next.audio, ttsEngine: event.target.value as TtsEngine } }))}>{ttsEngineOptions(draft.language).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
            {draft.audio.mode === "narrator" && <Field label="Narrator"><select value={draft.audio.narratorId} onChange={(event) => updateDraft((next) => ({ ...next, audio: { ...next.audio, narratorId: event.target.value as NarratorId } }))}>{narrators.map((narrator) => <option key={narrator.id} value={narrator.id}>{narrator.name} · {narrator.role}</option>)}</select></Field>}
            {draft.audio.mode === "characters" && <div className="voice-cast">{draft.participants.map((participant) => <label key={participant.id}><span>{participant.name}</span><select value={participant.narratorId} onChange={(event) => updateParticipant(participant.id, { narratorId: event.target.value as NarratorId })}>{narrators.map((narrator) => <option key={narrator.id} value={narrator.id}>{narrator.name} · {narrator.voice}</option>)}</select></label>)}</div>}
            {!characterVoicesValid && <div className="conversation-warning">Character audio requires two to four participants with distinct Reelio voices.</div>}
            <button className="voice-sample-button" onClick={() => void sampleVoice()} disabled={voiceSampling}>{voiceSampling ? <LoaderCircle className="spin" size={15} /> : <Mic2 size={15} />} {voiceSampling ? "Preparing sample…" : "Sample the opening message"}</button>
            {voiceSample && <audio controls autoPlay src={voiceSample} />}
          </>}
          <div className="conversation-music">
            <div className="conversation-panel-title"><Volume2 size={16} /><span><strong>Background music</strong><span>Choose one soundtrack source. It loops across the entire conversation and ducks under speech.</span></span></div>
            <div className="music-source-grid">
              {([
                { id: "none", label: "No music", detail: "Message and call audio only" },
                { id: "brand", label: "Brand Kit", detail: "Use the snapshotted Brand Kit track" },
                { id: "upload", label: "Local upload", detail: "Choose a soundtrack from this device" },
              ] as const).map((source) => <button key={source.id} className={draft.audio.musicSource === source.id ? "selected" : ""} onClick={() => updateDraft((next) => ({ ...next, audio: { ...next.audio, musicEnabled: source.id !== "none", musicSource: source.id, musicAssetId: source.id === "upload" ? next.audio.musicAssetId : null } }))}><strong>{source.label}</strong><span>{source.detail}</span></button>)}
            </div>
            {draft.audio.musicSource === "upload" && <label className={`event-upload ${draft.audio.musicAssetId ? "ready" : ""}`}><input type="file" accept="audio/*" onChange={(event) => event.target.files?.[0] && void uploadMusic(event.target.files[0])} /><Upload size={14} /><span>{draft.audio.musicAssetId ? "Local soundtrack ready" : "Choose local music file"}</span>{draft.audio.musicAssetId && <Check size={13} />}</label>}
            {draft.audio.musicSource === "brand" && !draft.applyBrandKit && <div className="conversation-warning">Enable “Apply active Brand Kit” in Setup to use its music.</div>}
            {draft.audio.musicSource !== "none" && <Field label={`Music level · ${Math.round(draft.audio.musicVolume * 100)}%`}><input type="range" min="0.02" max="0.7" step="0.02" value={draft.audio.musicVolume} onChange={(event) => updateDraft((next) => ({ ...next, audio: { ...next.audio, musicVolume: Number(event.target.value) } }), false)} /></Field>}
          </div>
          <div className="platform-checks">{platforms.map((platform) => <label key={platform.id}><input type="checkbox" checked={draft.platforms.includes(platform.id)} onChange={(event) => updateDraft((next) => ({ ...next, platforms: event.target.checked ? [...next.platforms, platform.id] : next.platforms.filter((id) => id !== platform.id) }))} /><span>{platform.short}</span>{platform.label}</label>)}</div>
        </section>
      </div>}

      {step === "preview" && <div className="conversation-workspace preview">
          <section className="conversation-preview-stage" data-audio-state={previewAudioState} data-last-sfx={lastPreviewSound}>
          <iframe key={previewRevision} ref={iframeRef} title="Conversation phone preview" src={`${SERVICE_URL}/conversation-drafts/${draft.id}/preview?revision=${previewRevision}`} />
          <div className="preview-controls">
            <button aria-label={previewPlaying ? "Pause conversation preview" : "Play conversation preview"} onClick={() => { if (!previewPlaying && !previewMuted) preparePreviewAudio(); sendPreview(previewPlaying ? "reelio-conversation-pause" : "reelio-conversation-play", { speed: previewSpeed }); setPreviewPlaying(!previewPlaying); }}>{previewPlaying ? <Pause size={15} /> : <Play size={15} />}</button>
            <button aria-label="Restart conversation preview" onClick={() => { sendPreview("reelio-conversation-restart"); setPreviewPlaying(false); }}><RefreshCw size={14} /></button>
            <button aria-label={previewMuted ? "Unmute conversation sounds" : "Mute conversation sounds"} title={previewMuted ? "Unmute conversation sounds" : "Mute conversation sounds"} className={!previewMuted ? "active" : ""} onClick={() => { const muted = !previewMuted; previewMutedRef.current = muted; setPreviewMuted(muted); if (!muted) preparePreviewAudio(); sendPreview("reelio-conversation-mute", { muted }); }}><Volume2 size={14} /></button>
            <button title="Toggle publishing safe zone" className={draft.appearance.showSafeZone ? "active" : ""} onClick={() => { const visible = !draft.appearance.showSafeZone; updateDraft((next) => ({ ...next, appearance: { ...next.appearance, showSafeZone: visible } }), false); sendPreview("reelio-conversation-safe-zone", { visible }); }}>Safe</button>
            <input type="range" min="0" max={Math.max(1, previewDuration)} value={Math.min(previewTime, previewDuration)} onChange={(event) => { const ms = Number(event.target.value); setPreviewTime(ms); sendPreview("reelio-conversation-seek", { ms }); }} />
            <span>{formatDuration(previewTime)} / {formatDuration(previewDuration)}</span>
            <select value={previewSpeed} onChange={(event) => setPreviewSpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
          </div>
        </section>
        <section className="conversation-panel review-panel">
          <PanelTitle icon={<Film size={18} />} title="Approve and record" detail="The final renderer frame-steps this same webpage at 1080×1920 and 30 fps." />
          <button className="refresh-preview" onClick={() => void saveAndRefreshPreview()} disabled={saving}><RefreshCw size={14} /> Save and refresh exact preview</button>
          <Field label={`Thumbnail cover · ${formatDuration(draft.appearance.coverTimeMs)}`}><input type="range" min="0" max={Math.max(1_000, durationMs - 1)} step="100" value={Math.min(draft.appearance.coverTimeMs, Math.max(1_000, durationMs - 1))} onChange={(event) => updateDraft((next) => ({ ...next, appearance: { ...next.appearance, coverTimeMs: Number(event.target.value) } }), false)} /></Field>
          <dl className="conversation-summary"><div><dt>Revision</dt><dd>{draft.revision}</dd></div><div><dt>Duration</dt><dd>{formatDuration(durationMs)}</dd></div><div><dt>Participants</dt><dd>{draft.participants.length}</dd></div><div><dt>Events</dt><dd>{draft.events.length}</dd></div><div><dt>Layout</dt><dd>{draft.appearance.layout === "device" ? "Phone on background" : "Edge-to-edge"}</dd></div><div><dt>Audio</dt><dd>{titleCase(draft.audio.mode)}</dd></div><div><dt>Music</dt><dd>{draft.audio.musicSource === "none" ? "None" : draft.audio.musicSource === "brand" ? "Brand Kit" : "Local upload"}</dd></div><div><dt>Renderer</dt><dd>{rendererReady ? "Ready" : "Setup required"}</dd></div><div><dt>Authenticity</dt><dd>Fictional</dd></div></dl>
          {!rendererReady && <div className="conversation-warning"><strong>Final recorder setup required.</strong><span>Run <code>npm run conversation:setup</code>. The live webpage preview is still available.</span></div>}
          {!assetsComplete && <div className="conversation-warning"><strong>Local media is incomplete.</strong><span>Add every selected attachment and background before approving the final render.</span></div>}
          <label className="conversation-approval"><input type="checkbox" checked={draft.approved} onChange={(event) => void toggleApproval(event.target.checked)} /><span><strong>I approve this fictional conversation</strong><small>I reviewed every participant, message, time, media attachment, voice, theme, and publishing destination.</small></span></label>
          <button className="conversation-render-button" onClick={() => void startRender()} disabled={rendering || !draft.approved || !rendererReady || !isValidDuration || !characterVoicesValid || !assetsComplete}>{rendering ? <LoaderCircle className="spin" size={17} /> : <Film size={17} />} {rendering ? renderJob ? `${renderJob.message} · ${renderJob.progress}%` : "Starting recorder…" : "Record 9:16 conversation video"}</button>
          {renderJob && <div className={`conversation-job ${renderJob.state}`}><span>{renderJob.state}</span><strong>{renderJob.message}</strong><div><i style={{ width: `${renderJob.progress}%` }} /></div>{renderJob.state === "completed" && <button onClick={() => onOpenJob(renderJob)}><Play size={14} /> Review video package</button>}</div>}
          <button className="settings-link" onClick={onOpenSettings}>Open provider and voice settings</button>
        </section>
      </div>}

      <footer className="conversation-footer">
        <span><Clock3 size={14} /> {formatDuration(durationMs)} · {draft.events.length} events · {draft.participants.length} participants</span>
        <button onClick={() => setStep(nextStep(step))}>{step === "preview" ? "Back to setup" : "Continue"} <ChevronRight size={15} /></button>
      </footer>
    </div>
  );
}

function ConversationEventEditor({
  event,
  index,
  participants,
  priorEvents,
  update,
  move,
  duplicate,
  remove,
  upload,
}: {
  event: ConversationEvent;
  index: number;
  participants: ConversationParticipant[];
  priorEvents: ConversationEvent[];
  update: (patch: Partial<ConversationEvent>) => void;
  move: (direction: -1 | 1) => void;
  duplicate: () => void;
  remove: () => void;
  upload: (file: File) => void;
}) {
  const needsParticipant = !["system", "date", "battery", "chat-switch"].includes(event.type);
  const needsAsset = ["image", "video", "audio"].includes(event.type);
  const usesChat = !["system", "date", "battery"].includes(event.type);
  const updateCallLine = (lineId: string, patch: Partial<ConversationEvent["callDialogue"][number]>) => update({
    callDialogue: event.callDialogue.map((line) => line.id === lineId ? { ...line, ...patch } : line),
  });
  return <article className="conversation-event-card">
    <header><b>{String(index + 1).padStart(2, "0")}</b><select value={event.type} onChange={(e) => update({ type: e.target.value as ConversationEventType, participantId: ["system", "date", "battery", "chat-switch"].includes(e.target.value) ? null : event.participantId ?? participants[0].id })}>{eventTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select>{needsParticipant && <select value={event.participantId ?? ""} onChange={(e) => update({ participantId: e.target.value })}>{participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}{participant.isSelf ? " · phone owner" : ""}</option>)}</select>}<div><button onClick={() => move(-1)} aria-label="Move up"><ArrowUp size={13} /></button><button onClick={() => move(1)} aria-label="Move down"><ArrowDown size={13} /></button><button onClick={duplicate} aria-label="Duplicate"><Copy size={13} /></button><button onClick={remove} aria-label="Delete"><Trash2 size={13} /></button></div></header>
    {!["typing", "battery"].includes(event.type) && <textarea value={event.text} maxLength={event.type === "text" ? 600 : 300} placeholder={needsAsset ? "Optional attachment caption" : event.type === "notification" ? "Notification preview" : event.type === "chat-switch" ? "Conversation title" : "Event text"} onChange={(e) => update({ text: e.target.value })} />}
    {needsAsset && <label className={`event-upload ${event.assetId ? "ready" : ""}`}><input type="file" accept={event.type === "audio" ? "audio/*" : event.type === "video" ? "video/*" : "image/*"} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /><Upload size={14} /><span>{event.fileName || `Choose local ${event.type}`}</span>{event.assetId && <Check size={13} />}</label>}
    <div className="event-options">
      <label>Displayed time<input type="time" value={event.displayTime} onChange={(e) => update({ displayTime: e.target.value })} /></label>
      {usesChat && <label>Chat screen<input value={event.chatId} maxLength={80} placeholder="primary" onChange={(e) => update({ chatId: e.target.value.replace(/[^A-Za-z0-9_-]/g, "-") || "primary" })} /></label>}
      {usesChat && <label>Screen title<input value={event.chatTitle} maxLength={80} placeholder="Uses participant name" onChange={(e) => update({ chatTitle: e.target.value })} /></label>}
      {event.type === "text" && <label>Typing behavior<select value={event.typingStyle} onChange={(e) => update({ typingStyle: e.target.value as ConversationEvent["typingStyle"] })}><option value="clean">Clean</option><option value="natural">Natural</option><option value="hesitant">Hesitant + corrections</option><option value="fast">Fast</option></select></label>}
      {event.type === "text" && <label>Receipt<select value={event.receipt} onChange={(e) => update({ receipt: e.target.value as ConversationEvent["receipt"] })}><option value="none">None</option><option value="sent">Sent</option><option value="delivered">Delivered</option><option value="read">Read</option></select></label>}
      {event.type === "text" && <label>Reply to<select value={event.replyToEventId ?? ""} onChange={(e) => update({ replyToEventId: e.target.value || null })}><option value="">No reply</option>{priorEvents.map((item, itemIndex) => <option key={item.id} value={item.id}>{itemIndex + 1}. {item.text || item.type}</option>)}</select></label>}
      {event.type === "notification" && <label>Notification title<input value={event.notificationTitle} maxLength={80} placeholder="Sender or app name" onChange={(e) => update({ notificationTitle: e.target.value })} /></label>}
      {event.type === "battery" && <label>Battery level<input type="number" min="1" max="100" value={event.batteryLevel ?? 10} onChange={(e) => update({ batteryLevel: Number(e.target.value) })} /></label>}
      {event.type === "call" && <label>Call screen<select value={event.callState ?? "completed"} onChange={(e) => update({ callState: e.target.value as ConversationEvent["callState"] })}><option value="incoming">Incoming · ringing</option><option value="outgoing">Outgoing · calling</option><option value="completed">Connected call</option><option value="missed">Missed</option><option value="declined">Declined</option></select></label>}
      {["text", "image", "video", "audio"].includes(event.type) && <label>Reaction<input value={event.reactions[0]?.emoji ?? ""} maxLength={12} placeholder="❤️" onChange={(e) => update({ reactions: e.target.value ? [{ participantId: event.participantId ?? participants[0].id, emoji: e.target.value }] : [] })} /></label>}
    </div>
    {event.type === "text" && <p className="typing-behavior-note">{participants.find((participant) => participant.id === event.participantId)?.isSelf ? "The approved text will be composed visibly in the phone input, including deterministic pauses and corrections." : "Incoming text stays private while uneven typing dots appear, then the approved bubble arrives."}</p>}
    {event.type === "call" && <div className="call-dialogue-editor">
      <header><span><strong>Call dialogue</strong><small>Timed spoken lines from both sides. Character voice mode gives each participant a distinct voice.</small></span><button onClick={() => update({ callDialogue: [...event.callDialogue, { id: crypto.randomUUID(), participantId: event.participantId ?? participants[0].id, text: "New call line", delayMs: event.callDialogue.length ? 450 : 700 }] })}><Plus size={12} /> Line</button></header>
      {event.callDialogue.map((line) => <div key={line.id}><select value={line.participantId} onChange={(e) => updateCallLine(line.id, { participantId: e.target.value })}>{participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}</select><input value={line.text} maxLength={300} onChange={(e) => updateCallLine(line.id, { text: e.target.value })} /><label>Pause ms<input type="number" min="0" max="15000" step="100" value={line.delayMs} onChange={(e) => updateCallLine(line.id, { delayMs: Number(e.target.value) })} /></label><button aria-label="Delete call line" onClick={() => update({ callDialogue: event.callDialogue.filter((item) => item.id !== line.id) })}><Trash2 size={12} /></button></div>)}
    </div>}
    {event.type === "video" && <div className="event-flags"><label><input type="checkbox" checked={event.playAudio} onChange={(e) => update({ playAudio: e.target.checked })} /> Play the attachment audio</label></div>}
    {event.type === "battery" && <div className="event-flags"><label><input type="checkbox" checked={event.charging} onChange={(e) => update({ charging: e.target.checked })} /> Show charging state</label></div>}
    {event.type === "text" && <div className="event-flags"><label><input type="checkbox" checked={event.edited} onChange={(e) => update({ edited: e.target.checked })} /> Edited</label><label><input type="checkbox" checked={event.deleted} onChange={(e) => update({ deleted: e.target.checked })} /> Deleted</label></div>}
  </article>;
}

function PanelTitle({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="conversation-panel-title">{icon}<div><strong>{title}</strong><span>{detail}</span></div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="conversation-field"><span>{label}</span>{children}</label>;
}

function StarterChoice({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <div className="story-choice"><strong>{label}</strong><div>{options.map((option) => <button key={option} className={value === option ? "selected" : ""} onClick={() => onChange(option)} aria-pressed={value === option}>{option}</button>)}</div></div>;
}

function estimateDuration(events: ConversationEvent[]) {
  return 1_100 + events.reduce((total, event) => total + Number(event.delayBeforeMs || 0) + Number(event.typingMs || 0) + Number(event.holdMs || 0), 0);
}
function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
function initials(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join("").slice(0, 4).toUpperCase() || "CH";
}
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function nextStep(step: Step): Step {
  if (step === "setup") return "write";
  if (step === "write") return "timing";
  if (step === "timing") return "preview";
  return "setup";
}
function draftFingerprint(draft: ConversationDraft) {
  return JSON.stringify(draft, (key, value) => ["revision", "updatedAt", "validation"].includes(key) ? undefined : value);
}
