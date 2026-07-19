import assert from "node:assert/strict";
import test from "node:test";

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

test("keeps the active AI provider contracts in the project", async () => {
  const { readFile } = await import("node:fs/promises");
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, /REELIO_TEXT_PROVIDER=google/);
  assert.match(envExample, /GEMINI_API_KEY=/);
  assert.match(envExample, /GEMINI_TEXT_MODEL=gemini-3.5-flash/);
  assert.match(envExample, /GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview/);
  assert.match(envExample, /GEMINI_TTS_VOICE=Puck/);
  assert.match(envExample, /GEMINI_TTS_BURMESE_SPEED=0.94/);
  assert.match(envExample, /OPENROUTER_API_KEY=/);
  assert.match(envExample, /OPENROUTER_TEXT_MODEL=google\/gemma-4-31b-it:free/);
  assert.match(envExample, /OPENROUTER_FALLBACK_MODEL=google\/gemma-4-26b-a4b-it:free/);
  assert.doesNotMatch(envExample, /OPENAI_API_KEY=/);
  assert.match(envExample, /PEXELS_API_KEY=/);
  assert.match(envExample, /KOKORO_MODEL_PATH=.reelio\/kokoro\/models\/kokoro-v1.0.onnx/);
  assert.match(envExample, /KOKORO_VOICE=af_heart/);
  assert.match(envExample, /KOKORO_SPEED=1.15/);
  assert.match(envExample, /VOXCPM_MODEL_PATH=.reelio\/voxcpm2\/models\/VoxCPM2/);
  assert.match(envExample, /VOXCPM_DEVICE=auto/);
});

test("includes the complete video detail workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
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

test("includes guided YouTube OAuth setup in Settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Connect YouTube/);
  assert.match(page, /Enable YouTube Data API v3/);
  assert.match(page, /Set up Google Auth Platform/);
  assert.match(page, /Add yourself as a test user/);
  assert.match(page, /oauth\/youtube\/status/);
  assert.match(page, /Save & connect YouTube/);
});

test("includes guided TikTok Content Posting setup in Settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Connect TikTok/);
  assert.match(page, /Content Posting API/);
  assert.match(page, /video\.upload/);
  assert.match(page, /Sandbox target user/);
  assert.match(page, /oauth\/tiktok\/status/);
  assert.match(page, /Save & connect TikTok/);
});

test("includes guided Facebook Page Reels setup in Settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, service] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../local-service/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Connect Facebook Page/);
  assert.match(page, /pages_show_list/);
  assert.match(page, /pages_read_engagement/);
  assert.match(page, /pages_manage_posts/);
  assert.match(page, /Do not mix up these IDs/);
  assert.match(page, /me\/accounts\?fields=name,access_token,tasks/);
  assert.match(page, /If the response says.*data: \[\]/);
  assert.match(page, /me\/permissions/);
  assert.doesNotMatch(page, /61592195997189/);
  assert.doesNotMatch(page, /className="query-warning"/);
  assert.match(page, /Save & check Facebook/);
  assert.match(service, /publishing\/facebook\/status/);
  assert.match(service, /Facebook Page token verified/);
  assert.match(service, /fields: "id,name"/);
  assert.match(service, /same GET \/me\/accounts entry/);
});

test("includes guided Instagram Reels setup without an inline credential form", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, service, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
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
