import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { buildAss, buildSrt, buildXfadeChain, chooseDuration, extractPauses, ffmpegPath, motionFilter, planClipQueries, segmentText, styleProfile, validateLanguageText } from "../local-service/pipeline.mjs";
import { parseVoiceBlend } from "../local-service/kokoro-client.mjs";
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
import { buildFacebookAuthorizationUrl } from "../local-service/facebook-oauth.mjs";
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

test("chooses topic-aware look, pacing, and voice tone per category", () => {
  const tech = styleProfile("Technology");
  assert.equal(tech.clipSeconds, 2.8);
  assert.equal(tech.kokoroSpeed, 1.2);
  assert.ok(tech.transitions.includes("slideleft"));
  assert.ok(tech.subtitle.fontsize >= 60);
  const wellness = styleProfile("Wellness");
  assert.ok(wellness.kokoroSpeed < tech.kokoroSpeed, "calm topics narrate slower than energetic ones");
  const fallback = styleProfile("Something unmapped");
  assert.equal(fallback.clipSeconds, 3.2);
  assert.ok(Array.isArray(fallback.motions) && fallback.motions.length > 0);
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
