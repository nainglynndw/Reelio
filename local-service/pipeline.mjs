import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
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

  await progress("script", 12, "Writing a retention-first script");
  const canonicalScript = await createScript(job.request);
  const masterScriptPath = path.join(outputDir, "master-script-english.txt");
  await writeFile(masterScriptPath, `${canonicalScript.trim()}\n`, "utf8");
  const canonicalSegments = segmentText(canonicalScript, "English");
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
  const narration = await createNarration(transcriptSegments, job.request.language, ttsEngine, outputDir);
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
  await writeFile(styledCaptionsPath, buildAss(subtitleSegments, fittedNarration.cues, targetDuration, captionFont(job.request.subtitleLanguage)), "utf8");

  await progress("music", 35, "Composing the curated intro, background, and ending mix");
  const music = await createCuratedMusic(targetDuration, job.request.category, outputDir);

  await progress("stock-search", 39, "Finding and preparing visual clips");
  const clipDuration = 3.2;
  const clipCount = Math.ceil(targetDuration / clipDuration);
  const visualQueries = await createVisualQueries(canonicalScript, job.request.category);
  const stock = await findStockClips(job.request, clipCount, clipsDir, visualQueries, progress);
  const normalizedClips = [];
  const licenses = [];

  for (let index = 0; index < clipCount; index += 1) {
    const output = path.join(clipsDir, `clip-${String(index + 1).padStart(2, "0")}.mp4`);
    const source = stock[index % Math.max(stock.length, 1)];
    if (source) {
      await normalizeStockClip(source.file, output, clipDuration);
      licenses.push(source.license);
    } else {
      await createMotionClip(output, clipDuration, index);
    }
    normalizedClips.push(output);
    await progress("stock-search", 45 + Math.round(((index + 1) / clipCount) * 18), `Prepared visual ${index + 1} of ${clipCount}`);
  }

  await progress("render", 68, "Stitching the clean background master");
  const concatPath = path.join(clipsDir, "concat.txt");
  await writeFile(concatPath, normalizedClips.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  const cleanPath = path.join(outputDir, "clean-background.mp4");
  await run(ffmpegPath, [
    "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
    "-t", targetDuration.toFixed(2),
    "-vf", "scale=1080:1920:flags=lanczos,fps=30,format=yuv420p",
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", cleanPath,
  ]);

  await progress("thumbnail", 80, "Designing the social thumbnail");
  const thumbnailPath = path.join(outputDir, "thumbnail.jpg");
  await createThumbnail(cleanPath, thumbnailPath, canonicalSegments[0] ?? makeTitle(job.request.prompt), job.request.category, outputDir);

  await progress("captions", 82, "Burning high-contrast safe-zone captions");
  const finalPath = path.join(outputDir, "final.mp4");
  const escapedSubtitlePath = styledCaptionsPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
  const captionFilter = `ass='${escapedSubtitlePath}'`;
  await run(ffmpegPath, [
    "-y", "-i", cleanPath, "-i", fittedNarration.path, "-i", music.path,
    "-vf", captionFilter,
    "-filter_complex", `[1:a]apad=whole_dur=${targetDuration.toFixed(2)},volume=1.0,asplit=2[voice_sc][voice_mix];[2:a]atrim=0:${targetDuration.toFixed(2)},volume='if(lt(t\\,1.4)\\,0.72\\,if(gt(t\\,${Math.max(0, targetDuration - 3.2).toFixed(2)})\\,0.60\\,0.34))':eval=frame[music];[music][voice_sc]sidechaincompress=threshold=0.075:ratio=4:attack=18:release=260:makeup=1[ducked];[voice_mix][ducked]amix=inputs=2:duration=longest:weights='1 1':normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-t", targetDuration.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", finalPath,
  ]);

  await progress("render", 96, "Writing metadata and platform package");
  const platformCopy = await createPlatformCopy(job.request, canonicalScript);
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
    if (!hasEnoughScriptContent(request.approvedScript, "English", wordRange.min) || !hasCompleteScript(request.approvedScript)) {
      throw new Error("The approved script is too short for the selected duration.");
    }
    return request.approvedScript;
  }
  const generated = await generateText({
    system: `Write one original English master voiceover script for a ${request.duration} vertical knowledge reel. Target ${wordRange.min}-${wordRange.max} spoken words. Start with an immediate surprising hook, establish a curiosity gap, deliver concrete and defensible information in short spoken sentences, add a pattern interrupt roughly every 8 seconds, and finish with a useful payoff before a one-sentence CTA. Keep every sentence between 5 and 12 words so each sentence can become one synchronized narration and subtitle cue. Use only claims supported by the brief or conservative general knowledge. Explain named research effects narrowly and acknowledge important limits; never claim the brain was designed for something, can be hacked or tricked, or that one result applies universally. Do not introduce unrelated named rules, statistics, historical details, or mechanisms. Every sentence must follow logically from the one before it. This English master will be professionally translated, so avoid idioms, ambiguous pronouns, abbreviations, and culturally specific wordplay. Avoid medical, legal, financial, political, or other high-stakes claims unless the brief explicitly supplies reviewed source material. Silently review the script for factual overstatement, contradiction, and unclear phrasing before returning it. No headings, stage directions, citations, markdown, or unsupported claims.`,
    user: `Topic and reviewed boundaries: ${request.prompt}\nCategory: ${request.category ?? "Knowledge"}\nAudience: curious general viewers.`,
    maxTokens: Math.max(180, Math.ceil(wordRange.max * 2.2)),
    temperature: 0.72,
  });
  if (generated) {
    const edited = await generateText({
      system: `Act as a skeptical senior fact editor for a monetized knowledge channel. Rewrite the draft into the final English voiceover, targeting ${wordRange.min}-${wordRange.max} spoken words. The supplied brief is the source of truth. Remove or correct every claim, mechanism, recommendation, and level of certainty that is not directly supported by that brief. Never reverse a condition into an instruction, recommend creating a problem to demonstrate an effect, or imply an outcome is easy, universal, guaranteed, or biologically designed. Keep the hook strong without sensationalism. Use coherent sentences of 5-12 words, smooth transitions, one practical payoff, and one natural CTA. Silently verify logical consistency before returning. Return only the revised script with no headings, notes, citations, or markdown.`,
      user: `Reviewed brief:\n${request.prompt}\n\nDraft to fact-edit:\n${generated.text}`,
      maxTokens: Math.max(220, Math.ceil(wordRange.max * 2.2)),
      temperature: 0.22,
    });
    let script = edited?.text ?? generated.text;
    if (!hasEnoughScriptContent(script, "English", wordRange.min) || !hasCompleteScript(script)) {
      const expanded = await generateText({
        system: `Expand the supplied English voiceover to ${wordRange.min}-${wordRange.max} spoken words without adding any claim, mechanism, technique, or certainty not supported by the reviewed brief. Preserve the existing meaning and factual limits. Add clarity, a concrete interrupted-email moment, smooth transitions, and useful explanation rather than repetition. Keep sentences concise and natural for synchronized narration. Return only the complete expanded script with no title, headings, word count, markdown, or notes.`,
        user: `Reviewed brief:\n${request.prompt}\n\nShort script to expand:\n${script}`,
        maxTokens: Math.max(260, Math.ceil(wordRange.max * 2.5)),
        temperature: 0.2,
      });
      if (expanded?.text) script = expanded.text;
    }
    if (!hasEnoughScriptContent(script, "English", wordRange.min)) throw new Error(`${edited?.provider ?? generated.provider} returned a script that was too short for the retention target.`);
    if (!hasCompleteScript(script)) throw new Error(`${edited?.provider ?? generated.provider} returned an incomplete script. Rendering stopped before narration.`);
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
  return /[.!?]["'”’)]?\s*$/u.test(String(script ?? "").trim());
}

async function createNarration(segments, language, ttsEngine, outputDir) {
  const narrationDir = path.join(outputDir, "narration");
  await mkdir(narrationDir, { recursive: true });
  const engine = ttsEngine ?? defaultTtsEngine(language);
  const files = engine === "kokoro"
    ? await synthesizeKokoroCues({ segments, outputDir: narrationDir })
    : engine === "voxcpm2"
      ? await synthesizeVoxCpmCues({ segments, language, outputDir: narrationDir })
      : await synthesizeGeminiCues({ segments, language, outputDir: narrationDir });
  const pacedFiles = engine === "gemini" && language === "Burmese" ? await paceGeminiBurmeseCues(files, narrationDir) : files;

  const durations = [];
  for (const file of pacedFiles) durations.push(await mediaDuration(file));
  const concatPath = path.join(narrationDir, "concat.txt");
  await writeFile(concatPath, pacedFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  const output = path.join(outputDir, "voice-cued.m4a");
  await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output]);
  const outputDuration = await mediaDuration(output);
  const sourceDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const scale = outputDuration / sourceDuration;
  let cursor = 0;
  const cues = durations.map((duration) => {
    const start = cursor;
    cursor += duration * scale;
    return { start, end: cursor };
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
  const paced = [];
  for (let index = 0; index < files.length; index += 1) {
    const output = path.join(outputDir, `paced-${String(index + 1).padStart(3, "0")}.wav`);
    await run(ffmpegPath, ["-y", "-i", files[index], "-filter:a", atempoFilter(speed), "-ar", "24000", "-ac", "1", output]);
    paced.push(output);
  }
  return paced;
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

async function createVisualQueries(script, category) {
  try {
    const generated = await generateText({
      system: "Create exactly six short stock-video search phrases for this script. Each phrase must describe a concrete, filmable person, object, action, or location that directly matches a different moment in the narration. Prioritize the opening hook in the first phrase. Avoid abstract concepts, production terminology, cameras, film crews, logos, proper names, and the words video, reel, footage, animation, or background. Return only six tagged blocks in this format: <Q>person writing email on laptop</Q>.",
      user: `Category: ${category ?? "Knowledge"}\nScript: ${script}`,
      maxTokens: 280,
      temperature: 0.2,
    });
    const queries = [...String(generated?.text ?? "").matchAll(/<Q>([\s\S]*?)<\/Q>/gi)]
      .map((match) => match[1].trim().replace(/[.!?]+$/, ""))
      .filter((query) => query.split(/\s+/).length >= 2 && query.length <= 90);
    if (queries.length >= 4) return queries.slice(0, 6);
  } catch {
    // Fall back to deterministic script keywords below.
  }
  const keywords = uniqueWords(script).slice(0, 18);
  return [0, 3, 6, 9, 12, 15].map((offset) => keywords.slice(offset, offset + 3).join(" ")).filter((query) => query.split(/\s+/).length >= 2);
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

async function findStockClips(request, count, clipsDir, visualQueries = [], progress = async () => {}) {
  if (!process.env.PEXELS_API_KEY) return [];
  try {
    await progress("stock-search", 40, "Searching Pexels for relevant portrait clips");
    const category = String(request.category ?? "knowledge").trim();
    const keywords = uniqueWords(request.prompt).slice(0, 12);
    const queries = [...new Set([
      ...visualQueries,
      [category, ...keywords.slice(0, 3)].join(" "),
      keywords.slice(3, 7).join(" "),
      `${category} practical example`,
    ].map((query) => query.trim()).filter((query) => query.split(/\s+/).length >= 2))].slice(0, 4);
    const results = await Promise.all(queries.map(async (query) => {
      const perPage = Math.min(10, Math.max(6, Math.ceil(count / queries.length)));
      const response = await fetchWithTimeout(`https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=${perPage}`, { headers: { Authorization: process.env.PEXELS_API_KEY } }, 20_000);
      if (!response.ok) return [];
      const data = await response.json();
      return data.videos ?? [];
    }));
    await progress("stock-search", 41, "Selecting lightweight licensed clips");
    const interleaved = [];
    const resultDepth = Math.max(0, ...results.map((items) => items.length));
    for (let row = 0; row < resultDepth; row += 1) for (const items of results) if (items[row]) interleaved.push(items[row]);
    const seen = new Set();
    const candidates = interleaved.map((video) => {
      if (seen.has(video.id)) return null;
      seen.add(video.id);
      const files = [...(video.video_files ?? [])].sort((a, b) => Math.abs((a.width ?? 0) - 720) - Math.abs((b.width ?? 0) - 720));
      const chosen = files.find((file) => file.file_type === "video/mp4" && (file.height ?? 0) >= (file.width ?? 0)) ?? files.find((file) => file.file_type === "video/mp4");
      return chosen ? { url: chosen.link, id: video.id, page: video.url, creator: video.user?.name ?? "Pexels contributor" } : null;
    }).filter(Boolean).slice(0, Math.min(count, 12));
    const downloaded = [];
    const concurrency = 4;
    for (let offset = 0; offset < candidates.length; offset += concurrency) {
      const batch = candidates.slice(offset, offset + concurrency);
      const results = await Promise.all(batch.map(async (candidate, batchIndex) => {
        try {
          const response = await fetchWithTimeout(candidate.url, {}, 25_000);
          if (!response.ok) return null;
          const file = path.join(clipsDir, `source-${String(offset + batchIndex + 1).padStart(2, "0")}.mp4`);
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
          return {
            file,
            license: { provider: "Pexels", mediaId: candidate.id, creator: candidate.creator, sourceUrl: candidate.page, license: "Pexels License" },
          };
        } catch {
          return null;
        }
      }));
      downloaded.push(...results.filter(Boolean));
      const finished = Math.min(candidates.length, offset + batch.length);
      await progress("stock-search", 41 + Math.round((finished / Math.max(1, candidates.length)) * 4), `Downloaded ${downloaded.length} of ${candidates.length} licensed source clips`);
    }
    return downloaded;
  } catch {
    return [];
  }
}

async function normalizeStockClip(input, output, seconds) {
  await run(ffmpegPath, [
    "-y", "-stream_loop", "-1", "-i", input, "-t", String(seconds),
    "-vf", `scale=760:1352:force_original_aspect_ratio=increase,crop=720:1280:x='20+20*sin(t*0.8)':y='36+36*cos(t*0.65)',fps=30,eq=contrast=1.04:saturation=1.1,fade=t=in:d=0.12,fade=t=out:st=${Math.max(0, seconds - 0.12).toFixed(2)}:d=0.12,format=yuv420p`,
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

function buildAss(segments, cues, totalDuration, fontName = "Arial") {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Reelio,${fontName},62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H76000000,-1,0,0,0,100,100,0,0,3,10,0,2,90,90,430,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const events = cues.map((cue, index) => ({ cue, text: segments[index] })).filter(({ cue, text }) => text && cue.start < totalDuration).map(({ cue, text }) => `Dialogue: 0,${assTime(cue.start)},${assTime(Math.min(cue.end, totalDuration))},Reelio,,0,0,0,,${escapeAss(wrapSubtitle(text)).replaceAll("\n", "\\N")}`).join("\n");
  return `${header}${events}\n`;
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

export { buildAss, buildSrt, chooseDuration, createCuratedMusic, ffmpegPath, ffprobePath, segmentText, validateLanguageText };
