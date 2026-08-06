import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { registerJobProcess } from "../job-control.mjs";
import { narratorProfile } from "../narrators.mjs";
import {
  applyBrandVisuals,
  buildSrtFromCues,
  createBrandMusic,
  createCuratedMusic,
  createNarration,
  createPlatformCopy,
  fitNarration,
  segmentText,
  translateSegments,
} from "../pipeline.mjs";
import { transcribeMedia } from "../stt-client.mjs";
import { formatSrt, parseSubtitles } from "./subtitles.mjs";

export const DEFAULT_GEMINI_HIGHLIGHT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_LONG_VIDEO_TITLE_CARD_SECONDS = 1.5;

const ffprobePath = ffprobe.path;

export async function analyzeLongVideo({ mediaFile, subtitleFile, outputDir, options, progress }) {
  await mkdir(outputDir, { recursive: true });
  const duration = await mediaDuration(mediaFile);
  await progress("captions", 8, "Checking the source for existing captions");
  let transcript;
  let transcriptSource;
  if (subtitleFile) {
    transcript = transcriptFromCues(parseSubtitles(await readFile(subtitleFile, "utf8")), options.sourceLanguage);
    transcriptSource = "provided-captions";
  } else {
    const embedded = await extractEmbeddedCaptions(mediaFile, outputDir).catch(() => null);
    if (embedded) {
      transcript = transcriptFromCues(parseSubtitles(await readFile(embedded, "utf8")), options.sourceLanguage);
      transcriptSource = "embedded-captions";
    } else {
      await progress("transcribing", 18, "Creating a timed transcript with Gemini Flash-Lite");
      transcript = await transcribeMedia({ input: mediaFile, outputDir: path.join(outputDir, "transcription"), language: options.sourceLanguage });
      transcriptSource = transcript.provider === "gemini" ? "gemini-transcription" : "faster-whisper";
    }
  }
  const cues = normalizeCues(transcript.cues, duration);
  await progress("analysis", 48, `Finding ${options.maxClips} coherent short-video moments`);
  const rawCandidates = await selectHighlightCandidates({
    cues,
    duration,
    maxClips: options.maxClips,
    minClipSeconds: options.minClipSeconds,
    maxClipSeconds: options.maxClipSeconds,
  });
  const candidates = normalizeHighlightCandidates(rawCandidates, cues, {
    duration,
    maxClips: options.maxClips,
    minClipSeconds: options.minClipSeconds,
    maxClipSeconds: options.maxClipSeconds,
  });
  if (!candidates.length) throw new Error("Gemini could not identify a complete short-video moment. Try a longer source or a different language selection.");

  await progress("finalizing", 88, "Saving the transcript and highlight review");
  const srtPath = path.join(outputDir, "source-subtitles.srt");
  const transcriptPath = path.join(outputDir, "source-transcript.txt");
  const analysisPath = path.join(outputDir, "highlight-analysis.json");
  await writeFile(srtPath, formatSrt(cues), "utf8");
  await writeFile(transcriptPath, `${cues.map((cue) => cue.text).join(" ")}\n`, "utf8");
  const analysis = {
    version: 1,
    duration,
    language: transcript.language || options.sourceLanguage || "auto",
    transcriptSource,
    transcriptProvider: transcript.provider || transcriptSource,
    transcriptModel: transcript.model || null,
    highlightModel: process.env.GEMINI_HIGHLIGHT_MODEL || DEFAULT_GEMINI_HIGHLIGHT_MODEL,
    cues,
    candidates,
    createdAt: new Date().toISOString(),
  };
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  return {
    assets: {
      analysis: await makeAsset(analysisPath, "analysis"),
      subtitles: await makeAsset(srtPath, "subtitles"),
      transcript: await makeAsset(transcriptPath, "text"),
    },
    metadata: {
      duration,
      language: analysis.language,
      transcriptSource,
      transcriptProvider: analysis.transcriptProvider,
      transcriptModel: analysis.transcriptModel,
      highlightModel: analysis.highlightModel,
      candidateCount: candidates.length,
      candidates,
    },
  };
}

export async function renderLongVideoShorts({ mediaFile, analysisFile, outputDir, options, progress }) {
  await mkdir(outputDir, { recursive: true });
  const analysis = JSON.parse(await readFile(analysisFile, "utf8"));
  if (!Array.isArray(analysis.cues) || !Array.isArray(analysis.candidates)) throw new Error("The selected highlight analysis is invalid.");
  const sourceDuration = await mediaDuration(mediaFile);
  const edits = options.candidates?.length ? options.candidates : analysis.candidates.map((candidate) => ({
    id: candidate.id,
    selected: true,
    start: candidate.start,
    end: candidate.end,
    title: candidate.title,
    hook: candidate.hook,
    framing: "center",
  }));
  const selected = edits.filter((candidate) => candidate.selected !== false).slice(0, 10);
  if (!selected.length) throw new Error("Select at least one highlight to render.");
  const assets = {};
  const rendered = [];
  for (const [index, edit] of selected.entries()) {
    const original = analysis.candidates.find((candidate) => candidate.id === edit.id) ?? edit;
    const candidate = validateRenderCandidate({ ...original, ...edit }, sourceDuration);
    const duration = candidate.end - candidate.start;
    const titleCardSeconds = longVideoTitleCardSeconds();
    const outputDuration = duration + titleCardSeconds;
    const key = `short${String(index + 1).padStart(2, "0")}`;
    await progress("rendering", 6 + Math.round((index / selected.length) * 84), `Rendering short ${index + 1} of ${selected.length}`);
    const shiftedCues = analysis.cues
      .filter((cue) => Number(cue.end) > candidate.start && Number(cue.start) < candidate.end)
      .map((cue) => ({
        start: Math.max(0, Number(cue.start) - candidate.start),
        end: Math.min(duration, Number(cue.end) - candidate.start),
        text: String(cue.text),
      }))
      .filter((cue) => cue.end > cue.start && cue.text.trim());
    if (options.packageTreatment) {
      await progress("voice", 10 + Math.round((index / selected.length) * 82), `Producing narration and publishing package ${index + 1} of ${selected.length}`);
      const packaged = await renderPublishableShort({
        mediaFile,
        outputDir,
        key,
        candidate,
        shiftedCues,
        duration,
        sourceLanguage: analysis.language || "auto",
        options,
      });
      Object.assign(assets, packaged.assets);
      rendered.push({
        ...candidate,
        assetKey: key,
        thumbnailAssetKey: `${key}Thumbnail`,
        sourceDuration: duration,
        duration: packaged.metadata.durationSeconds,
        titleCardSeconds,
        packageAssetKeys: packaged.packageAssetKeys,
        packageRequest: packaged.request,
        packageMetadata: packaged.metadata,
      });
    } else {
      const assPath = path.join(outputDir, `${key}-captions.ass`);
      await writeFile(assPath, buildShortAss({
        cues: shiftedCues,
        duration,
        hook: candidate.hook,
        brand: options.brandKit,
        includeCaptions: options.captions,
      }), "utf8");
      const outputName = `${key}-${safeFilePart(candidate.title)}.mp4`;
      const basePath = path.join(outputDir, options.applyBrandKit ? `${key}-base.mp4` : outputName);
      await renderVerticalClip({
        input: mediaFile,
        output: basePath,
        assPath,
        start: candidate.start,
        duration,
        framing: candidate.framing,
        mirror: options.mirror,
        transitions: options.transitions,
      });
      let outputPath = options.applyBrandKit
        ? await applyBrandVisuals(basePath, duration, outputDir, options.brandKit, {
          preserveAudio: true,
          outputName,
        })
        : basePath;
      if (outputPath === basePath && path.basename(basePath) !== outputName) {
        outputPath = path.join(outputDir, outputName);
        await rename(basePath, outputPath);
      }
      const thumbnailKey = `${key}Thumbnail`;
      const thumbnailPath = path.join(outputDir, `${key}-${safeFilePart(candidate.title)}-thumbnail.jpg`);
      await createShortThumbnail({
        videoFile: outputPath,
        outputFile: thumbnailPath,
        title: candidate.title,
        hook: candidate.hook,
        brand: options.brandKit,
        duration,
      });
      assets[thumbnailKey] = await makeAsset(thumbnailPath, "image");
      const titledPath = path.join(outputDir, `${key}-with-title-card.mp4`);
      await prependTitleCard({
        videoFile: outputPath,
        thumbnailPath,
        outputFile: titledPath,
        contentDuration: duration,
        titleCardSeconds,
      });
      await rm(outputPath, { force: true });
      await rename(titledPath, outputPath);
      assets[key] = await makeAsset(outputPath, "video", outputName);
      rendered.push({ ...candidate, assetKey: key, thumbnailAssetKey: thumbnailKey, sourceDuration: duration, duration: outputDuration, titleCardSeconds });
    }
  }
  const manifestPath = path.join(outputDir, "shorts-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    sourceDuration,
    captions: options.captions,
    packageTreatment: options.packageTreatment,
    mirror: options.mirror,
    transitions: options.transitions,
    clips: rendered,
  }, null, 2)}\n`, "utf8");
  assets.manifest = await makeAsset(manifestPath, "analysis");
  await progress("finalizing", 96, `Prepared ${rendered.length} reviewed short${rendered.length === 1 ? "" : "s"}`);
  return {
    assets,
    metadata: {
      clipCount: rendered.length,
      clips: rendered,
      captions: options.captions,
      packageTreatment: options.packageTreatment,
      speechLanguage: options.speechLanguage,
      subtitleLanguage: options.subtitleLanguage,
      narratorId: options.narratorId,
      ttsEngine: options.ttsEngine,
      platforms: options.platforms,
      mirror: options.mirror,
      transitions: options.transitions,
      branded: Boolean(options.applyBrandKit && options.brandKit?.enabled),
    },
  };
}

async function renderPublishableShort({ mediaFile, outputDir, key, candidate, shiftedCues, duration, sourceLanguage, options }) {
  const packageDir = path.join(outputDir, key);
  await mkdir(packageDir, { recursive: true });
  const titleCardSeconds = longVideoTitleCardSeconds();
  const outputDuration = duration + titleCardSeconds;
  const reviewedScript = cleanGeneratedText(
    candidate.transcript || shiftedCues.map((cue) => cue.text).join(" "),
    shiftedCues.map((cue) => cue.text).join(" "),
    20_000,
  );
  const sourceSegments = segmentText(reviewedScript, sourceLanguage);
  if (!sourceSegments.length) throw new Error(`The reviewed narration script for "${candidate.title}" is empty.`);

  const speechSegments = sameLanguage(sourceLanguage, options.speechLanguage) || likelyMatchesLanguage(reviewedScript, options.speechLanguage)
    ? sourceSegments
    : await translateSegments(sourceSegments, sourceLanguage, options.speechLanguage, "spoken narration transcript");
  const captionSegments = sameLanguage(options.subtitleLanguage, options.speechLanguage)
    ? speechSegments
    : sameLanguage(options.subtitleLanguage, sourceLanguage)
      ? sourceSegments
      : await translateSegments(sourceSegments, sourceLanguage, options.subtitleLanguage, "on-screen subtitles");

  const narrator = narratorProfile(options.narratorId);
  const narration = await createNarration(
    speechSegments,
    options.speechLanguage,
    options.ttsEngine,
    packageDir,
    {},
    [],
    narrator,
  );
  const fitted = await fitNarration(narration, duration, packageDir, options.speechLanguage);
  const fittedNarration = fitted.duration > duration - 0.08
    ? await compressNarrationToDuration(fitted, Math.max(1, duration - 0.12), packageDir)
    : fitted;
  const captionCues = fittedNarration.cues.map((cue, index) => ({
    start: Math.max(0, Number(cue.start)),
    end: Math.min(duration, Number(cue.end)),
    text: String(captionSegments[index] ?? ""),
  })).filter((cue) => cue.end > cue.start && cue.text.trim());

  const masterScriptPath = path.join(packageDir, "master-script.txt");
  const transcriptPath = path.join(packageDir, "transcript.txt");
  const captionsPath = path.join(packageDir, "captions.srt");
  const styledCaptionsPath = path.join(packageDir, "captions.ass");
  await writeFile(masterScriptPath, `${reviewedScript}\n`, "utf8");
  await writeFile(transcriptPath, `${speechSegments.join(" ").trim()}\n`, "utf8");
  const publishedCaptionCues = fittedNarration.cues.map((cue) => ({
    start: Number(cue.start) + titleCardSeconds,
    end: Number(cue.end) + titleCardSeconds,
  }));
  await writeFile(captionsPath, buildSrtFromCues(captionSegments, publishedCaptionCues, outputDuration), "utf8");
  await writeFile(styledCaptionsPath, buildShortAss({
    cues: captionCues,
    duration,
    hook: candidate.hook,
    brand: options.brandKit,
    includeCaptions: options.captions,
  }), "utf8");

  const request = {
    prompt: candidate.description || (candidate.hook ? `${candidate.title}: ${candidate.hook}` : candidate.title),
    editorialTitle: candidate.title,
    editorialDescription: candidate.description || summarizeHighlight(reviewedScript),
    sourceLanguage,
    category: options.category,
    duration: `${Math.round(outputDuration)} sec`,
    language: options.speechLanguage,
    ttsEngine: options.ttsEngine,
    subtitleLanguage: options.subtitleLanguage,
    platforms: options.platforms,
    narratorId: options.narratorId,
    approvedScript: reviewedScript,
  };
  const publishingCopyProvenance = {};
  const platformCopy = await createPlatformCopy(
    request,
    reviewedScript,
    publishingCopyProvenance,
    speechSegments.join(" "),
  );
  const editorialCopy = publishingCopyProvenance.editorial ?? {
    title: candidate.title,
    description: candidate.description || summarizeHighlight(reviewedScript),
  };

  const cleanSourcePath = path.join(packageDir, "clean-source.mp4");
  await renderVerticalClip({
    input: mediaFile,
    output: cleanSourcePath,
    assPath: null,
    start: candidate.start,
    duration,
    framing: candidate.framing,
    mirror: options.mirror,
    transitions: options.transitions,
  });
  let cleanPath = options.applyBrandKit
    ? await applyBrandVisuals(cleanSourcePath, duration, packageDir, options.brandKit, {
      preserveAudio: true,
      outputName: "clean.mp4",
    })
    : cleanSourcePath;
  if (cleanPath === cleanSourcePath) {
    const normalizedCleanPath = path.join(packageDir, "clean.mp4");
    await rename(cleanSourcePath, normalizedCleanPath);
    cleanPath = normalizedCleanPath;
  }

  const thumbnailPath = path.join(packageDir, "thumbnail.jpg");
  await createShortThumbnail({
    videoFile: cleanPath,
    outputFile: thumbnailPath,
    title: editorialCopy.title,
    hook: candidate.hook,
    brand: options.brandKit,
    duration,
  });
  const music = options.brandKit?.enabled && options.brandKit.assets?.music?.file
    ? await createBrandMusic(options.brandKit.assets.music.file, outputDuration, packageDir)
    : await createCuratedMusic(outputDuration, options.category, packageDir);
  const finalPath = path.join(packageDir, `${key}-${safeFilePart(candidate.title)}.mp4`);
  await assembleNarratedShort({
    cleanPath,
    voicePath: fittedNarration.path,
    musicPath: music.path,
    thumbnailPath,
    captionsPath: styledCaptionsPath,
    outputPath: finalPath,
    duration,
    titleCardSeconds,
    includeCaptions: options.captions,
    mixOriginalAudio: options.mixOriginalAudio,
  });

  const publishingCopyPath = path.join(packageDir, "publishing-copy.json");
  await writeFile(publishingCopyPath, `${JSON.stringify(platformCopy, null, 2)}\n`, "utf8");
  const metadata = {
    title: editorialCopy.title,
    description: editorialCopy.description,
    tags: shortTags(`${editorialCopy.title} ${candidate.title} ${candidate.description} ${reviewedScript}`),
    durationSeconds: Number(outputDuration.toFixed(2)),
    resolution: `${positiveEvenInteger(process.env.REELIO_SHORT_WIDTH, 1080)}x${positiveEvenInteger(process.env.REELIO_SHORT_HEIGHT, 1920)}`,
    frameRate: 30,
    narrationLanguage: options.speechLanguage,
    subtitleLanguage: options.subtitleLanguage,
    voiceProvider: fittedNarration.providerLabel,
    narrator: `${narrator.name} — ${narrator.role}`,
    narratorTone: `${narrator.voice} · ${narrator.tone} · ${narrator.pace}`,
    visualSource: "Reviewed excerpt from a licensed long-video source",
    creationMode: "long-video-shorts",
    titleCardSeconds,
    thumbnailTitle: editorialCopy.title,
    sourceStartSeconds: candidate.start,
    sourceEndSeconds: candidate.end,
    sourceLanguage,
    originalAudioMix: options.mixOriginalAudio ? "Low source ambience under narrator" : "Narrator and music only",
    publishingCopySource: {
      mode: publishingCopyProvenance.mode ?? "unknown",
      provider: publishingCopyProvenance.provider ?? null,
      model: publishingCopyProvenance.model ?? null,
      error: publishingCopyProvenance.error ?? null,
      bilingual: Boolean(publishingCopyProvenance.bilingual),
      sourceLanguage: publishingCopyProvenance.sourceLanguage ?? sourceLanguage,
      localizedLanguage: publishingCopyProvenance.localizedLanguage ?? options.speechLanguage,
    },
    platformCopy,
    retentionPreflight: {
      score: Math.max(1, Math.min(100, Math.round(Number(candidate.score) || 70))),
      hookWithinSeconds: titleCardSeconds,
      averageVisualChangeSeconds: Number(duration.toFixed(2)),
      highContrastCaptions: Boolean(options.captions),
      noIntroBeforeHook: false,
    },
  };
  const metadataPath = path.join(packageDir, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const packageAssetKeys = {
    final: key,
    clean: `${key}Clean`,
    thumbnail: `${key}Thumbnail`,
    voice: `${key}Voice`,
    music: `${key}Music`,
    masterScript: `${key}MasterScript`,
    transcript: `${key}Transcript`,
    captions: `${key}Captions`,
    styledCaptions: `${key}StyledCaptions`,
    metadata: `${key}Metadata`,
    publishingCopy: `${key}PublishingCopy`,
  };
  return {
    request,
    metadata,
    packageAssetKeys,
    assets: {
      [packageAssetKeys.final]: await makeAsset(finalPath, "video"),
      [packageAssetKeys.clean]: await makeAsset(cleanPath, "video"),
      [packageAssetKeys.thumbnail]: await makeAsset(thumbnailPath, "image"),
      [packageAssetKeys.voice]: await makeAsset(fittedNarration.path, "audio"),
      [packageAssetKeys.music]: await makeAsset(music.path, "audio"),
      [packageAssetKeys.masterScript]: await makeAsset(masterScriptPath, "text"),
      [packageAssetKeys.transcript]: await makeAsset(transcriptPath, "text"),
      [packageAssetKeys.captions]: await makeAsset(captionsPath, "subtitles"),
      [packageAssetKeys.styledCaptions]: await makeAsset(styledCaptionsPath, "subtitles"),
      [packageAssetKeys.metadata]: await makeAsset(metadataPath, "json"),
      [packageAssetKeys.publishingCopy]: await makeAsset(publishingCopyPath, "json"),
    },
  };
}

export async function assembleNarratedShort({
  cleanPath,
  voicePath,
  musicPath,
  thumbnailPath,
  captionsPath,
  outputPath,
  duration,
  titleCardSeconds,
  includeCaptions,
  mixOriginalAudio,
}) {
  const hasSourceAudio = mixOriginalAudio && await mediaHasAudio(cleanPath);
  const escapedCaptions = escapeFilterPath(captionsPath);
  const width = positiveEvenInteger(process.env.REELIO_SHORT_WIDTH, 1080);
  const height = positiveEvenInteger(process.env.REELIO_SHORT_HEIGHT, 1920);
  const outputDuration = duration + titleCardSeconds;
  const delayMilliseconds = Math.round(titleCardSeconds * 1000);
  const titleCardGraph = `[3:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p,loop=loop=-1:size=1:start=0,trim=duration=${titleCardSeconds.toFixed(3)},fps=30,setpts=PTS-STARTPTS[title]`;
  const videoGraph = includeCaptions
    ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},ass='${escapedCaptions}',fps=30,setsar=1,setpts=PTS-STARTPTS[capped];${titleCardGraph};[title][capped]concat=n=2:v=1:a=0[vout]`
    : `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,setpts=PTS-STARTPTS[capped];${titleCardGraph};[title][capped]concat=n=2:v=1:a=0[vout]`;
  const sourceAudio = hasSourceAudio
    ? `[0:a]adelay=${delayMilliseconds}:all=1,apad=whole_dur=${outputDuration.toFixed(3)},volume=0.13[source];`
    : "";
  const finalMix = hasSourceAudio
    ? `[voice_mix][source][ducked]amix=inputs=3:duration=longest:weights='1 1 1':normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,atrim=0:${outputDuration.toFixed(3)}[aout]`
    : `[voice_mix][ducked]amix=inputs=2:duration=longest:weights='1 1':normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,atrim=0:${outputDuration.toFixed(3)}[aout]`;
  const audioGraph = `${sourceAudio}[1:a]adelay=${delayMilliseconds}:all=1,apad=whole_dur=${outputDuration.toFixed(3)},volume=1.0,asplit=2[voice_sc][voice_mix];[2:a]atrim=0:${outputDuration.toFixed(3)},apad=whole_dur=${outputDuration.toFixed(3)},volume=0.30[music];[music][voice_sc]sidechaincompress=threshold=0.075:ratio=4:attack=18:release=260:makeup=1[ducked];${finalMix}`;
  await runProcess(ffmpegPath, [
    "-y", "-i", cleanPath, "-i", voicePath, "-i", musicPath, "-i", thumbnailPath,
    "-filter_complex", `${videoGraph};${audioGraph}`,
    "-map", "[vout]", "-map", "[aout]", "-t", outputDuration.toFixed(3),
    "-c:v", "libx264", "-preset", "faster", "-crf", "23", "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath,
  ], Number(process.env.REELIO_PROCESS_TIMEOUT_MS || 900_000), "Publishable short assembly");
}

async function compressNarrationToDuration(narration, targetDuration, outputDir) {
  const speed = narration.duration / Math.max(0.5, targetDuration);
  const output = path.join(outputDir, "voice-fitted.m4a");
  await runProcess(ffmpegPath, [
    "-y", "-i", narration.path, "-filter:a", atempoFilter(speed),
    "-t", targetDuration.toFixed(3), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output,
  ], Number(process.env.REELIO_PROCESS_TIMEOUT_MS || 900_000), "Narration timing");
  const finalDuration = await mediaDuration(output);
  const scale = finalDuration / narration.duration;
  return {
    ...narration,
    path: output,
    duration: finalDuration,
    cues: narration.cues.map((cue) => ({ start: cue.start * scale, end: cue.end * scale })),
  };
}

async function mediaHasAudio(file) {
  const output = await runProcess(ffprobePath, [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", file,
  ], 60_000, "Audio inspection");
  return Boolean(output.trim());
}

export async function ensureLongVideoShortThumbnails(job) {
  if (!job || job.request?.toolId !== "long-video-render" || job.state !== "completed") {
    throw new Error("Choose a completed Long Video to Shorts render.");
  }
  const assets = { ...(job.assets ?? {}) };
  const clips = Array.isArray(job.metadata?.clips) ? job.metadata.clips.map((clip) => ({ ...clip })) : [];
  let changed = false;
  for (const [index, clip] of clips.entries()) {
    const assetKey = String(clip.assetKey || `short${String(index + 1).padStart(2, "0")}`);
    const video = assets[assetKey];
    if (!video?.file) continue;
    const thumbnailAssetKey = String(clip.thumbnailAssetKey || `${assetKey}Thumbnail`);
    if (assets[thumbnailAssetKey]?.file) continue;
    const thumbnailPath = path.join(path.dirname(video.file), `${assetKey}-${safeFilePart(clip.title)}-thumbnail.jpg`);
    await createShortThumbnail({
      videoFile: video.file,
      outputFile: thumbnailPath,
      title: clip.title,
      hook: clip.hook,
      brand: job.request?.options?.brandKit,
      duration: clip.duration,
    });
    assets[thumbnailAssetKey] = await makeAsset(thumbnailPath, "image");
    clip.thumbnailAssetKey = thumbnailAssetKey;
    changed = true;
  }
  return {
    changed,
    assets,
    metadata: { ...(job.metadata ?? {}), clips },
  };
}

export function longVideoTitleCardSeconds(value = process.env.REELIO_SHORT_TITLE_CARD_SECONDS) {
  const parsed = Number(value ?? DEFAULT_LONG_VIDEO_TITLE_CARD_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_LONG_VIDEO_TITLE_CARD_SECONDS;
  return Math.max(1, Math.min(2, parsed));
}

export async function prependTitleCard({ videoFile, thumbnailPath, outputFile, contentDuration, titleCardSeconds = longVideoTitleCardSeconds() }) {
  const width = positiveEvenInteger(process.env.REELIO_SHORT_WIDTH, 1080);
  const height = positiveEvenInteger(process.env.REELIO_SHORT_HEIGHT, 1920);
  const intro = longVideoTitleCardSeconds(titleCardSeconds);
  const content = Math.max(0.1, Number(contentDuration));
  const total = content + intro;
  const hasAudio = await mediaHasAudio(videoFile);
  const delayMilliseconds = Math.round(intro * 1000);
  const videoGraph = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30,trim=duration=${intro.toFixed(3)},setpts=PTS-STARTPTS[title]`,
    `[1:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30,trim=duration=${content.toFixed(3)},setpts=PTS-STARTPTS[content]`,
    `[title][content]concat=n=2:v=1:a=0[vout]`,
  ].join(";");
  const audioGraph = hasAudio
    ? `;[1:a]adelay=${delayMilliseconds}:all=1,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[aout]`
    : "";
  const args = [
    "-y", "-loop", "1", "-framerate", "30", "-t", intro.toFixed(3), "-i", thumbnailPath,
    "-i", videoFile,
    "-filter_complex", `${videoGraph}${audioGraph}`,
    "-map", "[vout]",
  ];
  if (hasAudio) args.push("-map", "[aout]");
  args.push(
    "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "faster", "-crf", "22", "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p",
  );
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000");
  args.push("-movflags", "+faststart", outputFile);
  await runProcess(ffmpegPath, args, Number(process.env.REELIO_PROCESS_TIMEOUT_MS || 900_000), "Short title-card intro");
  return { file: outputFile, duration: total, titleCardSeconds: intro };
}

export async function createShortThumbnail({ videoFile, outputFile, title, hook, brand, duration }) {
  const assPath = outputFile.replace(/\.jpe?g$/i, ".ass");
  await writeFile(assPath, buildShortThumbnailAss({ title, hook, brand }), "utf8");
  await runProcess(ffmpegPath, [
    "-y",
    "-ss", Math.min(1.4, Math.max(0, Number(duration || 0) / 5)).toFixed(3),
    "-i", videoFile,
    "-frames:v", "1",
    "-vf", `subtitles='${escapeFilterPath(assPath)}'`,
    "-q:v", "2",
    outputFile,
  ], 120_000, "Short thumbnail generation");
  return outputFile;
}

export function buildShortThumbnailAss({ title, hook, brand }) {
  const font = String(brand?.fontFamily || "Arial").replace(/,/g, " ");
  const accent = assColor(brand?.accentColor || "#7c5cff");
  const cleanTitle = cleanGeneratedText(title, "Video highlight", 90);
  const cleanHook = cleanGeneratedText(hook, "", 120);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Kicker,${font},30,${accent},${accent},&H0015111B,&H00000000,-1,0,0,0,100,100,4,0,1,5,0,8,80,80,520,1
Style: Title,${font},84,&H00FFFFFF,&H00FFFFFF,&H0015111B,&H780A0810,-1,0,0,0,100,100,0,0,3,6,0,8,82,82,570,1
Style: Hook,${font},42,&H00FFFFFF,&H00FFFFFF,&H0015111B,&H00000000,-1,0,0,0,100,100,0,0,1,5,0,8,100,100,930,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 2,0:00:00.00,0:00:10.00,Kicker,,0,0,0,,REELIO HIGHLIGHT
Dialogue: 2,0:00:00.00,0:00:10.00,Title,,0,0,0,,${escapeAss(wrapText(cleanTitle, 22))}
${cleanHook ? `Dialogue: 2,0:00:00.00,0:00:10.00,Hook,,0,0,0,,${escapeAss(wrapText(cleanHook, 32))}` : ""}
`;
}

export function normalizeHighlightCandidates(rawCandidates, cues, config) {
  const duration = Number(config.duration);
  const minimum = Number(config.minClipSeconds);
  const maximum = Number(config.maxClipSeconds);
  const normalized = [];
  for (const [index, raw] of (Array.isArray(rawCandidates) ? rawCandidates : []).entries()) {
    let start = Number(raw?.start);
    let end = Number(raw?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    start = Math.max(0, Math.min(duration - 1, start));
    end = Math.max(start + 1, Math.min(duration, end));
    const firstCue = cues.find((cue) => cue.end > start);
    const lastCue = [...cues].reverse().find((cue) => cue.start < end);
    if (firstCue) start = firstCue.start;
    if (lastCue) end = lastCue.end;
    if (end - start < minimum) {
      end = Math.min(duration, start + minimum);
      const extended = [...cues].reverse().find((cue) => cue.start < end);
      if (extended) end = Math.min(duration, extended.end);
    }
    if (end - start > maximum) {
      end = start + maximum;
      const bounded = [...cues].reverse().find((cue) => cue.start < end);
      if (bounded) end = Math.min(end, bounded.end);
    }
    if (end - start < Math.min(8, minimum)) continue;
    const transcript = cues.filter((cue) => cue.end > start && cue.start < end).map((cue) => cue.text).join(" ").trim();
    if (!transcript) continue;
    const candidate = {
      id: `highlight-${String(index + 1).padStart(2, "0")}`,
      title: cleanGeneratedText(raw?.title, `Highlight ${index + 1}`, 80),
      hook: cleanGeneratedText(raw?.hook, transcript.split(/[.!?]/)[0], 120),
      description: cleanGeneratedText(raw?.description, summarizeHighlight(transcript), 520),
      start: roundTime(start),
      end: roundTime(end),
      duration: roundTime(end - start),
      score: Math.max(1, Math.min(100, Math.round(Number(raw?.score) || 70))),
      reason: cleanGeneratedText(raw?.reason, "A coherent moment with a clear opening and payoff.", 220),
      transcript,
    };
    const overlaps = normalized.some((existing) => overlapRatio(existing, candidate) > 0.68);
    if (!overlaps) normalized.push(candidate);
  }
  return normalized.sort((a, b) => b.score - a.score).slice(0, config.maxClips);
}

export function validateLongVideoAnalyzeOptions(value = {}) {
  if (value.rightsConfirmed !== true) throw new Error("Confirm that you own or are licensed to edit and publish this source.");
  if (value.cloudConsent !== true) throw new Error("Confirm that the transcript may be sent to Gemini for highlight analysis.");
  const minClipSeconds = boundedNumber(value.minClipSeconds, 15, 60, 25);
  const maxClipSeconds = boundedNumber(value.maxClipSeconds, Math.max(30, minClipSeconds), 120, 60);
  return {
    rightsConfirmed: true,
    cloudConsent: true,
    sourceLanguage: cleanOption(value.sourceLanguage, 40, "auto"),
    maxClips: Math.round(boundedNumber(value.maxClips, 1, 10, 5)),
    minClipSeconds,
    maxClipSeconds,
    workflowId: cleanOption(value.workflowId, 80, ""),
  };
}

export function validateLongVideoRenderOptions(value = {}) {
  if (value.rightsConfirmed !== true) throw new Error("Confirm that you own or are licensed to edit and publish this source.");
  const mirror = value.mirror === true;
  const transitions = value.transitions === true;
  if ((mirror || transitions) && value.remixConfirmed !== true) {
    throw new Error("Confirm the optional creative remix edits before rendering.");
  }
  const candidates = Array.isArray(value.candidates) ? value.candidates.slice(0, 10).map((candidate, index) => {
    const start = Number(candidate?.start);
    const end = Number(candidate?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 120) {
      throw new Error(`Highlight ${index + 1} has invalid in/out points.`);
    }
    return {
      id: cleanOption(candidate.id, 80, `highlight-${index + 1}`),
      selected: candidate.selected !== false,
      start: roundTime(start),
      end: roundTime(end),
      title: cleanOption(candidate.title, 80, `Highlight ${index + 1}`),
      hook: cleanOption(candidate.hook, 120, ""),
      description: cleanOption(candidate.description, 520, ""),
      transcript: cleanOption(candidate.transcript, 20_000, ""),
      framing: ["left", "center", "right", "fit"].includes(candidate.framing) ? candidate.framing : "center",
    };
  }) : [];
  const speechLanguage = cleanOption(value.speechLanguage, 40, "English");
  const subtitleLanguage = cleanOption(value.subtitleLanguage, 40, speechLanguage);
  const fallbackEngine = speechLanguage.toLowerCase() === "english" ? "kokoro" : "voxcpm2";
  const ttsEngine = ["kokoro", "gemini", "voxcpm2"].includes(value.ttsEngine) ? value.ttsEngine : fallbackEngine;
  if (ttsEngine === "kokoro" && speechLanguage.toLowerCase() !== "english") {
    throw new Error("Kokoro supports English speech only.");
  }
  const narratorId = ["maya", "theo", "nova", "ellis"].includes(value.narratorId) ? value.narratorId : "maya";
  const platforms = Array.isArray(value.platforms)
    ? [...new Set(value.platforms.map((platform) => String(platform).toLowerCase()).filter((platform) => ["youtube", "tiktok", "facebook", "instagram"].includes(platform)))]
    : ["youtube", "tiktok", "facebook", "instagram"];
  return {
    rightsConfirmed: true,
    cloudConsent: value.cloudConsent === true,
    remixConfirmed: value.remixConfirmed === true,
    candidates,
    captions: value.captions !== false,
    packageTreatment: value.packageTreatment !== false,
    speechLanguage,
    subtitleLanguage,
    ttsEngine,
    narratorId,
    platforms,
    category: cleanOption(value.category, 80, "Source recap"),
    mixOriginalAudio: value.mixOriginalAudio !== false,
    mirror,
    transitions,
    applyBrandKit: value.applyBrandKit !== false,
    workflowId: cleanOption(value.workflowId, 80, ""),
  };
}

async function selectHighlightCandidates({ cues, duration, maxClips, minClipSeconds, maxClipSeconds }) {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("Add a Gemini API key in Settings before analyzing a long video.");
  const client = new GoogleGenAI({ apiKey: key });
  const transcript = cues.map((cue) => `[${cue.start.toFixed(2)}-${cue.end.toFixed(2)}] ${cue.text}`).join("\n");
  const model = process.env.GEMINI_HIGHLIGHT_MODEL || DEFAULT_GEMINI_HIGHLIGHT_MODEL;
  const response = await withTimeout(client.models.generateContent({
    model,
    contents: [
      `Select up to ${maxClips} self-contained short-video moments from this timestamped transcript.`,
      `Each moment must be ${minClipSeconds}-${maxClipSeconds} seconds, open with understandable context, preserve the speaker's meaning, and end with a payoff rather than cutting mid-thought.`,
      "Prioritize surprising claims, useful explanations, emotional turns, strong stories, concrete examples, and quotable conclusions.",
      "Do not fabricate dialogue, combine distant passages, remove essential caveats, or choose sponsor reads and housekeeping.",
      "Return precise source seconds, a concise editorial title, an on-screen hook faithful to the source, an original full-video description, a 1-100 score, and a short selection reason.",
      "Write a fresh 3-8 word thumbnail title for each short. Do not copy the source-video title, channel name, filename, or a full transcript sentence. Make the title specific to that selected moment without inventing facts.",
      "Write DESCRIPTION as 2-3 natural sentences summarizing the selected moment's complete subject, development, and payoff. It must not copy the first transcript line, merely repeat HOOK, mention timestamps, or discuss how the clip was made.",
      transcript.slice(0, 500_000),
    ].join("\n\n"),
    config: {
      maxOutputTokens: 8_192,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        required: ["candidates"],
        properties: {
          candidates: {
            type: "array",
            maxItems: maxClips * 2,
            items: {
              type: "object",
              required: ["title", "hook", "description", "start", "end", "score", "reason"],
              properties: {
                title: { type: "string" },
                hook: { type: "string" },
                description: { type: "string" },
                start: { type: "number", minimum: 0, maximum: duration },
                end: { type: "number", minimum: 0, maximum: duration },
                score: { type: "number", minimum: 1, maximum: 100 },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  }), Number(process.env.GEMINI_HIGHLIGHT_TIMEOUT_MS || 180_000), "Gemini highlight analysis");
  const parsed = parseJson(response.text, "Gemini returned highlight data that could not be read.");
  return parsed.candidates;
}

async function extractEmbeddedCaptions(mediaFile, outputDir) {
  const result = JSON.parse(await runProcess(ffprobePath, [
    "-v", "error", "-select_streams", "s", "-show_entries", "stream=index,codec_name:stream_tags=language", "-of", "json", mediaFile,
  ], 60_000, "Subtitle inspection"));
  const stream = (result.streams ?? []).find((item) => !["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"].includes(item.codec_name));
  if (!stream) return null;
  const output = path.join(outputDir, "embedded-subtitles.srt");
  await runProcess(ffmpegPath, ["-y", "-i", mediaFile, "-map", `0:${stream.index}`, "-c:s", "srt", output], 120_000, "Embedded subtitle extraction");
  return output;
}

function transcriptFromCues(cues, language) {
  return {
    cues,
    text: cues.map((cue) => cue.text).join(" "),
    language: language === "auto" ? "unknown" : String(language || "unknown").toLowerCase(),
    languageProbability: null,
    provider: "source-captions",
    model: null,
  };
}

function normalizeCues(cues, duration) {
  return (Array.isArray(cues) ? cues : []).map((cue, index) => {
    const start = Number(cue.start);
    const end = Number(cue.end);
    const text = String(cue.text ?? "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) {
      throw new Error(`Transcript cue ${index + 1} is invalid.`);
    }
    return { start: roundTime(start), end: roundTime(Math.min(duration, end)), text };
  }).filter((cue) => cue.end > cue.start).sort((a, b) => a.start - b.start);
}

async function renderVerticalClip({ input, output, assPath, start, duration, framing, mirror, transitions }) {
  const width = positiveEvenInteger(process.env.REELIO_SHORT_WIDTH, 1080);
  const height = positiveEvenInteger(process.env.REELIO_SHORT_HEIGHT, 1920);
  const mirrorFilter = mirror ? ",hflip" : "";
  const fadeFilter = transitions
    ? `,fade=t=in:st=0:d=0.18,fade=t=out:st=${Math.max(0, duration - 0.22).toFixed(3)}:d=0.22`
    : "";
  const subtitleFilter = assPath ? `,subtitles='${escapeFilterPath(assPath)}'` : "";
  let videoFilter;
  if (framing === "fit") {
    videoFilter = [
      `[0:v]split=2[background][foreground]`,
      `[background]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:12[blurred]`,
      `[foreground]scale=${width}:${height}:force_original_aspect_ratio=decrease${mirrorFilter}[fitted]`,
      `[blurred][fitted]overlay=(W-w)/2:(H-h)/2${fadeFilter}${subtitleFilter},format=yuv420p[v]`,
    ].join(";");
  } else {
    const x = framing === "left" ? "0" : framing === "right" ? "iw-ow" : "(iw-ow)/2";
    videoFilter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:x='${x}':y='(ih-oh)/2'${mirrorFilter}${fadeFilter}${subtitleFilter},format=yuv420p[v]`;
  }
  await runProcess(ffmpegPath, [
    "-y", "-ss", start.toFixed(3), "-i", input, "-t", duration.toFixed(3),
    "-filter_complex", videoFilter,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-r", "30", "-movflags", "+faststart", output,
  ], Number(process.env.REELIO_PROCESS_TIMEOUT_MS || 900_000), "Short-video rendering");
}

export function buildShortAss({ cues, duration, hook, brand, includeCaptions = true }) {
  const font = String(brand?.fontFamily || "Arial").replace(/,/g, " ");
  const accent = assColor(brand?.accentColor || "#7c5cff");
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Hook,${font},68,&H00FFFFFF,&H00FFFFFF,&H00191420,&H00000000,-1,0,0,0,100,100,0,0,1,7,0,8,74,74,180,1
Style: Caption,${font},62,&H00FFFFFF,${accent},&H00120F18,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,90,90,360,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const events = [];
  const cleanHook = String(hook || "").replace(/\s+/g, " ").trim();
  if (cleanHook) events.push(`Dialogue: 1,0:00:00.00,${assTime(Math.min(duration, 3.2))},Hook,,0,0,0,,{\\fad(100,180)}${escapeAss(wrapText(cleanHook, 25))}`);
  if (includeCaptions) {
    for (const cue of cues) {
      events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(Math.min(duration, cue.end))},Caption,,0,0,0,,{\\fad(60,50)}${escapeAss(wrapText(cue.text, 30))}`);
    }
  }
  return `${header}${events.join("\n")}\n`;
}

function validateRenderCandidate(candidate, sourceDuration) {
  const start = Number(candidate.start);
  const end = Number(candidate.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > sourceDuration + 0.25) {
    throw new Error(`The in/out points for ${candidate.title || "a highlight"} are outside the source.`);
  }
  if (end - start < 8 || end - start > 120) throw new Error("Each reviewed short must be between 8 and 120 seconds.");
  return {
    id: String(candidate.id),
    title: cleanGeneratedText(candidate.title, "Short video", 80),
    hook: cleanGeneratedText(candidate.hook, "", 120),
    description: cleanGeneratedText(candidate.description, summarizeHighlight(candidate.transcript), 520),
    start: roundTime(start),
    end: roundTime(end),
    score: Math.max(1, Math.min(100, Math.round(Number(candidate.score) || 70))),
    reason: cleanGeneratedText(candidate.reason, "", 220),
    transcript: cleanGeneratedText(candidate.transcript, "", 20_000),
    framing: ["left", "center", "right", "fit"].includes(candidate.framing) ? candidate.framing : "center",
  };
}

function summarizeHighlight(transcript) {
  const clean = String(transcript || "").replace(/\s+/g, " ").trim();
  if (!clean) return "This short presents a complete selected moment and its key takeaway.";
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [clean];
  const selected = sentences.length <= 2
    ? sentences
    : [sentences[Math.min(1, sentences.length - 1)], sentences[sentences.length - 1]];
  const description = selected.join(" ");
  return description.length > 500 ? `${description.slice(0, 497).trimEnd()}…` : description;
}

async function mediaDuration(file) {
  const output = await runProcess(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], 60_000, "Media inspection");
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read the long video's duration.");
  return duration;
}

async function makeAsset(file, type, name = path.basename(file)) {
  const details = await stat(file);
  return { file, name, bytes: details.size, type };
}

function runProcess(command, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerJobProcess(child);
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (timedOut) reject(new Error(`${label} exceeded the processing time limit.`));
      else reject(new Error(`${label} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-1800)}`));
    });
  });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function overlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function positiveEvenInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 160 && number <= 4320 && number % 2 === 0 ? number : fallback;
}

function cleanOption(value, maximum, fallback) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maximum);
}

function cleanGeneratedText(value, fallback, maximum) {
  return String(value || fallback || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function parseJson(value, message) {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

function safeFilePart(value) {
  return String(value || "highlight").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || "highlight";
}

function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((centiseconds % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function wrapText(value, length) {
  const words = String(value).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > length) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\\N");
}

function escapeAss(value) {
  const lineBreak = "\u0000";
  return String(value)
    .replaceAll("\\N", lineBreak)
    .replace(/[{}]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll(lineBreak, "\\N");
}

function escapeFilterPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function assColor(hex) {
  const match = String(hex).match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return match ? `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase() : "&H00FF5C7C";
}

function sameLanguage(left, right) {
  const aliases = {
    ar: "arabic", my: "burmese", zh: "chinese", da: "danish", nl: "dutch", en: "english",
    fi: "finnish", fr: "french", de: "german", el: "greek", he: "hebrew", hi: "hindi",
    id: "indonesian", it: "italian", ja: "japanese", km: "khmer", ko: "korean", lo: "lao",
    ms: "malay", no: "norwegian", pl: "polish", pt: "portuguese", ru: "russian", es: "spanish",
    sw: "swahili", sv: "swedish", tl: "tagalog", th: "thai", tr: "turkish", vi: "vietnamese",
  };
  const normalize = (value) => {
    const clean = String(value || "").trim().toLowerCase().replaceAll("_", "-");
    return aliases[clean] || aliases[clean.split("-")[0]] || clean;
  };
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a !== "auto" && a !== "unknown" && a === b);
}

function shortTags(value) {
  const stop = new Set(["this", "that", "with", "from", "your", "into", "what", "when", "where", "about", "video", "short"]);
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((word) => !stop.has(word)) ?? [])].slice(0, 12);
}

function likelyMatchesLanguage(text, language) {
  if (String(language).toLowerCase() !== "english") return false;
  const letters = [...String(text)].filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return false;
  const latin = letters.filter((character) => /[A-Za-z]/.test(character)).length;
  return latin / letters.length >= 0.88;
}

function atempoFilter(speed) {
  let remaining = Math.max(0.01, Number(speed) || 1);
  const factors = [];
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`).join(",");
}
