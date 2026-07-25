import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = fileURLToPath(new URL("../app", import.meta.url));

async function readAppSource() {
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return sources.join("\n");
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the Reelio creator shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Reelio — AI Knowledge Video Studio<\/title>/i);
  assert.match(html, /Suggest an idea/);
  assert.match(html, /Latest news/);
  assert.match(html, /Turn an idea into a reel people finish/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships the Reelio app icon set and installable manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.short_name, "Reelio");
  assert.equal(manifest.theme_color, "#6f4bf3");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  for (const file of ["favicon.ico", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "reelio-icon.png"]) {
    await access(new URL(`../public/${file}`, import.meta.url));
  }
  const [layout, page, styles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(layout, /shortcut: "\/favicon\.ico"/);
  assert.match(page, /className="brand-mark" aria-hidden="true"/);
  assert.match(styles, /url\("\/icon-192\.png"\)/);
});

test("keeps the active AI provider contracts in the project", async () => {
  const [envExample, settings] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(envExample, /REELIO_TEXT_PROVIDER=google/);
  assert.match(envExample, /GEMINI_API_KEY=/);
  assert.match(envExample, /GEMINI_TEXT_MODEL=gemini-3.5-flash/);
  assert.match(envExample, /GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview/);
  assert.match(envExample, /REELIO_BRAND_VOICE_OVERRIDE=false/);
  assert.match(envExample, /GEMINI_TTS_VOICE=Puck/);
  assert.match(envExample, /GEMINI_TTS_BURMESE_SPEED=0.94/);
  assert.match(envExample, /OPENROUTER_API_KEY=/);
  assert.match(envExample, /OPENROUTER_TEXT_MODEL=google\/gemma-4-31b-it:free/);
  assert.match(envExample, /OPENROUTER_FALLBACK_MODEL=google\/gemma-4-26b-a4b-it:free/);
  assert.doesNotMatch(envExample, /OPENAI_API_KEY=/);
  assert.match(envExample, /PEXELS_API_KEY=/);
  assert.match(envExample, /PIXABAY_API_KEY=/);
  assert.match(settings, /Pixabay/);
  assert.match(settings, /pixabayApiKey/);
  assert.match(settings, /pixabay\.com\/api\/docs/);
  assert.match(envExample, /KOKORO_MODEL_PATH=.reelio\/kokoro\/models\/kokoro-v1.0.onnx/);
  assert.match(envExample, /KOKORO_VOICE=af_heart/);
  assert.match(envExample, /KOKORO_SPEED=1.15/);
  assert.match(envExample, /VOXCPM_MODEL_PATH=.reelio\/voxcpm2\/models\/VoxCPM2/);
  assert.match(envExample, /VOXCPM_DEVICE=auto/);
  assert.doesNotMatch(settings, /geminiTtsVoice: "Puck"/);
  assert.doesNotMatch(settings, /kokoroVoice: "af_heart"/);
});

test("includes the complete video detail workflow", async () => {
  const page = await readAppSource();
  assert.match(page, /function VideoDetailView/);
  assert.match(page, /View details/);
  assert.match(page, /Generate language version/);
  assert.match(page, /Stop & unload models/);
  assert.match(page, /\/jobs\/\$\{activeJobId\}\/stop/);
  assert.match(page, /Voice engine/);
  assert.match(page, /VoxCPM2 — local/);
  assert.match(page, /renderLocked/);
  assert.match(page, /Another video is already generating|A video is already generating/);
  assert.match(page, /Transcript/);
  assert.match(page, /Subtitles/);
  assert.match(page, /Upload everywhere at once/);
  assert.match(page, /Selected uploads start in parallel/);
  assert.match(page, /assets\.clean|Clean background video/);
  assert.doesNotMatch(page, /Live creative plan/);
  assert.doesNotMatch(page, /buildLiveDirection/);
  assert.match(page, /setRenderProgress\(\(current\) => Math\.max\(current,/);
  assert.match(page, /setStep\(\(current\) => Math\.max\(current,/);
  assert.match(page, /if \(polling \|\| cancelled\) return/);
  assert.match(page, /Generated thumbnail/);
  assert.match(page, /options=\{\["60 sec", "75 sec", "90 sec", "2 min"/);
  assert.match(page, /platform-copy-grid/);
  assert.match(page, /post kit copied/);
  assert.match(page, /Re-upload as new/);
  assert.match(page, /Manage on platform/);
  assert.match(page, /reuploadPlatforms/);
  assert.match(page, /studio\.youtube\.com\/video/);
  assert.match(page, /tiktok\.com\/tiktokstudio\/content/);
});

test("keeps Quick Create and adds a separate functional Guided Create flow", async () => {
  const [page, guided, service, pipeline] = await Promise.all([
    readAppSource(),
    readFile(new URL("../app/components/GuidedCreateView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../local-service/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../local-service/pipeline.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /label="Quick Create"/);
  assert.match(page, /label="Guided Create"/);
  assert.match(page, /view === "create"/);
  assert.match(page, /view === "guided-create"/);
  assert.match(guided, /Brief/);
  assert.match(guided, /Approve the exact script/);
  assert.match(guided, /Choose production settings/);
  assert.match(guided, /Your brief/);
  assert.match(guided, /Turn this brief into a script/);
  assert.match(guided, /Write it myself/);
  assert.match(guided, /Script structure/);
  assert.match(guided, /No tokens until Generate/);
  assert.match(guided, /Research-backed AI script draft/);
  assert.match(guided, /Gemini also searches grounded sources/);
  assert.match(guided, /role="radiogroup"/);
  for (const label of ["Clear explainer", "Story-led", "Problem → solution", "Myth vs fact", "List format", "Question-led", "Case study", "Compare & contrast", "Timeline", "Practical guide"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(guided, /Generate visual themes/);
  assert.match(guided, /Open storyboard without AI/);
  assert.match(guided, /localOnly: true/);
  assert.match(guided, /No text-provider call and no AI tokens/);
  assert.match(guided, /Stock searches/);
  assert.match(guided, /Visual storyboard/);
  assert.match(guided, /Find matching footage/);
  assert.match(guided, /Show different clips/);
  assert.match(guided, /stockSearchPageRef/);
  assert.match(guided, /showDifferentResults/);
  assert.match(guided, /Choose your video/);
  assert.match(guided, /selectExistingCustomVideo/);
  assert.match(guided, /customVideoAssets/);
  assert.match(guided, /Replace your video/);
  assert.match(guided, /guided-storyboard-custom-edit/);
  assert.match(guided, /type="file"/);
  assert.match(guided, /mode: "custom"/);
  assert.match(guided, /\/tool-inputs/);
  assert.match(guided, /candidate\.providerLabel/);
  assert.match(guided, /Pixabay/);
  assert.match(guided, /Motion background/);
  assert.match(guided, /Choose your narrator/);
  assert.match(guided, /Selection uses no tokens/);
  assert.match(guided, /aria-label="Video narrator"/);
  assert.match(guided, /Generate voice sample/);
  assert.match(guided, /Gemini · API key \+ tokens/);
  assert.match(guided, /Local · no API tokens/);
  assert.match(guided, /Translate opening with AI/);
  assert.match(guided, /Confirm and translate/);
  assert.match(guided, /cached for free replay/);
  assert.match(guided, /A saved sample appears only for the narrator who generated it/);
  assert.match(guided, /preview\.narratorId === narratorId/);
  assert.doesNotMatch(guided, /comparableVoicePreviews\.map/);
  assert.match(guided, /setVoicePreviews/);
  for (const narrator of ["Maya", "Theo", "Nova", "Ellis", "Warm guide", "Curious analyst", "Energetic host", "Calm documentarian"]) {
    assert.match(page, new RegExp(narrator));
  }
  assert.match(guided, /props\.startGeneration\(script, visualThemes, visualSelections, scriptStyle, narratorId\)/);
  assert.match(page, /narratorId=\{quickNarratorId\}/);
  assert.match(page, /narratorId: narratorId \?\? quickNarratorId/);
  assert.match(guided, /label="Script style"/);
  assert.match(guided, /label="Narrator"/);
  assert.match(guided, /Review and create your video/);
  assert.match(guided, /"Create video"/);
  assert.match(guided, /View finished video/);
  assert.match(guided, /Create another video/);
  assert.doesNotMatch(guided, /Add video to queue/);
  assert.match(guided, /Optional AI brief helper/);
  assert.match(guided, /Uses API tokens/);
  assert.match(guided, /No request is sent until you confirm/);
  assert.match(guided, /Confirm and run/);
  assert.match(guided, /disabled=\{!aiTopicReady/);
  assert.match(guided, /\/script-draft/);
  assert.match(guided, /prerequisites\.slice\(0, next\)\.findIndex\(Boolean\)/);
  assert.match(guided, /disabled=\{!briefReady\}/);
  assert.match(guided, /disabled=\{!scriptReady\}/);
  assert.match(guided, /disabled=\{!productionReady\}/);
  assert.match(page, /className="brand-mark" aria-hidden="true"/);
  assert.doesNotMatch(page, /next\/image/);
  assert.match(service, /url\.pathname === "\/script-draft"/);
  assert.match(service, /url\.pathname === "\/voice-previews"/);
  assert.match(service, /url\.pathname === "\/voice-preview-translation"/);
  assert.match(service, /url\.pathname === "\/visual-themes"/);
  assert.match(service, /body\.localOnly === true/);
  assert.match(service, /url\.pathname === "\/visual-candidates"/);
  assert.match(pipeline, /export async function createScriptDraft/);
  assert.match(pipeline, /export async function createVisualThemePlan/);
  assert.match(pipeline, /export function createLocalVisualThemePlan/);
  assert.match(pipeline, /export async function findVisualCandidates/);
  assert.match(pipeline, /collectStockProviderResults/);
  assert.match(pipeline, /allocateStoryboardCandidates/);
  assert.match(pipeline, /STOCK_RESULTS_PER_PROVIDER = 48/);
  assert.match(pipeline, /STOCK_SEARCH_CACHE_MS/);
  assert.match(pipeline, /preserving the selected "\$\{scriptStyle\.label\}" structure/);
  assert.match(pipeline, /researchScriptTopic/);
  assert.match(pipeline, /createScriptAnglePlan/);
  assert.match(pipeline, /grounded_evidence/);
  assert.match(pipeline, /thinkingLevel: "high"/);
  assert.match(pipeline, /voice: narrator\.kokoroVoice/);
  assert.match(pipeline, /voiceDescription: narrator\.voxDescription/);
  assert.match(pipeline, /voice: narrator\.geminiVoice/);
  assert.match(pipeline, /planThemeQueries/);
  assert.doesNotMatch(pipeline, /createSegmentQueries/);
});

test("includes a modular Tools tab with reusable multi-job outputs", async () => {
  const page = await readAppSource();
  for (const label of ["Chop", "Download video from link", "Generate audio", "Extract subtitle track", "Extract captions from link", "Generate subtitle", "Translate", "Speech synthesis", "Video synthesis"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /\/tool-inputs/);
  assert.match(page, /\/tool-jobs/);
  assert.match(page, /reuse an output/);
  assert.match(page, /Media jobs can run together/);
  assert.match(page, /Run \$\{selected\.name\}/);
  assert.match(page, /aiLabel: "API key"/);
  assert.match(page, /aiLabel: "Local AI"/);
  assert.match(page, /Subtitle text is sent to the selected cloud provider/);
  assert.match(page, /aiLabel: "No AI"/);
  assert.match(page, /Local link utility · no AI or API key/);
  assert.match(page, /webmedia:setup/);
  assert.match(page, /does not need to point directly to an MP4/);
  assert.match(page, /label="Narrator"/);
  assert.match(page, /narratorId/);
  assert.match(page, />Settings</);
  assert.doesNotMatch(page, /tool-card\.selected > em/);
});

test("includes a production Brand Kit workspace and Video Synthesis integration", async () => {
  const page = await readAppSource();
  assert.match(page, /label="Brand Kit"/);
  assert.match(page, /Make every video unmistakably yours/);
  assert.match(page, /Logo watermark/);
  assert.match(page, /Brand voice/);
  assert.match(page, /Apply active Brand Kit/);
  assert.match(page, /\/brand-kit\/assets\/\$\{kind\}/);
});

test("includes separate production calendar and cron automation lifecycles", async () => {
  const [page, service, automationModule] = await Promise.all([
    readAppSource(),
    readFile(new URL("../local-service/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../local-service/automations.mjs", import.meta.url), "utf8"),
  ]);
  for (const label of ["Content Calendar", "Quick Automation", "AI Suggested Idea", "AI Latest News", "Start date", "End date", "Add another post time", "Generate video now", "Wait for review", "Publish automatically"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /\/automations\/\$\{pipeline\.id\}\/run/);
  assert.match(page, /\/automations\/\$\{pipeline\.id\}\/plan/);
  assert.match(page, /\/calendar-entries\/\$\{selectedEntry\.id\}\/\$\{action\}/);
  assert.match(page, /uses AI tokens for every generated brief/);
  assert.match(page, /Each cron occurrence creates a new brief/);
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /publishing\/readiness/);
  assert.match(page, /setInterval/);
  assert.match(service, /runAutomation/);
  assert.match(service, /runCalendarEntry/);
  assert.match(service, /runDueCalendarEntry/);
  assert.match(service, /queueCalendarBriefs/);
  assert.match(service, /generateAutomationBrief/);
  assert.match(service, /completeAutomationRun/);
  assert.match(service, /activeAutomationJob/);
  assert.match(service, /nextRunAt/);
  assert.match(service, /removeAutomation/);
  assert.match(service, /removeAutomationCalendarEntries/);
  assert.match(service, /Automatic publishing/);
  assert.match(automationModule, /normalizeAutomationCreate/);
  assert.match(automationModule, /buildCalendarEntries/);
  assert.match(automationModule, /at most 400 planned posts/);
  assert.match(automationModule, /Automatic publishing requires at least one platform/);
});

test("includes guided YouTube OAuth setup in Settings", async () => {
  const page = await readAppSource();
  assert.match(page, /Connect YouTube/);
  assert.match(page, /Enable YouTube Data API v3/);
  assert.match(page, /Set up Google Auth Platform/);
  assert.match(page, /Add yourself as a test user/);
  assert.match(page, /oauth\/youtube\/status/);
  assert.match(page, /Save & connect YouTube/);
});

test("includes guided TikTok Content Posting setup in Settings", async () => {
  const page = await readAppSource();
  assert.match(page, /Connect TikTok/);
  assert.match(page, /Content Posting API/);
  assert.match(page, /video\.upload/);
  assert.match(page, /Sandbox target user/);
  assert.match(page, /oauth\/tiktok\/status/);
  assert.match(page, /Save & connect TikTok/);
});

test("includes guided Facebook OAuth setup in Settings", async () => {
  const [page, service, facebookOauth] = await Promise.all([
    readAppSource(),
    readFile(new URL("../local-service/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../local-service/facebook-oauth.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Connect Facebook/);
  assert.match(page, /Save & connect Facebook/);
  assert.match(page, /oauth\/facebook\/start/);
  assert.match(page, /oauth\/facebook\/select-page/);
  assert.match(page, /Meta app ID/);
  assert.match(page, /Meta app secret/);
  assert.match(page, /Valid OAuth Redirect URIs/);
  assert.match(page, /Choose the Facebook Page to publish to/);
  // The Meta Login scopes remain part of the guide.
  assert.match(page, /pages_manage_posts/);
  assert.match(page, /business_management/);
  assert.match(page, /instagram_content_publish/);
  // The old manual Graph API Explorer token flow is gone.
  assert.doesNotMatch(page, /Do not mix up these IDs/);
  assert.doesNotMatch(page, /me\/accounts\?fields=name,access_token,tasks/);
  assert.doesNotMatch(page, /Save & check Facebook/);
  assert.match(page, /reelio-facebook-oauth/);
  assert.match(service, /publishing\/facebook\/status/);
  assert.match(service, /oauth\/facebook\/callback/);
  assert.match(facebookOauth, /buildFacebookAuthorizationUrl/);
  assert.match(facebookOauth, /Facebook Page token verified/);
  assert.match(facebookOauth, /fields: "id,name"/);
  assert.match(facebookOauth, /same GET \/me\/accounts entry/);
  assert.match(facebookOauth, /fb_exchange_token/);
});

test("includes guided Instagram Reels setup without an inline credential form", async () => {
  const [page, service, styles] = await Promise.all([
    readAppSource(),
    readFile(new URL("../local-service/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Connect Instagram/);
  assert.match(page, /instagram_content_publish/);
  assert.match(page, /instagram_business_account/);
  assert.match(page, /Public media base URL/);
  assert.match(page, /Save & check Instagram/);
  assert.match(page, /Prepare the public media URL/);
  assert.match(page, /Something not working/);
  assert.doesNotMatch(page, /className="meta-credential-grid"/);
  assert.match(service, /publishing\/instagram\/status/);
  assert.match(service, /fields: "id,username"/);
  assert.match(service, /publicly reachable HTTPS address/);
  assert.match(styles, /\.platform-logo\.youtube/);
  assert.match(styles, /\.platform-logo\.tiktok/);
  assert.match(styles, /\.platform-logo\.facebook/);
  assert.match(styles, /\.platform-logo\.instagram/);
  assert.match(styles, /library-platform-summary em \.platform-logo/);
});
