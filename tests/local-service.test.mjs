import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { buildAss, buildSrt, chooseDuration, ffmpegPath, segmentText, validateLanguageText } from "../local-service/pipeline.mjs";
import { parseByteRange } from "../local-service/http-utils.mjs";
import { durationBounds, normalizeVideoRequest, ValidationError } from "../local-service/validation.mjs";
import { kokoroConfig } from "../local-service/kokoro-client.mjs";
import { GEMINI_TTS_LANGUAGES, geminiTtsConfig, pcmToWave } from "../local-service/gemini-tts-client.mjs";
import { VOXCPM2_LANGUAGES, voxCpmConfig } from "../local-service/voxcpm-client.mjs";
import { DEFAULT_GEMINI_TEXT_MODEL, DEFAULT_OPENROUTER_MODEL, textProviderConfig } from "../local-service/text-provider.mjs";
import { normalizeIdeaOutput } from "../local-service/idea-generator.mjs";
import { JobStoppedError, registerJobProcess, runWithJobControl, stopJobExecution } from "../local-service/job-control.mjs";
import { buildYouTubeAuthorizationUrl } from "../local-service/youtube-oauth.mjs";
import { buildTikTokAuthorizationUrl } from "../local-service/tiktok-oauth.mjs";
import { buildTikTokUploadPlan, buildYouTubeUploadPlan, publishingMediaIssue } from "../local-service/publishers.mjs";

test("uses Google Gemini as the primary multilingual text provider with OpenRouter fallback", () => {
  assert.equal(DEFAULT_GEMINI_TEXT_MODEL, "gemini-3.5-flash");
  assert.equal(DEFAULT_OPENROUTER_MODEL, "google/gemma-4-31b-it:free");
  assert.equal(textProviderConfig().preferred, "google");
  assert.match(textProviderConfig().model, /gemini-3.5-flash|gemma-4-31b-it:free|built-in English fallback/);
});

test("builds a secure offline YouTube OAuth request", () => {
  const auth = new URL(buildYouTubeAuthorizationUrl({ clientId: "client-id", redirectUri: "http://127.0.0.1:8788/oauth/youtube/callback", state: "csrf-state" }));
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  assert.equal(auth.searchParams.get("state"), "csrf-state");
  assert.match(auth.searchParams.get("scope"), /youtube\.upload/);
  assert.match(auth.searchParams.get("scope"), /youtube\.readonly/);
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
});

test("blocks media that does not meet each short-video connector contract", () => {
  const base = { state: "completed", assets: { final: { file: "/tmp/final.mp4" } }, metadata: { durationSeconds: 75, resolution: "1080x1920", frameRate: 30 } };
  for (const platform of ["youtube", "tiktok", "facebook", "instagram"]) assert.equal(publishingMediaIssue(base, platform), null);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 181 } }, "youtube"), /3 minutes/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 601 } }, "tiktok"), /10 minutes/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, durationSeconds: 91 } }, "facebook"), /3–90 seconds/);
  assert.match(publishingMediaIssue({ ...base, metadata: { ...base.metadata, frameRate: 61 } }, "instagram"), /23 and 60 FPS/);
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
  const wave = pcmToWave(Buffer.alloc(480), 24_000, 1);
  assert.equal(wave.subarray(0, 4).toString(), "RIFF");
  assert.equal(wave.subarray(8, 12).toString(), "WAVE");
  assert.equal(wave.readUInt32LE(40), 480);
});

test("keeps VoxCPM2 seed handling compatible with installed and newer APIs", async () => {
  const script = await readFile(new URL("../scripts/voxcpm2_tts.py", import.meta.url), "utf8");
  assert.match(script, /supports_seed = "seed" in inspect\.signature/);
  assert.match(script, /if supports_seed:/);
  assert.match(script, /torch\.manual_seed\(seed\)/);
  assert.match(script, /generation\["reference_wav_path"\] = voice_reference/);
  assert.match(script, /voice_reference = cue\["output"\]/);
  assert.doesNotMatch(script, /seed = int\([^\n]+\) \+ index/);
  assert.doesNotMatch(script, /model\.generate\([\s\S]{0,400}seed=/);
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

test("turns AI idea output into a plain fact-safe brief without UI markup", () => {
  assert.equal(
    normalizeIdeaOutput('```json\n{"idea":"Investigate whether listeners can distinguish hot and cold water by sound, using controlled recordings before explaining only well-supported physical differences."}\n```'),
    "Investigate whether listeners can distinguish hot and cold water by sound, using controlled recordings before explaining only well-supported physical differences.",
  );
  assert.equal(
    normalizeIdeaOutput("**Hook:** A bold opening\n**Visuals:** A controlled side-by-side test"),
    "A bold opening A controlled side-by-side test",
  );
});

test("bundles an FFmpeg build with subtitle rendering", async () => {
  await access(ffmpegPath);
  const result = spawnSync(ffmpegPath, ["-filters"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /subtitles\s+V->V/);
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

test("validates generation requests before queuing work", () => {
  const request = normalizeVideoRequest({ prompt: "Explain one useful memory technique", duration: "60 sec", language: "English", subtitleLanguage: "Thai", platforms: ["youtube", "youtube", "tiktok"] });
  assert.equal(request.language, "English");
  assert.equal(request.ttsEngine, "kokoro");
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
  const reviewed = normalizeVideoRequest({ prompt: "A valid prompt", duration: "60 sec", platforms: [], approvedScript: "This reviewed script is intentionally long enough for the validation contract." });
  assert.match(reviewed.approvedScript, /reviewed script/);
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
