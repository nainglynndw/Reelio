import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { synthesizeGeminiCues } from "../gemini-tts-client.mjs";
import { registerJobProcess } from "../job-control.mjs";
import { synthesizeKokoroCues } from "../kokoro-client.mjs";
import { transcribeMedia } from "../stt-client.mjs";
import { generateText, textProviderConfig } from "../text-provider.mjs";
import { synthesizeVoxCpmCues } from "../voxcpm-client.mjs";
import { DEFAULT_NARRATOR_ID, NARRATORS, narratorProfile } from "../narrators.mjs";
import { formatSrt, parseSubtitles } from "./subtitles.mjs";
import { downloadWebCaptions, downloadWebMedia, normalizeWebMediaUrl } from "./web-media.mjs";
import { applyBrandVisuals, brandSubtitleForceStyle } from "../pipeline.mjs";

const ffprobePath = ffprobe.path;

export const TOOL_DEFINITIONS = [
  { id: "chop", label: "Chop", description: "Cut a long video into overlapping clips.", group: "media", inputs: [{ id: "video", label: "Video", accepts: "video/*" }] },
  { id: "download-media", label: "Download video from link", description: "Resolve a supported public video webpage or direct-media URL and save its video.", group: "media", inputs: [] },
  { id: "extract-audio", label: "Generate audio", description: "Extract a clean audio track from a video.", group: "media", inputs: [{ id: "video", label: "Video", accepts: "video/*" }] },
  { id: "extract-subtitles", label: "Extract subtitle track", description: "Copy an existing embedded subtitle track to SRT without speech recognition.", group: "media", inputs: [{ id: "video", label: "Video with subtitles", accepts: "video/*" }] },
  { id: "extract-web-captions", label: "Extract captions from link", description: "Save existing manual or automatic captions from a supported public link.", group: "media", inputs: [] },
  { id: "transcribe", label: "Generate subtitle", description: "Turn speech from audio or video into timed subtitles.", group: "model", inputs: [{ id: "media", label: "Audio or video", accepts: "audio/*,video/*" }] },
  { id: "translate", label: "Translate", description: "Translate subtitles while preserving every cue time.", group: "model", inputs: [{ id: "subtitles", label: "Subtitle file", accepts: ".srt,.vtt,text/vtt,application/x-subrip" }] },
  { id: "speech-synthesis", label: "Speech synthesis", description: "Create timed narration from translated subtitles.", group: "model", inputs: [{ id: "subtitles", label: "Subtitle file", accepts: ".srt,.vtt,text/vtt,application/x-subrip" }] },
  { id: "video-synthesis", label: "Video synthesis", description: "Combine a video, translated audio, and subtitles.", group: "media", inputs: [
    { id: "video", label: "Source video", accepts: "video/*" },
    { id: "audio", label: "Translated audio", accepts: "audio/*" },
    { id: "subtitles", label: "Translated subtitles", accepts: ".srt,.vtt,text/vtt,application/x-subrip" },
  ] },
];

const definitionsById = new Map(TOOL_DEFINITIONS.map((definition) => [definition.id, definition]));

export function toolDefinition(id) {
  return definitionsById.get(id) ?? null;
}

export function toolGroup(id) {
  return toolDefinition(id)?.group ?? "media";
}

export function normalizeToolRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolValidationError("Tool request must be an object.");
  const toolId = String(value.toolId ?? "").trim();
  const definition = toolDefinition(toolId);
  if (!definition) throw new ToolValidationError("Choose a supported tool.");
  const inputs = value.inputs && typeof value.inputs === "object" && !Array.isArray(value.inputs) ? value.inputs : {};
  for (const input of definition.inputs) {
    const reference = inputs[input.id];
    if (!reference || typeof reference !== "object" || (!reference.uploadId && !(reference.toolJobId && reference.assetKey))) {
      throw new ToolValidationError(`${input.label} is required.`);
    }
  }
  const options = value.options && typeof value.options === "object" && !Array.isArray(value.options) ? value.options : {};
  return { toolId, inputs: structuredClone(inputs), options: normalizeOptions(toolId, options) };
}

export async function executeTool({ request, inputs, outputDir, progress }) {
  await mkdir(outputDir, { recursive: true });
  if (request.toolId === "chop") return chopVideo(inputs.video.file, outputDir, request.options, progress);
  if (request.toolId === "download-media") return downloadMediaFromLink(outputDir, request.options, progress);
  if (request.toolId === "extract-audio") return extractAudio(inputs.video.file, outputDir, request.options, progress);
  if (request.toolId === "extract-subtitles") return extractSubtitleTrack(inputs.video.file, outputDir, request.options, progress);
  if (request.toolId === "extract-web-captions") return extractCaptionsFromLink(outputDir, request.options, progress);
  if (request.toolId === "transcribe") return transcribe(inputs.media.file, outputDir, request.options, progress);
  if (request.toolId === "translate") return translateSubtitles(inputs.subtitles.file, outputDir, request.options, progress);
  if (request.toolId === "speech-synthesis") return synthesizeSpeech(inputs.subtitles.file, outputDir, request.options, progress);
  if (request.toolId === "video-synthesis") return synthesizeVideo(inputs, outputDir, request.options, progress);
  throw new ToolValidationError("Unsupported tool.");
}

async function chopVideo(input, outputDir, options, progress) {
  const duration = await mediaDuration(input);
  const clipSeconds = options.clipSeconds;
  const overlapSeconds = Math.min(options.overlapSeconds, clipSeconds - 1);
  const plan = planChopSegments(duration, clipSeconds, overlapSeconds);
  const assets = {};
  for (const [index, item] of plan.entries()) {
    const key = `clip${String(index + 1).padStart(2, "0")}`;
    const output = path.join(outputDir, `${key}-${formatRange(item.start)}-${formatRange(item.start + item.length)}.mp4`);
    await progress("processing", 5 + Math.round((index / Math.max(1, plan.length)) * 90), `Cutting clip ${index + 1} of ${plan.length}`);
    await runMedia(ffmpegPath, [
      "-y", "-ss", item.start.toFixed(3), "-i", input, "-t", item.length.toFixed(3),
      "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
    ]);
    assets[key] = await makeAsset(output, "video");
  }
  await progress("finalizing", 98, `Prepared ${plan.length} video clips`);
  return { assets, metadata: { sourceDuration: duration, clipSeconds, overlapSeconds, clipCount: plan.length } };
}

export function planChopSegments(duration, clipSeconds = 180, overlapSeconds = 5) {
  if (![duration, clipSeconds, overlapSeconds].every(Number.isFinite) || duration <= 0 || clipSeconds <= 0 || overlapSeconds < 0 || overlapSeconds >= clipSeconds) {
    throw new ToolValidationError("Chop timing is invalid.");
  }
  const step = clipSeconds - overlapSeconds;
  const plan = [];
  for (let start = 0; start < duration; start += step) {
    const length = Math.min(clipSeconds, duration - start);
    if (length < 0.25) break;
    plan.push({ start, length });
    if (start + length >= duration) break;
  }
  return plan;
}

async function extractAudio(input, outputDir, options, progress) {
  await progress("processing", 20, "Extracting the audio track");
  const extension = options.format;
  const output = path.join(outputDir, `extracted-audio.${extension}`);
  const codec = extension === "wav"
    ? ["-c:a", "pcm_s16le", "-ar", "48000"]
    : ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];
  await runMedia(ffmpegPath, ["-y", "-i", input, "-vn", ...codec, output]);
  await progress("finalizing", 95, "Audio extraction complete");
  return { assets: { audio: await makeAsset(output, "audio") }, metadata: { format: extension, durationSeconds: await mediaDuration(output) } };
}

async function downloadMediaFromLink(outputDir, options, progress) {
  const result = await downloadWebMedia({ ...options, outputDir, progress });
  return { assets: { video: await makeAsset(result.file, "video") }, metadata: result.metadata };
}

async function extractSubtitleTrack(input, outputDir, options, progress) {
  await progress("processing", 15, "Inspecting embedded subtitle tracks");
  const probe = await runMedia(ffprobePath, [
    "-v", "error", "-select_streams", "s",
    "-show_entries", "stream=index,codec_name:stream_tags=language,title",
    "-of", "json", input,
  ]);
  const streams = JSON.parse(probe || "{}").streams ?? [];
  if (!streams.length) {
    throw new Error("This video has no embedded subtitle track. Use Generate subtitle to transcribe its speech with the local model.");
  }
  if (options.trackIndex >= streams.length) throw new Error(`Subtitle track ${options.trackIndex + 1} is not available; this video has ${streams.length}.`);
  const stream = streams[options.trackIndex];
  const output = path.join(outputDir, `embedded-subtitles-${options.trackIndex + 1}.srt`);
  await progress("processing", 48, `Extracting subtitle track ${options.trackIndex + 1} of ${streams.length}`);
  try {
    await runMedia(ffmpegPath, ["-y", "-i", input, "-map", `0:${stream.index}`, "-c:s", "srt", output]);
  } catch {
    throw new Error("This subtitle track is image-based and cannot be converted to text. Use Generate subtitle for local speech recognition.");
  }
  const cues = parseSubtitles(await readFile(output, "utf8"));
  const transcript = path.join(outputDir, "embedded-transcript.txt");
  await writeFile(transcript, cues.map((cue) => cue.text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") + "\n", "utf8");
  await progress("finalizing", 95, "Embedded subtitles are ready");
  return {
    assets: { subtitles: await makeAsset(output, "subtitles"), transcript: await makeAsset(transcript, "text") },
    metadata: {
      trackIndex: options.trackIndex,
      trackCount: streams.length,
      language: stream.tags?.language ?? "unknown",
      title: stream.tags?.title ?? "",
      codec: stream.codec_name ?? "unknown",
      cueCount: cues.length,
      usedSpeechRecognition: false,
    },
  };
}

async function extractCaptionsFromLink(outputDir, options, progress) {
  const result = await downloadWebCaptions({ ...options, outputDir, progress });
  const cues = parseSubtitles(await readFile(result.file, "utf8"));
  const transcriptPath = path.join(outputDir, "web-transcript.txt");
  await writeFile(transcriptPath, cues.map((cue) => cue.text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") + "\n", "utf8");
  return {
    assets: {
      subtitles: await makeAsset(result.file, "subtitles"),
      transcript: await makeAsset(transcriptPath, "text"),
    },
    metadata: { ...result.metadata, cueCount: cues.length },
  };
}

async function transcribe(input, outputDir, options, progress) {
  await progress("processing", 12, "Loading local speech recognition");
  const result = await transcribeMedia({ input, outputDir, language: options.sourceLanguage });
  await progress("finalizing", 88, "Writing transcript and subtitle files");
  const srtPath = path.join(outputDir, "subtitles.srt");
  const transcriptPath = path.join(outputDir, "transcript.txt");
  await writeFile(srtPath, formatSrt(result.cues), "utf8");
  await writeFile(transcriptPath, `${result.text.trim()}\n`, "utf8");
  return {
    assets: { subtitles: await makeAsset(srtPath, "subtitles"), transcript: await makeAsset(transcriptPath, "text") },
    metadata: { language: result.language, languageProbability: result.languageProbability, cueCount: result.cues.length, fallbackWithoutVad: Boolean(result.fallbackWithoutVad) },
  };
}

async function translateSubtitles(input, outputDir, options, progress) {
  if (!textProviderConfig().ready) throw new Error("Subtitle translation requires a Gemini or OpenRouter API key.");
  const cues = parseSubtitles(await readFile(input, "utf8"));
  const translated = [];
  for (let offset = 0; offset < cues.length; offset += 8) {
    const batch = cues.slice(offset, offset + 8).map((cue, index) => ({ id: offset + index, text: cue.text }));
    await progress("processing", 10 + Math.round((offset / Math.max(1, cues.length)) * 75), `Translating cue ${offset + 1} of ${cues.length}`);
    const generated = await generateText({
      system: `Translate every subtitle cue into natural ${options.targetLanguage}. Return exactly one <T id="number">translation</T> block for every input item. Preserve each numeric id and meaning. Do not merge, split, omit, explain, or add content. Do not place angle brackets inside translations.`,
      user: JSON.stringify(batch),
      maxTokens: Math.min(4000, Math.max(1000, JSON.stringify(batch).length * 2)),
      temperature: 0.05,
      thinkingLevel: "low",
    });
    const matches = [...String(generated?.text ?? "").matchAll(/<T\s+id=["']?(\d+)["']?\s*>([\s\S]*?)<\/T>/gi)];
    const byId = new Map(matches.map((match) => [Number(match[1]), match[2].trim()]));
    for (const item of batch) {
      const text = byId.get(item.id);
      if (!text) throw new Error("Translation did not preserve every subtitle cue.");
      translated[item.id] = { ...cues[item.id], text };
    }
  }
  const output = path.join(outputDir, `subtitles-${safeSlug(options.targetLanguage)}.srt`);
  await writeFile(output, formatSrt(translated), "utf8");
  await progress("finalizing", 95, "Translated subtitles are ready");
  return { assets: { subtitles: await makeAsset(output, "subtitles") }, metadata: { targetLanguage: options.targetLanguage, cueCount: translated.length } };
}

async function synthesizeSpeech(input, outputDir, options, progress) {
  const cues = parseSubtitles(await readFile(input, "utf8"));
  const cueDir = path.join(outputDir, "cues");
  await mkdir(cueDir, { recursive: true });
  await progress("processing", 12, `Synthesizing ${options.language} speech`);
  const segments = cues.map((cue) => cue.text.replace(/\s+/g, " ").trim());
  const narrator = narratorProfile(options.narratorId);
  const files = options.ttsEngine === "kokoro"
    ? await synthesizeKokoroCues({ segments, outputDir: cueDir, speed: options.speed * narrator.speedScale, voice: narrator.kokoroVoice })
    : options.ttsEngine === "voxcpm2"
      ? await synthesizeVoxCpmCues({
        segments,
        language: options.language,
        outputDir: cueDir,
        voiceDescription: narrator.voxDescription,
        personaId: narrator.id,
        personaSeed: narrator.voxSeed,
        personaReferenceText: narrator.voxReferenceText,
      })
      : await synthesizeGeminiCues({ segments, language: options.language, outputDir: cueDir, voice: narrator.geminiVoice, delivery: narrator.delivery });
  await progress("processing", 72, "Aligning synthesized speech to subtitle timing");
  const output = path.join(outputDir, `speech-${safeSlug(options.language)}.m4a`);
  const cueDurations = await Promise.all(files.map(mediaDuration));
  const cueSpeeds = cueDurations.map((duration, index) => Math.max(1, duration / Math.max(0.25, cues[index].end - cues[index].start)));
  const filterParts = files.map((_, index) => {
    const speedFilter = cueSpeeds[index] > 1.001 ? `${atempoFilter(cueSpeeds[index])},` : "";
    const slotDuration = Math.max(0.25, cues[index].end - cues[index].start);
    return `[${index}:a]aresample=48000,${speedFilter}atrim=duration=${slotDuration.toFixed(3)},adelay=${Math.round(cues[index].start * 1000)}:all=1[a${index}]`;
  });
  filterParts.push(`${files.map((_, index) => `[a${index}]`).join("")}amix=inputs=${files.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`);
  const duration = Math.max(...cues.map((cue) => cue.end)) + 0.25;
  await runMedia(ffmpegPath, [
    "-y", ...files.flatMap((file) => ["-i", file]),
    "-filter_complex", filterParts.join(";"), "-map", "[aout]", "-t", duration.toFixed(3),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output,
  ]);
  const manifest = path.join(outputDir, "speech-timing.json");
  await writeFile(manifest, `${JSON.stringify({ language: options.language, ttsEngine: options.ttsEngine, narratorId: narrator.id, narrator: narrator.name, cues }, null, 2)}\n`, "utf8");
  return {
    assets: { audio: await makeAsset(output, "audio"), timing: await makeAsset(manifest, "json") },
    metadata: {
      language: options.language,
      ttsEngine: options.ttsEngine,
      narrator: `${narrator.name} — ${narrator.role}`,
      cueCount: cues.length,
      durationSeconds: await mediaDuration(output),
      maxCueSpeed: Number(Math.max(...cueSpeeds).toFixed(4)),
    },
  };
}

async function synthesizeVideo(inputs, outputDir, options, progress) {
  const videoDuration = await mediaDuration(inputs.video.file);
  const audioDuration = await mediaDuration(inputs.audio.file);
  const speed = audioDuration > Math.max(1, videoDuration - 0.15) ? audioDuration / Math.max(1, videoDuration - 0.15) : 1;
  const audioFilter = speed > 1.001
    ? `${atempoFilter(speed)},apad=whole_dur=${videoDuration.toFixed(3)}`
    : `apad=whole_dur=${videoDuration.toFixed(3)}`;
  const output = path.join(outputDir, "synthesized-video.mp4");
  const subtitlePath = inputs.subtitles.file.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
  await progress("processing", 18, "Combining video, translated speech, and subtitles");
  const args = ["-y", "-i", inputs.video.file, "-i", inputs.audio.file];
  const forceStyle = brandSubtitleForceStyle(options.brandKit);
  if (options.burnSubtitles) args.push("-vf", `subtitles='${subtitlePath}'${forceStyle ? `:force_style='${forceStyle}'` : ""}`);
  args.push(
    "-filter:a", audioFilter, "-map", "0:v:0", "-map", "1:a:0", "-t", videoDuration.toFixed(3),
    "-c:v", "libx264", "-preset", "faster", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
  );
  await runMedia(ffmpegPath, args);
  let finalOutput = output;
  if (options.brandKit?.enabled) {
    await progress("branding", 82, "Applying the saved Brand Kit");
    finalOutput = await applyBrandVisuals(output, videoDuration, outputDir, options.brandKit, {
      preserveAudio: true,
      outputName: "branded-synthesized-video.mp4",
    });
    if (options.brandKit.assets?.music?.file) {
      finalOutput = await mixBrandMusic(finalOutput, options.brandKit.assets.music.file, videoDuration, outputDir);
    }
  }
  await progress("finalizing", 96, "Video synthesis complete");
  return {
    assets: { video: await makeAsset(finalOutput, "video") },
    metadata: { durationSeconds: videoDuration, sourceAudioDurationSeconds: audioDuration, audioSpeed: Number(speed.toFixed(4)), burnedSubtitles: options.burnSubtitles, brandKitApplied: Boolean(options.brandKit?.enabled) },
  };
}

async function mixBrandMusic(video, music, duration, outputDir) {
  const output = path.join(outputDir, "brand-kit-synthesized-video.mp4");
  await runMedia(ffmpegPath, [
    "-y", "-i", video, "-stream_loop", "-1", "-i", music,
    "-filter_complex",
    `[0:a]volume=1.0,asplit=2[voice_sc][voice_mix];[1:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.26,afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(0, duration - 0.9).toFixed(3)}:d=0.9[music];[music][voice_sc]sidechaincompress=threshold=0.075:ratio=4:attack=18:release=260:makeup=1[ducked];[voice_mix][ducked]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    "-map", "0:v:0", "-map", "[aout]", "-t", duration.toFixed(3),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
  ]);
  return output;
}

function normalizeOptions(toolId, options) {
  if (toolId === "chop") {
    const clipSeconds = boundedNumber(options.clipSeconds, 10, 180, 180);
    return { clipSeconds, overlapSeconds: boundedNumber(options.overlapSeconds, 0, Math.max(0, clipSeconds - 1), 5) };
  }
  if (toolId === "download-media") {
    try { return { url: normalizeWebMediaUrl(options.url) }; }
    catch (error) { throw new ToolValidationError(error instanceof Error ? error.message : "Enter a valid media link."); }
  }
  if (toolId === "extract-audio") return { format: options.format === "m4a" ? "m4a" : "wav" };
  if (toolId === "extract-subtitles") return { trackIndex: Math.round(boundedNumber(options.trackIndex, 0, 31, 0)) };
  if (toolId === "extract-web-captions") {
    let url;
    try { url = normalizeWebMediaUrl(options.url); }
    catch (error) { throw new ToolValidationError(error instanceof Error ? error.message : "Enter a valid media link."); }
    const language = cleanOption(options.language, 20, "en").toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) throw new ToolValidationError("Caption language must be a code such as en, my, or pt-BR.");
    return { url, language };
  }
  if (toolId === "transcribe") return { sourceLanguage: cleanOption(options.sourceLanguage, 40, "auto") };
  if (toolId === "translate") return { targetLanguage: cleanOption(options.targetLanguage, 40, "English") };
  if (toolId === "speech-synthesis") {
    const language = cleanOption(options.language, 40, "English");
    const fallbackEngine = language.toLowerCase() === "english" ? "kokoro" : "voxcpm2";
    const ttsEngine = ["kokoro", "gemini", "voxcpm2"].includes(options.ttsEngine) ? options.ttsEngine : fallbackEngine;
    if (ttsEngine === "kokoro" && language.toLowerCase() !== "english") throw new ToolValidationError("Kokoro supports English speech only.");
    const narratorId = cleanOption(options.narratorId, 32, DEFAULT_NARRATOR_ID);
    if (!NARRATORS.some((narrator) => narrator.id === narratorId)) throw new ToolValidationError("Choose a supported narrator.");
    return { language, ttsEngine, narratorId, speed: boundedNumber(options.speed, 0.8, 1.4, 1.1) };
  }
  if (toolId === "video-synthesis") return { burnSubtitles: options.burnSubtitles !== false, applyBrandKit: options.applyBrandKit !== false };
  return {};
}

function cleanOption(value, max, fallback) {
  const clean = String(value ?? fallback).trim();
  if (!clean || clean.length > max || /[\u0000-\u001F\u007F]/.test(clean)) throw new ToolValidationError("A tool option is invalid.");
  return clean;
}

function boundedNumber(value, min, max, fallback) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ToolValidationError(`Value must be between ${min} and ${max}.`);
  return number;
}

function safeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "output";
}

function formatRange(value) {
  return String(Math.max(0, Math.round(value))).padStart(3, "0");
}

function atempoFilter(speed) {
  const factors = [];
  let remaining = speed;
  while (remaining > 2) { factors.push(2); remaining /= 2; }
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5; }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`).join(",");
}

async function makeAsset(file, type) {
  return { file, name: path.basename(file), bytes: (await stat(file)).size, type };
}

async function mediaDuration(file) {
  const output = await runMedia(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read the media duration.");
  return duration;
}

function runMedia(command, args) {
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

export class ToolValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ToolValidationError";
    this.status = status;
  }
}
