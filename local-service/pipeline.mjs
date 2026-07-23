import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { getRoot } from "./store.mjs";
import { defaultTtsEngine, durationBounds } from "./validation.mjs";
import { generateText, textProviderConfig } from "./text-provider.mjs";
import { kokoroConfig, synthesizeKokoroCues } from "./kokoro-client.mjs";
import { GEMINI_TTS_LANGUAGES, geminiTtsConfig, synthesizeGeminiCues } from "./gemini-tts-client.mjs";
import { getVoxCpmHealth, synthesizeVoxCpmCues, VOXCPM2_LANGUAGES, voxCpmConfig } from "./voxcpm-client.mjs";
import { registerJobProcess } from "./job-control.mjs";

const ffprobePath = ffprobe.path;
const palette = ["0x111827", "0x231942", "0x0b2533", "0x3a1b2c", "0x252017"];
const accents = ["0x7656e8", "0x18a7b8", "0xe49a38", "0xdf5f9c", "0x49b881"];

export async function renderJob(job, progress) {
  await validateLanguageCapabilities(job.request);
  const outputDir = path.join(getRoot(), "generated", job.id);
  const clipsDir = path.join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const profile = styleProfile(job.request.category);

  await progress("script", 12, "Writing a retention-first script");
  const canonicalScript = await createScript(job.request);
  const masterScriptPath = path.join(outputDir, "master-script-english.txt");
  await writeFile(masterScriptPath, `${stripMarkers(canonicalScript)}\n`, "utf8");
  // Pull [pause]/ellipsis markers out into per-segment silence, and use the cleaned segments everywhere.
  const { segments: canonicalSegments, pauses } = extractPauses(segmentText(canonicalScript, "English"));
  const translatedSpeechSegments = job.request.language.toLowerCase() === "english"
    ? canonicalSegments
    : await translateSegments(canonicalSegments, "English", job.request.language, "spoken narration transcript");
  const transcriptSegments = normalizeTranslatedScript(translatedSpeechSegments, job.request.language);
  validateLanguageText(transcriptSegments, job.request.language, "transcript");
  const script = transcriptSegments.join(" ");
  const transcriptPath = path.join(outputDir, "transcript.txt");
  await writeFile(transcriptPath, `${script.trim()}\n`, "utf8");

  const ttsEngine = job.request.ttsEngine ?? defaultTtsEngine(job.request.language);
  await progress("voice", 26, narrationProgressMessage(job.request.language, ttsEngine));
  const narration = await createNarration(transcriptSegments, job.request.language, ttsEngine, outputDir, profile, pauses);
  const targetDuration = chooseDuration(job.request.duration, narration.duration, job.request.language);
  const fittedNarration = await fitNarration(narration, targetDuration, outputDir, job.request.language);

  const translatedSubtitleSegments = job.request.subtitleLanguage.toLowerCase() === job.request.language.toLowerCase()
    ? transcriptSegments
    : job.request.subtitleLanguage.toLowerCase() === "english"
      ? canonicalSegments
      : await translateSegments(canonicalSegments, "English", job.request.subtitleLanguage, "on-screen subtitles");
  const subtitleSegments = normalizeTranslatedScript(translatedSubtitleSegments, job.request.subtitleLanguage);
  validateLanguageText(subtitleSegments, job.request.subtitleLanguage, "subtitles");
  const captionsPath = path.join(outputDir, "captions.srt");
  const styledCaptionsPath = path.join(outputDir, "captions.ass");
  await writeFile(captionsPath, buildSrtFromCues(subtitleSegments, fittedNarration.cues, targetDuration), "utf8");
  await writeFile(styledCaptionsPath, buildAss(subtitleSegments, fittedNarration.cues, targetDuration, captionFont(job.request.subtitleLanguage), profile.subtitle), "utf8");

  await progress("music", 35, "Composing the curated intro, background, and ending mix");
  // Music and platform copy are independent of the visuals; render them while clips download and encode.
  const musicPromise = createCuratedMusic(targetDuration, job.request.category, outputDir);
  musicPromise.catch(() => {});
  const platformCopyPromise = createPlatformCopy(job.request, canonicalScript);
  platformCopyPromise.catch(() => {});

  await progress("stock-search", 39, "Finding and preparing visual clips");
  const clipDuration = profile.clipSeconds;
  const transitionSeconds = profile.transitionSeconds;
  const clipCount = Math.max(1, Math.ceil((targetDuration - transitionSeconds) / (clipDuration - transitionSeconds)));
  const segmentQueries = await createSegmentQueries(canonicalSegments, job.request.category);
  const clipPlan = planClipQueries(clipCount, clipDuration, transitionSeconds, fittedNarration.cues, segmentQueries);
  const stock = await findStockClips(job.request, clipPlan, clipsDir, progress);
  let preparedCount = 0;
  const prepared = await mapWithConcurrency(Array.from({ length: clipCount }, (_, index) => index), clipEncodeConcurrency(), async (index) => {
    const output = path.join(clipsDir, `clip-${String(index + 1).padStart(2, "0")}.mp4`);
    const source = stock[index];
    const motionOptions = { motion: profile.motions[index % profile.motions.length], grade: profile.grade };
    if (source?.type === "image") await normalizeStillImage(source.file, output, clipDuration, motionOptions);
    else if (source) await normalizeStockClip(source.file, output, clipDuration, motionOptions);
    else await createMotionClip(output, clipDuration, index);
    preparedCount += 1;
    await progress("stock-search", 45 + Math.round((preparedCount / clipCount) * 18), `Prepared visual ${preparedCount} of ${clipCount}`);
    return { output, license: source?.license ?? null };
  });
  const normalizedClips = prepared.map((clip) => clip.output);
  const licenses = prepared.map((clip) => clip.license).filter(Boolean);

  await progress("render", 68, "Stitching the master with cross-clip transitions");
  const cleanPath = path.join(outputDir, "clean-background.mp4");
  const transitionGraph = buildXfadeChain(normalizedClips.length, clipDuration, transitionSeconds, profile.transitions);
  await run(ffmpegPath, [
    "-y", ...normalizedClips.flatMap((file) => ["-i", file]),
    "-filter_complex", transitionGraph, "-map", "[vout]",
    "-t", targetDuration.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", cleanPath,
  ]);

  await progress("thumbnail", 80, "Designing the social thumbnail");
  const thumbnailPath = path.join(outputDir, "thumbnail.jpg");
  await createThumbnail(cleanPath, thumbnailPath, canonicalSegments[0] ?? makeTitle(job.request.prompt), job.request.category, outputDir);

  await progress("captions", 82, "Burning high-contrast safe-zone captions");
  const music = await musicPromise;
  const finalPath = path.join(outputDir, "final.mp4");
  const escapedSubtitlePath = styledCaptionsPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
  // Burn captions, then set the very first frame to the generated thumbnail so the file's poster frame
  // is the designed cover. Audio and caption timing are untouched (only frame 0 is replaced).
  const videoGraph = `[0:v]ass='${escapedSubtitlePath}'[capped];[3:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p[cover];[capped][cover]overlay=enable='eq(n,0)'[vout]`;
  const audioGraph = `[1:a]apad=whole_dur=${targetDuration.toFixed(2)},volume=1.0,asplit=2[voice_sc][voice_mix];[2:a]atrim=0:${targetDuration.toFixed(2)},volume='if(lt(t\\,1.4)\\,0.72\\,if(gt(t\\,${Math.max(0, targetDuration - 3.2).toFixed(2)})\\,0.60\\,0.34))':eval=frame[music];[music][voice_sc]sidechaincompress=threshold=0.075:ratio=4:attack=18:release=260:makeup=1[ducked];[voice_mix][ducked]amix=inputs=2:duration=longest:weights='1 1':normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  await run(ffmpegPath, [
    "-y", "-i", cleanPath, "-i", fittedNarration.path, "-i", music.path, "-i", thumbnailPath,
    "-filter_complex", `${videoGraph};${audioGraph}`,
    "-map", "[vout]", "-map", "[aout]",
    "-t", targetDuration.toFixed(2),
    // Constant motion (Ken Burns zoom, transitions, animated captions) defeats interframe compression,
    // so cap the bitrate and use a more efficient preset to keep the uploaded file a sensible size.
    "-c:v", "libx264", "-preset", "faster", "-crf", "23", "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", finalPath,
  ]);

  await progress("render", 96, "Writing metadata and platform package");
  const platformCopy = await platformCopyPromise;
  const platformCopyPath = path.join(outputDir, "publishing-copy.json");
  await writeFile(platformCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  const metadata = {
    title: makeTitle(job.request.prompt),
    description: `${job.request.prompt}\n\nGenerated with Reelio. Review facts and platform policies before publishing.`,
    tags: uniqueWords(`${job.request.category} ${job.request.prompt}`).slice(0, 12),
    durationSeconds: Number(targetDuration.toFixed(2)),
    resolution: "1080x1920",
    frameRate: 30,
    narrationLanguage: job.request.language,
    voiceProvider: narration.providerLabel,
    subtitleLanguage: job.request.subtitleLanguage,
    music: `${music.preset} — original procedural intro, ducked background, and ending lift`,
    visualSource: stock.length ? "Pexels stock" : "Generated motion backgrounds",
    captionSafeZone: "centered lower-third, 430px bottom clearance",
    audioSubtitleSync: "cue-timed narration",
    audioLoudnessTarget: "-14 LUFS, -1.5 dBTP",
    platformCopy,
    licenseRecords: licenses,
    retentionPreflight: {
      hookWithinSeconds: 1.2,
      averageVisualChangeSeconds: clipDuration,
      highContrastCaptions: true,
      noIntroBeforeHook: true,
      score: stock.length ? 91 : 86,
    },
  };
  const metadataPath = path.join(outputDir, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    assets: {
      clean: await asset(cleanPath),
      final: await asset(finalPath),
      thumbnail: await asset(thumbnailPath),
      voice: await asset(fittedNarration.path),
      music: await asset(music.path),
      masterScript: await asset(masterScriptPath),
      transcript: await asset(transcriptPath),
      captions: await asset(captionsPath),
      styledCaptions: await asset(styledCaptionsPath),
      metadata: await asset(metadataPath),
      publishingCopy: await asset(platformCopyPath),
    },
    metadata,
  };
}

async function createScript(request) {
  const wordRange = scriptWordRange(request.duration);
  if (request.approvedScript) {
    if (!hasEnoughScriptContent(stripMarkers(request.approvedScript), "English", wordRange.min) || !hasCompleteScript(stripMarkers(request.approvedScript))) {
      throw new Error("The approved script is too short for the selected duration.");
    }
    return request.approvedScript;
  }
  const generated = await generateText({
    system: `Write one original English master voiceover script for a ${request.duration} vertical knowledge reel. Target ${wordRange.min}-${wordRange.max} spoken words. Write in the voice of one knowledgeable person talking directly to the viewer as "you", with a clear point of view and genuine curiosity — not a neutral encyclopedia. Open with a personal, direct hook that creates a curiosity gap. Ground the piece in one vivid, concrete detail or mini-scene the viewer can picture, then deliver defensible information in short spoken sentences with a pattern interrupt roughly every 8 seconds, and finish with a useful payoff before a one-sentence CTA. Vary sentence rhythm naturally (mix very short punchy lines with slightly longer ones), but keep each sentence between 5 and 12 words so it maps to one synchronized narration and subtitle cue. At natural breath points between sentences you may place up to three [pause] markers on their own line, and you may end a trailing-off thought with an ellipsis; never start or end the script with a marker. Use only claims supported by the brief or conservative general knowledge. Explain named research effects narrowly and acknowledge important limits; never claim the brain was designed for something, can be hacked or tricked, or that one result applies universally. Do not introduce unrelated named rules, statistics, historical details, or mechanisms. Every sentence must follow logically from the one before it. This English master will be professionally translated, so avoid idioms, ambiguous pronouns, abbreviations, and culturally specific wordplay. Avoid medical, legal, financial, political, or other high-stakes claims unless the brief explicitly supplies reviewed source material. Silently review the script for factual overstatement, contradiction, and unclear phrasing before returning it. No headings, stage directions, citations, or markdown.`,
    user: `Topic and reviewed boundaries: ${request.prompt}\nCategory: ${request.category ?? "Knowledge"}\nAudience: curious general viewers.`,
    maxTokens: Math.max(180, Math.ceil(wordRange.max * 2.2)),
    temperature: 0.72,
  });
  if (generated) {
    const edited = await generateText({
      system: `Act as a skeptical senior fact editor for a monetized knowledge channel. Rewrite the draft into the final English voiceover, targeting ${wordRange.min}-${wordRange.max} spoken words. The supplied brief is the source of truth. Remove or correct every claim, mechanism, recommendation, and level of certainty that is not directly supported by that brief. Never reverse a condition into an instruction, recommend creating a problem to demonstrate an effect, or imply an outcome is easy, universal, guaranteed, or biologically designed. Keep a natural, human editorial voice with a clear point of view and a strong hook, without sensationalism. Preserve any [pause] markers between sentences. Use coherent sentences of 5-12 words with varied rhythm, smooth transitions, one practical payoff, and one natural CTA. Silently verify logical consistency before returning. Return only the revised script with no headings, notes, citations, or markdown.`,
      user: `Reviewed brief:\n${request.prompt}\n\nDraft to fact-edit:\n${generated.text}`,
      maxTokens: Math.max(220, Math.ceil(wordRange.max * 2.2)),
      temperature: 0.22,
    });
    let script = edited?.text ?? generated.text;
    if (!hasEnoughScriptContent(stripMarkers(script), "English", wordRange.min) || !hasCompleteScript(stripMarkers(script))) {
      const expanded = await generateText({
        system: `Expand the supplied English voiceover to ${wordRange.min}-${wordRange.max} spoken words without adding any claim, mechanism, technique, or certainty not supported by the reviewed brief. Preserve the existing meaning and factual limits. Add clarity, a concrete interrupted-email moment, smooth transitions, and useful explanation rather than repetition. Keep sentences concise and natural for synchronized narration. Return only the complete expanded script with no title, headings, word count, markdown, or notes.`,
        user: `Reviewed brief:\n${request.prompt}\n\nShort script to expand:\n${script}`,
        maxTokens: Math.max(260, Math.ceil(wordRange.max * 2.5)),
        temperature: 0.2,
      });
      if (expanded?.text) script = expanded.text;
    }
    if (!hasEnoughScriptContent(stripMarkers(script), "English", wordRange.min)) throw new Error(`${edited?.provider ?? generated.provider} returned a script that was too short for the retention target.`);
    if (!hasCompleteScript(stripMarkers(script))) throw new Error(`${edited?.provider ?? generated.provider} returned an incomplete script. Rendering stopped before narration.`);
    return script;
  }
  return fallbackScript(request.prompt, wordRange.max);
}

async function createPlatformCopy(request, script) {
  const language = request.subtitleLanguage || "English";
  const platformIds = ["youtube", "tiktok", "facebook", "instagram"];
  try {
    const generated = await generateText({
      system: `Create ready-to-post social copy in ${language} for one factual knowledge video. Use only the supplied brief and final script. Return exactly four tagged blocks and no commentary: <P id="youtube"><TITLE>...</TITLE><CAPTION>...</CAPTION><DESCRIPTION>...</DESCRIPTION><TAGS>tag one, tag two</TAGS></P>, then equivalent blocks for tiktok, facebook, and instagram. Tailor the hook and tone to each platform without changing facts. TITLE must be concise and compelling. CAPTION must be a complete ready-to-post caption with a natural call to action. DESCRIPTION must summarize the value and important nuance. TAGS must contain 6-12 useful comma-separated search tags without the hash symbol. Avoid clickbait, unsupported claims, engagement bait, and duplicated fields.`,
      user: `Brief:\n${request.prompt}\n\nFinal English transcript:\n${script}`,
      maxTokens: 2400,
      temperature: 0.38,
    });
    if (generated?.text) {
      const parsed = {};
      for (const id of platformIds) {
        const block = generated.text.match(new RegExp(`<P\\s+id=["']?${id}["']?\\s*>([\\s\\S]*?)<\\/P>`, "i"))?.[1] ?? "";
        const field = (name) => block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]?.trim() ?? "";
        const tags = field("TAGS").split(/[,\n]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).slice(0, 12);
        const entry = { title: field("TITLE"), caption: field("CAPTION"), description: field("DESCRIPTION"), tags };
        if (!entry.title || !entry.caption || !entry.description || tags.length < 4) throw new Error(`Incomplete ${id} publishing copy.`);
        parsed[id] = entry;
      }
      return parsed;
    }
  } catch {
    // A complete deterministic kit is safer than failing an otherwise finished render.
  }
  return fallbackPlatformCopy(request);
}

function fallbackPlatformCopy(request) {
  const title = makeTitle(request.prompt).replace(/^(explain|create|show)\s+/i, "");
  const tags = uniqueWords(`${request.category} ${request.prompt}`).slice(0, 10);
  const hashtags = tags.slice(0, 6).map((tag) => `#${tag}`).join(" ");
  const base = {
    title,
    caption: `${title}. Watch the full explanation, then share the most surprising detail.\n\n${hashtags}`,
    description: `${request.prompt}\n\n${request.language} narration with ${request.subtitleLanguage} subtitles. Review the finished video and sources before publishing.`,
    tags,
  };
  return {
    youtube: { ...base, title: `${title} | Explained Clearly` },
    tiktok: { ...base, caption: `${title}. Here is the part most people miss.\n\n${hashtags}` },
    facebook: { ...base },
    instagram: { ...base, caption: `${title}. Save this explanation for later.\n\n${hashtags}` },
  };
}

function fallbackScript(prompt, maxWords) {
  const topic = prompt.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const sentences = [
    "Stop scrolling—this is more useful than it first sounds.",
    `${topic}.`,
    "Here is the part most people miss.",
    "Your attention reacts to open questions, contrast, and a payoff it can use.",
    "First, turn the idea into one clear question.",
    "Then connect it to a concrete example you can picture immediately.",
    "Now add one action that can be tested today, not someday.",
    "That combination changes information into something memorable.",
    "Try it now: repeat the idea in one sentence, give one example, and choose one next step.",
    "If you can recall it later, the structure worked.",
    "The goal is not louder information—it is making every second earn the next one.",
    "Save this and test it today.",
  ];
  const selected = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).length;
    if (selected.length >= 2 && words + count > maxWords) break;
    selected.push(sentence);
    words += count;
  }
  return selected.join(" ");
}

function hasEnoughScriptContent(script, language, minimumWords) {
  const trimmed = script.trim();
  const words = trimmed.split(/\s+/u).filter(Boolean).length;
  if (words >= Math.max(18, Math.floor(minimumWords * 0.92))) return true;
  const noSpaceLanguages = new Set(["burmese", "chinese", "japanese", "khmer", "korean", "lao", "thai"]);
  if (!noSpaceLanguages.has(String(language ?? "").toLowerCase())) return false;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)).filter((part) => /[^\p{P}\p{S}\s]/u.test(part.segment)).length;
  return graphemes >= Math.max(70, Math.floor(minimumWords * 1.2));
}

function hasCompleteScript(script) {
  return /[.!?…]["'”’)]?\s*$/u.test(String(script ?? "").trim());
}

const PAUSE_MARKER = /\[\s*(?:pause|break|beat)\s*\]/gi;

// Remove the human-pacing markers the script generator may insert so they never reach TTS or subtitles.
function stripMarkers(text) {
  return String(text ?? "").replace(PAUSE_MARKER, " ").replace(/\s{2,}/g, " ").replace(/\s+([.!?,;:…])/g, "$1").trim();
}

// Convert inline [pause] markers and trailing ellipses into per-segment silence (seconds) and clean text.
// Returns segments and a parallel `pauses` array; indices stay aligned so cues map to the same gaps.
function extractPauses(segments) {
  const cleaned = [];
  const pauses = [];
  for (const segment of segments) {
    const markerCount = (segment.match(PAUSE_MARKER) || []).length;
    let text = stripMarkers(segment);
    let pause = markerCount * 0.45;
    if (/(?:…|\.\.\.)\s*$/.test(text)) {
      pause += 0.3;
      text = text.replace(/(?:…|\.\.\.)\s*$/, "").trim();
    }
    if (!text) continue;
    cleaned.push(text);
    pauses.push(Math.min(1.2, Number(pause.toFixed(2))));
  }
  return { segments: cleaned, pauses };
}

async function createNarration(segments, language, ttsEngine, outputDir, profile = {}, pauses = []) {
  const narrationDir = path.join(outputDir, "narration");
  await mkdir(narrationDir, { recursive: true });
  const engine = ttsEngine ?? defaultTtsEngine(language);
  const files = engine === "kokoro"
    ? await synthesizeKokoroCues({ segments, outputDir: narrationDir, speed: profile.kokoroSpeed })
    : engine === "voxcpm2"
      ? await synthesizeVoxCpmCues({ segments, language, outputDir: narrationDir, voiceDescription: profile.voxDescription })
      : await synthesizeGeminiCues({ segments, language, outputDir: narrationDir });
  const pacedFiles = engine === "gemini" && language === "Burmese" ? await paceGeminiBurmeseCues(files, narrationDir) : files;

  const durations = await Promise.all(pacedFiles.map((file) => mediaDuration(file)));
  // Insert a matching-format silence clip after any segment that carried a [pause]/ellipsis marker,
  // so the narration breathes at natural points instead of running edge to edge.
  const gaps = pacedFiles.map((_, index) => Math.max(0, Math.min(1.2, Number(pauses[index] ?? 0))));
  const audioFormat = gaps.some((gap) => gap > 0.01) ? await probeAudioFormat(pacedFiles[0]).catch(() => ({ rate: 24000, channels: 1 })) : null;
  const timeline = [];
  for (let index = 0; index < pacedFiles.length; index += 1) {
    timeline.push(pacedFiles[index]);
    if (audioFormat && gaps[index] > 0.01) {
      const silence = path.join(narrationDir, `pause-${String(index + 1).padStart(3, "0")}.wav`);
      await createSilence(silence, gaps[index], audioFormat.rate, audioFormat.channels);
      timeline.push(silence);
    }
  }
  const concatPath = path.join(narrationDir, "concat.txt");
  await writeFile(concatPath, timeline.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  const output = path.join(outputDir, "voice-cued.m4a");
  await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output]);
  const outputDuration = await mediaDuration(output);
  const sourceDuration = durations.reduce((sum, duration) => sum + duration, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
  const scale = outputDuration / sourceDuration;
  let cursor = 0;
  const cues = durations.map((duration, index) => {
    const start = cursor;
    cursor += duration * scale;
    const end = cursor;
    cursor += gaps[index] * scale;
    return { start, end };
  });
  return {
    path: output,
    duration: outputDuration,
    cues,
    providerLabel: engine === "kokoro"
      ? `Local ${kokoroConfig().model} (${kokoroConfig().voice})`
      : engine === "voxcpm2"
        ? `Local ${voxCpmConfig().model}`
        : `Google ${geminiTtsConfig().model} (${geminiTtsConfig().voice})`,
  };
}

async function paceGeminiBurmeseCues(files, outputDir) {
  const speed = Math.max(0.82, Math.min(1.02, Number(process.env.GEMINI_TTS_BURMESE_SPEED || 0.94)));
  return mapWithConcurrency(files, clipEncodeConcurrency(), async (file, index) => {
    const output = path.join(outputDir, `paced-${String(index + 1).padStart(3, "0")}.wav`);
    await run(ffmpegPath, ["-y", "-i", file, "-filter:a", atempoFilter(speed), "-ar", "24000", "-ac", "1", output]);
    return output;
  });
}

async function fitNarration(narration, targetDuration, outputDir, language = "English") {
  const desiredDuration = Math.max(1, targetDuration - 0.35);
  const rawSpeed = narration.duration / desiredDuration;
  if (rawSpeed >= 0.96 && rawSpeed <= 1.03) return narration;
  const minimumSpeed = language === "Burmese" ? 1 : 0.96;
  const speed = Math.max(minimumSpeed, rawSpeed);
  const output = path.join(outputDir, "voice.m4a");
  await run(ffmpegPath, ["-y", "-i", narration.path, "-filter:a", atempoFilter(speed), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output]);
  const duration = await mediaDuration(output);
  const scale = duration / narration.duration;
  return { ...narration, path: output, duration, cues: narration.cues.map((cue) => ({ start: cue.start * scale, end: cue.end * scale })) };
}

async function createCuratedMusic(duration, category, outputDir) {
  const preset = musicPreset(category);
  const endStart = Math.max(0, duration - 3.2);
  const third = preset.minor ? 1.189207 : 1.259921;
  const expression = [
    `0.030*(0.74+0.26*sin(2*PI*0.125*t))*sin(2*PI*${preset.root.toFixed(3)}*t)`,
    `0.020*sin(2*PI*${(preset.root * third).toFixed(3)}*t)`,
    `0.018*sin(2*PI*${(preset.root * 1.498307).toFixed(3)}*t)`,
    `0.012*pow(max(0\,sin(2*PI*2*t))\,10)*sin(2*PI*${(preset.root * 4).toFixed(3)}*t)`,
    `if(lt(t\,1.35)\,0.055*(1-t/1.35)*sin(2*PI*${(preset.root * 6).toFixed(3)}*t)\,0)`,
    `if(gt(t\,${endStart.toFixed(3)})\,0.036*((t-${endStart.toFixed(3)})/3.2)*sin(2*PI*${(preset.root * 3).toFixed(3)}*t)\,0)`,
  ].join("+");
  const output = path.join(outputDir, "music.m4a");
  await run(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", `aevalsrc='${expression}':s=48000:d=${duration.toFixed(3)}`,
    "-af", `highpass=f=70,lowpass=f=${preset.lowpass},aecho=0.8:0.34:60|120:0.10|0.05,afade=t=in:st=0:d=0.06,afade=t=out:st=${Math.max(0, duration - 0.9).toFixed(3)}:d=0.9,loudnorm=I=-18:TP=-3:LRA=8,aformat=channel_layouts=stereo`,
    "-t", duration.toFixed(3), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output,
  ]);
  return { path: output, preset: preset.name };
}

async function createThumbnail(videoPath, output, title, category, outputDir) {
  const assPath = path.join(outputDir, "thumbnail.ass");
  await writeFile(assPath, buildThumbnailAss(title, category), "utf8");
  const escapedAssPath = assPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
  await run(ffmpegPath, [
    "-y", "-ss", "1.2", "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale=1080:1920:flags=lanczos,eq=brightness=-0.10:saturation=1.18,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.24:t=fill,ass='${escapedAssPath}'`,
    "-q:v", "2", "-update", "1", output,
  ]);
}

function buildThumbnailAss(title, category) {
  const hook = escapeAss(wrapThumbnailTitle(title)).replaceAll("\n", "\\N");
  const label = escapeAss(String(category || "Knowledge").toUpperCase());
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Hook,Arial,88,&H00FFFFFF,&H00FFFFFF,&H00120D22,&H72000000,-1,0,0,0,100,100,0,0,3,12,0,5,90,90,230,1\nStyle: Label,Arial,34,&H00FFFFFF,&H00FFFFFF,&H007656E8,&H007656E8,-1,0,0,0,100,100,1,0,3,8,0,8,100,100,130,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:10.00,Label,,0,0,0,,${label}\nDialogue: 0,0:00:00.00,0:00:10.00,Hook,,0,0,0,,${hook}\n`;
}

function wrapThumbnailTitle(value) {
  const words = String(value).trim().replace(/\s+/g, " ").split(" ").slice(0, 12);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > 22 && lines.length < 2) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function musicPreset(category = "Knowledge") {
  const value = String(category).toLowerCase();
  if (value.includes("technology")) return { name: "Digital Pulse", root: 146.832, minor: true, lowpass: 7600 };
  if (value.includes("business")) return { name: "Forward Motion", root: 130.813, minor: false, lowpass: 6900 };
  if (value.includes("history")) return { name: "Archive Glow", root: 110.0, minor: true, lowpass: 5200 };
  if (value.includes("wellness")) return { name: "Quiet Current", root: 174.614, minor: false, lowpass: 4400 };
  if (value.includes("psychology")) return { name: "Mind Loop", root: 123.471, minor: true, lowpass: 6000 };
  return { name: "Curiosity Pulse", root: 138.591, minor: false, lowpass: 6500 };
}

// Topic-aware look and feel: color grade, camera motion, transition set, pacing, subtitle style, and
// voice tone are chosen per category so videos read as deliberately produced rather than templated.
// Transition names are restricted to a set verified to exist in the bundled ffmpeg xfade filter.
function styleProfile(category = "Knowledge") {
  const value = String(category).toLowerCase();
  const base = {
    grade: "eq=contrast=1.05:saturation=1.12",
    motions: ["zoomin", "pan", "zoomout", "pan"],
    transitions: ["fade", "slideleft", "circleopen", "wipeleft", "dissolve"],
    transitionSeconds: 0.5,
    clipSeconds: 3.2,
    subtitle: { fontsize: 64, outline: "&H00202020", marginV: 440, animate: true, kinetic: true, highlight: "&H0000FFFF" },
    kokoroSpeed: 1.15,
    voxDescription: "A clear, energetic, confident knowledge presenter with a warm natural voice and a medium conversational pace.",
  };
  if (value.includes("technology")) return { ...base,
    grade: "eq=contrast=1.08:saturation=1.03,colorbalance=bs=0.05:rm=-0.02",
    motions: ["zoomin", "zoomout", "pan"],
    transitions: ["slideleft", "wipeleft", "smoothright", "fade"],
    clipSeconds: 2.8,
    subtitle: { fontsize: 66, outline: "&H00A85200", marginV: 470, animate: true, kinetic: true, highlight: "&H00FFFF00" },
    kokoroSpeed: 1.2,
    voxDescription: "A crisp, modern, high-energy technology presenter with a confident, articulate voice and a brisk pace.",
  };
  if (value.includes("business")) return { ...base,
    grade: "eq=contrast=1.07:saturation=1.05",
    transitions: ["slideup", "wipeleft", "fade", "slideleft"],
    clipSeconds: 2.9,
    subtitle: { fontsize: 64, outline: "&H00202020", marginV: 450, animate: true, kinetic: true, highlight: "&H0000FF00" },
    kokoroSpeed: 1.22,
    voxDescription: "A confident, motivating business presenter with a clear, persuasive voice and an energetic, purposeful pace.",
  };
  if (value.includes("history")) return { ...base,
    grade: "eq=contrast=1.03:saturation=0.9:gamma=0.98,colorbalance=rs=0.06:bs=-0.05",
    motions: ["pan", "zoomin", "pan", "zoomout"],
    transitions: ["fade", "dissolve", "circleclose"],
    clipSeconds: 3.6,
    subtitle: { fontsize: 62, outline: "&H00203040", marginV: 430, animate: true, kinetic: true, highlight: "&H000098FF" },
    kokoroSpeed: 1.08,
    voxDescription: "A warm, measured storyteller with a rich, calm voice and an unhurried, cinematic pace.",
  };
  if (value.includes("wellness")) return { ...base,
    grade: "eq=contrast=1.0:saturation=1.05:brightness=0.03",
    motions: ["pan", "zoomin", "pan"],
    transitions: ["fade", "dissolve", "circleopen"],
    clipSeconds: 3.8,
    subtitle: { fontsize: 60, outline: "&H00404020", marginV: 420, animate: true, kinetic: true, highlight: "&H00D0FF80" },
    kokoroSpeed: 1.05,
    voxDescription: "A soothing, warm wellness presenter with a gentle, reassuring voice and a slow, calming pace.",
  };
  if (value.includes("psychology")) return { ...base,
    grade: "eq=contrast=1.1:saturation=1.0,colorbalance=bs=0.04",
    transitions: ["fade", "dissolve", "slideleft", "circleopen"],
    clipSeconds: 3.2,
    subtitle: { fontsize: 64, outline: "&H00301A2A", marginV: 450, animate: true, kinetic: true, highlight: "&H00FF66FF" },
    kokoroSpeed: 1.12,
    voxDescription: "A thoughtful, engaging psychology presenter with a warm, curious voice and a natural, deliberate pace.",
  };
  return base;
}

function motionFilter(motion) {
  if (motion === "pan") return "crop=720:1280:x='20+20*sin(t*0.8)':y='36+36*cos(t*0.65)'";
  if (motion === "zoomout") return "crop=720:1280,zoompan=z='if(eq(on,0),1.35,max(1.001,zoom-0.0016))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
  return "crop=720:1280,zoompan=z='min(zoom+0.0016,1.35)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30";
}

// Assemble N normalized clips into one 1080x1920 master with cross-clip transitions.
// Each clip contributes (clipSeconds - overlap) of unique screen time; the graph output length is
// (count - 1) * (clipSeconds - overlap) + clipSeconds, then trimmed to the target duration.
function buildXfadeChain(count, clipSeconds, overlap, transitions) {
  const scale = (index) => `[${index}:v]scale=1080:1920:flags=lanczos,fps=30,setsar=1,format=yuv420p,settb=AVTB[v${index}]`;
  if (count <= 1) return `${scale(0).replace("[v0]", "[vout]")}`;
  const parts = Array.from({ length: count }, (_, index) => scale(index));
  let last = "v0";
  let offset = clipSeconds - overlap;
  for (let index = 1; index < count; index += 1) {
    const out = index === count - 1 ? "vout" : `x${index}`;
    const transition = transitions[(index - 1) % transitions.length];
    parts.push(`[${last}][v${index}]xfade=transition=${transition}:duration=${overlap.toFixed(2)}:offset=${offset.toFixed(2)}[${out}]`);
    last = out;
    offset += clipSeconds - overlap;
  }
  return parts.join(";");
}

function atempoFilter(speed) {
  const factors = [];
  let remaining = speed;
  while (remaining > 2) { factors.push(2); remaining /= 2; }
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5; }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`).join(",");
}

async function translateSegments(segments, sourceLanguage, targetLanguage, purpose = "subtitles") {
  if (!targetLanguage || sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) return segments;
  if (!textProviderConfig().ready) throw new Error(`Translation from ${sourceLanguage} to ${targetLanguage} requires Gemini or OpenRouter.`);
  const translated = [];
  for (let offset = 0; offset < segments.length; offset += 5) {
    const batch = segments.slice(offset, offset + 5).map((text, index) => ({ id: offset + index, text }));
    translated.push(...await translateBatch(batch, sourceLanguage, targetLanguage, purpose));
  }
  return translated;
}

async function translateBatch(batch, sourceLanguage, targetLanguage, purpose) {
  try {
    const generated = await generateText({
      system: `You are a professional ${targetLanguage} translator. Translate every input object's text from ${sourceLanguage} to natural ${targetLanguage} for ${purpose}. Return one tagged block per input in this exact format: <T id="0">translated text</T>. Copy every numeric input id unchanged and exactly once. Preserve meaning and tone; never merge, split, reorder, omit, or invent content. Never put angle brackets inside the translated text. Never mix unrelated scripts. For Burmese, use natural modern Myanmar language and write every word in Myanmar script; render names and unavoidable technical terms phonetically in Myanmar letters, with no Latin letters. No JSON, markdown, or commentary.`,
      user: JSON.stringify(batch),
      maxTokens: Math.min(2200, Math.max(800, Math.ceil(JSON.stringify(batch).length * 2.2))),
      temperature: 0.05,
    });
    const matches = [...String(generated?.text ?? "").matchAll(/<T\s+id=["']?(\d+)["']?\s*>([\s\S]*?)<\/T>/gi)];
    const byId = new Map(matches.map((match) => [Number(match[1]), match[2].trim()]));
    const ordered = batch.map((item) => byId.get(item.id));
    if (ordered.some((text) => typeof text !== "string" || !text.trim())) {
      throw new Error("Translation did not preserve every timing cue.");
    }
    return ordered.map((text) => text.trim());
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Translation failed.");
  }
}

// One concrete visual search phrase per narration line, aligned by index, so footage can track what
// is actually being said. Falls back to per-line keywords when no text provider is available.
async function createSegmentQueries(segments, category) {
  const fallback = segments.map((segment) => {
    const words = uniqueWords(segment).slice(0, 3);
    return words.length >= 2 ? words.join(" ") : `${category ?? "knowledge"} ${words.join(" ")}`.trim();
  });
  try {
    const numbered = segments.map((segment, index) => `${index}. ${segment}`).join("\n");
    const generated = await generateText({
      system: "For each numbered narration line, give ONE short stock-media search phrase (2-6 words) describing a concrete, filmable person, object, action, or place that visually represents that specific line. Avoid abstract concepts, on-screen text, logos, proper names, and the words video, footage, animation, or background. Return one line per input formatted exactly as \"<index>: phrase\", keeping the same indexes and order.",
      user: `Category: ${category ?? "Knowledge"}\nLines:\n${numbered}`,
      maxTokens: Math.min(1400, 60 + segments.length * 26),
      temperature: 0.3,
    });
    if (generated?.text) {
      const byIndex = new Map();
      for (const match of String(generated.text).matchAll(/^\s*(\d+)\s*[:.)\-]\s*(.+)$/gm)) {
        const phrase = match[2].trim().replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").trim();
        if (phrase.split(/\s+/).length >= 2 && phrase.length <= 90) byIndex.set(Number(match[1]), phrase);
      }
      if (byIndex.size) return segments.map((_, index) => byIndex.get(index) ?? fallback[index]);
    }
  } catch {
    // Fall back to deterministic per-line keywords below.
  }
  return fallback;
}

// Map each clip slot to the narration line playing during it, so the clip's footage matches the words.
// The clip's midpoint on the timeline picks the cue whose window it falls in (or the last one started).
export function planClipQueries(clipCount, clipDuration, transitionSeconds, cues, segmentQueries) {
  const step = Math.max(0.1, clipDuration - transitionSeconds);
  const fallbackQuery = segmentQueries.find(Boolean) ?? "";
  return Array.from({ length: clipCount }, (_, index) => {
    const midpoint = index * step + clipDuration / 2;
    let cueIndex = 0;
    for (let j = 0; j < cues.length; j += 1) {
      if (cues[j].start <= midpoint) cueIndex = j;
      else break;
    }
    const clamped = Math.max(0, Math.min(segmentQueries.length - 1, cueIndex));
    return segmentQueries[clamped] || fallbackQuery;
  });
}

function validateLanguageText(segments, language, label) {
  if (!Array.isArray(segments) || segments.length < 2 || segments.some((segment) => typeof segment !== "string" || !segment.trim())) {
    throw new Error(`Generated ${label} failed the content quality check.`);
  }
  const normalized = String(language ?? "").trim().toLowerCase();
  const text = segments.join(" ");
  if (normalized === "burmese" || normalized === "myanmar") {
    const letters = [...text].filter((character) => /\p{L}/u.test(character));
    const myanmarLetters = letters.filter((character) => /\p{Script=Myanmar}/u.test(character));
    if (letters.length < 30 || myanmarLetters.length !== letters.length) {
      throw new Error(`Generated ${label} is not clean Burmese. Rendering stopped before voice and video creation.`);
    }
  }
}

function normalizeTranslatedScript(segments, language) {
  const normalized = String(language ?? "").trim().toLowerCase();
  if (normalized !== "burmese" && normalized !== "myanmar") return segments;
  return segments.map((segment) => segment
    .replace(/\s*[（(][^()）]*[A-Za-z][^()）]*[）)]/g, "")
    .replace(/Follow\s*လုပ်ထားပေးပါဦး/gi, "စာမျက်နှာကို စောင့်ကြည့်ထားပေးပါဦး")
    .replace(/Follow\s*လုပ်ထားပါဦး/gi, "စာမျက်နှာကို စောင့်ကြည့်ထားပါဦး")
    .replace(/Follow\s*လုပ်ပါ/gi, "စာမျက်နှာကို စောင့်ကြည့်ပါ")
    .replace(/Zeigarnik\s+effect/gi, "ဇိုင်ဂါးနစ် အကျိုးသက်ရောက်မှု")
    .replace(/psychology/gi, "စိတ်ပညာ")
    .replace(/e-?mail/gi, "အီးမေးလ်")
    .replace(/follow/gi, "စောင့်ကြည့်")
    .replace(/ရုပ်ပိုင်းဆိုင်ရာ\s+လုပ်ဆောင်ချက်/g, "လက်တွေ့လုပ်ဆောင်ချက်")
    .replace(/အာရုံပြန်စုံ/g, "အာရုံပြန်စိုက်")
    .replace(/စောင့်ကြည့်\s+လုပ်ထား(?:လိုက်)?ပါ/g, "ဆက်လက်စောင့်ကြည့်ထားပါ")
    .replace(/\s+([၊။!?])/g, "$1")
    .trim());
}

// Find one licensed source per clip slot, matched to that slot's query. Prefers a portrait video;
// when a query has no video (common for abstract topics) it falls back to a photo the pipeline
// animates with Ken Burns motion. Returns an array aligned 1:1 with clipPlan (null => motion clip).
async function findStockClips(request, clipPlan, clipsDir, progress = async () => {}) {
  const clipCount = clipPlan.length;
  const key = process.env.PEXELS_API_KEY;
  if (!key) return new Array(clipCount).fill(null);
  try {
    await progress("stock-search", 40, "Searching Pexels for footage that matches each line");
    const category = String(request.category ?? "knowledge").trim();
    const uniqueQueries = [...new Set(clipPlan.filter(Boolean))].slice(0, 14);
    if (!uniqueQueries.length) uniqueQueries.push([category, ...uniqueWords(request.prompt).slice(0, 3)].join(" ").trim());
    const seenMediaIds = new Set();
    const byQuery = new Map();
    await mapWithConcurrency(uniqueQueries, 4, async (query) => {
      const media = (await searchPexelsMedia(query, key)).filter((item) => item && !seenMediaIds.has(item.id));
      media.forEach((item) => seenMediaIds.add(item.id));
      byQuery.set(query, media);
    });

    // Assign a distinct candidate to each clip from its own query first, then borrow spares, then reuse.
    const pointers = new Map();
    const chosen = clipPlan.map((query) => {
      const list = byQuery.get(query) ?? [];
      const pointer = pointers.get(query) ?? 0;
      if (list[pointer]) { pointers.set(query, pointer + 1); return list[pointer]; }
      return null;
    });
    const used = new Set(chosen.filter(Boolean).map((item) => item.id));
    const spares = [...byQuery.values()].flat().filter((item) => !used.has(item.id));
    let spareIndex = 0;
    for (let index = 0; index < chosen.length; index += 1) {
      if (!chosen[index] && spareIndex < spares.length) { chosen[index] = spares[spareIndex++]; used.add(chosen[index].id); }
    }
    const anyChosen = chosen.filter(Boolean);
    for (let index = 0; index < chosen.length; index += 1) {
      if (!chosen[index] && anyChosen.length) chosen[index] = anyChosen[index % anyChosen.length];
    }

    // Download each distinct source once (random-start sampling later keeps reused sources visually varied).
    const distinct = [...new Map(chosen.filter(Boolean).map((item) => [item.id, item])).values()];
    await progress("stock-search", 41, "Downloading licensed sources");
    const downloadedById = new Map();
    let done = 0;
    await mapWithConcurrency(distinct, 4, async (candidate) => {
      try {
        const response = await fetchWithTimeout(candidate.url, {}, 25_000);
        if (response.ok) {
          const extension = candidate.type === "image" ? "jpg" : "mp4";
          const file = path.join(clipsDir, `source-${candidate.id}.${extension}`);
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
          downloadedById.set(candidate.id, {
            file,
            type: candidate.type,
            license: { provider: "Pexels", mediaType: candidate.type, mediaId: candidate.id, creator: candidate.creator, sourceUrl: candidate.page, license: "Pexels License" },
          });
        }
      } catch {
        // A failed download leaves this slot null -> motion background fallback.
      }
      done += 1;
      await progress("stock-search", 41 + Math.round((done / Math.max(1, distinct.length)) * 4), `Downloaded ${done} of ${distinct.length} licensed sources`);
    });
    return chosen.map((item) => (item && downloadedById.get(item.id)) || null);
  } catch {
    return new Array(clipCount).fill(null);
  }
}

// One Pexels lookup for a query: a portrait video if available, otherwise portrait photos.
async function searchPexelsMedia(query, key) {
  try {
    const response = await fetchWithTimeout(`https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=4`, { headers: { Authorization: key } }, 20_000);
    if (response.ok) {
      const data = await response.json();
      const videos = (data.videos ?? []).map((video) => {
        const files = [...(video.video_files ?? [])].sort((a, b) => Math.abs((a.width ?? 0) - 720) - Math.abs((b.width ?? 0) - 720));
        const chosen = files.find((file) => file.file_type === "video/mp4" && (file.height ?? 0) >= (file.width ?? 0)) ?? files.find((file) => file.file_type === "video/mp4");
        return chosen ? { type: "video", id: `v${video.id}`, url: chosen.link, page: video.url, creator: video.user?.name ?? "Pexels contributor" } : null;
      }).filter(Boolean);
      if (videos.length) return videos;
    }
  } catch {
    // Fall through to a photo search.
  }
  try {
    const response = await fetchWithTimeout(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=4`, { headers: { Authorization: key } }, 20_000);
    if (response.ok) {
      const data = await response.json();
      return (data.photos ?? []).map((photo) => {
        const url = photo.src?.portrait ?? photo.src?.large2x ?? photo.src?.large ?? photo.src?.original;
        return url ? { type: "image", id: `p${photo.id}`, url, page: photo.url, creator: photo.photographer ?? "Pexels contributor" } : null;
      }).filter(Boolean);
    }
  } catch {
    // No media for this query -> caller falls back to spares or a motion background.
  }
  return [];
}

async function normalizeStockClip(input, output, seconds, options = {}) {
  const motion = options.motion ?? "zoomin";
  const grade = options.grade ?? "eq=contrast=1.04:saturation=1.1";
  // Sample a random window of the source so reused clips never show the same footage twice.
  const sourceDuration = await mediaDuration(input).catch(() => 0);
  const seek = sourceDuration > seconds + 0.6
    ? ["-ss", (Math.random() * (sourceDuration - seconds - 0.3)).toFixed(2), "-i", input, "-t", String(seconds)]
    : ["-stream_loop", "-1", "-i", input, "-t", String(seconds)];
  const fadeOut = Math.max(0, seconds - 0.12).toFixed(2);
  await run(ffmpegPath, [
    "-y", ...seek,
    "-vf", `scale=760:1352:force_original_aspect_ratio=increase,${motionFilter(motion)},fps=30,${grade},fade=t=in:d=0.12,fade=t=out:st=${fadeOut}:d=0.12,format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", output,
  ]);
}

// Turn a still photo into a clip with Ken Burns motion, matching the grade/fades of video clips so it
// composits seamlessly in the transition chain. Zoom-only motions read best on stills.
async function normalizeStillImage(input, output, seconds, options = {}) {
  const motion = options.motion === "pan" ? "zoomin" : (options.motion ?? "zoomin");
  const grade = options.grade ?? "eq=contrast=1.04:saturation=1.1";
  const fadeOut = Math.max(0, seconds - 0.12).toFixed(2);
  await run(ffmpegPath, [
    "-y", "-loop", "1", "-framerate", "30", "-t", String(seconds), "-i", input,
    "-vf", `scale=760:1352:force_original_aspect_ratio=increase,${motionFilter(motion)},fps=30,${grade},fade=t=in:d=0.12,fade=t=out:st=${fadeOut}:d=0.12,format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", output,
  ]);
}

async function createMotionClip(output, seconds, index) {
  const base = palette[index % palette.length];
  const accent = accents[index % accents.length];
  const accentTwo = accents[(index + 2) % accents.length];
  const phase = (index % 7) * 0.73;
  const gradientType = ["linear", "radial", "circular", "spiral"][index % 4];
  const filter = [
    `[1:v]format=rgba,pad=520:520:180:180:color=black@0,gblur=sigma=82:steps=3[glow1]`,
    `[2:v]format=rgba,pad=440:440:150:150:color=black@0,gblur=sigma=68:steps=3[glow2]`,
    `[0:v][glow1]overlay=x='(W-w)*(0.5+0.48*sin(t*0.82+${phase}))':y='(H-h)*(0.5+0.46*cos(t*0.64+${phase}))':eval=frame:shortest=1[layer1]`,
    `[layer1][glow2]overlay=x='(W-w)*(0.5+0.48*cos(t*1.08+${phase}))':y='(H-h)*(0.5+0.46*sin(t*0.91+${phase}))':eval=frame:shortest=1[layer2]`,
    `[layer2]drawgrid=width=80:height=80:thickness=1:color=white@0.045,noise=alls=5:allf=t,vignette=PI/4,eq=contrast=1.08:saturation=1.24,fade=t=in:d=0.12,fade=t=out:st=${Math.max(0, seconds - 0.12).toFixed(2)}:d=0.12,format=yuv420p[out]`,
  ].join(";");
  await run(ffmpegPath, [
    "-y",
    "-f", "lavfi", "-i", `gradients=s=720x1280:r=30:c0=${base}:c1=${accent}:c2=${accentTwo}:nb_colors=3:d=${seconds}:speed=${(0.045 + (index % 4) * 0.018).toFixed(3)}:type=${gradientType}`,
    "-f", "lavfi", "-i", `color=c=${accent}:s=160x160:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `color=c=${accentTwo}:s=140x140:r=30:d=${seconds}`,
    "-filter_complex", filter, "-map", "[out]", "-t", String(seconds), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", output,
  ]);
}

function segmentText(text, language = "English") {
  const segments = [];
  const compactScript = new Set(["burmese", "chinese", "japanese", "khmer", "korean", "lao", "thai"]).has(String(language).toLowerCase());
  const sentenceLimit = compactScript ? 52 : 68;
  const sentences = text.trim().match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text.trim()];
  for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) {
    if (sentence.length <= sentenceLimit) segments.push(sentence);
    else if (compactScript && !/\s/u.test(sentence)) segments.push(...splitLongToken(sentence, language, sentenceLimit));
    else segments.push(...splitLongSentence(sentence, language));
  }
  if (segments.length > 1 && segments.at(-1).length < 14 && `${segments.at(-2)} ${segments.at(-1)}`.length <= 56) segments.splice(-2, 2, `${segments.at(-2)} ${segments.at(-1)}`);
  return segments;
}

function splitLongSentence(sentence, language) {
  const words = sentence.split(/\s+/).flatMap((word) => splitLongToken(word, language, 52));
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    let hardEnd = start;
    while (hardEnd < words.length && words.slice(start, hardEnd + 1).join(" ").length <= 72) hardEnd += 1;
    if (hardEnd >= words.length) { chunks.push(words.slice(start).join(" ")); break; }
    const preferredEnd = (() => {
      let end = start;
      while (end < words.length && words.slice(start, end + 1).join(" ").length <= 60) end += 1;
      return Math.max(start + 1, end);
    })();
    let breakAt = -1;
    for (let index = hardEnd - 1; index > start + 1; index -= 1) {
      const left = words.slice(start, index).join(" ");
      const next = words[index];
      if (left.length < 28) continue;
      if (/[,;:]$/.test(words[index - 1]) || /^(and|but|because|then|so|while|when|if|that|which|who|can|could|may|might|should|would|is|are|was|were|has|have|to)$/i.test(next)) {
        breakAt = index;
        break;
      }
    }
    if (breakAt < 0) breakAt = preferredEnd;
    chunks.push(words.slice(start, breakAt).join(" "));
    start = breakAt;
  }
  return chunks;
}

function buildSrt(segments, totalDuration) {
  const weights = segments.map((segment) => Math.max(8, segment.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const minimum = Math.min(0.9, (totalDuration / segments.length) * 0.72);
  const weightedTime = Math.max(0, totalDuration - minimum * segments.length);
  let cursor = 0;
  const cues = segments.map((segment, index) => {
    const duration = minimum + (weights[index] / totalWeight) * weightedTime;
    const start = cursor;
    const end = Math.min(totalDuration, cursor + duration);
    cursor = end;
    return { start, end };
  });
  return buildSrtFromCues(segments, cues, totalDuration);
}

function buildSrtFromCues(segments, cues, totalDuration) {
  return cues.map((cue, index) => ({ cue, text: segments[index] })).filter(({ cue, text }) => text && cue.start < totalDuration).map(({ cue, text }, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(Math.min(cue.end, totalDuration))}\n${wrapSubtitle(text)}\n`).join("\n");
}

function buildAss(segments, cues, totalDuration, fontName = "Arial", style = null) {
  // Defaults reproduce the original fixed style byte-for-byte; a per-topic `style` overrides them.
  const s = { fontsize: 62, primary: "&H00FFFFFF", secondary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", outlineW: 6, marginV: 430, animate: false, kinetic: false, highlight: "&H0000FFFF", ...(style ?? {}) };
  // Kinetic mode colors already-spoken words with the highlight accent and unspoken words white.
  const activeColour = s.kinetic ? s.highlight : s.primary;
  const restColour = s.kinetic ? s.primary : s.secondary;
  // BorderStyle 1 = outline stroke around the glyphs (no background box); the outline colour is the stroke.
  const styleLine = `Style: Reelio,${fontName},${s.fontsize},${activeColour},${restColour},${s.outline},${s.back},-1,0,0,0,100,100,0,0,1,${s.outlineW},0,2,90,90,${s.marginV},1`;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${styleLine}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const intro = s.animate ? (s.kinetic ? "{\\fad(80,60)}" : "{\\fad(120,90)}") : "";
  const events = cues.map((cue, index) => ({ cue, text: segments[index] })).filter(({ cue, text }) => text && cue.start < totalDuration).map(({ cue, text }) => {
    const end = Math.min(cue.end, totalDuration);
    const body = s.kinetic ? buildKaraokeLine(text, Math.max(0.2, end - cue.start), subtitleMaxChars(s.fontsize)) : `${escapeAss(wrapSubtitle(text)).replaceAll("\n", "\\N")}`;
    return `Dialogue: 0,${assTime(cue.start)},${assTime(end)},Reelio,,0,0,0,,${intro}${body}`;
  }).join("\n");
  return `${header}${events}\n`;
}

// Characters that safely fit one line: usable width is 1080 minus the 90px side margins, and a bold
// glyph advance is ~0.6*fontsize. Larger fonts therefore wrap sooner so text never runs off-screen.
function subtitleMaxChars(fontsize) {
  return Math.max(14, Math.floor(900 / (Math.max(1, Number(fontsize) || 62) * 0.6)));
}

// Word-by-word karaoke: each word carries a \kf sweep whose centiseconds are proportional to its
// length, so the highlight tracks the narration. Wraps to a new line once a line runs out of width.
function buildKaraokeLine(text, durationSeconds, maxChars = 28) {
  const words = String(text).trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (!words.length) return "";
  const totalCs = Math.max(1, Math.round(durationSeconds * 100));
  const weights = words.map((word) => Math.max(2, word.length));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let used = 0;
  const durations = weights.map((weight, index) => {
    if (index === weights.length - 1) return Math.max(1, totalCs - used);
    const value = Math.max(1, Math.round((weight / weightSum) * totalCs));
    used += value;
    return value;
  });
  const lines = [];
  let current = [];
  let length = 0;
  words.forEach((word, index) => {
    if (length && length + 1 + word.length > maxChars) { lines.push(current); current = []; length = 0; }
    current.push(`{\\kf${durations[index]}}${escapeAss(word)}`);
    length += (length ? 1 : 0) + word.length;
  });
  if (current.length) lines.push(current);
  return lines.map((line) => line.join(" ")).join("\\N");
}

function wrapSubtitle(text) {
  const clean = String(text).trim().replace(/\s+/g, " ");
  if (clean.length <= 30) return clean;
  const words = clean.split(" ");
  if (words.length === 1) {
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)].map((item) => item.segment);
    const midpoint = Math.ceil(graphemes.length / 2);
    return `${graphemes.slice(0, midpoint).join("")}\n${graphemes.slice(midpoint).join("")}`;
  }
  let bestIndex = 1;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ");
    const right = words.slice(index).join(" ");
    const difference = Math.abs(left.length - right.length) + Math.max(0, left.length - 32) * 4 + Math.max(0, right.length - 32) * 4;
    if (difference < bestDifference) { bestIndex = index; bestDifference = difference; }
  }
  return `${words.slice(0, bestIndex).join(" ")}\n${words.slice(bestIndex).join(" ")}`;
}

function splitLongToken(token, language, maxLength) {
  if (token.length <= maxLength) return [token];
  const locale = ({ Burmese: "my", Chinese: "zh", Japanese: "ja", Khmer: "km", Korean: "ko", Lao: "lo", Thai: "th" })[language] ?? undefined;
  const graphemes = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(token)].map((item) => item.segment);
  const chunks = [];
  let current = "";
  for (const grapheme of graphemes) {
    if (current && current.length + grapheme.length > maxLength) { chunks.push(current); current = ""; }
    current += grapheme;
  }
  if (current) chunks.push(current);
  return chunks;
}

function captionFont(language) {
  return ({
    Burmese: "Noto Sans Myanmar",
    Chinese: "PingFang SC",
    Japanese: "Hiragino Sans",
    Khmer: "Noto Sans Khmer",
    Korean: "Apple SD Gothic Neo",
    Lao: "Noto Sans Lao",
    Thai: "Thonburi",
    Hindi: "Noto Sans Devanagari",
    Arabic: "Noto Sans Arabic",
  })[language] ?? "Arial";
}

function escapeAss(text) {
  return String(text).replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function chooseDuration(requested, voiceDuration, language = "English") {
  const { min, max } = durationBounds(requested ?? "60–90 sec");
  if (language === "Burmese") return Math.min(180, Math.max(min, voiceDuration + 1.25));
  return Math.min(max, Math.max(min, voiceDuration + 1.25));
}

function scriptWordRange(requested) {
  const { min, max } = durationBounds(requested ?? "60–90 sec");
  const target = min === max ? min : min + (max - min) * 0.52;
  return {
    min: Math.max(18, Math.round(target * 2.45)),
    max: Math.min(440, Math.max(24, Math.round(target * 2.75))),
  };
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

async function mediaDuration(file) {
  const output = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read narration duration.");
  return duration;
}

async function probeAudioFormat(file) {
  const output = await run(ffprobePath, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const [rate, channels] = output.trim().split("\n").map((value) => Number(value));
  return { rate: Number.isFinite(rate) && rate > 0 ? rate : 24000, channels: Number.isFinite(channels) && channels > 0 ? channels : 1 };
}

// A silence clip in the same PCM format as the narration cues, so the concat demuxer stays uniform.
async function createSilence(output, seconds, rate = 24000, channels = 1) {
  await run(ffmpegPath, ["-y", "-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=${channels >= 2 ? "stereo" : "mono"}`, "-t", seconds.toFixed(3), "-c:a", "pcm_s16le", output]);
}

function uniqueWords(text) {
  const stop = new Set(["this", "that", "with", "from", "your", "into", "what", "when", "where", "about", "using", "make", "video", "explain"]);
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((word) => !stop.has(word)) ?? [])];
}

function makeTitle(prompt) {
  const words = prompt.trim().replace(/\s+/g, " ").split(" ").slice(0, 12).join(" ");
  return words.length > 82 ? `${words.slice(0, 79)}…` : words;
}

async function asset(file) {
  return { file, name: path.basename(file), bytes: (await stat(file)).size };
}

function clipEncodeConcurrency() {
  const requested = Number(process.env.REELIO_CLIP_CONCURRENCY);
  if (Number.isInteger(requested) && requested >= 1) return Math.min(8, requested);
  return Math.max(1, Math.min(4, (os.availableParallelism?.() ?? 4) - 1));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number(process.env.REELIO_PROCESS_TIMEOUT_MS ?? 900_000));
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (timedOut) reject(new Error(`${path.basename(command)} exceeded the processing time limit.`));
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-1800)}`));
    });
  });
}

async function validateLanguageCapabilities(request) {
  const text = textProviderConfig();
  const engine = request.ttsEngine ?? defaultTtsEngine(request.language);
  if (engine === "gemini") {
    if (!GEMINI_TTS_LANGUAGES.includes(request.language)) throw new Error(`${request.language} speech is not supported by Gemini TTS.`);
    if (!geminiTtsConfig().ready) throw new Error(`${request.language} Gemini narration requires a Gemini API key.`);
  } else if (engine === "voxcpm2") {
    if (!VOXCPM2_LANGUAGES.includes(request.language)) throw new Error(`${request.language} speech is not supported by VoxCPM2.`);
    const health = await getVoxCpmHealth();
    if (!health.ready) throw new Error(health.error);
  }
  if (!text.ready && (request.language.toLowerCase() !== "english" || request.subtitleLanguage.toLowerCase() !== "english")) {
    throw new Error("Multilingual transcripts and subtitles require Gemini or OpenRouter translation.");
  }
}

function narrationProgressMessage(language, engine) {
  if (engine === "kokoro") return "Generating local English Kokoro narration";
  if (engine === "voxcpm2") return `Generating local ${language} VoxCPM2 narration`;
  return `Generating ${language} Gemini narration`;
}

async function fetchWithTimeout(url, options, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Provider request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { buildAss, buildSrt, buildXfadeChain, chooseDuration, createCuratedMusic, extractPauses, ffmpegPath, ffprobePath, motionFilter, segmentText, styleProfile, validateLanguageText };
