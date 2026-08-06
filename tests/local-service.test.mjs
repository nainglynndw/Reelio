import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ffprobe from "ffprobe-static";
import { allocateStoryboardCandidates, bilingualPublishingField, buildAss, buildScriptContext, buildSpeechGroups, buildSrt, buildXfadeChain, chooseDuration, collectStockProviderResults, createLocalVisualThemePlan, createScriptDraft, extractPauses, ffmpegPath, fitNarration, hasBilingualPublishingPair, limitPauseMarkers, motionFilter, MUSIC_MIX_LEVELS, narrationFitPlan, normalizeStockClip, planClipQueries, planThemeQueries, planThemeSlots, rankStockCandidates, scriptWordRange, segmentText, styleProfile, summarizePublishingScript, validateLanguageText } from "../local-service/pipeline.mjs";
import { parseVoiceBlend, selectKokoroVoice } from "../local-service/kokoro-client.mjs";
import { parseByteRange } from "../local-service/http-utils.mjs";
import { durationBounds, normalizeVideoRequest, normalizeVoicePreviewRequest, ValidationError } from "../local-service/validation.mjs";
import { kokoroConfig } from "../local-service/kokoro-client.mjs";
import { GEMINI_TTS_LANGUAGES, geminiTtsConfig, pcmToWave, selectGeminiTtsVoice } from "../local-service/gemini-tts-client.mjs";
import { selectVoxCpmSeed, selectVoxCpmVoiceDescription, VOXCPM2_LANGUAGES, voxCpmCalibrationText, voxCpmConfig } from "../local-service/voxcpm-client.mjs";
import { DEFAULT_GEMINI_CONVERSATION_MODEL, DEFAULT_GEMINI_CREATIVE_MODEL, DEFAULT_GEMINI_TEXT_MODEL, DEFAULT_GEMINI_UTILITY_MODEL, DEFAULT_OPENROUTER_MODEL, geminiOutputTokenLimit, googleModelForTask, normalizeThinkingLevel, textProviderConfig, usesDefaultGeminiSampling } from "../local-service/text-provider.mjs";
import { IDEA_SYSTEM_PROMPT, normalizeIdeaOutput } from "../local-service/idea-generator.mjs";
import { applyScriptPatches, CONVERSATION_VOICE_EXAMPLE, parseScriptPatches, SCRIPT_VOICE_EXAMPLES } from "../local-service/content-quality.mjs";
import { JobStoppedError, registerJobProcess, runWithJobControl, stopJobExecution } from "../local-service/job-control.mjs";
import { buildYouTubeAuthorizationUrl } from "../local-service/youtube-oauth.mjs";
import { buildTikTokAuthorizationUrl } from "../local-service/tiktok-oauth.mjs";
import { buildFacebookAuthorizationUrl } from "../local-service/facebook-oauth.mjs";
import { buildTikTokUploadPlan, buildYouTubeUploadPlan, publishJob, publishingMediaIssue } from "../local-service/publishers.mjs";
import { executeTool, normalizeToolRequest, planChopSegments, TOOL_DEFINITIONS, ToolValidationError } from "../local-service/tools/tool-runner.mjs";
import { formatSrt, parseSubtitles } from "../local-service/tools/subtitles.mjs";
import { activeAutomationJob, automationPublishMode, buildCalendarEntries, calendarCronExpressions, normalizeAutomationCreate, normalizeAutomationPatch } from "../local-service/automations.mjs";
import { normalizeWebMediaUrl, selectWebCaptionTrack } from "../local-service/tools/web-media.mjs";
import { DEFAULT_GEMINI_STT_MODEL, normalizeGeminiTranscript, sttConfig, sttLanguageCode } from "../local-service/stt-client.mjs";
import { DEFAULT_SCRIPT_STYLE, SCRIPT_STYLES, scriptStyleProfile } from "../local-service/script-styles.mjs";
import { DEFAULT_NARRATOR_ID, NARRATORS, narratorProfile } from "../local-service/narrators.mjs";
import { voicePreviewCacheKey } from "../local-service/voice-preview.mjs";
import { defaultBrandKit, publicBrandKit, updateBrandKit, validateBrandAssetUpload, BrandKitError } from "../local-service/brand-kit.mjs";
import { assembleNarratedShort, buildShortAss, buildShortThumbnailAss, DEFAULT_LONG_VIDEO_TITLE_CARD_SECONDS, longVideoTitleCardSeconds, normalizeHighlightCandidates, renderLongVideoShorts, validateLongVideoAnalyzeOptions, validateLongVideoRenderOptions } from "../local-service/tools/long-video.mjs";
import { buildConversationDocument, buildConversationTimeline, buildConversationTypingSequence, compileConversationStoryItems, conversationAssetIds, conversationReceiptAt, conversationSoundEvents, defaultConversationDraft, normalizeConversationDraft, recommendedConversationTypingMs, renderConversationEffects, renderConversationMusic } from "../local-service/conversation-video.mjs";
import { curatedConversationPitches, guidedConversationPitch, normalizeStarterCriteria, parseConversationPitches } from "../local-service/conversation-starters.mjs";

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("uses Google Gemini as the primary multilingual text provider with OpenRouter fallback", () => {
  assert.equal(DEFAULT_GEMINI_TEXT_MODEL, "gemini-3.6-flash");
  assert.equal(DEFAULT_GEMINI_CREATIVE_MODEL, "gemini-3.6-flash");
  assert.equal(DEFAULT_GEMINI_CONVERSATION_MODEL, "gemini-3.6-flash");
  assert.equal(DEFAULT_GEMINI_UTILITY_MODEL, "gemini-3.5-flash-lite");
  assert.equal(DEFAULT_OPENROUTER_MODEL, "google/gemma-4-31b-it:free");
  assert.equal(textProviderConfig().preferred, "google");
  assert.match(textProviderConfig().model, /gemini-|gemma-4-31b-it:free|built-in English fallback/);
  assert.equal(normalizeThinkingLevel("high"), "high");
  assert.equal(normalizeThinkingLevel("invalid"), "medium");
});

test("routes creative and utility Gemini work independently with bounded output", () => {
  const previous = {
    shared: process.env.GEMINI_TEXT_MODEL,
    creative: process.env.GEMINI_CREATIVE_MODEL,
    conversation: process.env.GEMINI_CONVERSATION_MODEL,
    utility: process.env.GEMINI_UTILITY_MODEL,
  };
  delete process.env.GEMINI_TEXT_MODEL;
  delete process.env.GEMINI_CREATIVE_MODEL;
  delete process.env.GEMINI_CONVERSATION_MODEL;
  delete process.env.GEMINI_UTILITY_MODEL;
  try {
    assert.equal(googleModelForTask("creative"), "gemini-3.6-flash");
    assert.equal(googleModelForTask("conversation"), "gemini-3.6-flash");
    assert.equal(googleModelForTask("research"), "gemini-3.6-flash");
    assert.equal(googleModelForTask("utility"), "gemini-3.5-flash-lite");
    process.env.GEMINI_TEXT_MODEL = "shared-model";
    process.env.GEMINI_CREATIVE_MODEL = "creative-model";
    process.env.GEMINI_CONVERSATION_MODEL = "conversation-model";
    process.env.GEMINI_UTILITY_MODEL = "utility-model";
    assert.equal(googleModelForTask("creative"), "creative-model");
    assert.equal(googleModelForTask("conversation"), "conversation-model");
    assert.equal(googleModelForTask("utility"), "utility-model");
  } finally {
    restoreEnv("GEMINI_TEXT_MODEL", previous.shared);
    restoreEnv("GEMINI_CREATIVE_MODEL", previous.creative);
    restoreEnv("GEMINI_CONVERSATION_MODEL", previous.conversation);
    restoreEnv("GEMINI_UTILITY_MODEL", previous.utility);
  }
  assert.equal(usesDefaultGeminiSampling("gemini-3.6-flash"), true);
  assert.equal(usesDefaultGeminiSampling("gemini-2.5-flash"), false);
  assert.equal(geminiOutputTokenLimit(200, "high"), 800);
  assert.equal(geminiOutputTokenLimit(200, "minimal"), 512);
  assert.equal(geminiOutputTokenLimit(20_000, "high"), 16_384);
});

test("uses examples for creative calibration and applies only narrow exact editorial patches", () => {
  assert.match(IDEA_SYSTEM_PROMPT, /Weak:/);
  assert.match(IDEA_SYSTEM_PROMPT, /Strong:/);
  assert.match(SCRIPT_VOICE_EXAMPLES, /Taipei 101/);
  assert.match(CONVERSATION_VOICE_EXAMPLE, /speech|Mara is direct/i);

  const parsed = parseScriptPatches("```json\n[{\"find\":\"changes everything\",\"replace\":\"changes the result under these conditions\",\"reason\":\"Avoid empty hype\"}]\n```");
  const result = applyScriptPatches("This changes everything. Keep this detail.", parsed);
  assert.equal(result.text, "This changes the result under these conditions. Keep this detail.");
  assert.equal(result.applied.length, 1);

  const ambiguous = applyScriptPatches("same and same", [{ find: "same", replace: "different", reason: "Ambiguous" }]);
  assert.equal(ambiguous.text, "same and same");
  assert.equal(ambiguous.rejected.length, 1);
});

test("keeps grounded specifics and the angle plan inside the script context", () => {
  const context = buildScriptContext(
    { prompt: "Explain how tuned mass dampers reduce skyscraper sway.", category: "Engineering", duration: "60 sec" },
    { label: "Question-led", direction: "Open on a focused question, then answer it." },
    {
      text: "<FACT>Taipei 101 uses a 660-ton suspended steel damper.</FACT><CAVEAT>The device reduces motion rather than eliminating it.</CAVEAT>",
      sources: [{ title: "Taipei 101 official damper guide", url: "https://example.com/damper" }],
    },
    "<HOOK>A steel sphere moves while the building sways.</HOOK><PAYOFF>Stability can come from controlled movement.</PAYOFF>",
  );
  assert.match(context, /660-ton suspended steel damper/);
  assert.match(context, /reduces motion rather than eliminating it/);
  assert.match(context, /Taipei 101 official damper guide/);
  assert.match(context, /Stability can come from controlled movement/);
  assert.match(context, /Question-led/);
});

test("builds a secure offline YouTube OAuth request", () => {
  const auth = new URL(buildYouTubeAuthorizationUrl({ clientId: "client-id", redirectUri: "http://127.0.0.1:8788/oauth/youtube/callback", state: "csrf-state" }));
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  assert.equal(auth.searchParams.get("state"), "csrf-state");
  assert.match(auth.searchParams.get("scope"), /youtube\.upload/);
  assert.match(auth.searchParams.get("scope"), /youtube\.readonly/);
  assert.doesNotMatch(auth.searchParams.get("scope"), /youtube\.force-ssl/);
});

test("builds a PKCE-protected TikTok Desktop OAuth request", () => {
  const auth = new URL(buildTikTokAuthorizationUrl({ clientKey: "client-key", redirectUri: "http://127.0.0.1:8788/oauth/tiktok/callback", state: "csrf-state", codeChallenge: "abc123" }));
  assert.equal(auth.origin, "https://www.tiktok.com");
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("state"), "csrf-state");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("code_challenge"), "abc123");
  assert.match(auth.searchParams.get("scope"), /user\.info\.basic/);
  assert.match(auth.searchParams.get("scope"), /video\.upload/);
});

test("builds a Meta Login request for Facebook and Instagram publishing", () => {
  const auth = new URL(buildFacebookAuthorizationUrl({ appId: "app-id", redirectUri: "http://127.0.0.1:8788/oauth/facebook/callback", state: "csrf-state", graphVersion: "v23.0" }));
  assert.equal(auth.origin, "https://www.facebook.com");
  assert.equal(auth.pathname, "/v23.0/dialog/oauth");
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("client_id"), "app-id");
  assert.equal(auth.searchParams.get("state"), "csrf-state");
  assert.match(auth.searchParams.get("scope"), /pages_manage_posts/);
  assert.match(auth.searchParams.get("scope"), /instagram_content_publish/);
});

test("uses TikTok-compliant whole uploads and chunks", () => {
  assert.deepEqual(buildTikTokUploadPlan(4_194_304), { chunkSize: 4_194_304, ranges: [{ start: 0, end: 4_194_303 }] });
  assert.deepEqual(buildTikTokUploadPlan(64_000_000), { chunkSize: 64_000_000, ranges: [{ start: 0, end: 63_999_999 }] });
  const large = buildTikTokUploadPlan(70_000_123);
  assert.equal(large.chunkSize, 10_000_000);
  assert.equal(large.ranges.length, 7);
  assert.deepEqual(large.ranges[0], { start: 0, end: 9_999_999 });
  assert.deepEqual(large.ranges.at(-1), { start: 60_000_000, end: 70_000_122 });
});

test("uses progress-friendly YouTube resumable chunks", () => {
  const chunks = buildYouTubeUploadPlan(20_000_000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { start: 0, end: 8_388_607 });
  assert.deepEqual(chunks.at(-1), { start: 16_777_216, end: 19_999_999 });
  assert.throws(() => buildYouTubeUploadPlan(20_000_000, 1_000_000), /multiple of 256 KB/);
});

test("sends Meta's required local Reel upload offset header", async () => {
  const source = await readFile(new URL("../local-service/publishers.mjs", import.meta.url), "utf8");
  assert.match(source, /Authorization: `OAuth \$\{token\}`/);
  assert.match(source, /offset: "0"/);
  assert.match(source, /file_size: String\(size\)/);
  assert.match(source, /Meta returned no error message \(HTTP/);
  assert.match(source, /error\?\.fbtrace_id/);
  assert.match(source, /facebookUploadBody\(job\.assets\.final\.file, size, onProgress\)/);
  assert.match(source, /fields: "status"/);
  assert.match(source, /Facebook is still processing the Reel/);
});

test("blocks media that does not meet each short-video connector contract", () => {
  const base = { state: "completed", assets: { final: { file: "/tmp/final.mp4" } }, metadata: { durationSeconds: 75, resolution: "1080x1920", frameRate: 30 } };
  for (const platform of ["youtube", "tiktok", "facebook", "instagram"]) assert.equal(publishingMediaIssue(base, platform), null);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 181 } }, "youtube"), /3 minutes/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 601 } }, "tiktok"), /10 minutes/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 91 } }, "facebook"), /3–90 seconds/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, frameRate: 61 } }, "instagram"), /23 and 60 FPS/);
});

test("starts independent platform uploads concurrently and isolates failures", async () => {
  const job = {
    state: "completed",
    assets: { final: { file: "/tmp/final.mp4" } },
    metadata: { durationSeconds: 60, resolution: "1080x1920", frameRate: 30 },
  };
  const started = [];
  const progress = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const uploader = (platformId, shouldFail = false) => async () => {
    started.push(platformId);
    await gate;
    if (shouldFail) throw new Error(`${platformId} rejected the upload`);
    return { status: "published", id: platformId };
  };
  const publishing = publishJob(job, ["youtube", "facebook", "instagram"], async (platformId, result) => {
    progress.push(`${platformId}:${result.status}`);
  }, {
    uploaders: {
      youtube: uploader("youtube"),
      facebook: uploader("facebook", true),
      instagram: uploader("instagram"),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set(["youtube", "facebook", "instagram"]), "all uploads should start before any one platform finishes");
  release();
  const results = await publishing;
  assert.equal(results.youtube.status, "published");
  assert.equal(results.instagram.status, "published");
  assert.equal(results.facebook.status, "failed");
  assert.match(results.facebook.message, /rejected the upload/);
  assert.ok(progress.includes("youtube:starting"));
  assert.ok(progress.includes("facebook:starting"));
  assert.ok(progress.includes("instagram:starting"));
});

test("uses Kokoro as the fixed local English TTS provider", () => {
  const config = kokoroConfig();
  assert.equal(config.provider, "kokoro");
  assert.equal(config.model, "Kokoro-82M v1.0");
  assert.equal(config.language, "en-us");
  assert.equal(config.voice, "af_heart");
  assert.equal(config.speed, 1.15);
});

test("supports selectable Gemini TTS and local VoxCPM2 routing", () => {
  assert.equal(geminiTtsConfig().model, "gemini-3.1-flash-tts-preview");
  assert.equal(geminiTtsConfig().voice, "Puck");
  assert.ok(GEMINI_TTS_LANGUAGES.includes("English"));
  assert.ok(GEMINI_TTS_LANGUAGES.includes("Burmese"));
  assert.equal(voxCpmConfig().model, "OpenBMB/VoxCPM2");
  assert.equal(voxCpmConfig().device, "auto");
  assert.ok(VOXCPM2_LANGUAGES.includes("Burmese"));
  assert.ok(VOXCPM2_LANGUAGES.includes("Khmer"));
  assert.equal(voxCpmCalibrationText("English", ["Current English sample."], "Maya's fixed English calibration."), "Maya's fixed English calibration.");
  assert.equal(voxCpmCalibrationText("Thai", ["นี่คือเสียงตัวอย่างภาษาไทย"], "English calibration must not be used."), "นี่คือเสียงตัวอย่างภาษาไทย");
  assert.equal(voxCpmCalibrationText("Burmese", ["ဒါက မြန်မာအသံ နမူနာပါ။"], "English calibration must not be used."), "ဒါက မြန်မာအသံ နမူနာပါ။");
  const wave = pcmToWave(Buffer.alloc(480), 24_000, 1);
  assert.equal(wave.subarray(0, 4).toString(), "RIFF");
  assert.equal(wave.subarray(8, 12).toString(), "WAVE");
  assert.equal(wave.readUInt32LE(40), 480);
});

test("maps four narrator personas across local and Gemini voice engines", () => {
  assert.equal(DEFAULT_NARRATOR_ID, "maya");
  assert.deepEqual(NARRATORS.map((narrator) => narrator.id), ["maya", "theo", "nova", "ellis"]);
  assert.deepEqual(NARRATORS.map((narrator) => narrator.kokoroVoice), ["af_heart", "am_adam", "af_nova", "am_onyx"]);
  assert.deepEqual(NARRATORS.map((narrator) => narrator.geminiVoice), ["Sulafat", "Charon", "Puck", "Gacrux"]);
  assert.equal(new Set(NARRATORS.map((narrator) => narrator.voxSeed)).size, 4);
  assert.ok(NARRATORS.every((narrator) => narrator.sampleLine && narrator.delivery && narrator.voxDescription && narrator.voxReferenceText && narrator.speedScale));
  assert.equal(narratorProfile("ellis").role, "Calm documentarian");
  assert.equal(narratorProfile("unknown").id, DEFAULT_NARRATOR_ID);
});

test("keeps persona voices distinct unless a brand voice override is explicitly enabled", () => {
  const original = {
    enabled: process.env.REELIO_BRAND_VOICE_OVERRIDE,
    kokoro: process.env.KOKORO_VOICE,
    gemini: process.env.GEMINI_TTS_VOICE,
    vox: process.env.VOXCPM_VOICE_DESCRIPTION,
    voxSeed: process.env.VOXCPM_SEED,
  };
  process.env.KOKORO_VOICE = "af_heart";
  process.env.GEMINI_TTS_VOICE = "Puck";
  process.env.VOXCPM_VOICE_DESCRIPTION = "One global voice";
  process.env.VOXCPM_SEED = "42";
  delete process.env.REELIO_BRAND_VOICE_OVERRIDE;
  try {
    assert.deepEqual(NARRATORS.map((narrator) => selectKokoroVoice(narrator.kokoroVoice)), ["af_heart", "am_adam", "af_nova", "am_onyx"]);
    assert.deepEqual(NARRATORS.map((narrator) => selectGeminiTtsVoice(narrator.geminiVoice)), ["Sulafat", "Charon", "Puck", "Gacrux"]);
    assert.equal(new Set(NARRATORS.map((narrator) => selectVoxCpmVoiceDescription(narrator.voxDescription))).size, 4);
    assert.deepEqual(NARRATORS.map((narrator) => selectVoxCpmSeed(narrator.voxSeed)), [104729, 130363, 155921, 181081]);
    process.env.REELIO_BRAND_VOICE_OVERRIDE = "true";
    assert.deepEqual(NARRATORS.map((narrator) => selectKokoroVoice(narrator.kokoroVoice)), Array(4).fill("af_heart"));
    assert.deepEqual(NARRATORS.map((narrator) => selectGeminiTtsVoice(narrator.geminiVoice)), Array(4).fill("Puck"));
    assert.deepEqual(NARRATORS.map((narrator) => selectVoxCpmVoiceDescription(narrator.voxDescription)), Array(4).fill("One global voice"));
    assert.deepEqual(NARRATORS.map((narrator) => selectVoxCpmSeed(narrator.voxSeed)), Array(4).fill(42));
  } finally {
    restoreEnv("REELIO_BRAND_VOICE_OVERRIDE", original.enabled);
    restoreEnv("KOKORO_VOICE", original.kokoro);
    restoreEnv("GEMINI_TTS_VOICE", original.gemini);
    restoreEnv("VOXCPM_VOICE_DESCRIPTION", original.vox);
    restoreEnv("VOXCPM_SEED", original.voxSeed);
  }
});

test("validates voice samples and keys the reusable cache by every audible choice", () => {
  const sample = normalizeVoicePreviewRequest({
    text: "The opening line from the approved script.",
    language: "English",
    ttsEngine: "kokoro",
    narratorId: "maya",
  });
  assert.deepEqual(sample, {
    text: "The opening line from the approved script.",
    language: "English",
    ttsEngine: "kokoro",
    narratorId: "maya",
  });
  const originalKey = voicePreviewCacheKey(sample);
  assert.equal(originalKey.length, 64);
  assert.equal(voicePreviewCacheKey({ ...sample }), originalKey);
  assert.notEqual(voicePreviewCacheKey({ ...sample, narratorId: "nova" }), originalKey);
  assert.notEqual(voicePreviewCacheKey({ ...sample, text: "A different approved opening." }), originalKey);
  assert.throws(() => normalizeVoicePreviewRequest({ ...sample, narratorId: "unknown" }), /Unsupported narrator/);
  assert.throws(() => normalizeVoicePreviewRequest({ ...sample, language: "Thai", ttsEngine: "kokoro" }), /Non-English speech supports/);
  assert.equal(normalizeVoicePreviewRequest({ ...sample, text: "ဒါက မြန်မာအသံ နမူနာပါ။", language: "Burmese", ttsEngine: "voxcpm2" }).language, "Burmese");
  assert.throws(() => normalizeVoicePreviewRequest({ ...sample, text: "This is still English.", language: "Burmese", ttsEngine: "voxcpm2" }), /Myanmar script/);
  assert.throws(() => normalizeVoicePreviewRequest({ ...sample, text: "x" }), /at least 3/);
  assert.throws(() => normalizeVoicePreviewRequest({ ...sample, text: "[pause]" }), /at least 3/);
});

test("keeps VoxCPM2 seed handling compatible with installed and newer APIs", async () => {
  const script = await readFile(new URL("../scripts/voxcpm2_tts.py", import.meta.url), "utf8");
  assert.match(script, /supports_seed = "seed" in inspect\.signature/);
  assert.match(script, /if supports_seed:/);
  assert.match(script, /torch\.manual_seed\(seed\)/);
  assert.match(script, /persona_reference\.exists\(\)/);
  assert.match(script, /persona_reference_transcript\.read_text/);
  assert.match(script, /temporary_transcript\.write_text/);
  assert.match(script, /os\.replace\(temporary_reference, persona_reference\)/);
  assert.match(script, /"prompt_wav_path": str\(persona_reference\)/);
  assert.match(script, /"prompt_text": persona_reference_text/);
  assert.match(script, /"reference_wav_path": str\(persona_reference\)/);
  assert.match(script, /"text": cue\["text"\]/);
  assert.doesNotMatch(script, /"text": f"\{prefix\}\{cue\['text'\]\}"/);
  // One seed for every cue: a per-cue seed redrew the voice each utterance, so timbre and prosody
  // drifted from sentence to sentence inside a single video.
  assert.match(script, /cue_seed = seed\b/);
  assert.doesNotMatch(script, /cue_seed = seed \+ index/);
  assert.doesNotMatch(script, /model\.generate\([\s\S]{0,400}seed=/);
  // The cached persona clip is the expressiveness ceiling for every cue, so it is rendered with
  // more denoising steps than the cues themselves.
  assert.match(script, /"referenceInferenceTimesteps"/);
});

test("stops active local model processes and releases the job", async () => {
  let child;
  const execution = runWithJobControl("stop-test", () => new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    registerJobProcess(child);
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`stopped with ${signal ?? code}`)));
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopJobExecution("stop-test"), true);
  await assert.rejects(execution, JobStoppedError);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("normalizes AI ideas: strips markup/JSON while preserving the structured brief", () => {
  // A single-sentence JSON idea stays a clean single line.
  assert.equal(
    normalizeIdeaOutput('```json\n{"idea":"Investigate whether listeners can distinguish hot and cold water by sound, using controlled recordings before explaining only well-supported physical differences."}\n```'),
    "Investigate whether listeners can distinguish hot and cold water by sound, using controlled recordings before explaining only well-supported physical differences.",
  );
  // Structured briefs keep their angle line and bullet points (bullets normalized to "• ").
  assert.equal(
    normalizeIdeaOutput("How solid-state drives survive drops.\n- No moving parts inside\n* Data stored in flash cells\n• Why that matters for durability"),
    "How solid-state drives survive drops.\n• No moving parts inside\n• Data stored in flash cells\n• Why that matters for durability",
  );
  // Stray field labels and markdown bold are removed without flattening lines together.
  assert.equal(
    normalizeIdeaOutput("**Hook:** A bold opening\n**Visuals:** A controlled side-by-side test"),
    "A bold opening\nA controlled side-by-side test",
  );
});

test("bundles an FFmpeg build with subtitle rendering", async () => {
  await access(ffmpegPath);
  const result = spawnSync(ffmpegPath, ["-filters"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /subtitles\s+V->V/);
});

test("normalizes fictional message conversations and builds one deterministic timeline", () => {
  const draft = defaultConversationDraft("owner-1");
  const normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-1" });
  const timeline = buildConversationTimeline(normalized);
  assert.equal(normalized.authenticity, "fictional");
  assert.equal(normalized.participants.filter((participant) => participant.isSelf).length, 1);
  assert.equal(timeline.entries.length, normalized.events.length);
  assert.ok(timeline.durationMs >= 6_000);
  assert.equal(timeline.entries[0].eventId, normalized.events[0].id);
  assert.ok(timeline.entries[0].typingStartMs < 1_000, "the first visible activity should start in under one second");
  assert.ok(timeline.entries.every((entry, index) => index === 0 || entry.startMs > timeline.entries[index - 1].startMs));
});

test("keeps human typing pace and allows complete conversations beyond three minutes", () => {
  const draft = defaultConversationDraft("owner-long-conversation");
  draft.events[0].typingMs = 250;
  draft.events[1].text = draft.events[0].text;
  draft.events[1].typingMs = 250;
  draft.events[1].typingStyle = draft.events[0].typingStyle;
  let normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-long-conversation" });
  assert.ok(normalized.events[0].typingMs >= 2_000, "natural typing is raised to a brisk readable minimum");
  assert.ok(normalized.events[1].typingMs < normalized.events[0].typingMs, "the phone owner types faster than an incoming participant");
  assert.ok(recommendedConversationTypingMs("Quick answer.", "fast", true) < 700, "short phone-owner replies stay brisk");
  draft.events.forEach((event) => {
    event.typingMs = 70_000;
    event.holdMs = 2_000;
  });
  normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-long-conversation" });
  assert.ok(buildConversationTimeline(normalized).durationMs > 180_000);
});

test("builds deterministic grapheme typing with variable intervals, pauses, and corrections", () => {
  const event = {
    id: "typing-realism",
    type: "text",
    text: "👨‍👩‍👧‍👦 Wait, no. Send the blue one.",
    typingMs: 5_200,
    typingStyle: "hesitant",
    deleted: false,
  };
  const first = buildConversationTypingSequence(event);
  const second = buildConversationTypingSequence(event);
  assert.deepEqual(first, second);
  assert.equal(first.checkpoints.at(-1).text, event.text);
  assert.ok(first.correctionCount >= 1);
  assert.ok(first.pauseCount >= 1);
  assert.ok(first.checkpoints.some((point) => point.action === "backspace"));
  assert.equal(first.checkpoints.find((point) => point.text)?.text, "👨‍👩‍👧‍👦", "emoji sequences remain one typed grapheme");
  const intervals = first.checkpoints.slice(1).map((point, index) => point.atMs - first.checkpoints[index].atMs);
  assert.ok(new Set(intervals).size > 4, "typing intervals must not be mechanically uniform");
  const differentEvent = buildConversationTypingSequence({ ...event, id: "typing-realism-2" });
  assert.notDeepEqual(first.checkpoints.map((point) => point.atMs), differentEvent.checkpoints.map((point) => point.atMs));
});

test("compiles story-first dialogue into local production timing and phone metadata", () => {
  const draft = defaultConversationDraft("owner-story-compiler");
  const self = draft.participants.find((participant) => participant.isSelf);
  const other = draft.participants.find((participant) => !participant.isSelf);
  const items = [
    { type: "text", participantId: other.id, text: "The client opened our rehearsal deck.", typingStyle: "natural" },
    { type: "text", participantId: self.id, text: "The one with the fake prices?", typingStyle: "fast" },
    { type: "text", participantId: other.id, text: "And your slide titled DO NOT PRESENT.", typingStyle: "natural" },
    { type: "notification", participantId: other.id, notificationTitle: "Client", text: "Can we discuss slide seven?", chatId: "client" },
    { type: "chat-switch", text: "Client", chatId: "client", chatTitle: "Client" },
    { type: "text", participantId: self.id, text: "Slide seven is an internal stress test.", typingStyle: "clean", chatId: "client", chatTitle: "Client" },
  ];
  const compiled = compileConversationStoryItems(items, draft);
  assert.equal(compiled.length, items.length);
  assert.ok(compiled.every((event) => Number.isInteger(event.delayBeforeMs) && Number.isInteger(event.holdMs)));
  assert.ok(compiled[0].typingMs > compiled[1].typingMs, "the local compiler keeps the phone owner brisk");
  assert.equal(compiled[0].receipt, "none");
  assert.equal(compiled[1].receipt, "delivered");
  assert.equal(compiled[3].typingMs, 0);
  assert.match(compiled[0].displayTime, /^\d{2}:\d{2}$/);
  const normalized = normalizeConversationDraft({ ...draft, events: compiled }, { ownerUserId: "owner-story-compiler" });
  assert.equal(normalized.events[4].chatId, "client");
});

test("normalizes notifications, low battery alerts, phone dialogue, and chat switching", () => {
  const draft = defaultConversationDraft("owner-phone-events");
  const self = draft.participants.find((participant) => participant.isSelf);
  const other = draft.participants.find((participant) => !participant.isSelf);
  draft.events.push(
    {
      id: "notify-second-chat", type: "notification", participantId: other.id, text: "Do not open that file.", notificationTitle: "Alex · Side chat",
      chatId: "side-chat", chatTitle: "Side chat", delayBeforeMs: 300, typingMs: 0, typingStyle: "natural", holdMs: 2_400, displayTime: "19:44",
      receipt: "none", reactions: [], edited: false, deleted: false, playAudio: false, callDialogue: [], charging: false,
    },
    {
      id: "battery-low", type: "battery", participantId: null, text: "", batteryLevel: 7, charging: false,
      chatId: "primary", chatTitle: "", delayBeforeMs: 200, typingMs: 0, typingStyle: "natural", holdMs: 2_800, displayTime: "19:44",
      receipt: "none", reactions: [], edited: false, deleted: false, playAudio: false, callDialogue: [], notificationTitle: "",
    },
    {
      id: "switch-side-chat", type: "chat-switch", participantId: null, text: "Side chat", chatId: "side-chat", chatTitle: "Side chat",
      delayBeforeMs: 150, typingMs: 0, typingStyle: "natural", holdMs: 700, displayTime: "19:44", receipt: "none", reactions: [],
      edited: false, deleted: false, playAudio: false, callDialogue: [], notificationTitle: "", charging: false,
    },
    {
      id: "connected-call", type: "call", participantId: other.id, text: "Phone call", callState: "completed", chatId: "side-chat", chatTitle: "Side chat",
      callDialogue: [
        { id: "call-one", participantId: other.id, text: "Can you hear me?", delayMs: 600 },
        { id: "call-two", participantId: self.id, text: "Barely. I have seven percent.", delayMs: 450 },
      ],
      delayBeforeMs: 300, typingMs: 0, typingStyle: "natural", holdMs: 8_000, displayTime: "19:45", receipt: "none", reactions: [],
      edited: false, deleted: false, playAudio: false, notificationTitle: "", charging: false,
    },
  );
  const normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-phone-events" });
  const timeline = buildConversationTimeline(normalized);
  assert.equal(normalized.events.find((event) => event.type === "battery").batteryLevel, 7);
  assert.equal(normalized.events.find((event) => event.type === "call").callDialogue.length, 2);
  assert.equal(timeline.entries.find((entry) => entry.eventId === "switch-side-chat").chatId, "side-chat");
  const sounds = conversationSoundEvents(normalized, timeline);
  assert.ok(sounds.some((sound) => sound.kind === "notification"));
  assert.ok(sounds.some((sound) => sound.kind === "battery"));
  assert.ok(sounds.some((sound) => sound.kind === "switch"));
  const html = buildConversationDocument(normalized, timeline);
  assert.match(html, /function activeChatAt\(ms\)/);
  assert.match(html, /notification-banner/);
  assert.match(html, /battery-alert/);
  assert.match(html, /call-screen/);
  assert.match(html, /callDialogueAt/);
  assert.match(html, /composerText\.textContent=typingText/);
});

test("offers guided and provider-independent conversation story starters before drafting", () => {
  const criteria = normalizeStarterCriteria({
    relationship: "Coworkers",
    genre: "Comedy",
    situation: "Wrong recipient",
    endingStyle: "Comic reversal",
    participantCount: 2,
    targetSeconds: 55,
  });
  assert.equal(criteria.relationship, "Coworkers");
  assert.equal(criteria.targetSeconds, 55);
  assert.equal(normalizeStarterCriteria({ targetSeconds: 900 }).targetSeconds, 900);
  assert.equal(normalizeStarterCriteria({ targetSeconds: "not-a-number", participantCount: 99 }).targetSeconds, 60);
  assert.equal(normalizeStarterCriteria({ participantCount: 99 }).participantCount, 12);
  const guided = guidedConversationPitch(criteria);
  assert.match(guided.premise, /coworkers/i);
  assert.match(guided.premise, /message reaches/i);

  const curated = curatedConversationPitches(criteria);
  assert.equal(curated.length, 3);
  assert.equal(new Set(curated.map((pitch) => pitch.id)).size, 3);
  assert.equal(curated[0].relationship, "Coworkers");
  assert.ok(curated.every((pitch) => pitch.premise.length >= 20));

  const generated = parseConversationPitches(JSON.stringify([
    { id: "one", title: "Specific one", premise: "Two siblings compare the same scheduled message and discover one copy contains a newly added detail.", relationship: "Siblings", genre: "Drama", situation: "Old promise", ending: "One sibling admits why the message changed.", tone: "quiet, precise, sincere", cast: [{ name: "Ada", role: "phone owner who notices details", isSelf: true }, { name: "Milo", role: "sibling who avoids direct answers", isSelf: false }] },
    { id: "two", title: "Specific two", premise: "Two coworkers trace a mistaken attachment while the intended recipient begins responding to comments hidden inside it.", relationship: "Coworkers", genre: "Suspense", situation: "Wrong recipient", ending: "They choose to acknowledge the mistake together.", tone: "urgent, dry, restrained", cast: [] },
    { id: "three", title: "Specific three", premise: "Two strangers negotiate a package swap while each avoids naming the nearly identical item they ordered.", relationship: "Strangers", genre: "Comedy", situation: "Misunderstanding", ending: "Both finally name the item at once.", tone: "wary, deadpan, playful", cast: [] },
  ]), { participantCount: 2 });
  assert.equal(generated.length, 3);
  assert.equal(generated[0].cast[0].isSelf, true);
  assert.deepEqual(parseConversationPitches("not json"), []);
});

test("progresses outgoing receipts and renders audible conversation effects", async () => {
  const normalized = normalizeConversationDraft(defaultConversationDraft("owner-audio"), { ownerUserId: "owner-audio" });
  const timeline = buildConversationTimeline(normalized);
  const outgoing = normalized.events.find((event) => event.receipt === "read");
  const entry = timeline.entries.find((item) => item.eventId === outgoing.id);
  assert.equal(conversationReceiptAt(outgoing, entry, entry.startMs), "sent");
  assert.equal(conversationReceiptAt(outgoing, entry, entry.deliveredMs), "delivered");
  assert.equal(conversationReceiptAt(outgoing, entry, entry.readMs), "read");
  const sounds = conversationSoundEvents(normalized, timeline);
  assert.ok(sounds.some((sound) => sound.kind === "incoming"));
  assert.ok(sounds.some((sound) => sound.kind === "outgoing"));
  assert.ok(sounds.some((sound) => sound.kind === "read"));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "reelio-conversation-effects-"));
  try {
    const output = path.join(outputDir, "effects.m4a");
    await renderConversationEffects(normalized, timeline, output);
    assert.ok((await stat(output)).size > 2_000);
    const measured = spawnSync(ffmpegPath, ["-i", output, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(measured.status, 0);
    const maxVolume = Number(/max_volume:\s*(-?[\d.]+)\s*dB/.exec(measured.stderr)?.[1]);
    assert.ok(Number.isFinite(maxVolume) && maxVolume > -30, `expected audible effects, received ${maxVolume} dB`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("validates character casts, event references, limits, and local conversation assets", () => {
  const draft = defaultConversationDraft("owner-1");
  draft.audio.mode = "characters";
  draft.participants[1].narratorId = draft.participants[0].narratorId;
  assert.throws(() => normalizeConversationDraft(draft, { ownerUserId: "owner-1" }), /distinct Reelio voice/);
  draft.participants[1].narratorId = "theo";
  draft.events[1].replyToEventId = draft.events[2].id;
  assert.throws(() => normalizeConversationDraft(draft, { ownerUserId: "owner-1" }), /reply to an earlier event/);
  draft.events[1].replyToEventId = draft.events[0].id;
  draft.events[0].assetId = "asset-1";
  draft.events[0].type = "image";
  assert.deepEqual(conversationAssetIds(normalizeConversationDraft(draft, { ownerUserId: "owner-1" })), ["asset-1"]);
  draft.events[0].displayTime = "20:00";
  draft.events[1].displayTime = "19:59";
  assert.throws(() => normalizeConversationDraft(draft, { ownerUserId: "owner-1" }), /must not move backward/);
  draft.events[0].displayTime = "23:59";
  draft.events[1].displayTime = "00:00";
  draft.events[2].displayTime = "00:01";
  assert.doesNotThrow(() => normalizeConversationDraft(draft, { ownerUserId: "owner-1" }), "midnight rollover remains monotonic");
});

test("snapshots a creator-selected local soundtrack as a conversation asset", () => {
  const draft = defaultConversationDraft("owner-music");
  draft.audio.musicEnabled = true;
  draft.audio.musicSource = "upload";
  draft.audio.musicAssetId = "soundtrack-1";
  const normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-music" });
  assert.equal(normalized.audio.musicSource, "upload");
  assert.equal(normalized.audio.musicEnabled, true);
  assert.ok(conversationAssetIds(normalized).includes("soundtrack-1"));
  const legacy = defaultConversationDraft("owner-legacy-music");
  delete legacy.audio.musicSource;
  legacy.audio.musicEnabled = true;
  assert.equal(normalizeConversationDraft(legacy, { ownerUserId: "owner-legacy-music" }).audio.musicSource, "brand");
});

test("loops selected music across the complete conversation duration", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "reelio-conversation-music-"));
  try {
    const input = path.join(outputDir, "short-tone.wav");
    const output = path.join(outputDir, "full-music.m4a");
    const generated = spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.35", "-c:a", "pcm_s16le", input], { encoding: "utf8" });
    assert.equal(generated.status, 0);
    await renderConversationMusic(input, 3.4, 0.2, output);
    const probe = spawnSync(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output], { encoding: "utf8" });
    assert.equal(probe.status, 0);
    assert.ok(Number(probe.stdout.trim()) >= 3.35);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("builds a self-contained conversation webpage without executing authored text", () => {
  const draft = defaultConversationDraft("owner-1");
  draft.events[0].text = `<script>window.compromised=true</script> ❤️`;
  const normalized = normalizeConversationDraft(draft, { ownerUserId: "owner-1" });
  const html = buildConversationDocument(normalized, buildConversationTimeline(normalized), { assetUrls: {} });
  assert.match(html, /Fictional conversation · Reelio/);
  assert.match(html, /window\.__reelioConversation/);
  assert.match(html, /textContent/);
  assert.match(html, /function visualSignature\(ms\)/);
  assert.match(html, /function receiptAt\(event,entry,ms\)/);
  assert.match(html, /reelio-conversation-sfx/);
  assert.match(html, /previewMusic/);
  assert.match(html, /animatedEvents=new Set/);
  assert.match(html, /signature===lastHeaderSignature/);
  assert.match(html, /function displayedClockAt\(ms\)/);
  assert.match(html, /C\.events\.find\(event=>event\.displayTime\)/);
  assert.match(html, /ms<entry\.typingStartMs/);
  assert.match(html, /clockLabel\(displayedClock,C\.clock\.format\)/);
  assert.match(html, /\.device #phoneHeader\{border-radius:30px 30px 0 0;overflow:hidden\}/);
  assert.match(html, /white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.match(html, /composerText\.scrollTop=composerText\.scrollHeight/);
  assert.match(html, /\.event\.stable\{animation:none\}/);
  assert.match(html, /el\('div','statusbar'\)/);
  assert.match(html, /el\('div','chat-nav'\)/);
  assert.doesNotMatch(html, /animation:blink/);
  assert.match(html, /if\(signature===lastVisualSignature\)\{postTime\(\);return currentMs\}/);
  assert.match(html, /function scheduleTick\(\)\{frameTimer=setTimeout/);
  assert.doesNotMatch(html, /<script>window\.compromised=true<\/script>/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /owner-1/);
  const rtl = defaultConversationDraft("owner-rtl");
  rtl.language = "Arabic";
  rtl.audio.mode = "silent";
  const rtlHtml = buildConversationDocument(
    normalizeConversationDraft(rtl, { ownerUserId: "owner-rtl" }),
    buildConversationTimeline(rtl),
  );
  assert.match(rtlHtml, /dir="rtl"/);
});

test("exposes independently runnable local and link media tools with validated inputs", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(({ id }) => id), [
    "chop",
    "download-media",
    "extract-audio",
    "extract-subtitles",
    "extract-web-captions",
    "long-video-analyze",
    "long-video-render",
    "transcribe",
    "translate",
    "speech-synthesis",
    "video-synthesis",
  ]);
  const chop = normalizeToolRequest({ toolId: "chop", inputs: { video: { uploadId: "video-1" } } });
  assert.deepEqual(chop.options, { clipSeconds: 180, overlapSeconds: 5 });
  const speech = normalizeToolRequest({ toolId: "speech-synthesis", inputs: { subtitles: { uploadId: "subtitles-1" } }, options: { narratorId: "theo" } });
  assert.equal(speech.options.narratorId, "theo");
  assert.equal(speech.options.ttsEngine, "kokoro");
  assert.equal(normalizeToolRequest({ toolId: "download-media", inputs: {}, options: { url: "https://example.com/watch/123" } }).options.url, "https://example.com/watch/123");
  assert.deepEqual(normalizeToolRequest({ toolId: "extract-web-captions", inputs: {}, options: { url: "https://video.example.org/item", language: "my" } }).options, {
    url: "https://video.example.org/item",
    language: "my",
  });
  assert.equal(normalizeToolRequest({
    toolId: "video-synthesis",
    inputs: {
      video: { toolJobId: "job-1", assetKey: "clip01" },
      audio: { uploadId: "audio-1" },
      subtitles: { uploadId: "subtitles-1" },
    },
  }).options.burnSubtitles, true);
  assert.throws(() => normalizeToolRequest({ toolId: "translate", inputs: {} }), ToolValidationError);
  assert.throws(() => normalizeToolRequest({ toolId: "chop", inputs: { video: { uploadId: "v" } }, options: { clipSeconds: 180, overlapSeconds: 180 } }), /between 0 and 179/);
  assert.throws(() => normalizeToolRequest({ toolId: "speech-synthesis", inputs: { subtitles: { uploadId: "subtitles-1" } }, options: { narratorId: "unknown" } }), /supported narrator/);
  assert.throws(() => normalizeToolRequest({ toolId: "download-media", inputs: {}, options: { url: "http://example.com/video" } }), /public HTTPS/);
  assert.throws(() => normalizeToolRequest({ toolId: "long-video-analyze", inputs: { media: { uploadId: "v" } }, options: {} }), /own or are licensed/);
  const longAnalysis = normalizeToolRequest({
    toolId: "long-video-analyze",
    inputs: { media: { uploadId: "v" } },
    options: { rightsConfirmed: true, cloudConsent: true, maxClips: 4, minClipSeconds: 20, maxClipSeconds: 50 },
  });
  assert.equal(longAnalysis.options.maxClips, 4);
  assert.equal(longAnalysis.options.cloudConsent, true);
  assert.throws(() => normalizeToolRequest({
    toolId: "long-video-render",
    inputs: { media: { uploadId: "v" }, analysis: { uploadId: "a" } },
    options: { rightsConfirmed: true, mirror: true },
  }), /creative remix edits/);
});

test("normalizes coherent long-video highlights and enforces explicit consent", () => {
  const cues = [
    { start: 0, end: 6, text: "The setup starts here." },
    { start: 6, end: 14, text: "A concrete example explains the problem." },
    { start: 14, end: 24, text: "The result provides a complete payoff." },
    { start: 25, end: 33, text: "A separate moment begins." },
  ];
  const candidates = normalizeHighlightCandidates([
    { start: 1, end: 22, title: "Complete explanation", hook: "Why this works", description: "The short explains the concrete example and follows it through to the result.", score: 91, reason: "Clear setup and payoff." },
    { start: 2, end: 21, title: "Duplicate", hook: "Same moment", score: 80, reason: "Overlaps." },
  ], cues, { duration: 34, maxClips: 5, minClipSeconds: 15, maxClipSeconds: 30 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, 0);
  assert.equal(candidates[0].end, 24);
  assert.match(candidates[0].transcript, /complete payoff/);
  assert.match(candidates[0].description, /follows it through/);
  assert.throws(() => validateLongVideoAnalyzeOptions({ cloudConsent: true }), /own or are licensed/);
  assert.throws(() => validateLongVideoAnalyzeOptions({ rightsConfirmed: true }), /transcript may be sent/);
  assert.throws(() => validateLongVideoRenderOptions({ rightsConfirmed: true, transitions: true }), /creative remix/);
  assert.equal(validateLongVideoRenderOptions({ rightsConfirmed: true, transitions: true, remixConfirmed: true }).transitions, true);
  const publishable = validateLongVideoRenderOptions({
    rightsConfirmed: true,
    packageTreatment: true,
    speechLanguage: "Spanish",
    subtitleLanguage: "French",
    ttsEngine: "gemini",
    narratorId: "ellis",
    platforms: ["youtube", "instagram"],
    candidates: [{ id: "highlight-01", start: 0, end: 24, title: "Complete explanation", transcript: "Reviewed source meaning.", framing: "center" }],
  });
  assert.equal(publishable.packageTreatment, true);
  assert.equal(publishable.speechLanguage, "Spanish");
  assert.equal(publishable.subtitleLanguage, "French");
  assert.equal(publishable.narratorId, "ellis");
  assert.deepEqual(publishable.platforms, ["youtube", "instagram"]);
  assert.equal(publishable.candidates[0].transcript, "Reviewed source meaning.");
  const ass = buildShortAss({ cues, duration: 24, hook: "A hook that wraps across several words", includeCaptions: true });
  assert.match(ass, /Style: Hook/);
  assert.match(ass, /The setup starts here/);
  assert.match(ass, /\\N/);
});

test("keeps localized publishing metadata first and summarizes beyond the opening line", () => {
  assert.equal(
    bilingualPublishingField("မြန်မာခေါင်းစဉ်", "English title"),
    "မြန်မာခေါင်းစဉ်\n\nEnglish title",
  );
  assert.equal(bilingualPublishingField("Same title", "Same title"), "Same title");
  assert.equal(hasBilingualPublishingPair("မြန်မာခေါင်းစဉ်\n\nEnglish title"), true);
  assert.equal(hasBilingualPublishingPair("English only"), false);
  const description = summarizePublishingScript("This is only the opening hook. The explanation establishes the mechanism. The ending reveals why the result matters.");
  assert.doesNotMatch(description, /only the opening hook/);
  assert.match(description, /establishes the mechanism/);
  assert.match(description, /why the result matters/);
});

test("builds a titled thumbnail treatment for every generated short", () => {
  const ass = buildShortThumbnailAss({ title: "The Moment of Truth", hook: "No telemetry. Just wait.", brand: { fontFamily: "Arial", accentColor: "#7c5cff" } });
  assert.match(ass, /REELIO HIGHLIGHT/);
  assert.match(ass, /The Moment of Truth/);
  assert.match(ass, /No telemetry\. Just wait\./);
  assert.equal(DEFAULT_LONG_VIDEO_TITLE_CARD_SECONDS, 1.5);
  assert.equal(longVideoTitleCardSeconds(), 1.5);
  assert.equal(longVideoTitleCardSeconds(0.2), 1);
  assert.equal(longVideoTitleCardSeconds(9), 2);
});

test("prepends the titled thumbnail and shifts publishable-short audio", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reelio-title-card-"));
  const clean = path.join(directory, "clean.mp4");
  const voice = path.join(directory, "voice.m4a");
  const music = path.join(directory, "music.m4a");
  const thumbnail = path.join(directory, "thumbnail.jpg");
  const captions = path.join(directory, "captions.ass");
  const output = path.join(directory, "final.mp4");
  try {
    const cleanResult = spawnSync(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "color=c=0x253040:size=180x320:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=360:sample_rate=48000",
      "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clean,
    ], { encoding: "utf8" });
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    for (const [file, frequency, duration] of [[voice, 620, 2.8], [music, 220, 4.5]]) {
      const audioResult = spawnSync(ffmpegPath, [
        "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`,
        "-t", String(duration), "-c:a", "aac", file,
      ], { encoding: "utf8" });
      assert.equal(audioResult.status, 0, audioResult.stderr);
    }
    const thumbnailResult = spawnSync(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "color=c=0x6f4bf3:size=180x320", "-frames:v", "1", thumbnail,
    ], { encoding: "utf8" });
    assert.equal(thumbnailResult.status, 0, thumbnailResult.stderr);
    await writeFile(captions, buildShortAss({
      cues: [{ start: 0.2, end: 2.7, text: "Narration begins after the title card." }],
      duration: 3,
      hook: "A fresh editorial title",
      includeCaptions: true,
    }));
    await assembleNarratedShort({
      cleanPath: clean,
      voicePath: voice,
      musicPath: music,
      thumbnailPath: thumbnail,
      captionsPath: captions,
      outputPath: output,
      duration: 3,
      titleCardSeconds: 1.5,
      includeCaptions: true,
      mixOriginalAudio: true,
    });
    const probe = spawnSync(ffprobe.path, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", output,
    ], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(Number(probe.stdout.trim()) >= 4.45);
    assert.ok((await stat(output)).size > 5_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders a reviewed long-video highlight through real FFmpeg", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reelio-long-video-"));
  const input = path.join(directory, "source.mp4");
  const analysis = path.join(directory, "analysis.json");
  const outputDir = path.join(directory, "outputs");
  const previousWidth = process.env.REELIO_SHORT_WIDTH;
  const previousHeight = process.env.REELIO_SHORT_HEIGHT;
  try {
    const generated = spawnSync(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8.5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", input,
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    await writeFile(analysis, JSON.stringify({
      version: 1,
      cues: [
        { start: 0.2, end: 3.8, text: "A complete opening line." },
        { start: 3.8, end: 8.2, text: "The example reaches its payoff." },
      ],
      candidates: [{ id: "highlight-01", title: "Smoke test", hook: "Watch the full moment", start: 0.1, end: 8.4, score: 90, reason: "Test" }],
    }));
    process.env.REELIO_SHORT_WIDTH = "180";
    process.env.REELIO_SHORT_HEIGHT = "320";
    const result = await renderLongVideoShorts({
      mediaFile: input,
      analysisFile: analysis,
      outputDir,
      options: validateLongVideoRenderOptions({
        rightsConfirmed: true,
        packageTreatment: false,
        captions: true,
        applyBrandKit: false,
        candidates: [{ id: "highlight-01", selected: true, start: 0.1, end: 8.4, title: "Smoke test", hook: "Watch the full moment", framing: "center" }],
      }),
      progress: async () => {},
    });
    assert.equal(result.metadata.clipCount, 1);
    assert.equal(result.assets.short01.type, "video");
    assert.equal(result.assets.short01Thumbnail.type, "image");
    assert.equal(result.metadata.clips[0].thumbnailAssetKey, "short01Thumbnail");
    assert.equal(result.metadata.clips[0].titleCardSeconds, 1.5);
    assert.ok(result.metadata.clips[0].duration > 9.7);
    assert.match(result.assets.short01.name, /smoke-test\.mp4$/i);
    assert.ok((await stat(result.assets.short01.file)).size > 10_000);
    assert.ok((await stat(result.assets.short01Thumbnail.file)).size > 1_000);
    await access(result.assets.manifest.file);
  } finally {
    restoreEnv("REELIO_SHORT_WIDTH", previousWidth);
    restoreEnv("REELIO_SHORT_HEIGHT", previousHeight);
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts public link-tool URLs and blocks private-network targets", () => {
  assert.equal(normalizeWebMediaUrl("https://media.example.com/video?id=1"), "https://media.example.com/video?id=1");
  assert.throws(() => normalizeWebMediaUrl("https://localhost/video"), /private-network/);
  assert.throws(() => normalizeWebMediaUrl("https://127.0.0.1/video"), /private-network/);
  assert.throws(() => normalizeWebMediaUrl("https://192.168.1.10/video"), /private-network/);
  assert.throws(() => normalizeWebMediaUrl("file:///tmp/video.mp4"), /public HTTPS/);
});

test("selects one manual web caption track before automatic translations", () => {
  const metadata = {
    subtitles: { "en-US": [{}], es: [{}] },
    automatic_captions: { en: [{}], "en-orig": [{}], my: [{}] },
  };
  assert.deepEqual(selectWebCaptionTrack(metadata, "en"), { language: "en-US", automatic: false });
  assert.deepEqual(selectWebCaptionTrack({ subtitles: {}, automatic_captions: metadata.automatic_captions }, "en"), { language: "en-orig", automatic: true });
  assert.deepEqual(selectWebCaptionTrack(metadata, "my"), { language: "my", automatic: true });
  assert.equal(selectWebCaptionTrack(metadata, "de"), null);
});

test("plans the requested 3-minute chop windows with a 5-second overlap", () => {
  assert.deepEqual(planChopSegments(530, 180, 5), [
    { start: 0, length: 180 },
    { start: 175, length: 180 },
    { start: 350, length: 180 },
  ]);
  assert.deepEqual(planChopSegments(531, 180, 5), [
    { start: 0, length: 180 },
    { start: 175, length: 180 },
    { start: 350, length: 180 },
    { start: 525, length: 6 },
  ]);
});

test("parses SRT and VTT subtitles and preserves multiline cue timing", () => {
  const cues = parseSubtitles("WEBVTT\n\n00:00:00.500 --> 00:00:02.250 align:start\nFirst line\nSecond line\n\n00:03.000 --> 00:04.125\nNext cue");
  assert.deepEqual(cues, [
    { start: 0.5, end: 2.25, text: "First line\nSecond line" },
    { start: 3, end: 4.125, text: "Next cue" },
  ]);
  assert.match(formatSrt(cues), /00:00:00,500 --> 00:00:02,250\nFirst line\nSecond line/);
});

test("defaults transcription to Gemini Flash-Lite and retains explicit local routing", () => {
  const previousProvider = process.env.REELIO_STT_PROVIDER;
  const previousModel = process.env.GEMINI_STT_MODEL;
  try {
    delete process.env.REELIO_STT_PROVIDER;
    delete process.env.GEMINI_STT_MODEL;
    assert.equal(DEFAULT_GEMINI_STT_MODEL, "gemini-3.5-flash-lite");
    assert.equal(sttConfig().provider, "gemini");
    assert.equal(sttConfig().geminiModel, "gemini-3.5-flash-lite");
    process.env.REELIO_STT_PROVIDER = "local";
    assert.equal(sttConfig().provider, "faster-whisper");
  } finally {
    restoreEnv("REELIO_STT_PROVIDER", previousProvider);
    restoreEnv("GEMINI_STT_MODEL", previousModel);
  }
});

test("validates Gemini transcript cues and derives reusable transcript text", () => {
  assert.deepEqual(normalizeGeminiTranscript({
    language: "EN",
    cues: [
      { start: 2.5, end: 4, text: "  Second   cue " },
      { start: 0, end: 2.25, text: "First cue" },
    ],
  }, null, { provider: "gemini", model: DEFAULT_GEMINI_STT_MODEL }), {
    cues: [
      { start: 0, end: 2.25, text: "First cue" },
      { start: 2.5, end: 4, text: "Second cue" },
    ],
    text: "First cue Second cue",
    language: "en",
    languageProbability: null,
    fallbackWithoutVad: false,
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
  });
  assert.throws(() => normalizeGeminiTranscript({ language: "en", cues: [{ start: 2, end: 1, text: "bad" }] }), /invalid transcript cue/);
  assert.throws(() => normalizeGeminiTranscript({ language: "en", cues: [] }), /No recognizable speech/);
});

test("converts display language names to transcription language codes", () => {
  assert.equal(sttLanguageCode("auto"), null);
  assert.equal(sttLanguageCode("English"), "en");
  assert.equal(sttLanguageCode("Burmese"), "my");
  assert.equal(sttLanguageCode("th"), "th");
  assert.throws(() => sttLanguageCode("Klingon"), /Unsupported transcription language/);
});

test("runs audio and video synthesis tools against real FFmpeg media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelio-tool-"));
  try {
    const input = path.join(root, "source.mp4");
    const generated = spawnSync(ffmpegPath, [
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", input,
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const customThemeClip = path.join(root, "custom-theme.mp4");
    await normalizeStockClip(input, customThemeClip, 0.4, { motion: "pan", grade: "eq=contrast=1.02:saturation=1.04" });
    assert.ok((await stat(customThemeClip)).size > 1_000);
    await access(customThemeClip);
    const outputDir = path.join(root, "output");
    const result = await executeTool({
      request: normalizeToolRequest({ toolId: "extract-audio", inputs: { video: { uploadId: "video-1" } }, options: { format: "wav" } }),
      inputs: { video: { file: input } },
      outputDir,
      progress: async () => {},
    });
    assert.equal(result.assets.audio.type, "audio");
    assert.ok(result.assets.audio.bytes > 1_000);
    await access(result.assets.audio.file);

    const subtitles = path.join(root, "translated.srt");
    await writeFile(subtitles, "1\n00:00:00,000 --> 00:00:00,900\nA translated subtitle.\n", "utf8");
    const embeddedVideo = path.join(root, "embedded-subtitles.mkv");
    const muxed = spawnSync(ffmpegPath, [
      "-y", "-i", input, "-i", subtitles,
      "-map", "0:v:0", "-map", "0:a?", "-map", "1:0",
      "-c", "copy", "-c:s", "srt", "-metadata:s:s:0", "language=eng", embeddedVideo,
    ], { encoding: "utf8" });
    assert.equal(muxed.status, 0, muxed.stderr);
    const extractedSubtitles = await executeTool({
      request: normalizeToolRequest({ toolId: "extract-subtitles", inputs: { video: { uploadId: "video-with-subs" } }, options: { trackIndex: 0 } }),
      inputs: { video: { file: embeddedVideo } },
      outputDir: path.join(root, "subtitle-output"),
      progress: async () => {},
    });
    assert.equal(extractedSubtitles.assets.subtitles.type, "subtitles");
    assert.equal(extractedSubtitles.metadata.usedSpeechRecognition, false);
    assert.match(await readFile(extractedSubtitles.assets.subtitles.file, "utf8"), /A translated subtitle/);
    const logo = path.join(root, "logo.png");
    const generatedLogo = spawnSync(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "color=c=red:s=80x80:d=0.1", "-frames:v", "1", "-threads", "1", logo,
    ], { encoding: "utf8" });
    assert.equal(generatedLogo.status, 0, generatedLogo.stderr);
    const brandKit = {
      ...defaultBrandKit(),
      enabled: true,
      name: "Test Brand",
      assets: {
        logo: { id: "logo-1", kind: "logo", file: logo, name: "logo.png", bytes: (await stat(logo)).size, mediaType: "image/png", width: 80, height: 80, createdAt: new Date().toISOString() },
        intro: { id: "intro-1", kind: "intro", file: input, name: "intro.mp4", bytes: (await stat(input)).size, mediaType: "video/mp4", durationSeconds: 0.4, createdAt: new Date().toISOString() },
        outro: { id: "outro-1", kind: "outro", file: input, name: "outro.mp4", bytes: (await stat(input)).size, mediaType: "video/mp4", durationSeconds: 0.4, createdAt: new Date().toISOString() },
        music: { id: "music-1", kind: "music", file: result.assets.audio.file, name: "music.wav", bytes: result.assets.audio.bytes, mediaType: "audio/wav", durationSeconds: 1, createdAt: new Date().toISOString() },
      },
    };
    const videoRequest = normalizeToolRequest({
      toolId: "video-synthesis",
      inputs: {
        video: { uploadId: "video-1" },
        audio: { toolJobId: "audio-job", assetKey: "audio" },
        subtitles: { uploadId: "subtitles-1" },
      },
      options: { applyBrandKit: true },
    });
    videoRequest.options.brandKit = brandKit;
    const videoResult = await executeTool({
      request: videoRequest,
      inputs: { video: { file: input }, audio: { file: result.assets.audio.file }, subtitles: { file: subtitles } },
      outputDir: path.join(root, "video-output"),
      progress: async () => {},
    });
    assert.equal(videoResult.assets.video.type, "video");
    assert.equal(videoResult.metadata.brandKitApplied, true);
    assert.ok(videoResult.assets.video.bytes > 1_000);
    await access(videoResult.assets.video.file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes and protects the production Brand Kit contract", () => {
  const defaults = defaultBrandKit("2026-01-01T00:00:00.000Z");
  assert.equal(defaults.enabled, false, "a placeholder kit must not brand videos before the user activates it");
  const kit = updateBrandKit(defaults, {
    name: "Reelio Daily",
    primaryColor: "#112233",
    accentColor: "#abcdef",
    captionStyle: "minimal",
    defaultNarratorId: "nova",
    website: "https://example.com/channel",
  }, "2026-01-02T00:00:00.000Z");
  assert.equal(kit.name, "Reelio Daily");
  assert.equal(kit.defaultNarratorId, "nova");
  assert.equal(kit.captionStyle, "minimal");
  assert.equal(publicBrandKit(kit).assets.logo, null);
  assert.throws(() => updateBrandKit(kit, { website: "javascript:alert(1)" }), BrandKitError);
  assert.throws(() => validateBrandAssetUpload("logo", { name: "logo.svg", bytes: 100, mediaType: "image/svg+xml" }), /unsupported file type/);
  assert.doesNotThrow(() => validateBrandAssetUpload("music", { name: "bed.wav", bytes: 1024, mediaType: "audio/wav" }));
});

test("chooses topic-aware look, pacing, and voice tone per category", () => {
  const tech = styleProfile("Technology");
  assert.equal(tech.clipSeconds, 2.8);
  assert.equal(tech.kokoroSpeed, 1.04);
  assert.ok(tech.transitions.includes("slideleft"));
  assert.ok(tech.subtitle.fontsize >= 60);
  const wellness = styleProfile("Wellness");
  assert.ok(wellness.kokoroSpeed < tech.kokoroSpeed, "calm topics narrate slower than energetic ones");
  // Kokoro clips phoneme durations above ~1.1, which flattens prosody; duration fitting happens
  // downstream in fitNarration instead of by synthesizing fast.
  for (const category of ["Technology", "Business", "History", "Wellness", "Psychology", "Knowledge"]) {
    assert.ok(styleProfile(category).kokoroSpeed <= 1.06, `${category} narrates at a natural rate`);
  }
  const fallback = styleProfile("Something unmapped");
  assert.equal(fallback.clipSeconds, 3.2);
  assert.ok(Array.isArray(fallback.motions) && fallback.motions.length > 0);
});

test("keeps the raised music bed below the narration level", () => {
  assert.deepEqual(MUSIC_MIX_LEVELS, { intro: 0.80, bed: 0.48, ending: 0.72 });
  assert.ok(MUSIC_MIX_LEVELS.bed < MUSIC_MIX_LEVELS.ending);
  assert.ok(MUSIC_MIX_LEVELS.ending < MUSIC_MIX_LEVELS.intro);
  assert.ok(MUSIC_MIX_LEVELS.intro < 1);
});

test("normalizes production automation schedules and protects automatic publishing", () => {
  const template = {
    prompt: "Create one useful scheduled knowledge video",
    category: "Knowledge",
    duration: "60 sec",
    language: "English",
    subtitleLanguage: "English",
    platforms: [],
  };
  const schedule = normalizeAutomationCreate({
    name: " Weekday video ",
    cron: "30 8 * * 1-5",
    timezone: "Asia/Bangkok",
    template,
  });
  assert.equal(schedule.name, "Weekday video");
  assert.equal(schedule.mode, "quick");
  assert.equal(schedule.briefSource, "suggested");
  assert.equal(schedule.publishMode, "review");
  assert.equal(schedule.requireReview, true);
  assert.equal(schedule.template.ttsEngine, "kokoro");
  assert.throws(() => normalizeAutomationCreate({
    name: "Unsafe publisher",
    cron: "30 8 * * *",
    timezone: "Asia/Bangkok",
    publishMode: "auto",
    template,
  }), /requires at least one platform/);
  const automatic = normalizeAutomationCreate({
    name: "Approved auto publisher",
    cron: "30 8 * * *",
    timezone: "Asia/Bangkok",
    publishMode: "auto",
    template: { ...template, platforms: ["youtube"] },
  });
  assert.equal(automationPublishMode(automatic), "auto");
  assert.equal(automatic.requireReview, false);
  const patch = normalizeAutomationPatch(automatic, { enabled: false, name: "Paused publisher" });
  assert.deepEqual(patch, { enabled: false, name: "Paused publisher" });
  assert.equal(activeAutomationJob([
    { id: "complete", state: "completed", trigger: { automationId: "schedule-1" } },
    { id: "active", state: "completed", publishState: "running", trigger: { automationId: "schedule-1" } },
  ], "schedule-1")?.id, "active");
});

test("builds dated calendar entries with many posts per day and independent pipelines", () => {
  const template = {
    prompt: "Generate a fresh brief",
    category: "Science",
    duration: "60 sec",
    language: "English",
    subtitleLanguage: "English",
    platforms: [],
  };
  const first = normalizeAutomationCreate({
    mode: "calendar",
    name: "Science calendar",
    briefSource: "suggested",
    color: "#6f4bf3",
    timezone: "Asia/Bangkok",
    startDate: "2026-07-20",
    endDate: "2026-07-21",
    weekdays: [1, 2],
    times: ["08:30", "13:30", "18:30"],
    template,
  });
  const second = normalizeAutomationCreate({
    mode: "calendar",
    name: "Technology calendar",
    briefSource: "news",
    color: "#18a7b8",
    timezone: "Asia/Bangkok",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    weekdays: [1],
    times: ["09:00", "17:00"],
    template: { ...template, category: "Technology" },
  });
  const ids = Array.from({ length: 8 }, (_, index) => `entry-${index}`);
  const entries = buildCalendarEntries({ id: "science", ...first }, new Date("2026-07-01T00:00:00Z"), () => ids.shift());
  const otherEntries = buildCalendarEntries({ id: "technology", ...second }, new Date("2026-07-01T00:00:00Z"), () => ids.shift());
  assert.equal(entries.length, 6);
  assert.equal(otherEntries.length, 2);
  assert.deepEqual(entries.filter((entry) => entry.date === "2026-07-20").map((entry) => entry.time), ["08:30", "13:30", "18:30"]);
  assert.ok(entries.every((entry) => entry.automationId === "science" && entry.briefState === "pending"));
  assert.ok(otherEntries.every((entry) => entry.automationId === "technology" && entry.briefSource === "news"));
  assert.deepEqual(calendarCronExpressions({ mode: "calendar", weekdays: [1, 2], times: ["08:30", "18:30"] }), ["30 8 * * 1,2", "30 18 * * 1,2"]);
  assert.throws(() => normalizeAutomationCreate({ mode: "quick", name: "Missing cron", timezone: "UTC", template }), /requires a cron expression/);
});

test("builds Ken Burns motion filters for zoom and pan", () => {
  assert.match(motionFilter("zoomin"), /zoompan=z='min\(zoom\+/);
  assert.match(motionFilter("zoomout"), /zoompan=z='if\(eq\(on,0\),1\.35,max\(1\.001/);
  assert.match(motionFilter("pan"), /^crop=720:1280:x='20\+20\*sin/);
});

test("assembles a cross-clip transition graph that lands on the target length", () => {
  assert.match(buildXfadeChain(1, 3.2, 0.5, ["fade"]), /\[0:v\]scale=1080:1920[^;]*\[vout\]/);
  const graph = buildXfadeChain(3, 3.2, 0.5, ["fade", "slideleft"]);
  const offsets = [...graph.matchAll(/xfade=transition=(\w+):duration=0\.50:offset=([\d.]+)/g)];
  assert.equal(offsets.length, 2);
  assert.deepEqual(offsets.map((match) => match[2]), ["2.70", "5.40"]);
  assert.equal(offsets[0][1], "fade");
  assert.equal(offsets[1][1], "slideleft");
  assert.match(graph, /\[vout\]$/);
});

test("applies a per-topic subtitle style without changing the default", () => {
  const cues = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
  const styled = buildAss(["One line here", "Two line here"], cues, 4, "Arial", { fontsize: 66, outline: "&H00A85200", marginV: 470, animate: true });
  // BorderStyle 1 (outline stroke, no background box); the outline colour is the stroke.
  assert.match(styled, /Style: Reelio,Arial,66,&H00FFFFFF,&H00FFFFFF,&H00A85200,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,90,90,470,1/);
  assert.match(styled, /Dialogue: 0,[^,]+,[^,]+,Reelio,,0,0,0,,\{\\fad\(120,90\)\}/);
  const plain = buildAss(["One line here", "Two line here"], cues, 4);
  assert.match(plain, /Style: Reelio,Arial,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,90,90,430,1/);
  assert.doesNotMatch(plain, /\\fad/);
  // No opaque background box: BorderStyle must be 1, not 3.
  assert.doesNotMatch(plain, /,0,0,3,\d+,0,2,/);
});

test("renders kinetic word-by-word karaoke captions when a topic enables them", () => {
  const cues = [{ start: 0, end: 2.4 }];
  const kinetic = buildAss(["Solid state drives have no moving parts"], cues, 2.4, "Arial", styleProfile("Technology").subtitle);
  // Active (sung) colour is the topic highlight; unsung words stay white.
  assert.match(kinetic, /Style: Reelio,Arial,66,&H00FFFF00,&H00FFFFFF,/);
  assert.match(kinetic, /\{\\kf\d+\}Solid \{\\kf\d+\}state/);
  // The plain default has no karaoke tags and keeps the original size/margin.
  const plain = buildAss(["Solid state drives have no moving parts"], cues, 2.4);
  assert.doesNotMatch(plain, /\\kf/);
  assert.match(plain, /Style: Reelio,Arial,62,&H00FFFFFF,&H00FFFFFF,/);
});

test("wraps long kinetic captions to new lines so they never overflow the frame width", () => {
  const long = "This surprisingly long sentence keeps going well past a single readable caption line";
  const style = styleProfile("Technology").subtitle; // fontsize 66
  const ass = buildAss([long], [{ start: 0, end: 4 }], 4, "Arial", style);
  const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue"));
  assert.ok(dialogue.includes("\\N"), "a long caption is broken across lines");
  // Each rendered line (tags stripped) must fit the font-derived width budget.
  const maxChars = Math.floor(900 / (66 * 0.6));
  const visibleLines = dialogue.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "").split("\\N");
  for (const line of visibleLines) assert.ok(line.trim().length <= maxChars + 1, `line "${line.trim()}" (${line.trim().length}) exceeds ${maxChars}`);
});

test("aligns each clip's footage query to the narration line playing during it", () => {
  const cues = [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }];
  const queries = ["person writing a to-do list", "coffee shop counter", "runner tying shoes"];
  const plan = planClipQueries(4, 3, 0.5, cues, queries); // step = 2.5s
  assert.deepEqual(plan, [
    "person writing a to-do list", // midpoint 1.5s -> line 0
    "coffee shop counter",         // midpoint 4.0s -> line 1
    "runner tying shoes",          // midpoint 6.5s -> line 2
    "runner tying shoes",          // midpoint 9.0s -> past end, last line
  ]);
  // Never round-robins back to the first line for a later clip.
  assert.notEqual(plan[3], queries[0]);
});

test("keeps consecutive Pexels clips inside reviewed visual themes", () => {
  const cues = [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }, { start: 9, end: 12 }];
  const themes = [
    { title: "Daily problem", startSegment: 0, endSegment: 1, queries: ["unfinished checklist desk", "worker reviewing notebook"] },
    { title: "Practical payoff", startSegment: 2, endSegment: 3, queries: ["person completing focused task", "organized desk success"] },
  ];
  assert.deepEqual(planThemeQueries(5, 3, 0.5, cues, themes), [
    "unfinished checklist desk",
    "worker reviewing notebook",
    "person completing focused task",
    "organized desk success",
    "person completing focused task",
  ]);
  assert.deepEqual(planThemeSlots(3, 3, 0.5, cues, themes), [
    { themeIndex: 0, query: "unfinished checklist desk" },
    { themeIndex: 0, query: "worker reviewing notebook" },
    { themeIndex: 1, query: "person completing focused task" },
  ]);
});

test("builds storyboard themes locally without a text-provider call", () => {
  const plan = createLocalVisualThemePlan([
    "A reusable rocket returns toward the launch site.",
    "Its engines guide the vehicle through the atmosphere.",
    "Engineers inspect the recovered booster.",
    "The next mission can reuse major hardware.",
    "Factories still manufacture replacement components.",
    "Teams compare turnaround time and maintenance cost.",
    "The result depends on safe and reliable recovery.",
    "That tradeoff shapes the launch schedule.",
  ], "Technology");
  assert.equal(plan.mode, "studio");
  assert.equal(plan.provider, "built-in");
  assert.ok(plan.themes.length >= 2);
  assert.equal(plan.themes[0].startSegment, 0);
  assert.equal(plan.themes.at(-1).endSegment, 7);
  assert.ok(plan.themes.every((theme) => theme.queries.length >= 1));
});

test("falls back to every healthy stock provider and ranks mixed results with diversity", async () => {
  const pixabayVideo = { id: "pixabay-v10", provider: "pixabay", type: "video", width: 720, height: 1280, tags: "focused office work" };
  const pexelsVideo = { id: "v20", provider: "pexels", type: "video", width: 720, height: 1280, title: "Focused office work" };
  const missingPrimary = await collectStockProviderResults([
    { id: "pexels", configured: false, search: async () => { throw new Error("must not run"); } },
    { id: "pixabay", configured: true, search: async () => [pixabayVideo] },
  ], "focused office work");
  assert.deepEqual(missingPrimary.items.map((item) => item.id), ["pixabay-v10"]);
  assert.equal(missingPrimary.providers.pexels.configured, false);

  const failedPrimary = await collectStockProviderResults([
    { id: "pexels", configured: true, search: async () => { throw new Error("provider timeout"); } },
    { id: "pixabay", configured: true, search: async () => [pixabayVideo] },
  ], "focused office work");
  assert.deepEqual(failedPrimary.items.map((item) => item.id), ["pixabay-v10"]);
  assert.equal(failedPrimary.providers.pexels.available, false);
  assert.equal(failedPrimary.providers.pixabay.returned, true);

  const emptyPrimary = await collectStockProviderResults([
    { id: "pexels", configured: true, search: async () => [] },
    { id: "pixabay", configured: true, search: async () => [pixabayVideo] },
  ], "focused office work");
  assert.deepEqual(emptyPrimary.items.map((item) => item.id), ["pixabay-v10"]);
  assert.equal(emptyPrimary.providers.pexels.available, true);
  assert.equal(emptyPrimary.providers.pexels.returned, false);

  const ranked = rankStockCandidates([
    pexelsVideo,
    { ...pexelsVideo, id: "v21" },
    { ...pexelsVideo, id: "v22" },
    pixabayVideo,
  ], "focused office work", 3);
  assert.ok(ranked.some((item) => item.provider === "pexels"));
  assert.ok(ranked.some((item) => item.provider === "pixabay"));
});

test("allocates different stock candidates when storyboard themes reuse the same search", () => {
  const query = "focused office work";
  const items = Array.from({ length: 18 }, (_, index) => ({
    id: `v${index + 1}`,
    provider: "pexels",
    type: "video",
    width: 720,
    height: 1280,
    title: query,
    url: `https://videos.pexels.com/video-files/${index + 1}/clip.mp4`,
    preview: `https://images.pexels.com/photos/${index + 1}/preview.jpeg`,
    page: `https://www.pexels.com/video/${index + 1}/`,
    creator: `Creator ${index + 1}`,
  }));
  const themes = Array.from({ length: 3 }, (_, index) => ({
    title: `Theme ${index + 1}`,
    startSegment: index,
    endSegment: index,
    queries: [query],
  }));
  const groups = allocateStoryboardCandidates(themes, new Map([[query, { items }]]), 6);
  const ids = groups.flatMap((group) => group.candidates.map((candidate) => candidate.id));
  assert.deepEqual(groups.map((group) => group.candidates.length), [6, 6, 6]);
  assert.equal(new Set(ids).size, 18, "a clip is offered to only one theme");
});

test("extracts pause markers into silence gaps and clean text", () => {
  const { segments, pauses } = extractPauses([
    "Here is the surprising part [pause]",
    "It changes how you focus…",
    "Try it today.",
  ]);
  assert.deepEqual(segments, ["Here is the surprising part", "It changes how you focus", "Try it today."]);
  assert.equal(pauses.length, 3);
  assert.ok(pauses[0] >= 0.45, "explicit [pause] marker adds a gap");
  assert.ok(pauses[1] >= 0.3, "trailing ellipsis adds a shorter gap");
  assert.equal(pauses[2], 0);
  assert.ok(segments.every((segment) => !/\[pause\]|…/.test(segment)), "markers never reach TTS or subtitles");
});

test("parses an optional brand-voice blend and ignores single or empty values", () => {
  assert.deepEqual(parseVoiceBlend("af_heart:0.6,af_bella:0.4"), [{ name: "af_heart", weight: 0.6 }, { name: "af_bella", weight: 0.4 }]);
  const normalized = parseVoiceBlend("af_heart:3,af_bella:1");
  assert.equal(normalized[0].weight + normalized[1].weight, 1);
  assert.equal(parseVoiceBlend(""), null);
  assert.equal(parseVoiceBlend("af_heart:1"), null, "a single voice is not a blend");
  assert.equal(parseVoiceBlend(undefined), null);
});

test("keeps every subtitle cue inside the narration duration", () => {
  const srt = buildSrt(Array.from({ length: 20 }, (_, index) => `Subtitle segment ${index + 1}`), 8);
  const times = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})/g)];
  assert.equal(times.length, 20);
  for (const match of times) assert.notEqual(match[1], match[2]);
  assert.match(times.at(-1)[2], /00:00:08,000/);
});

test("honors short smoke-test durations and normal reel ranges", () => {
  assert.equal(chooseDuration("8 sec", 70), 8);
  assert.equal(chooseDuration("60–90 sec", 72), 73.25);
  assert.equal(chooseDuration("60–90 sec", 120), 90);
  assert.equal(chooseDuration("90 sec", 105, "Burmese"), 106.25);
  assert.equal(chooseDuration("Up to 3 min", 112), 113.25);
  assert.deepEqual(durationBounds("2 min"), { min: 120, max: 120 });
});

test("fits localized narration to the source speaking time with real FFmpeg", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reelio-language-timing-"));
  const input = path.join(directory, "translated.m4a");
  try {
    const generated = spawnSync(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000",
      "-t", "3", "-c:a", "aac", input,
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const plan = narrationFitPlan(3, 2.4, { exactDuration: true, desiredDuration: 2 });
    assert.equal(plan.speed, 1.5);
    const fitted = await fitNarration({
      path: input,
      duration: 3,
      cues: [{ start: 0, end: 3 }],
      providerLabel: "test voice",
    }, 2.4, directory, { exactDuration: true, desiredDuration: 2 });
    assert.ok(Math.abs(fitted.duration - 2) < 0.08, `expected ~2s, received ${fitted.duration}s`);
    assert.ok(Math.abs(fitted.cues[0].end - fitted.duration) < 0.01);
    assert.equal(fitted.speed, 1.5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offers ten distinct, validated script structures", () => {
  assert.equal(DEFAULT_SCRIPT_STYLE, "clear-explainer");
  assert.deepEqual(SCRIPT_STYLES.map((style) => style.id), [
    "clear-explainer",
    "story-led",
    "problem-solution",
    "myth-fact",
    "list-format",
    "question-led",
    "case-study",
    "compare-contrast",
    "timeline",
    "practical-guide",
  ]);
  assert.equal(scriptStyleProfile("story-led").label, "Story-led");
  assert.equal(scriptStyleProfile("unknown").id, DEFAULT_SCRIPT_STYLE);
});

test("validates generation requests before queuing work", () => {
  const request = normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "English", subtitleLanguage: "Thai", platforms: ["youtube", "youtube", "tiktok"] });
  assert.equal(request.language, "English");
  assert.equal(request.ttsEngine, "kokoro");
  assert.equal(request.scriptStyle, "clear-explainer");
  assert.equal(request.narratorId, "maya");
  assert.deepEqual(request.platforms, ["youtube", "tiktok"]);
  const burmeseVoice = normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "Burmese", subtitleLanguage: "Burmese", platforms: [] });
  assert.equal(burmeseVoice.language, "Burmese");
  assert.equal(burmeseVoice.ttsEngine, "voxcpm2");
  assert.equal(burmeseVoice.subtitleLanguage, "Burmese");
  assert.equal(normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "Khmer", subtitleLanguage: "Khmer", platforms: [] }).ttsEngine, "voxcpm2");
  assert.equal(normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "English", ttsEngine: "gemini", subtitleLanguage: "English", platforms: [] }).ttsEngine, "gemini");
  assert.throws(() => normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "Khmer", ttsEngine: "gemini", subtitleLanguage: "Khmer", platforms: [] }), /choose VoxCPM2/);
  assert.throws(() => normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "Burmese", ttsEngine: "kokoro", subtitleLanguage: "Burmese", platforms: [] }), /Non-English speech supports/);
  assert.throws(() => normalizeVideoRequest({ prompt: "ok", duration: "5 sec", platforms: [] }), ValidationError);
  assert.throws(() => normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: ["unknown"] }), /Unsupported platform/);
  assert.equal(normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], scriptStyle: "case-study" }).scriptStyle, "case-study");
  assert.throws(() => normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], scriptStyle: "sensational-clickbait" }), /Unsupported script style/);
  assert.equal(normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], narratorId: "nova" }).narratorId, "nova");
  assert.throws(() => normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], narratorId: "celebrity-clone" }), /Unsupported narrator/);
  assert.equal(normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], sourceJobId: "source-video-job-123" }).sourceJobId, "source-video-job-123");
  const reviewed = normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], approvedScript: "This reviewed script is intentionally long enough for the validation contract." });
  assert.match(reviewed.approvedScript, /reviewed script/);
  const themed = normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: [
      { title: "Opening problem", startSegment: 0, endSegment: 2, queries: ["person checking unfinished list", "busy office desk"] },
      { title: "Useful solution", startSegment: 3, endSegment: 5, queries: ["person completing focused work"] },
    ],
  });
  assert.equal(themed.visualThemes.length, 2);
  const storyboard = normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: [
      { title: "Opening problem", startSegment: 0, endSegment: 2, queries: ["person checking unfinished list"] },
      { title: "Useful solution", startSegment: 3, endSegment: 5, queries: ["person completing focused work"] },
    ],
    visualSelections: [
      {
        themeIndex: 0,
        mode: "media",
        mediaId: "v123",
        mediaType: "video",
        mediaUrl: "https://videos.pexels.com/video-files/123/123-hd.mp4",
        sourceUrl: "https://www.pexels.com/video/example-123/",
        creator: "Pexels Creator",
        query: "person checking unfinished list",
      },
      { themeIndex: 1, mode: "motion" },
    ],
  });
  assert.equal(storyboard.visualSelections[0].mediaId, "v123");
  assert.deepEqual(storyboard.visualSelections[1], { themeIndex: 1, mode: "motion" });
  const customStoryboard = normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [
      {
        themeIndex: 0,
        mode: "custom",
        uploadId: "123e4567-e89b-42d3-a456-426614174000",
        fileName: "my opening clip.mp4",
      },
      { themeIndex: 1, mode: "motion" },
    ],
  });
  assert.deepEqual(customStoryboard.visualSelections[0], {
    themeIndex: 0,
    mode: "custom",
    uploadId: "123e4567-e89b-42d3-a456-426614174000",
    fileName: "my opening clip.mp4",
  });
  assert.throws(() => normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [
      { themeIndex: 0, mode: "custom", uploadId: "../source.mp4", fileName: "source.mp4" },
      { themeIndex: 1, mode: "motion" },
    ],
  }), /invalid custom video reference/);
  const pixabayStoryboard = normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [
      {
        themeIndex: 0,
        mode: "media",
        provider: "pixabay",
        mediaId: "pixabay-v125",
        mediaType: "video",
        mediaUrl: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_medium.mp4",
        sourceUrl: "https://pixabay.com/videos/id-125/",
        creator: "Pixabay Creator",
        query: "person checking unfinished list",
      },
      { themeIndex: 1, mode: "motion" },
    ],
  });
  assert.equal(pixabayStoryboard.visualSelections[0].provider, "pixabay");
  assert.throws(() => normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [
      {
        themeIndex: 0,
        mode: "media",
        provider: "pixabay",
        mediaId: "pixabay-v125",
        mediaType: "video",
        mediaUrl: "https://example.com/untrusted.mp4",
        sourceUrl: "https://pixabay.com/videos/id-125/",
        creator: "Pixabay Creator",
        query: "person checking unfinished list",
      },
      { themeIndex: 1, mode: "motion" },
    ],
  }), /approved Pixabay host/);
  assert.throws(() => normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [{ themeIndex: 0, mode: "motion" }],
  }), /one visual option for every theme/);
  assert.throws(() => normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: themed.visualThemes,
    visualSelections: [
      {
        themeIndex: 0,
        mode: "media",
        mediaId: "v123",
        mediaType: "video",
        mediaUrl: "https://example.com/untrusted.mp4",
        sourceUrl: "https://www.pexels.com/video/example-123/",
        creator: "Pexels Creator",
        query: "person checking unfinished list",
      },
      { themeIndex: 1, mode: "motion" },
    ],
  }), /approved Pexels host/);
  assert.throws(() => normalizeVideoRequest({
    prompt: "A valid prompt",
    duration: "60 sec",
    platforms: [],
    visualThemes: [
      { title: "Opening", startSegment: 0, endSegment: 1, queries: ["person working"] },
      { title: "Gap", startSegment: 3, endSegment: 4, queries: ["office desk"] },
    ],
  }), /contiguous/);
});

test("uses the Prompt to Video approved script without generating a replacement", async () => {
  const approvedScript = `${Array.from({ length: 140 }, (_, index) => `reviewed${index + 1}`).join(" ")}.`;
  const request = normalizeVideoRequest({
    prompt: "Explain a reviewed memory technique",
    duration: "60 sec",
    language: "English",
    subtitleLanguage: "English",
    platforms: [],
    approvedScript,
  });
  assert.equal(await createScriptDraft(request), approvedScript);
});

test("supports seekable video byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.throws(() => parseByteRange("bytes=1000-1001", 1000), /outside/);
});

test("keeps burned captions in a fixed vertical-video safe zone", () => {
  const segments = segmentText("Stop scrolling—this is more useful than it first sounds. Explain why unfinished tasks stay in memory and give one practical focus technique.");
  assert.ok(segments.every((segment) => segment.length <= 72));
  assert.equal(segments[0], "Stop scrolling—this is more useful than it first sounds.");
  const cues = segments.map((_, index) => ({ start: index * 2.5, end: (index + 1) * 2.5 }));
  const ass = buildAss(segments, cues, cues.at(-1).end);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /,90,90,430,1/);
  assert.match(ass, /\\N/);
  const burmese = "မပြီးဆုံးသေးသောအလုပ်များကိုဦးနှောက်ကဘာကြောင့်မှတ်မိနေသလဲဆိုတာရှင်းပြပါ";
  const burmeseSegments = segmentText(burmese, "Burmese");
  assert.ok(burmeseSegments.length > 1);
  assert.ok(burmeseSegments.every((segment) => segment.length <= 52));
  assert.match(buildAss(burmeseSegments, burmeseSegments.map((_, index) => ({ start: index, end: index + 1 })), burmeseSegments.length, "Noto Sans Myanmar"), /Style: Reelio,Noto Sans Myanmar/);
});

test("rejects mixed-script Burmese before rendering", () => {
  const clean = [
    "မပြီးသေးတဲ့ အလုပ်တွေက စိတ်ထဲမှာ ဆက်ရှိနေတတ်ပါတယ်။",
    "နောက်တစ်ဆင့်ကို စာရွက်ပေါ်မှာ ရေးထားပြီး ခဏနားပါ။",
    "ပြန်စတဲ့အခါ ဘာလုပ်ရမလဲဆိုတာ ရှင်းနေပါလိမ့်မယ်။",
  ];
  assert.doesNotThrow(() => validateLanguageText(clean, "Burmese", "subtitles"));
  assert.throws(
    () => validateLanguageText([clean[0], "This subtitle is not Burmese.", clean[2]], "Burmese", "subtitles"),
    /not clean Burmese/,
  );
});

test("synthesizes whole utterances instead of subtitle-sized fragments", () => {
  // Subtitle segmentation splits on ~68 characters, so a long sentence arrives as several
  // fragments. Feeding those to TTS gives each half sentence-final falling intonation, which is
  // what made concatenated narration sound robotic.
  const script = "In July 2026, two research models calculated a shortcut to pass a security test. Instead of solving the challenges, they broke out of the isolated laboratory. How did they escape the sandbox?";
  const segments = segmentText(script, "English");
  const groups = buildSpeechGroups(segments, []);
  assert.ok(segments.length > groups.length, "utterances are coarser than subtitle lines");
  for (const group of groups) {
    assert.match(group.text, /[.!?]["'\u201d\u2019)\]]?$/u, "every utterance ends on a sentence boundary");
  }
  // Every subtitle segment is covered exactly once and in order, so caption timing stays aligned.
  assert.deepEqual(groups.flatMap((group) => group.indices), segments.map((_, index) => index));
  assert.equal(groups.map((group) => group.text).join(" ").replace(/\s+/g, " "), segments.join(" ").replace(/\s+/g, " "));
});

test("ends a spoken utterance at an authored pause marker", () => {
  const segments = ["First idea lands here.", "Second idea follows it.", "Third idea closes."];
  const groups = buildSpeechGroups(segments, [0, 0.45, 0]);
  assert.equal(groups.length, 2, "the pause marker closes the utterance that carries it");
  assert.deepEqual(groups[0].indices, [0, 1]);
  assert.deepEqual(groups[1].indices, [2]);
});

test("caps pause markers so narration does not fill with dead air", () => {
  const sentences = Array.from({ length: 8 }, (_, index) => `Sentence number ${index + 1} explains one point. [pause]`).join(" ");
  const limited = limitPauseMarkers(sentences);
  assert.equal((limited.match(/\[pause\]/g) ?? []).length, 3);
  assert.doesNotMatch(limited, /  +/, "removing markers leaves no double spaces");
  // Scripts already within the cap are returned untouched.
  const short = "One point here. [pause] Another point there.";
  assert.equal(limitPauseMarkers(short), short);
});

test("targets a narratable word rate instead of forcing padding", () => {
  const range = scriptWordRange("90 sec");
  assert.ok(range.min / 90 >= 1.9 && range.min / 90 <= 2.15, `min rate ${range.min / 90} words/sec is narratable`);
  assert.ok(range.max / 90 <= 2.4, `max rate ${range.max / 90} words/sec is narratable`);
  assert.ok(range.max > range.min);
});
