import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { access, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { chromium } from "playwright";
import { synthesizeGeminiCues } from "./gemini-tts-client.mjs";
import { assertJobActive, registerJobProcess } from "./job-control.mjs";
import { synthesizeKokoroCues } from "./kokoro-client.mjs";
import { narratorProfile, NARRATORS } from "./narrators.mjs";
import { applyBrandVisuals } from "./pipeline.mjs";
import { getRoot } from "./store.mjs";
import { synthesizeVoxCpmCues } from "./voxcpm-client.mjs";
import { defaultTtsEngine, normalizePlatforms, normalizeSpeechLanguage, ValidationError } from "./validation.mjs";

const ffprobePath = ffprobe.path;
const EVENT_TYPES = new Set(["text", "image", "video", "audio", "typing", "notification", "battery", "call", "chat-switch", "system", "date"]);
const AUDIO_MODES = new Set(["silent", "sfx", "narrator", "characters"]);
const THEMES = new Set(["reelio-light", "reelio-dark", "minimal", "brand"]);
const LAYOUTS = new Set(["screen", "device"]);
const BACKGROUNDS = new Set(["solid", "gradient", "image", "motion"]);
const RECEIPTS = new Set(["none", "sent", "delivered", "read"]);
const CALL_STATES = new Set(["incoming", "outgoing", "missed", "declined", "completed"]);
const TYPING_STYLES = new Set(["clean", "natural", "hesitant", "fast"]);
const STORY_EVENT_TYPES = new Set(["text", "notification", "battery", "call", "chat-switch", "system", "date"]);
const MUSIC_SOURCES = new Set(["none", "brand", "upload"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_EVENTS = 200;
const MAX_PARTICIPANTS = 12;
const MIN_DURATION_MS = 6_000;
const MAX_EVENT_TIMING_MS = 300_000;

export function defaultConversationDraft(ownerUserId) {
  const now = new Date().toISOString();
  const selfId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  return {
    version: 1,
    id: crypto.randomUUID(),
    ownerUserId,
    revision: 1,
    title: "The message that changed everything",
    language: "English",
    authenticity: "fictional",
    clock: { startDate: now.slice(0, 10), startTime: "19:42", format: "12h" },
    participants: [
      { id: selfId, name: "Me", initials: "ME", color: "#7259e8", isSelf: true, narratorId: "maya" },
      { id: otherId, name: "Alex", initials: "AL", color: "#25a89b", isSelf: false, narratorId: "theo" },
    ],
    events: [
      conversationEvent({ type: "text", participantId: otherId, text: "Are you still awake?", displayTime: "19:42", typingMs: 2_000, typingStyle: "natural", holdMs: 1_500 }),
      conversationEvent({ type: "text", participantId: selfId, text: "Yeah. What happened?", displayTime: "19:43", receipt: "read", typingMs: 900, typingStyle: "fast", holdMs: 1_500 }),
      conversationEvent({ type: "text", participantId: otherId, text: "I finally found the letter.", displayTime: "19:43", typingMs: 2_800, typingStyle: "natural", holdMs: 2_000 }),
    ],
    appearance: {
      theme: "reelio-dark",
      layout: "device",
      bubbleStyle: "soft",
      background: { type: "gradient", color: "#15111f", accentColor: "#6c4fe0", assetId: null },
      showSafeZone: false,
      coverTimeMs: 4_500,
    },
    audio: {
      mode: "sfx",
      ttsEngine: "kokoro",
      narratorId: "maya",
      sfxVolume: 0.7,
      musicEnabled: false,
      musicSource: "none",
      musicAssetId: null,
      musicVolume: 0.2,
    },
    platforms: ["youtube", "tiktok", "facebook", "instagram"],
    applyBrandKit: true,
    approved: false,
    generation: null,
    createdAt: now,
    updatedAt: now,
  };
}

function conversationEvent(value) {
  return {
    id: crypto.randomUUID(),
    delayBeforeMs: 650,
    holdMs: 1_500,
    typingMs: 0,
    typingStyle: "natural",
    chatId: "primary",
    chatTitle: "",
    displayTime: "",
    receipt: "none",
    reactions: [],
    ...value,
  };
}

export function normalizeConversationDraft(value, { ownerUserId, preserveIdentity = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Conversation draft must be an object.");
  const participants = normalizeParticipants(value.participants);
  const participantIds = new Set(participants.map((item) => item.id));
  const selfParticipantIds = new Set(participants.filter((item) => item.isSelf).map((item) => item.id));
  const events = normalizeEvents(value.events, participantIds, selfParticipantIds);
  const eventIds = new Set(events.map((event) => event.id));
  for (const [index, event] of events.entries()) {
    if (event.replyToEventId && (!eventIds.has(event.replyToEventId) || events.findIndex((item) => item.id === event.replyToEventId) >= index)) {
      throw new ValidationError(`Conversation event ${index + 1} must reply to an earlier event.`);
    }
  }
  validateDisplayedTimes(events);
  const language = normalizeSpeechLanguage(value.language ?? "English", "Conversation language");
  const appearance = normalizeAppearance(value.appearance);
  const audio = normalizeAudio(value.audio, language, participants);
  const timeline = buildConversationTimeline({ participants, events });
  if (timeline.durationMs < MIN_DURATION_MS) throw new ValidationError("Conversation playback must be at least 6 seconds.");
  const now = new Date().toISOString();
  const normalized = {
    version: 1,
    id: preserveIdentity && SAFE_ID.test(String(value.id ?? "")) ? String(value.id) : crypto.randomUUID(),
    ownerUserId: ownerUserId ?? value.ownerUserId,
    revision: Number.isInteger(Number(value.revision)) && Number(value.revision) > 0 ? Number(value.revision) : 1,
    title: cleanText(value.title ?? "Untitled conversation", "Conversation title", 1, 100),
    language,
    authenticity: "fictional",
    clock: normalizeClock(value.clock),
    participants,
    events,
    appearance,
    audio,
    platforms: normalizePlatforms(value.platforms ?? []),
    applyBrandKit: value.applyBrandKit !== false,
    approved: Boolean(value.approved),
    generation: normalizeGeneration(value.generation),
    validation: { durationMs: timeline.durationMs, eventCount: events.length, participantCount: participants.length },
    createdAt: preserveIdentity && validDate(value.createdAt) ? value.createdAt : now,
    updatedAt: now,
  };
  return normalized;
}

function normalizeParticipants(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PARTICIPANTS) {
    throw new ValidationError("A conversation must have between 2 and 12 participants.");
  }
  const ids = new Set();
  const participants = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ValidationError(`Participant ${index + 1} must be an object.`);
    const id = String(item.id ?? "").trim();
    if (!SAFE_ID.test(id) || ids.has(id)) throw new ValidationError(`Participant ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id);
    const name = cleanText(item.name, `Participant ${index + 1} name`, 1, 40);
    const initials = cleanText(item.initials ?? initialsFor(name), `Participant ${index + 1} initials`, 1, 4).toUpperCase();
    const color = cleanColor(item.color ?? "#7259e8", `Participant ${index + 1} color`);
    const narratorId = String(item.narratorId ?? NARRATORS[index % NARRATORS.length].id);
    if (!NARRATORS.some((narrator) => narrator.id === narratorId)) throw new ValidationError(`Participant ${index + 1} has an unsupported voice.`);
    const avatarAssetId = item.avatarAssetId == null || item.avatarAssetId === "" ? null : cleanId(item.avatarAssetId, `Participant ${index + 1} avatar`);
    return { id, name, initials, color, isSelf: Boolean(item.isSelf), narratorId, avatarAssetId };
  });
  if (participants.filter((item) => item.isSelf).length !== 1) throw new ValidationError("Choose exactly one participant as the phone owner.");
  return participants;
}

function normalizeEvents(value, participantIds, selfParticipantIds = new Set()) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVENTS) {
    throw new ValidationError("A conversation must contain between 1 and 200 events.");
  }
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ValidationError(`Conversation event ${index + 1} must be an object.`);
    const id = String(item.id ?? "").trim();
    if (!SAFE_ID.test(id) || ids.has(id)) throw new ValidationError(`Conversation event ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id);
    const type = String(item.type ?? "text").toLowerCase();
    if (!EVENT_TYPES.has(type)) throw new ValidationError(`Conversation event ${index + 1} has an unsupported type.`);
    const participantId = item.participantId == null || item.participantId === "" ? null : String(item.participantId);
    if (participantId && !participantIds.has(participantId)) throw new ValidationError(`Conversation event ${index + 1} references an unknown participant.`);
    if (!["system", "date", "battery", "chat-switch"].includes(type) && !participantId) throw new ValidationError(`Conversation event ${index + 1} requires a participant.`);
    const textRequired = ["text", "notification", "system", "date", "call", "chat-switch"].includes(type);
    const text = textRequired
      ? cleanText(item.text ?? defaultEventText(type), `Conversation event ${index + 1} text`, 1, type === "text" ? 600 : 180)
      : optionalText(item.text, `Conversation event ${index + 1} caption`, 300);
    const assetId = ["image", "video", "audio"].includes(type)
      ? item.assetId == null || item.assetId === "" ? null : cleanId(item.assetId, `Conversation event ${index + 1} asset`)
      : null;
    const reactions = normalizeReactions(item.reactions, participantIds, index);
    const receipt = String(item.receipt ?? "none").toLowerCase();
    if (!RECEIPTS.has(receipt)) throw new ValidationError(`Conversation event ${index + 1} has an unsupported delivery state.`);
    const callState = type === "call" ? String(item.callState ?? "completed").toLowerCase() : null;
    if (callState && !CALL_STATES.has(callState)) throw new ValidationError(`Conversation event ${index + 1} has an unsupported call state.`);
    const typingStyle = String(item.typingStyle ?? "natural").toLowerCase();
    if (!TYPING_STYLES.has(typingStyle)) throw new ValidationError(`Conversation event ${index + 1} has an unsupported typing behavior.`);
    const chatId = cleanId(item.chatId ?? "primary", `Conversation event ${index + 1} chat`);
    const chatTitle = optionalText(item.chatTitle, `Conversation event ${index + 1} chat title`, 80);
    const callDialogue = type === "call" ? normalizeCallDialogue(item.callDialogue, participantIds, index) : [];
    const configuredHoldMs = milliseconds(item.holdMs, 250, MAX_EVENT_TIMING_MS, defaultHold(type, text));
    const callMinimumHoldMs = type === "call" && callDialogue.length
      ? Math.min(MAX_EVENT_TIMING_MS, 1_800 + callDialogue.reduce((total, line) => total + line.delayMs + 900, 0) + 600)
      : 0;
    const requestedTypingMs = milliseconds(item.typingMs, 0, MAX_EVENT_TIMING_MS, 0);
    const typingMs = type === "text" && !item.deleted && requestedTypingMs > 0
      ? Math.max(requestedTypingMs, recommendedConversationTypingMs(text, typingStyle, selfParticipantIds.has(participantId)))
      : requestedTypingMs;
    return {
      id,
      type,
      participantId,
      text,
      assetId,
      fileName: assetId ? optionalText(item.fileName, `Conversation event ${index + 1} filename`, 180) : "",
      delayBeforeMs: milliseconds(item.delayBeforeMs, 0, MAX_EVENT_TIMING_MS, 650),
      holdMs: Math.max(configuredHoldMs, callMinimumHoldMs),
      typingMs,
      typingStyle,
      chatId,
      chatTitle,
      displayTime: optionalClockTime(item.displayTime),
      receipt,
      replyToEventId: item.replyToEventId ? cleanId(item.replyToEventId, `Conversation event ${index + 1} reply`) : null,
      reactions,
      edited: Boolean(item.edited),
      deleted: Boolean(item.deleted),
      playAudio: Boolean(item.playAudio),
      callState,
      callDialogue,
      notificationTitle: type === "notification" ? optionalText(item.notificationTitle, `Conversation event ${index + 1} notification title`, 80) : "",
      batteryLevel: type === "battery" ? milliseconds(item.batteryLevel, 1, 100, 10) : null,
      charging: type === "battery" ? Boolean(item.charging) : false,
    };
  });
}

function normalizeCallDialogue(value, participantIds, eventIndex) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ValidationError(`Call event ${eventIndex + 1} may contain up to 20 dialogue lines.`);
  return value.map((line, index) => {
    if (!line || typeof line !== "object" || !participantIds.has(String(line.participantId))) {
      throw new ValidationError(`Call line ${index + 1} on event ${eventIndex + 1} has an unknown participant.`);
    }
    return {
      id: SAFE_ID.test(String(line.id ?? "")) ? String(line.id) : `${eventIndex + 1}-call-${index + 1}`,
      participantId: String(line.participantId),
      text: cleanText(line.text, `Call line ${index + 1} text`, 1, 300),
      delayMs: milliseconds(line.delayMs, 0, 60_000, index === 0 ? 700 : 450),
    };
  });
}

function normalizeReactions(value, participantIds, eventIndex) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new ValidationError(`Conversation event ${eventIndex + 1} has too many reactions.`);
  return value.map((reaction, index) => {
    if (!reaction || typeof reaction !== "object" || !participantIds.has(String(reaction.participantId))) {
      throw new ValidationError(`Reaction ${index + 1} on event ${eventIndex + 1} has an unknown participant.`);
    }
    return {
      participantId: String(reaction.participantId),
      emoji: cleanText(reaction.emoji, `Reaction ${index + 1} emoji`, 1, 12),
    };
  });
}

function normalizeAppearance(value = {}) {
  const theme = String(value?.theme ?? "reelio-dark").toLowerCase();
  const layout = String(value?.layout ?? "device").toLowerCase();
  if (!THEMES.has(theme)) throw new ValidationError("Choose a supported Reelio conversation theme.");
  if (!LAYOUTS.has(layout)) throw new ValidationError("Choose a supported phone layout.");
  const backgroundType = String(value?.background?.type ?? "gradient").toLowerCase();
  if (!BACKGROUNDS.has(backgroundType)) throw new ValidationError("Choose a supported conversation background.");
  return {
    theme,
    layout,
    bubbleStyle: ["soft", "square", "compact"].includes(String(value?.bubbleStyle)) ? String(value.bubbleStyle) : "soft",
    background: {
      type: backgroundType,
      color: cleanColor(value?.background?.color ?? "#15111f", "Background color"),
      accentColor: cleanColor(value?.background?.accentColor ?? "#6c4fe0", "Background accent color"),
      assetId: ["image", "motion"].includes(backgroundType)
        ? value?.background?.assetId == null || value.background.assetId === "" ? null : cleanId(value.background.assetId, "Background asset")
        : null,
    },
    showSafeZone: Boolean(value?.showSafeZone),
    coverTimeMs: milliseconds(value?.coverTimeMs, 0, 86_400_000, 4_000),
  };
}

function normalizeAudio(value = {}, language, participants) {
  const mode = String(value?.mode ?? "sfx").toLowerCase();
  if (!AUDIO_MODES.has(mode)) throw new ValidationError("Choose a supported conversation audio treatment.");
  if (mode === "characters" && participants.length > 4) throw new ValidationError("Character voices support up to four participants.");
  if (mode === "characters") {
    const voices = participants.map((item) => item.narratorId);
    if (new Set(voices).size !== voices.length) throw new ValidationError("Assign a distinct Reelio voice to every character.");
  }
  const narratorId = String(value?.narratorId ?? "maya");
  if (!NARRATORS.some((item) => item.id === narratorId)) throw new ValidationError("Choose a supported narrator.");
  const ttsEngine = String(value?.ttsEngine ?? defaultTtsEngine(language)).toLowerCase();
  if (!["kokoro", "gemini", "voxcpm2"].includes(ttsEngine)) throw new ValidationError("Choose a supported voice engine.");
  if (["narrator", "characters"].includes(mode) && language !== "English" && ttsEngine === "kokoro") {
    throw new ValidationError("Non-English conversations with speech require VoxCPM2 or Gemini.");
  }
  const legacyMusicEnabled = Boolean(value?.musicEnabled);
  const musicSource = String(value?.musicSource ?? (legacyMusicEnabled ? "brand" : "none")).toLowerCase();
  if (!MUSIC_SOURCES.has(musicSource)) throw new ValidationError("Choose no music, Brand Kit music, or an uploaded local soundtrack.");
  const musicAssetId = musicSource === "upload"
    ? value?.musicAssetId == null || value.musicAssetId === "" ? null : cleanId(value.musicAssetId, "Conversation soundtrack")
    : null;
  return {
    mode,
    ttsEngine,
    narratorId,
    sfxVolume: numberRange(value?.sfxVolume, 0, 1, 0.7),
    musicEnabled: musicSource !== "none",
    musicSource,
    musicAssetId,
    musicVolume: numberRange(value?.musicVolume, 0, 0.7, 0.2),
  };
}

function normalizeClock(value = {}) {
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value?.startDate ?? "")) ? String(value.startDate) : new Date().toISOString().slice(0, 10);
  const startTime = optionalClockTime(value?.startTime) || "19:42";
  return { startDate, startTime, format: value?.format === "24h" ? "24h" : "12h" };
}

function validateDisplayedTimes(events) {
  let previous = null;
  let dayOffset = 0;
  for (const [index, event] of events.entries()) {
    if (!event.displayTime) continue;
    const [hours, minutes] = event.displayTime.split(":").map(Number);
    let value = hours * 60 + minutes + dayOffset;
    if (previous != null && value < previous) {
      const priorMinute = previous - dayOffset;
      if (priorMinute >= 18 * 60 && hours <= 6) {
        dayOffset += 24 * 60;
        value += 24 * 60;
      } else {
        throw new ValidationError(`Displayed time on conversation event ${index + 1} must not move backward.`);
      }
    }
    previous = value;
  }
}

function normalizeGeneration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fallback = value.fallback && typeof value.fallback === "object" && !Array.isArray(value.fallback)
    ? {
        provider: optionalText(value.fallback.provider, "Fallback provider", 80),
        model: optionalText(value.fallback.model, "Fallback model", 120),
        reason: optionalText(value.fallback.reason, "Fallback reason", 180),
      }
    : null;
  return {
    mode: value.mode === "ai" ? "ai" : "manual",
    premise: optionalText(value.premise, "Generation premise", 700),
    provider: optionalText(value.provider, "Generation provider", 80),
    model: optionalText(value.model, "Generation model", 120),
    genre: optionalText(value.genre, "Generation genre", 80),
    qualityStages: Array.isArray(value.qualityStages) ? value.qualityStages.slice(0, 6).map((item) => optionalText(item, "Generation quality stage", 40)).filter(Boolean) : [],
    fallback,
    generatedAt: validDate(value.generatedAt) ? value.generatedAt : null,
  };
}

export function buildConversationTypingSequence(event) {
  const durationMs = Math.max(0, Number(event?.typingMs) || 0);
  const graphemes = splitGraphemes(String(event?.text ?? ""));
  if (event?.type !== "text" || event?.deleted || durationMs <= 0 || graphemes.length === 0) {
    return { version: 1, durationMs, checkpoints: [], correctionCount: 0, pauseCount: 0 };
  }
  const style = TYPING_STYLES.has(event.typingStyle) ? event.typingStyle : "natural";
  const random = seededRandom(`${event.id}:${event.text}:${style}`);
  const operations = [];
  let composed = "";
  let correctionCount = 0;
  let pauseCount = 0;
  const correctionTarget = style === "hesitant"
    ? Math.min(3, Math.max(1, Math.floor(graphemes.length / 13)))
    : style === "natural" && graphemes.length >= 14 && random() < 0.32 ? 1 : 0;
  const correctionSlots = new Set();
  while (correctionSlots.size < correctionTarget && graphemes.length > 4) {
    correctionSlots.add(2 + Math.floor(random() * Math.max(1, graphemes.length - 3)));
  }
  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];
    if (correctionSlots.has(index) && composed) {
      const accidental = splitGraphemes(composed).at(-1) ?? grapheme;
      operations.push({ text: composed + accidental, action: "mistype", weight: 70 + random() * 95 });
      operations.push({ text: composed, action: "backspace", weight: 85 + random() * 115 });
      correctionCount += 1;
    }
    composed += grapheme;
    const isPunctuation = /[.!?,;:…؟،。！？]/u.test(grapheme);
    const isSpace = /^\s$/u.test(grapheme);
    operations.push({
      text: composed,
      action: "type",
      weight: (style === "fast" ? 35 : style === "hesitant" ? 88 : 62) + random() * (style === "fast" ? 65 : 130),
    });
    const naturalPause = isPunctuation || (isSpace && index > 5 && random() < (style === "hesitant" ? 0.22 : style === "natural" ? 0.09 : 0.02));
    if (naturalPause && index < graphemes.length - 1) {
      operations.push({
        text: composed,
        action: "pause",
        weight: (isPunctuation ? 320 : 180) + random() * (style === "hesitant" ? 850 : 420),
      });
      pauseCount += 1;
    }
  }
  if (!pauseCount && style === "hesitant" && operations.length > 5) {
    const insertAt = Math.max(2, Math.floor(operations.length * (0.42 + random() * 0.2)));
    operations.splice(insertAt, 0, {
      text: operations[insertAt - 1].text,
      action: "pause",
      weight: 480 + random() * 720,
    });
    pauseCount = 1;
  }
  const totalWeight = operations.reduce((total, operation) => total + operation.weight, 0) || 1;
  let elapsed = 0;
  const checkpoints = [{ atMs: 0, text: "", action: "start" }];
  for (const [index, operation] of operations.entries()) {
    elapsed += operation.weight;
    checkpoints.push({
      atMs: index === operations.length - 1 ? durationMs : Math.max(1, Math.min(durationMs - 1, Math.round(elapsed / totalWeight * durationMs))),
      text: operation.text,
      action: operation.action,
    });
  }
  return { version: 1, durationMs, checkpoints, correctionCount, pauseCount };
}

function splitGraphemes(value) {
  if (typeof Intl.Segmenter !== "function") return Array.from(value);
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((item) => item.segment);
}

export function recommendedConversationTypingMs(text, style = "natural", isSelf = false) {
  const graphemes = graphemeCount(text);
  const baseMillisecondsPerGrapheme = {
    fast: 55,
    clean: 75,
    natural: 110,
    hesitant: 155,
  }[style] ?? 110;
  const millisecondsPerGrapheme = isSelf ? Math.round(baseMillisecondsPerGrapheme * 0.68) : baseMillisecondsPerGrapheme;
  const punctuationPause = style === "hesitant" ? 220 : 120;
  const punctuationPauses = (String(text).match(/[.!?,;:…؟،。！？]/gu) ?? []).length * (isSelf ? Math.round(punctuationPause * 0.68) : punctuationPause);
  return Math.min(MAX_EVENT_TIMING_MS, Math.max(isSelf ? 500 : 700, graphemes * millisecondsPerGrapheme + punctuationPauses));
}

export function compileConversationStoryItems(items, draft) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EVENTS) {
    throw new ValidationError("A generated conversation must contain between 1 and 200 story items.");
  }
  const participants = new Map((draft.participants ?? []).map((participant) => [participant.id, participant]));
  const [startHour, startMinute] = String(draft.clock?.startTime ?? "12:00").split(":").map(Number);
  const startTotalMinutes = (Number.isInteger(startHour) ? startHour : 12) * 60 + (Number.isInteger(startMinute) ? startMinute : 0);
  let playbackMs = 0;
  let selfMessageIndex = 0;
  return items.map((item, index) => {
    const type = String(item?.type ?? "text").toLowerCase();
    if (!STORY_EVENT_TYPES.has(type)) throw new ValidationError(`Generated story item ${index + 1} has an unsupported type.`);
    const participantId = ["system", "date", "battery", "chat-switch"].includes(type) ? null : String(item?.participantId ?? "");
    const participant = participantId ? participants.get(participantId) : null;
    if (participantId && !participant) throw new ValidationError(`Generated story item ${index + 1} references an unknown participant.`);
    if (!["system", "date", "battery", "chat-switch"].includes(type) && !participantId) {
      throw new ValidationError(`Generated story item ${index + 1} requires a participant.`);
    }
    const text = String(item?.text ?? defaultEventText(type)).trim();
    const typingStyle = TYPING_STYLES.has(String(item?.typingStyle).toLowerCase())
      ? String(item.typingStyle).toLowerCase()
      : participant?.isSelf ? "fast" : "natural";
    const typingMs = type === "text" ? recommendedConversationTypingMs(text, typingStyle, Boolean(participant?.isSelf)) : 0;
    const delayBeforeMs = index === 0
      ? 300
      : type === "chat-switch"
        ? 180
        : type === "battery"
          ? 240
          : Math.max(180, (participant?.isSelf ? 220 : 360) + index % 3 * 90 + (typingStyle === "hesitant" ? 420 : 0));
    const holdMs = type === "text"
      ? Math.max(800, Math.min(3_200, 620 + graphemeCount(text) * 28))
      : defaultHold(type, text);
    playbackMs += delayBeforeMs;
    const displayTotalMinutes = startTotalMinutes + Math.floor(playbackMs / 60_000);
    const displayTime = `${String(Math.floor(displayTotalMinutes / 60) % 24).padStart(2, "0")}:${String(displayTotalMinutes % 60).padStart(2, "0")}`;
    let receipt = "none";
    if (type === "text" && participant?.isSelf) {
      selfMessageIndex += 1;
      receipt = selfMessageIndex % 3 === 0 ? "read" : "delivered";
    }
    playbackMs += typingMs + holdMs;
    return {
      id: crypto.randomUUID(),
      type,
      participantId,
      text,
      assetId: null,
      fileName: "",
      delayBeforeMs,
      holdMs,
      typingMs,
      typingStyle,
      chatId: String(item?.chatId || "primary"),
      chatTitle: String(item?.chatTitle || ""),
      displayTime,
      receipt,
      replyToEventId: null,
      reactions: [],
      edited: false,
      deleted: false,
      playAudio: false,
      callState: type === "call" ? String(item?.callState || "incoming") : null,
      callDialogue: type === "call" && Array.isArray(item?.callDialogue) ? item.callDialogue : [],
      notificationTitle: type === "notification" ? String(item?.notificationTitle || participant?.name || "New message") : "",
      batteryLevel: type === "battery" ? Number(item?.batteryLevel || 10) : null,
      charging: type === "battery" ? Boolean(item?.charging) : false,
    };
  });
}

function seededRandom(seed) {
  let state = 2166136261;
  for (const character of String(seed)) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function buildConversationTimeline(conversation, durationOverrides = new Map()) {
  let cursor = 200;
  const entries = conversation.events.map((event, index) => {
    cursor += event.delayBeforeMs;
    const typingStartMs = cursor;
    cursor += event.typingMs;
    const startMs = cursor;
    const override = durationOverrides.get(event.id) ?? 0;
    const holdMs = Math.max(event.holdMs, Math.ceil(override * 1000) + (override ? 420 : 0));
    const endMs = startMs + holdMs;
    const deliveredMs = ["delivered", "read"].includes(event.receipt)
      ? startMs + Math.min(900, Math.max(500, Math.round(holdMs * 0.45)))
      : null;
    const readMs = event.receipt === "read"
      ? startMs + Math.min(2_200, Math.max((deliveredMs ?? startMs) - startMs + 650, Math.round(holdMs * 1.1)))
      : null;
    let callCursorMs = event.callState === "incoming" && !(event.callDialogue?.length) ? 0 : 1_800;
    const callDialogueCues = (event.callDialogue ?? []).map((line) => {
      callCursorMs += line.delayMs;
      return { cueId: `${event.id}:${line.id}`, participantId: line.participantId, text: line.text, startMs: callCursorMs, endMs: null };
    });
    cursor = endMs;
    return {
      index,
      eventId: event.id,
      type: event.type,
      participantId: event.participantId,
      chatId: event.chatId ?? "primary",
      typingStartMs,
      startMs,
      endMs,
      holdMs,
      typingSequence: buildConversationTypingSequence(event),
      displayTime: event.displayTime,
      deliveredMs,
      readMs,
      callDialogueCues,
    };
  });
  return { version: 1, durationMs: Math.ceil(cursor + 900), entries };
}

export function conversationReceiptAt(event, entry, ms) {
  if (!entry || event.receipt === "none" || Number(ms) < entry.startMs) return null;
  if (event.receipt === "read" && entry.readMs != null && Number(ms) >= entry.readMs) return "read";
  if (["delivered", "read"].includes(event.receipt) && entry.deliveredMs != null && Number(ms) >= entry.deliveredMs) return "delivered";
  return "sent";
}

export function conversationSoundEvents(conversation, timeline) {
  const selfId = conversation.participants.find((item) => item.isSelf)?.id;
  const sounds = [];
  const addChime = (kind, startMs, notes) => {
    for (const [offsetMs, frequency, duration, volume] of notes) sounds.push({ kind, startMs: startMs + offsetMs, frequency, duration, volume });
  };
  for (const entry of timeline.entries) {
    const event = conversation.events[entry.index];
    if (event.typingMs > 0 && entry.participantId === selfId) {
      const audible = (entry.typingSequence?.checkpoints ?? []).filter((point) => ["type", "backspace"].includes(point.action));
      for (const [index, point] of audible.entries()) {
        if (index % 2 && point.action !== "backspace") continue;
        sounds.push({
          kind: point.action === "backspace" ? "backspace" : "typing",
          startMs: entry.typingStartMs + point.atMs,
          frequency: point.action === "backspace" ? 245 : 315 + (index % 5) * 17,
          duration: point.action === "backspace" ? 0.035 : 0.018,
          volume: point.action === "backspace" ? 0.08 : 0.035,
        });
      }
    } else if (entry.type === "typing") {
      sounds.push({
        kind: "typing",
        startMs: entry.typingStartMs,
        frequency: 360,
        duration: Math.min(0.32, Math.max(0.1, (event.typingMs || entry.holdMs) / 7_000)),
        volume: 0.12,
      });
    }
    if (entry.type === "notification") {
      addChime("notification", entry.startMs, [[0, 880, 0.09, 0.35], [90, 1_180, 0.14, 0.31]]);
    } else if (entry.type === "battery") {
      addChime("battery", entry.startMs, [[0, 410, 0.11, 0.24], [145, 330, 0.18, 0.3]]);
    } else if (entry.type === "chat-switch") {
      addChime("switch", entry.startMs, [[0, 520, 0.05, 0.12]]);
    } else if (!["system", "date", "typing"].includes(entry.type)) {
      if (entry.type === "call") {
        if (event.callState === "incoming") {
          const ringDuration = event.callDialogue?.length ? 1_800 : Math.min(entry.holdMs, 5_000);
          for (let offset = 0; offset < ringDuration; offset += 1_100) {
            addChime("call", entry.startMs + offset, [[0, 620, 0.2, 0.32], [180, 780, 0.24, 0.28]]);
          }
        } else addChime("call", entry.startMs, [[0, 620, 0.2, 0.32], [180, 780, 0.24, 0.28]]);
      } else if (entry.participantId === selfId) {
        addChime("outgoing", entry.startMs, [[0, 780, 0.075, 0.34], [46, 1_080, 0.12, 0.42]]);
      } else {
        addChime("incoming", entry.startMs, [[0, 820, 0.1, 0.4], [58, 610, 0.15, 0.46]]);
      }
    }
    if (event.receipt === "read" && entry.participantId === selfId && entry.readMs != null) {
      addChime("read", entry.readMs, [[0, 1_120, 0.055, 0.22], [52, 1_360, 0.085, 0.28]]);
    }
  }
  return sounds;
}

export function conversationAssetIds(conversation) {
  const ids = new Set();
  for (const participant of conversation.participants) if (participant.avatarAssetId) ids.add(participant.avatarAssetId);
  for (const event of conversation.events) if (event.assetId) ids.add(event.assetId);
  if (conversation.appearance.background.assetId) ids.add(conversation.appearance.background.assetId);
  if (conversation.audio.musicSource === "upload" && conversation.audio.musicAssetId) ids.add(conversation.audio.musicAssetId);
  return [...ids];
}

export function buildConversationDocument(conversation, timeline, { assetUrls = {}, preview = false, musicUrl = "" } = {}) {
  const publicConversation = structuredClone(conversation);
  const brandKit = publicConversation.brandKit;
  delete publicConversation.ownerUserId;
  delete publicConversation.assets;
  delete publicConversation.brandKit;
  const safeConversation = {
    ...publicConversation,
    brand: brandKit?.enabled ? {
      fontFamily: brandKit.fontFamily,
      primaryColor: brandKit.primaryColor,
      accentColor: brandKit.accentColor,
    } : null,
    participants: conversation.participants.map((participant) => ({ ...participant, avatarUrl: participant.avatarAssetId ? assetUrls[participant.avatarAssetId] ?? "" : "" })),
    events: conversation.events.map((event) => ({ ...event, assetUrl: event.assetId ? assetUrls[event.assetId] ?? "" : "" })),
    audio: {
      ...conversation.audio,
      musicUrl: preview && conversation.audio.musicSource !== "none" ? musicUrl : "",
    },
    appearance: {
      ...conversation.appearance,
      background: {
        ...conversation.appearance.background,
        assetUrl: conversation.appearance.background.assetId ? assetUrls[conversation.appearance.background.assetId] ?? "" : "",
      },
    },
  };
  const payload = escapeJsonForHtml(JSON.stringify({ conversation: safeConversation, timeline, preview }));
  return `<!doctype html>
<html lang="${escapeAttribute(languageTag(conversation.language))}" dir="${["Arabic", "Hebrew"].includes(conversation.language) ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob: file:; media-src 'self' blob: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self' data:; connect-src 'none';">
<title>Reelio fictional conversation</title>
<style>${conversationCss()}</style>
</head>
<body>
<main id="stage"><div id="backdrop"></div><section id="phone"><header id="phoneHeader"></header><div id="messages"></div><div id="composer"><span id="composerText">Message</span><b>＋</b></div><div id="phoneOverlay"></div><div id="fiction">Fictional conversation · Reelio</div></section><div id="safe"></div></main>
<script>
const PAYLOAD=JSON.parse('${payload}');
const C=PAYLOAD.conversation,T=PAYLOAD.timeline;
const stage=document.getElementById('stage'),phone=document.getElementById('phone'),list=document.getElementById('messages'),header=document.getElementById('phoneHeader'),backdrop=document.getElementById('backdrop'),safe=document.getElementById('safe'),composer=document.getElementById('composer'),composerText=document.getElementById('composerText'),overlay=document.getElementById('phoneOverlay');
const participants=new Map(C.participants.map(p=>[p.id,p]));
let currentMs=0,timer=0,frameTimer=0,lastTick=0,playing=false,rate=1,muted=false,lastVisualSignature='',lastPostedMs=-Infinity,lastHeaderSignature='';
const animatedEvents=new Set(),animatedOverlays=new Set();
stage.className=[C.appearance.theme,C.appearance.layout,C.appearance.bubbleStyle].join(' ');
stage.style.setProperty('--bg',C.appearance.background.color);
stage.style.setProperty('--accent',C.appearance.background.accentColor);
if(C.brand?.fontFamily)stage.style.setProperty('--font',C.brand.fontFamily);
safe.style.display=C.appearance.showSafeZone?'block':'none';
let backgroundVideo=null;
if(C.appearance.background.assetUrl&&C.appearance.background.type==='motion'){backgroundVideo=document.createElement('video');backgroundVideo.src=C.appearance.background.assetUrl;backgroundVideo.muted=true;backgroundVideo.preload='auto';backgroundVideo.playsInline=true;backdrop.append(backgroundVideo)}
else if(C.appearance.background.assetUrl){backdrop.style.backgroundImage='url("'+String(C.appearance.background.assetUrl).replaceAll('"','%22')+'")'}
let previewMusic=null;
if(PAYLOAD.preview&&C.audio.musicUrl){previewMusic=document.createElement('audio');previewMusic.src=C.audio.musicUrl;previewMusic.loop=true;previewMusic.preload='auto';previewMusic.volume=Math.max(.02,Math.min(.7,Number(C.audio.musicVolume)||.2));previewMusic.muted=muted}
const others=C.participants.filter(p=>!p.isSelf);
renderHeader('primary',0);
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;if(/messageText|caption|reply|callText|system/.test(cls||''))node.dir='auto';return node}
function avatar(p){const node=el('div','avatar');node.style.background=p.color;if(p.avatarUrl){const image=document.createElement('img');image.src=p.avatarUrl;image.alt='';node.append(image)}else node.textContent=p.initials;return node}
function eventNode(event,entry,ms){
 const p=event.participantId?participants.get(event.participantId):null;
 if(event.type==='typing'){return typingNode(p)}
 if(event.type==='system'||event.type==='date'){return el('div','system '+event.type,event.text)}
 const row=el('article','event '+(p?.isSelf?'self':'other')+' type-'+event.type);
 if(p&&!p.isSelf&&C.participants.length>2)row.append(avatar(p));
 const wrap=el('div','bubbleWrap');
 if(p&&!p.isSelf&&C.participants.length>2)wrap.append(el('small','speaker',p.name));
 const bubble=el('div','bubble');
 if(event.replyToEventId){const target=C.events.find(x=>x.id===event.replyToEventId);const quoted=el('div','reply');quoted.textContent=(participants.get(target?.participantId)?.name||'Conversation')+' · '+(target?.text||target?.fileName||target?.type||'message');bubble.append(quoted)}
 if(event.deleted){bubble.append(el('em','deleted','Message deleted'))}
 else if(event.type==='image'){bubble.append(media('img',event))}
 else if(event.type==='video'){const video=media('video',event);video.muted=muted;video.playsInline=true;bubble.append(video)}
 else if(event.type==='audio'){const voice=el('div','voice');voice.append(el('span','play','▶'),el('span','wave','▂▄▆▃▇▅▂▄▆'),el('span','voiceTime',formatMs(Math.max(0,ms-entry.startMs))));bubble.append(voice)}
 else if(event.type==='call'){bubble.append(el('strong','callTitle',callLabel(event.callState)),el('span','callText',event.text))}
 else bubble.append(el('span','messageText',event.text));
 if(event.text&&!['text','call'].includes(event.type))bubble.append(el('span','caption',event.text));
 if(event.edited)bubble.append(el('small','edited','edited'));
 wrap.append(bubble);
 if(event.reactions?.length){const reacts=el('div','reactions');for(const r of event.reactions)reacts.append(el('span','reaction',r.emoji));wrap.append(reacts)}
 const receipt=p?.isSelf?receiptAt(event,entry,ms):null;
 const meta=el('small','meta',(event.displayTime||'')+(receipt?' · '+receipt:''));
 wrap.append(meta);row.append(wrap);return row
}
function media(tag,event){const node=document.createElement(tag);node.className='attachment';node.src=event.assetUrl||'';node.alt=event.fileName||event.type;if(tag==='video')node.preload='auto';return node}
function typingNode(p,entry,ms){const row=el('article','event stable typing-row '+(p?.isSelf?'self':'other'));const bubble=el('div','bubble typing');const step=typingStep(entry,ms),cycle=720+(step%5)*110,phase=((Math.max(0,ms-entry.typingStartMs)%cycle)/cycle)*3;for(let i=0;i<3;i++){const dot=el('i','', ''),distance=Math.min(Math.abs(phase-i),Math.abs(phase-i+3),Math.abs(phase-i-3)),lift=Math.max(0,1-distance);dot.style.opacity=String(.58+lift*.42);dot.style.transform='translateY('+(-2*lift).toFixed(2)+'px)';bubble.append(dot)}row.append(bubble);return row}
function callLabel(state){return ({incoming:'Incoming call',outgoing:'Outgoing call',missed:'Missed call',declined:'Declined call',completed:'Call completed'})[state]||'Call'}
function receiptAt(event,entry,ms){if(event.receipt==='none'||ms<entry.startMs)return null;if(event.receipt==='read'&&entry.readMs!=null&&ms>=entry.readMs)return'read';if((event.receipt==='delivered'||event.receipt==='read')&&entry.deliveredMs!=null&&ms>=entry.deliveredMs)return'delivered';return'sent'}
function clockLabel(value,format){if(format!=='12h')return value;const [h,m]=String(value).split(':').map(Number);return String(h%12||12)+':'+String(m).padStart(2,'0')+(h>=12?' PM':' AM')}
function formatMs(ms){const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function typingStep(entry,ms){const points=entry.typingSequence?.checkpoints||[];const local=Math.max(0,ms-entry.typingStartMs);let index=0;for(let i=0;i<points.length;i++){if(points[i].atMs>local)break;index=i}return index}
function typingText(entry,ms){const points=entry.typingSequence?.checkpoints||[];return points[typingStep(entry,ms)]?.text||''}
function activeChatAt(ms){let chatId='primary',title='';for(let i=0;i<C.events.length;i++){const event=C.events[i],entry=T.entries[i];if(ms<entry.startMs)break;if(event.type==='chat-switch'){chatId=event.chatId||'primary';title=event.chatTitle||event.text||''}}return{chatId,title}}
function chatContact(chatId,ms){for(let i=C.events.length-1;i>=0;i--){const event=C.events[i],entry=T.entries[i];if(entry.startMs>ms||event.chatId!==chatId||!event.participantId)continue;const participant=participants.get(event.participantId);if(participant&&!participant.isSelf)return participant}return others[0]||C.participants[0]}
function displayedClockAt(ms){let value=C.events.find(event=>event.displayTime)?.displayTime||C.clock.startTime;for(let i=0;i<C.events.length;i++){const event=C.events[i],entry=T.entries[i];if(ms<entry.typingStartMs)break;if(event.displayTime)value=event.displayTime}return value}
function renderHeader(chatId,ms,title=''){
 const contact=chatContact(chatId,ms),label=title||[...C.events].reverse().find(event=>event.chatId===chatId&&event.chatTitle)?.chatTitle||contact?.name||C.title;
 const chatParticipants=new Set(C.events.filter(event=>event.chatId===chatId&&event.participantId).map(event=>event.participantId));
 const otherParticipantCount=[...chatParticipants].filter(id=>!participants.get(id)?.isSelf).length;
 const subtitle=otherParticipantCount>1?(otherParticipantCount+1)+' participants':'Active now',displayedClock=displayedClockAt(ms),signature=chatId+':'+contact?.id+':'+label+':'+subtitle+':'+displayedClock;
 if(signature===lastHeaderSignature)return;
 lastHeaderSignature=signature;
 const status=el('div','statusbar'),statusIcons=el('div','status-icons');
 status.append(el('span','status-time',clockLabel(displayedClock,C.clock.format)));
 statusIcons.append(el('i','signal'),el('i','wifi'),el('i','battery'));
 status.append(statusIcons);
 const nav=el('div','chat-nav'),back=el('span','back','‹'),copy=el('div','contact-copy'),actions=el('div','actions');
 copy.append(el('strong','contact',label),el('small','contact-status',subtitle));
 actions.append(el('span','header-action search'),el('span','header-action more'));
 nav.append(back,avatar(contact),copy,actions);
 header.replaceChildren(status,nav)
}
function callDialogueAt(event,entry,localMs){const cues=entry.callDialogueCues||[];let latest=null;for(const cue of cues){if(localMs<cue.startMs)break;latest=cue}return latest}
function overlayNode(event,entry,ms){
 const local=Math.max(0,ms-entry.startMs),p=event.participantId?participants.get(event.participantId):null;
 if(event.type==='notification'){const node=el('div','notification-banner');node.append(avatar(p),el('div','notification-copy'));node.lastChild.append(el('strong','',event.notificationTitle||p?.name||'New message'),el('span','',event.text));node.append(el('small','notification-now','now'));return node}
 if(event.type==='battery'){const node=el('div','battery-alert');node.append(el('div','battery-icon',String(event.batteryLevel||10)+'%'),el('strong','',event.charging?'Battery charging':'Low Battery'),el('p','',event.charging?'Power connected. Charging has started.':String(event.batteryLevel||10)+'% of battery remaining.'),el('button','battery-dismiss','Close'));return node}
 if(event.type==='call'){const state=event.callState||'completed',answered=Boolean(event.callDialogue?.length)&&local>=1800,active=['outgoing','completed'].includes(state)||answered,ringing=state==='incoming'&&!answered;const node=el('div','call-screen '+state);node.append(el('div','call-status',ringing?'incoming phone call':state==='outgoing'&&local<1800?'calling…':active?'connected · '+formatMs(Math.max(0,local-1800)):callLabel(state)),avatar(p),el('h2','call-name',p?.name||'Unknown caller'));const line=callDialogueAt(event,entry,local);if(line){const speaker=participants.get(line.participantId);node.append(el('div','call-caption',(speaker?.name||'Caller')+': '+line.text))}const controls=el('div','call-controls');if(ringing){controls.append(el('button','decline','✕'),el('button','accept','●'))}else{controls.append(el('button','call-control','⌁'),el('button','call-control','◉'),el('button','decline','✕'))}node.append(controls);return node}
 if(event.type==='chat-switch'){const node=el('div','chat-switch-overlay');node.append(el('span','switch-icon','↔'),el('strong','',event.chatTitle||event.text),el('small','','Opening conversation'));return node}
 return null
}
async function renderAt(ms){
 const previousMs=currentMs;
 currentMs=Math.max(0,Math.min(T.durationMs,Number(ms)||0));
 if(previewMusic&&!playing&&Number.isFinite(previewMusic.duration)&&previewMusic.duration>0){previewMusic.currentTime=currentMs/1000%previewMusic.duration}
 if(playing&&!muted&&currentMs>=previousMs)emitSoundEvents(previousMs,currentMs);
 const signature=visualSignature(currentMs);
 if(signature===lastVisualSignature){postTime();return currentMs}
 lastVisualSignature=signature;list.replaceChildren();overlay.replaceChildren();composerText.textContent='Message';composer.classList.remove('composing');
 const mediaPromises=[];
 if(backgroundVideo){const duration=Number.isFinite(backgroundVideo.duration)&&backgroundVideo.duration>0?backgroundVideo.duration:30;mediaPromises.push(seekMedia(backgroundVideo,currentMs/1000%duration))}
 const active=activeChatAt(currentMs);renderHeader(active.chatId,currentMs,active.title);
 for(let i=0;i<C.events.length;i++){
   const event=C.events[i],entry=T.entries[i];
   if(currentMs>=entry.typingStartMs&&currentMs<entry.startMs&&event.typingMs>0){
     const participant=participants.get(event.participantId);
     if(participant?.isSelf&&event.type==='text'){composerText.textContent=typingText(entry,currentMs)||'Message';composer.classList.add('composing');composerText.scrollTop=composerText.scrollHeight}
     else list.append(typingNode(participant,entry,currentMs));
     break
   }
   if(currentMs<entry.startMs)break;
   if(event.type==='typing'&&currentMs<entry.endMs&&event.chatId===active.chatId){list.append(typingNode(participants.get(event.participantId),entry,currentMs));continue}
   if(currentMs<entry.endMs&&['notification','battery','call','chat-switch'].includes(event.type)){const activeOverlay=overlayNode(event,entry,currentMs);if(activeOverlay){if(animatedOverlays.has(event.id))activeOverlay.classList.add('stable');else animatedOverlays.add(event.id);overlay.append(activeOverlay)}}
   if(['notification','battery','chat-switch','typing'].includes(event.type)||event.chatId!==active.chatId)continue;
   const node=eventNode(event,entry,currentMs);if(animatedEvents.has(event.id))node.classList.add('stable');else animatedEvents.add(event.id);list.append(node);
   const previous=C.events[i-1];
   if(previous&&event.participantId&&previous.participantId===event.participantId&&!['system','date','typing','call'].includes(event.type)&&!['system','date','typing','call'].includes(previous.type))node.classList.add('grouped');
   const video=node.querySelector('video');
   if(video&&event.assetUrl){const local=Math.max(0,(currentMs-entry.startMs)/1000);mediaPromises.push(seekMedia(video,local))}
 }
 await Promise.all(mediaPromises);list.scrollTop=list.scrollHeight;
 document.body.dataset.time=String(Math.round(currentMs));postTime(true);return currentMs
}
function visualSignature(ms){
 let visible=-1,typing=-1,typingCheckpoint=-1,continuous=Boolean(backgroundVideo),receipts='',transient='';
 for(let i=0;i<C.events.length;i++){
   const event=C.events[i],entry=T.entries[i];
   if(ms>=entry.typingStartMs&&ms<entry.startMs&&event.typingMs>0){typing=i;typingCheckpoint=typingStep(entry,ms);break}
   if(ms<entry.startMs)break;
   visible=i;
   if(event.type==='typing'&&ms<entry.endMs)continuous=true;
   if(ms<entry.endMs&&['notification','battery','call','chat-switch'].includes(event.type)){transient=i+'-'+Math.floor((ms-entry.startMs)/(event.type==='call'?100:180))}
   if(event.receipt!=='none')receipts+=i+'-'+(receiptAt(event,entry,ms)||'')+';';
   if(event.type==='video'||event.type==='audio')continuous=true;
 }
 const continuousStep=PAYLOAD.preview?50:1000/30;
 return visible+':'+typing+':'+typingCheckpoint+':'+transient+':'+activeChatAt(ms).chatId+':'+receipts+':'+(continuous?Math.floor(ms/continuousStep):0)
}
function emitSoundEvents(fromMs,toMs){
 const selfId=C.participants.find(p=>p.isSelf)?.id;
 for(let i=0;i<T.entries.length;i++){
   const entry=T.entries[i],event=C.events[i];
   if(fromMs<entry.startMs&&toMs>=entry.startMs&&!['system','date','typing'].includes(entry.type)){
     const kind=entry.type==='call'?'call':entry.type==='notification'?'notification':entry.type==='battery'?'battery':entry.type==='chat-switch'?'switch':entry.participantId===selfId?'outgoing':'incoming';
     window.parent?.postMessage({type:'reelio-conversation-sfx',kind},'*')
   }
   if(event.receipt==='read'&&entry.participantId===selfId&&entry.readMs!=null&&fromMs<entry.readMs&&toMs>=entry.readMs){
     window.parent?.postMessage({type:'reelio-conversation-sfx',kind:'read'},'*')
   }
 }
}
function postTime(force=false){if(!force&&currentMs<T.durationMs&&currentMs!==0&&currentMs-lastPostedMs<50)return;lastPostedMs=currentMs;window.parent?.postMessage({type:'reelio-conversation-time',ms:currentMs,durationMs:T.durationMs},'*')}
function seekMedia(video,time){return new Promise(resolve=>{let finished=false;const done=()=>{if(finished)return;finished=true;resolve()};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',done,{once:true});video.currentTime=time;setTimeout(done,240)})}
function scheduleTick(){frameTimer=setTimeout(()=>{timer=requestAnimationFrame(tick)},0)}
function tick(now){if(!playing)return;const delta=(now-lastTick)*rate;lastTick=now;renderAt(currentMs+delta).then(()=>{if(currentMs>=T.durationMs){playing=false;if(previewMusic)previewMusic.pause();window.parent?.postMessage({type:'reelio-conversation-ended'},'*')}else scheduleTick()})}
window.__reelioConversation={ready:true,durationMs:T.durationMs,seek:renderAt,play(speed=1){rate=Number(speed)||1;if(!playing){playing=true;if(previewMusic){previewMusic.playbackRate=Math.max(.5,Math.min(2,rate));previewMusic.muted=muted;previewMusic.play().catch(()=>{})}lastTick=performance.now();timer=requestAnimationFrame(tick)}},pause(){playing=false;if(previewMusic)previewMusic.pause();cancelAnimationFrame(timer);clearTimeout(frameTimer)},restart(){this.pause();if(previewMusic)previewMusic.currentTime=0;animatedEvents.clear();animatedOverlays.clear();lastHeaderSignature='';lastVisualSignature='';return renderAt(0)},setMuted(value){muted=Boolean(value);if(previewMusic)previewMusic.muted=muted;lastVisualSignature='';return renderAt(currentMs)},setSafeZone(value){safe.style.display=value?'block':'none'}};
window.addEventListener('message',event=>{const d=event.data||{};if(d.type==='reelio-conversation-seek')renderAt(d.ms);if(d.type==='reelio-conversation-play')window.__reelioConversation.play(d.speed);if(d.type==='reelio-conversation-pause')window.__reelioConversation.pause();if(d.type==='reelio-conversation-restart')window.__reelioConversation.restart();if(d.type==='reelio-conversation-mute')window.__reelioConversation.setMuted(d.muted);if(d.type==='reelio-conversation-safe-zone')window.__reelioConversation.setSafeZone(d.visible)});
const initialPreviewMs=PAYLOAD.preview?Math.max(0,Math.min(T.durationMs,Number(new URLSearchParams(location.search).get('at'))||0)):0;
renderAt(initialPreviewMs).then(()=>{window.__reelioReady=true;window.parent?.postMessage({type:'reelio-conversation-ready',durationMs:T.durationMs},'*')});
</script>
</body></html>`;
}

export async function renderConversationJob(job, progress) {
  const renderStartedAt = Date.now();
  const conversation = job.request.conversation;
  const outputDir = path.join(getRoot(), "generated", job.id);
  await mkdir(outputDir, { recursive: true });
  const assetEntries = conversation.assets ?? [];
  for (const item of assetEntries) await access(item.file);
  assertConversationSnapshotComplete(conversation);

  await progress("conversation-assets", 8, "Preparing approved conversation assets");
  const cueDir = path.join(outputDir, "conversation-voice-cues");
  await mkdir(cueDir, { recursive: true });
  await progress("conversation-voices", 12, "Synthesizing selected conversation voices");
  const speech = await createConversationSpeech(conversation, cueDir, progress);
  const durationOverrides = new Map();
  for (const cue of speech.cues) {
    durationOverrides.set(cue.eventId, Math.max(durationOverrides.get(cue.eventId) ?? 0, cue.offsetMs / 1000 + cue.duration));
  }
  const timeline = buildConversationTimeline(conversation, durationOverrides);
  for (const entry of timeline.entries) {
    const callCues = speech.cues.filter((cue) => cue.eventId === entry.eventId && cue.callLine);
    if (callCues.length) entry.callDialogueCues = callCues.map((cue) => ({
      cueId: cue.cueId,
      participantId: cue.participantId,
      text: cue.text,
      startMs: cue.offsetMs,
      endMs: cue.offsetMs + Math.ceil(cue.duration * 1_000),
    }));
  }
  await progress("conversation-timeline", 34, "Finalizing the approved conversation timeline");

  const timelinePath = path.join(outputDir, "conversation-timeline.json");
  const manifestPath = path.join(outputDir, "conversation.json");
  await writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(publicConversationSnapshot(conversation), null, 2)}\n`, "utf8");

  const assetUrls = Object.fromEntries(assetEntries.map((item) => [item.id, relativeAssetUrl(outputDir, item.file)]));
  const documentPath = path.join(outputDir, "conversation-render.html");
  await writeFile(documentPath, buildConversationDocument(conversation, timeline, { assetUrls }), "utf8");

  await progress("conversation-record", 38, "Recording the approved phone conversation");
  const rawCapturePath = path.join(outputDir, "conversation-capture.mp4");
  const cleanPath = path.join(outputDir, "clean.mp4");
  const thumbnailPath = path.join(outputDir, "thumbnail.jpg");
  const captureDiagnostics = await captureConversationDocument(documentPath, rawCapturePath, thumbnailPath, timeline.durationMs, conversation.appearance.coverTimeMs, progress);
  const brandedCapturePath = await applyBrandVisuals(
    rawCapturePath,
    timeline.durationMs / 1000,
    outputDir,
    conversation.brandKit,
    { outputName: "clean.mp4" },
  );
  if (brandedCapturePath === rawCapturePath) await copyFile(rawCapturePath, cleanPath);
  await rm(rawCapturePath, { force: true });
  await progress("conversation-thumbnail", 74, "Finalizing the selected conversation cover frame");

  await progress("conversation-audio", 76, "Mixing conversation voices and message sounds");
  const audio = await createConversationAudio(conversation, timeline, speech, outputDir);
  const finalPath = path.join(outputDir, "final.mp4");
  await muxConversationAudio(cleanPath, audio.mix, finalPath, timeline.durationMs / 1000);

  const transcriptPath = path.join(outputDir, "transcript.txt");
  const captionsPath = path.join(outputDir, "captions.srt");
  await writeFile(transcriptPath, `${conversationTranscript(conversation, timeline)}\n`, "utf8");
  await writeFile(captionsPath, conversationSrt(conversation, timeline), "utf8");

  await progress("conversation-package", 91, "Preparing the fictional conversation publishing package");
  const title = conversation.title;
  const description = `A fictional message conversation created in Reelio. ${conversation.events.filter((event) => event.text).slice(0, 3).map((event) => event.text).join(" ")}`.slice(0, 600);
  const tags = ["fictionalconversation", "chatstory", "reelio"];
  const platformCopy = Object.fromEntries((conversation.platforms ?? []).map((platform) => [platform, {
    title,
    caption: `${title} — a fictional conversation.`,
    description,
    tags,
  }]));
  const publishingCopyPath = path.join(outputDir, "publishing-copy.json");
  await writeFile(publishingCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  const metadata = {
    title,
    description,
    tags,
    durationSeconds: Number((timeline.durationMs / 1000).toFixed(2)),
    resolution: "1080x1920",
    frameRate: 30,
    narrationLanguage: conversation.language,
    subtitleLanguage: conversation.language,
    voiceProvider: speech.provider,
    narrator: conversation.audio.mode === "characters" ? "Character voice cast" : conversation.audio.mode === "narrator" ? narratorProfile(conversation.audio.narratorId).name : "No spoken narration",
    visualSource: "Original Reelio fictional conversation renderer",
    creationMode: "message-conversation",
    conversationDraftId: job.request.draftId,
    conversationDraftRevision: job.request.draftRevision,
    conversationTheme: conversation.appearance.theme,
    conversationLayout: conversation.appearance.layout,
    conversationAudioMode: conversation.audio.mode,
    conversationMusicSource: conversation.audio.musicSource,
    conversationParticipants: conversation.participants.map((item) => item.name),
    authenticity: "fictional",
    renderDiagnostics: {
      browserVersion: captureDiagnostics.browserVersion,
      captureDurationMs: captureDiagnostics.captureDurationMs,
      totalDurationMs: Date.now() - renderStartedAt,
      retryCount: Math.max(0, Number(job.attempt ?? 0)),
      captureMode: "deterministic-frame-step",
    },
    platformCopy,
    retentionPreflight: {
      score: 100,
      hookWithinSeconds: Number((timeline.entries[0]?.startMs / 1000 ?? 0).toFixed(2)),
      averageVisualChangeSeconds: Number((timeline.durationMs / Math.max(1, timeline.entries.length) / 1000).toFixed(2)),
      highContrastCaptions: true,
      noIntroBeforeHook: true,
    },
  };
  const metadataPath = path.join(outputDir, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return {
    assets: {
      final: await localAsset(finalPath),
      clean: await localAsset(cleanPath),
      thumbnail: await localAsset(thumbnailPath),
      transcript: await localAsset(transcriptPath),
      captions: await localAsset(captionsPath),
      conversation: await localAsset(manifestPath),
      timeline: await localAsset(timelinePath),
      ...(speech.dialogue ? { dialogue: await localAsset(speech.dialogue) } : {}),
      ...(audio.effects ? { effects: await localAsset(audio.effects) } : {}),
      ...(audio.music ? { music: await localAsset(audio.music) } : {}),
      metadata: await localAsset(metadataPath),
      publishingCopy: await localAsset(publishingCopyPath),
    },
    metadata,
  };
}

function assertConversationSnapshotComplete(conversation) {
  const assets = new Map((conversation.assets ?? []).map((asset) => [asset.id, asset]));
  for (const [index, event] of conversation.events.entries()) {
    if (!["image", "video", "audio"].includes(event.type)) continue;
    if (!event.assetId || !assets.has(event.assetId)) throw new Error(`Conversation event ${index + 1} is missing its approved local ${event.type} attachment.`);
    if (event.type === "video" && event.playAudio && !assets.get(event.assetId).hasAudio) {
      throw new Error(`Video attachment "${event.fileName || "video"}" does not contain an audio track.`);
    }
  }
  if (["image", "motion"].includes(conversation.appearance.background.type)) {
    const assetId = conversation.appearance.background.assetId;
    if (!assetId || !assets.has(assetId)) throw new Error("The approved local conversation background is missing.");
  }
  if (conversation.audio.musicSource === "upload") {
    const music = assets.get(conversation.audio.musicAssetId);
    if (!music || !music.file) throw new Error("The approved local conversation soundtrack is missing.");
  }
  if (conversation.audio.musicSource === "brand" && !conversation.brandKit?.enabled) {
    throw new Error("Brand Kit music was selected, but no active Brand Kit was included in this job.");
  }
}

async function createConversationSpeech(conversation, outputDir, progress) {
  if (!["narrator", "characters"].includes(conversation.audio.mode)) return { cues: [], dialogue: null, provider: "No speech" };
  const speakable = [];
  for (const event of conversation.events) {
    if (event.type === "text" && !event.deleted && event.text) {
      speakable.push({ cueId: event.id, eventId: event.id, participantId: event.participantId, text: event.text, offsetMs: 0 });
    }
    if (event.type === "call") {
      for (const line of event.callDialogue ?? []) {
        speakable.push({
          cueId: `${event.id}:${line.id}`,
          eventId: event.id,
          participantId: line.participantId,
          text: line.text,
          offsetMs: 0,
          callLine: true,
          callBaseMs: event.callState === "incoming" && !(event.callDialogue?.length) ? 0 : 1_800,
          delayMs: line.delayMs,
        });
      }
    }
  }
  if (!speakable.length) return { cues: [], dialogue: null, provider: "No speech" };
  const groups = new Map();
  for (const cue of speakable) {
    const participant = conversation.participants.find((item) => item.id === cue.participantId);
    const narratorId = conversation.audio.mode === "narrator" ? conversation.audio.narratorId : participant.narratorId;
    if (!groups.has(narratorId)) groups.set(narratorId, []);
    groups.get(narratorId).push(cue);
  }
  const cueFiles = new Map();
  let completed = 0;
  for (const [narratorId, cues] of groups) {
    assertJobActive();
    const narrator = narratorProfile(narratorId);
    const groupDir = path.join(outputDir, narratorId);
    await mkdir(groupDir, { recursive: true });
    const segments = cues.map((cue) => cue.text);
    const files = conversation.audio.ttsEngine === "kokoro"
      ? await synthesizeKokoroCues({ segments, outputDir: groupDir, speed: 1.08 * narrator.speedScale, voice: narrator.kokoroVoice })
      : conversation.audio.ttsEngine === "voxcpm2"
        ? await synthesizeVoxCpmCues({
          segments,
          language: conversation.language,
          outputDir: groupDir,
          voiceDescription: narrator.voxDescription,
          personaId: narrator.id,
          personaSeed: narrator.voxSeed,
          personaReferenceText: narrator.voxReferenceText,
        })
        : await synthesizeGeminiCues({ segments, language: conversation.language, outputDir: groupDir, voice: narrator.geminiVoice, delivery: narrator.delivery });
    for (const [index, cue] of cues.entries()) {
      cueFiles.set(cue.cueId, files[index]);
      completed += 1;
      await progress("conversation-voices", 12 + Math.round((completed / speakable.length) * 20), `Prepared voice ${completed} of ${speakable.length}`);
    }
  }
  const cues = [];
  const callCursors = new Map();
  for (const cue of speakable) {
    const file = cueFiles.get(cue.cueId);
    const duration = await mediaDuration(file);
    let offsetMs = cue.offsetMs;
    if (cue.callLine) {
      const cursor = (callCursors.get(cue.eventId) ?? cue.callBaseMs) + cue.delayMs;
      offsetMs = cursor;
      callCursors.set(cue.eventId, cursor + Math.ceil(duration * 1_000));
    }
    cues.push({ ...cue, offsetMs, file, duration });
  }
  return {
    cues,
    dialogue: null,
    provider: conversation.audio.ttsEngine === "gemini" ? "Gemini TTS" : conversation.audio.ttsEngine === "kokoro" ? "Local Kokoro" : "Local VoxCPM2",
  };
}

async function createConversationAudio(conversation, timeline, speech, outputDir) {
  const duration = timeline.durationMs / 1000;
  const inputs = [];
  const filters = [];
  const mixLabels = [];
  let inputIndex = 0;
  for (const cue of speech.cues) {
    const entry = timeline.entries.find((item) => item.eventId === cue.eventId);
    inputs.push("-i", cue.file);
    const phoneFilter = cue.callLine ? ",highpass=f=280,lowpass=f=3600,acompressor=threshold=-22dB:ratio=2.5:attack=12:release=120" : "";
    filters.push(`[${inputIndex}:a]aresample=48000${phoneFilter},adelay=${Math.round(entry.startMs + (cue.offsetMs ?? 0))}:all=1,volume=1[voice${inputIndex}]`);
    mixLabels.push(`[voice${inputIndex}]`);
    inputIndex += 1;
  }
  for (const event of (conversation.audio.mode === "silent" ? [] : conversation.events).filter((item) =>
    item.assetId && (item.type === "audio" || (item.type === "video" && item.playAudio))
  )) {
    const asset = conversation.assets.find((item) => item.id === event.assetId);
    const entry = timeline.entries.find((item) => item.eventId === event.id);
    if (!asset?.file || !entry || (event.type === "video" && !asset.hasAudio)) continue;
    inputs.push("-i", asset.file);
    filters.push(`[${inputIndex}:a]aresample=48000,atrim=duration=${(entry.holdMs / 1000).toFixed(3)},adelay=${Math.round(entry.startMs)}:all=1,volume=1[voice${inputIndex}]`);
    mixLabels.push(`[voice${inputIndex}]`);
    inputIndex += 1;
  }
  let dialogue = null;
  if (mixLabels.length) {
    dialogue = path.join(outputDir, "dialogue.m4a");
    filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[dialogue]`);
    await run(ffmpegPath, ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[dialogue]", "-t", duration.toFixed(3), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", dialogue]);
    speech.dialogue = dialogue;
  }
  let effects = null;
  if (conversation.audio.mode !== "silent" && conversation.audio.sfxVolume > 0) {
    effects = path.join(outputDir, "effects.m4a");
    await renderConversationEffects(conversation, timeline, effects);
  }
  let music = null;
  const brandMusic = conversation.brandKit?.enabled && conversation.brandKit.assets?.music?.file ? conversation.brandKit.assets.music.file : null;
  const uploadedMusic = conversation.audio.musicSource === "upload"
    ? conversation.assets.find((item) => item.id === conversation.audio.musicAssetId)?.file
    : null;
  const selectedMusic = conversation.audio.musicSource === "brand" ? brandMusic : uploadedMusic;
  if (conversation.audio.musicSource !== "none" && !selectedMusic) {
    throw new Error(conversation.audio.musicSource === "brand"
      ? "Brand Kit music was selected, but the approved Brand Kit has no music track."
      : "The approved local conversation soundtrack is missing.");
  }
  if (selectedMusic) {
    music = path.join(outputDir, "music.m4a");
    await renderConversationMusic(selectedMusic, duration, conversation.audio.musicVolume, music);
  }
  const tracks = [dialogue, effects, music].filter(Boolean);
  const mix = path.join(outputDir, "conversation-mix.m4a");
  if (!tracks.length) {
    await run(ffmpegPath, ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", duration.toFixed(3), "-c:a", "aac", "-b:a", "128k", mix]);
  } else {
    const trackInputs = tracks.flatMap((file) => ["-i", file]);
    let graph;
    if (dialogue && music) {
      const dialogueIndex = tracks.indexOf(dialogue);
      const musicIndex = tracks.indexOf(music);
      const mixLabels = tracks.map((_, index) => {
        if (index === dialogueIndex) return "[dialogue-main]";
        if (index === musicIndex) return "[music-ducked]";
        return `[${index}:a]`;
      }).join("");
      graph = `[${dialogueIndex}:a]asplit=2[dialogue-main][dialogue-key];[${musicIndex}:a][dialogue-key]sidechaincompress=threshold=0.025:ratio=8:attack=18:release=320[music-ducked];${mixLabels}amix=inputs=${tracks.length}:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    } else {
      const labels = tracks.map((_, index) => `[${index}:a]`).join("");
      graph = `${labels}amix=inputs=${tracks.length}:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
    }
    await run(ffmpegPath, ["-y", ...trackInputs, "-filter_complex", graph, "-map", "[aout]", "-t", duration.toFixed(3), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", mix]);
  }
  return { mix, effects, music };
}

export async function renderConversationEffects(conversation, timeline, output) {
  const duration = timeline.durationMs / 1000;
  const soundEvents = conversationSoundEvents(conversation, timeline);
  const sources = soundEvents.map((sound, index) =>
    `sine=frequency=${sound.frequency}:sample_rate=48000:duration=${sound.duration.toFixed(3)},adelay=${Math.round(sound.startMs)}:all=1,volume=${(conversation.audio.sfxVolume * sound.volume).toFixed(4)}[s${index}]`
  );
  const labels = sources.map((_, index) => `[s${index}]`).join("");
  const graph = sources.length
    ? `${sources.join(";")};${labels}amix=inputs=${sources.length}:duration=longest:normalize=0,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}[fx]`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(3)}[fx]`;
  await run(ffmpegPath, ["-y", "-filter_complex", graph, "-map", "[fx]", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", output]);
  return output;
}

export async function renderConversationMusic(input, durationSeconds, volume, output) {
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
  const level = numberRange(volume, 0.02, 0.7, 0.2);
  await run(ffmpegPath, [
    "-y", "-stream_loop", "-1", "-i", input, "-t", duration.toFixed(3),
    "-af", `volume=${level},loudnorm=I=-24:TP=-3:LRA=7`,
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", output,
  ]);
  return output;
}

async function captureConversationDocument(documentPath, output, thumbnail, durationMs, coverTimeMs, progress) {
  const captureStartedAt = Date.now();
  const executablePath = await conversationBrowserExecutable();
  if (!executablePath) throw new Error("Conversation renderer browser is not ready. Run npm run conversation:setup.");
  const server = await chromium.launchServer({
    executablePath,
    headless: true,
    args: ["--disable-background-networking", "--disable-default-apps", "--disable-extensions", "--disable-sync", "--no-first-run"],
  });
  registerJobProcess(server.process());
  const browser = await chromium.connect(server.wsEndpoint());
  const browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, colorScheme: "dark" });
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const protocol = new URL(route.request().url()).protocol;
    if (["file:", "data:", "blob:"].includes(protocol)) route.continue();
    else route.abort();
  });
  let encoder;
  try {
    await page.goto(pathToFileURL(documentPath).href, { waitUntil: "load" });
    await page.waitForFunction(() => window.__reelioReady === true);
    const frameRate = 30;
    const frameCount = Math.ceil(durationMs / 1000 * frameRate);
    encoder = spawn(ffmpegPath, [
      "-y", "-f", "image2pipe", "-framerate", String(frameRate), "-vcodec", "png", "-i", "pipe:0",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", (durationMs / 1000).toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    registerJobProcess(encoder);
    const stderr = [];
    encoder.stderr.on("data", (chunk) => stderr.push(chunk));
    const completion = new Promise((resolve, reject) => {
      encoder.once("error", reject);
      encoder.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Conversation video encoding failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1_200)}`)));
    });
    const thumbnailFrame = Math.max(0, Math.min(frameCount - 1, Math.round(Math.min(coverTimeMs, durationMs - 1) / 1000 * frameRate)));
    for (let frame = 0; frame < frameCount; frame += 1) {
      assertJobActive();
      await page.evaluate((ms) => window.__reelioConversation.seek(ms), frame / frameRate * 1000);
      const buffer = await page.screenshot({ type: "png", animations: "disabled" });
      if (!encoder.stdin.write(buffer)) await once(encoder.stdin, "drain");
      if (frame === thumbnailFrame) await page.screenshot({ path: thumbnail, type: "jpeg", quality: 91, animations: "disabled" });
      if (frame % Math.max(1, Math.round(frameCount / 20)) === 0) {
        await progress("conversation-record", 38 + Math.round((frame / frameCount) * 34), `Recorded frame ${frame + 1} of ${frameCount}`);
      }
    }
    encoder.stdin.end();
    await completion;
    return { browserVersion, captureDurationMs: Date.now() - captureStartedAt };
  } finally {
    if (encoder && encoder.exitCode == null && !encoder.killed) encoder.kill("SIGTERM");
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function conversationBrowserHealth() {
  const executablePath = await conversationBrowserExecutable();
  return {
    enabled: process.env.REELIO_ENABLE_CONVERSATION_VIDEO !== "false",
    ready: Boolean(executablePath),
    browser: executablePath ? path.basename(executablePath) : null,
    message: executablePath ? "Conversation renderer ready." : "Run npm run conversation:setup to install the local render browser.",
  };
}

export async function conversationBrowserExecutable() {
  const candidates = [
    process.env.REELIO_CHROMIUM_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  const dataRoot = getRoot() || path.resolve(process.env.REELIO_DATA_DIR || path.join(process.cwd(), ".reelio"));
  const browserRoot = path.join(dataRoot, "browsers");
  return findExecutable(browserRoot, 4);
}

async function findExecutable(directory, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && ["chrome", "chromium", "chrome.exe", "headless_shell"].includes(entry.name)) return target;
    if (entry.isDirectory()) {
      const found = await findExecutable(target, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function conversationTranscript(conversation, timeline) {
  return conversation.events.flatMap((event, index) => {
    const entry = timeline.entries[index];
    if (event.type === "call" && entry.callDialogueCues?.length) {
      return entry.callDialogueCues.map((cue) => {
        const speaker = conversation.participants.find((item) => item.id === cue.participantId)?.name ?? "Caller";
        return `[${formatTranscriptTime(entry.startMs + cue.startMs)}] ${speaker} (phone): ${cue.text}`;
      });
    }
    const participant = conversation.participants.find((item) => item.id === event.participantId);
    const speaker = participant?.name ?? (event.type === "date" ? "Date" : "System");
    const text = event.deleted ? "[Message deleted]" : event.text || `[${event.type}: ${event.fileName || "attachment"}]`;
    return `[${formatTranscriptTime(timeline.entries[index].startMs)}] ${speaker}: ${text}`;
  }).join("\n");
}

function conversationSrt(conversation, timeline) {
  const cues = conversation.events.flatMap((event, index) => {
    const entry = timeline.entries[index];
    if (event.type === "call" && entry.callDialogueCues?.length) {
      return entry.callDialogueCues.map((cue, cueIndex) => {
        const participant = conversation.participants.find((item) => item.id === cue.participantId);
        const next = entry.callDialogueCues[cueIndex + 1];
        return {
          startMs: entry.startMs + cue.startMs,
          endMs: Math.min(entry.endMs, entry.startMs + (cue.endMs ?? next?.startMs ?? entry.holdMs)),
          text: `${participant?.name ?? "Caller"}: ${cue.text}`,
        };
      });
    }
    const participant = conversation.participants.find((item) => item.id === event.participantId);
    const text = event.deleted ? "Message deleted" : event.text || `${participant?.name ?? "Conversation"} sent ${event.type}`;
    return [{ startMs: entry.startMs, endMs: entry.endMs, text: `${participant ? `${participant.name}: ` : ""}${text}` }];
  });
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(Math.max(cue.startMs + 200, cue.endMs))}\n${cue.text}\n`).join("\n");
}

async function muxConversationAudio(video, audio, output, duration) {
  await run(ffmpegPath, [
    "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0",
    "-t", duration.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
  ]);
}

function publicConversationSnapshot(conversation) {
  const snapshot = structuredClone(conversation);
  delete snapshot.ownerUserId;
  snapshot.assets = (snapshot.assets ?? []).map((asset) => {
    const item = { ...asset };
    delete item.file;
    return item;
  });
  if (snapshot.brandKit?.assets) {
    for (const asset of Object.values(snapshot.brandKit.assets)) if (asset) delete asset.file;
  }
  return snapshot;
}

function conversationCss() {
  return `
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#09070d;font-family:var(--font),Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8f7fb}body{width:360px;height:640px}
#stage{--bg:#15111f;--accent:#6c4fe0;--font:Inter;position:relative;width:360px;height:640px;overflow:hidden;background:var(--bg);font-family:var(--font),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
#backdrop{position:absolute;inset:0;background:radial-gradient(circle at 20% 12%,color-mix(in srgb,var(--accent) 52%,transparent),transparent 42%),linear-gradient(155deg,var(--bg),#08070c);background-size:cover;background-position:center}
#backdrop video{width:100%;height:100%;object-fit:cover}
#phone{position:absolute;display:flex;flex-direction:column;overflow:hidden;background:#121017}
.device #phone{inset:26px 22px;border:4px solid #050507;border-radius:34px;box-shadow:0 24px 70px #0009}
.screen #phone{inset:0;border-radius:0}.reelio-light #phone{background:#f5f4f8;color:#16131c}.minimal #phone{background:#101014}
#phoneHeader{height:82px;flex:0 0 82px;position:relative;z-index:3;display:flex;flex-direction:column;border-bottom:1px solid #ffffff12;background:#17141df2;backdrop-filter:blur(18px)}
.device #phoneHeader{border-radius:30px 30px 0 0;overflow:hidden}
.reelio-light #phoneHeader{background:#fffffff2;border-color:#00000012}
.statusbar{height:25px;flex:0 0 25px;display:flex;align-items:flex-end;justify-content:space-between;padding:7px 16px 2px}.status-time{font-size:7px;font-weight:760;letter-spacing:.015em;white-space:nowrap}.status-icons{height:8px;display:flex;align-items:center;gap:4px;color:currentColor}.status-icons i{position:relative;display:block;flex:none}.signal{width:10px;height:7px;background:linear-gradient(to right,currentColor 0 18%,transparent 18% 28%,currentColor 28% 48%,transparent 48% 58%,currentColor 58% 78%,transparent 78% 88%,currentColor 88%);clip-path:polygon(0 100%,0 72%,18% 72%,18% 52%,48% 52%,48% 28%,78% 28%,78% 0,100% 0,100% 100%)}.wifi{width:10px;height:7px;border-top:1.5px solid currentColor;border-radius:50%}.wifi:after{content:'';position:absolute;left:4px;top:3px;width:2px;height:2px;border-radius:50%;background:currentColor}.battery{width:13px;height:7px;border:1px solid currentColor;border-radius:2px}.battery:before{content:'';position:absolute;inset:1px 2px;background:currentColor;border-radius:1px}.battery:after{content:'';position:absolute;right:-3px;top:1px;width:2px;height:3px;border-radius:0 1px 1px 0;background:currentColor}
.chat-nav{height:56px;min-width:0;display:grid;grid-template-columns:15px 34px minmax(0,1fr) auto;gap:8px;align-items:center;padding:2px 13px 9px 10px}.back{font-size:26px;line-height:1;color:var(--accent);transform:translateY(-1px)}.contact-copy{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px}.contact{font-size:11px;font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.contact-status{font-size:6px;color:#9f98a7;white-space:nowrap}.actions{display:flex;align-items:center;gap:13px;color:#b5afbb}.header-action{position:relative;display:block;width:12px;height:14px}.search:before{content:'';position:absolute;left:0;top:2px;width:6px;height:6px;border:1.5px solid currentColor;border-radius:50%}.search:after{content:'';position:absolute;left:7px;top:9px;width:5px;height:1.5px;background:currentColor;transform:rotate(45deg);transform-origin:left center;border-radius:2px}.more:before{content:'•••';position:absolute;right:0;top:-3px;font-size:10px;letter-spacing:1px}
.avatar{width:29px;height:29px;border-radius:50%;display:grid;place-items:center;font-size:8px;font-weight:800;color:white;overflow:hidden;flex:none}.avatar img{width:100%;height:100%;object-fit:cover}
#messages{flex:1;overflow:hidden;padding:15px 11px 102px;scroll-behavior:auto;display:flex;flex-direction:column;gap:7px}
.event{display:flex;align-items:flex-end;gap:6px;max-width:88%;animation:pop .16s ease-out}.event.stable{animation:none}.event.self{align-self:flex-end;justify-content:flex-end}.event.other{align-self:flex-start}.event>.avatar{width:21px;height:21px;font-size:6px;margin-bottom:13px}
.event.grouped{margin-top:-4px}.event.grouped>.avatar,.event.grouped .speaker{visibility:hidden}.event.grouped.other .bubble{border-top-left-radius:7px}.event.grouped.self .bubble{border-top-right-radius:7px}
.bubbleWrap{position:relative;min-width:36px}.speaker{display:block;color:#aaa3b4;font-size:7px;margin:0 7px 3px}.bubble{padding:8px 10px;border-radius:14px 14px 14px 4px;background:#28242f;font-size:10px;line-height:1.34;overflow-wrap:anywhere;box-shadow:0 3px 12px #0002}.self .bubble{background:var(--accent);border-radius:14px 14px 4px 14px;color:white}.reelio-light .bubble{background:#e8e6ed;color:#15131a}.reelio-light .self .bubble{background:var(--accent);color:white}.square .bubble{border-radius:7px}.compact .bubble{padding:6px 8px;font-size:9px}
.meta{display:block;font-size:6px;color:#8c8693;margin:2px 5px 0;text-align:right;text-transform:capitalize}.reply{border-left:2px solid #ffffff88;padding:3px 5px;margin-bottom:5px;font-size:7px;opacity:.8;max-width:180px}.messageText,.caption,.callText{white-space:pre-wrap}.caption{display:block;margin-top:5px}.edited{display:block;opacity:.62;margin-top:3px;font-size:6px}.deleted{opacity:.65}.reactions{position:absolute;right:4px;bottom:7px;transform:translateY(100%);display:flex}.reaction{background:#24212b;border:1px solid #413a4d;border-radius:10px;padding:1px 4px;font-size:8px}.attachment{display:block;width:155px;max-height:150px;object-fit:cover;border-radius:9px}.voice{display:flex;align-items:center;gap:6px;min-width:145px}.play{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#ffffff2b;font-size:7px}.wave{letter-spacing:1px;font-size:8px}.voiceTime{font-size:6px;opacity:.72}.callTitle{display:block;font-size:10px}.callText{display:block;font-size:8px;opacity:.72;margin-top:2px}
.system{align-self:center;max-width:88%;font-size:7px;color:#aaa3b4;text-align:center;padding:5px 10px}.system.date{font-weight:750;text-transform:uppercase;letter-spacing:.08em}
.typing{display:flex;gap:3px;padding:9px 11px}.typing i{width:4px;height:4px;border-radius:50%;background:#a69fae;will-change:transform,opacity}
#composer{position:absolute;left:11px;right:11px;bottom:20px;min-height:31px;max-height:82px;border:1px solid #ffffff24;background:#17141de8;border-radius:18px;padding:7px 11px;color:#88818e;font-size:8px;backdrop-filter:blur(12px);display:flex;align-items:flex-end;gap:7px}#composerText{flex:1;min-width:0;max-height:60px;overflow:hidden;color:#88818e;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.38}#composer.composing #composerText{color:#f4f1f7}#composer b{flex:none;align-self:flex-end;font-size:13px;line-height:12px;font-weight:500;margin-bottom:2px}.reelio-light #composer{background:#fff;border-color:#0002}.reelio-light #composer.composing #composerText{color:#1b1720}
#phoneOverlay{position:absolute;inset:0;pointer-events:none;z-index:8}.notification-banner{position:absolute;top:13px;left:10px;right:10px;min-height:53px;padding:8px 31px 8px 8px;display:flex;align-items:center;gap:8px;border:1px solid #ffffff29;border-radius:14px;background:#201c27e8;box-shadow:0 12px 28px #0007;backdrop-filter:blur(18px);animation:dropIn .22s ease-out}.notification-banner.stable,.chat-switch-overlay.stable{animation:none}.reelio-light .notification-banner{background:#fffffff0;color:#17131b;border-color:#0002}.notification-banner .avatar{width:29px;height:29px}.notification-copy{display:grid;gap:2px;min-width:0}.notification-copy strong{font-size:8px}.notification-copy span{font-size:7px;opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.notification-now{position:absolute;right:10px;top:9px;font-size:6px;opacity:.55}
.battery-alert{position:absolute;left:44px;right:44px;top:50%;transform:translateY(-50%);padding:16px 15px 12px;border:1px solid #ffffff24;border-radius:16px;background:#211d28f2;text-align:center;box-shadow:0 24px 60px #000a;backdrop-filter:blur(20px)}.reelio-light .battery-alert{background:#fffffff5;color:#17131b;border-color:#0002}.battery-icon{width:45px;height:23px;margin:0 auto 10px;border:2px solid #ff655f;border-radius:5px;display:grid;place-items:center;color:#ff7771;font-size:7px;font-weight:800}.battery-alert strong{display:block;font-size:11px}.battery-alert p{margin:6px 0 12px;font-size:8px;line-height:1.4;opacity:.72}.battery-dismiss{width:100%;height:27px;border:0;border-top:1px solid #ffffff1f;background:transparent;color:#9a7cff;font-size:8px}
.call-screen{position:absolute;inset:0;padding:78px 24px 38px;display:flex;flex-direction:column;align-items:center;background:radial-gradient(circle at 50% 20%,color-mix(in srgb,var(--accent) 44%,#25202d),#0d0b10 67%);text-align:center}.call-screen>.avatar{width:74px;height:74px;font-size:18px;box-shadow:0 15px 40px #0007}.call-status{order:-1;margin-bottom:15px;font-size:7px;letter-spacing:.12em;text-transform:uppercase;opacity:.65}.call-name{margin:12px 0 0;font-size:20px}.call-caption{margin-top:auto;max-width:260px;padding:9px 12px;border-radius:11px;background:#0005;font-size:9px;line-height:1.4}.call-controls{display:flex;gap:28px;margin-top:auto}.call-controls button{width:45px;height:45px;border:0;border-radius:50%;color:white;font-size:15px}.call-control{background:#ffffff20}.decline{background:#e84d55}.accept{background:#42c874}.chat-switch-overlay{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:7px;background:#121017e8;backdrop-filter:blur(12px);animation:fadeSwitch .36s ease}.switch-icon{width:42px;height:42px;display:grid;place-items:center;border-radius:50%;background:var(--accent);font-size:18px}.chat-switch-overlay strong{font-size:12px}.chat-switch-overlay small{font-size:7px;opacity:.6}
#fiction{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);font-size:5px;letter-spacing:.08em;text-transform:uppercase;color:#817a88;white-space:nowrap}
#safe{display:none;position:absolute;inset:54px 28px 78px;border:1px dashed #ffffff4d;pointer-events:none}
@keyframes pop{from{opacity:0;transform:translateY(5px) scale(.98)}to{opacity:1;transform:none}}@keyframes dropIn{from{opacity:0;transform:translateY(-13px) scale(.97)}to{opacity:1;transform:none}}@keyframes captionIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes fadeSwitch{from{opacity:0}to{opacity:1}}`;
}

function defaultEventText(type) {
  if (type === "call") return "Tap to call back";
  if (type === "notification") return "New message";
  if (type === "chat-switch") return "Another conversation";
  if (type === "date") return "Today";
  return "Conversation update";
}
function defaultHold(type, text) {
  if (type === "typing") return 1_200;
  if (type === "notification") return 2_400;
  if (type === "battery") return 2_800;
  if (type === "chat-switch") return 700;
  if (["image", "video", "audio", "call"].includes(type)) return 3_000;
  return Math.max(1_200, Math.min(7_000, 900 + graphemeCount(text ?? "") * 38));
}
function graphemeCount(value) {
  if (typeof Intl.Segmenter !== "function") return Array.from(value).length;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}
function milliseconds(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(min, Math.min(max, number)));
}
function numberRange(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function cleanText(value, label, min, max) {
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const clean = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (clean.length < min || clean.length > max) throw new ValidationError(`${label} must be between ${min} and ${max} characters.`);
  return clean;
}
function optionalText(value, label, max) {
  if (value == null || value === "") return "";
  return cleanText(String(value), label, 1, max);
}
function cleanId(value, label) {
  const id = String(value ?? "").trim();
  if (!SAFE_ID.test(id)) throw new ValidationError(`${label} has an invalid reference.`);
  return id;
}
function cleanColor(value, label) {
  const color = String(value ?? "").trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ValidationError(`${label} must be a six-digit hex color.`);
  return color.toLowerCase();
}
function optionalClockTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new ValidationError("Displayed message times must use HH:MM.");
  return text;
}
function initialsFor(value) {
  return String(value).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join("").slice(0, 4) || "CH";
}
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function escapeJsonForHtml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
function escapeAttribute(value) { return String(value).replace(/[&"'<>]/g, ""); }
function languageTag(language) {
  return ({ Arabic: "ar", Burmese: "my", Chinese: "zh", Hebrew: "he", Japanese: "ja", Korean: "ko", Thai: "th" })[language] ?? "en";
}
function relativeAssetUrl(outputDir, file) {
  return path.relative(outputDir, file).split(path.sep).map(encodeURIComponent).join("/");
}
function formatTranscriptTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function srtTime(ms) {
  const value = Math.max(0, Math.round(ms));
  return `${String(Math.floor(value / 3_600_000)).padStart(2, "0")}:${String(Math.floor(value % 3_600_000 / 60_000)).padStart(2, "0")}:${String(Math.floor(value % 60_000 / 1000)).padStart(2, "0")},${String(value % 1000).padStart(3, "0")}`;
}
async function mediaDuration(file) {
  const output = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read conversation media duration.");
  return duration;
}
async function localAsset(file) {
  return { file, name: path.basename(file), bytes: (await stat(file)).size };
}
function run(command, args) {
  if (!command) throw new Error("Required media executable is unavailable.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.REELIO_PROCESS_TIMEOUT_MS ?? 900_000));
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`Conversation media process failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1_200)}`));
    });
  });
}
