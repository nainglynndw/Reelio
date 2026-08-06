# Reelio

Reelio is a local-first AI studio for turning an idea into a finished vertical video package. It writes the script, finds or generates visuals, creates narration, builds subtitles, renders a real 1080×1920 video, and prepares platform-specific publishing copy.

![Reelio create-video workspace](screenshots/create_video_page.png)

## Highlights

- Generate research-backed scripts from a prompt, a suggested idea, or grounded current-news research.
- Keep Quick Create for the existing all-in-one form, or open Create Video to choose a production mode with a defined input and expected result.
- Render production-ready 9:16 video with FFmpeg.
- Use local narration with Kokoro for English and VoxCPM2 for multilingual speech.
- Optionally use Gemini for text, translation, and multilingual narration.
- Create transcripts, SRT subtitles, burned captions, thumbnails, clean video, and post copy.
- Choose licensed Pexels or Pixabay footage, a custom local video, or a generated motion background for each reviewed visual theme.
- Build additional language versions from an existing video package.
- Run individual media operations from the Tools tab and reuse one job's output as another job's input.
- Queue multiple tool jobs with separate limits for FFmpeg work and memory-intensive local models.
- Apply a reusable Brand Kit with colors, caption style, logo, intro/outro, music, voice direction, narrator default, CTA, handle, and website.
- Review every output before publishing to YouTube, TikTok, Facebook, or Instagram.
- Keep projects, generated media, credentials, and job history in a protected local workspace.

## Local database, authentication, and authorization

Reelio now uses SQLite as its local source of truth. On first start, the worker creates `reelio.sqlite` under `REELIO_DATA_DIR` and imports the existing `state.json` workspace automatically. The JSON state file remains as a human-readable recovery mirror; generated media stays in its existing local folders and is not copied into the database.

Visitors can explore every tab and configure the visible forms without signing in, including Quick Create, Create Video, Library, Tools, Automations, Brand Kit, and Settings. Private workspace records are not loaded for guests. Authentication appears contextually only when someone presses a protected action such as generating AI content, uploading media, running a tool, saving workspace data, connecting an account, or publishing. There is no mandatory onboarding flow.

Passwords are salted and hashed with scrypt, sessions use revocable random tokens stored only as SHA-256 hashes, and the browser receives an HttpOnly `SameSite=Lax` cookie. Authentication and authorization are separate: every session includes a subscription record, and the worker checks plan entitlements before executing a protected route. Resource reads and mutations also check `ownerUserId`, so one account cannot address another account's jobs, tool inputs, tool jobs, or automations.

The subscription model uses `free`, `creator`, and `studio` plan codes, plus `trialing`, `active`, `past_due`, and `canceled` states. Plan entitlements control creation modes, media tools, Brand Kit, publishing, automations, and provider configuration independently. The first account on a local installation receives an active Studio subscription so the existing desktop workflow remains fully available; hosted signups can start on Free without introducing staff-style roles.

## Product tour

### Quick Create a video package

Choose the topic, duration, speech language, subtitle language, voice engine, narrator personality, and target platforms. Reelio can also suggest an idea or research recent news.

When Gemini is configured, an unapproved script is generated through a quality pipeline: Reelio uses Gemini 3.6 Flash for creative work, searches for grounded evidence, builds a concrete research dossier, plans a topic-specific hook and sequence of story beats, and drafts with calibrated strong/weak writing examples. The fact and retention editor returns only narrow exact patches, so it cannot silently rewrite a distinctive draft into generic prose. Supported names, dates, quantities, examples, mechanisms, and caveats are retained instead of being generalized away. Mechanical work such as translation and structured metadata routes to Gemini 3.5 Flash-Lite by default. OpenRouter-only setups use the same planning and writing prompts but safely fall back to the reviewed brief when Gemini Search is unavailable. Provider fallback and the actual model used are retained in generation provenance. These extra passes improve specificity but use more API tokens and can take longer.

![Create a Reelio video package](screenshots/create_video_page.png)

### Choose a Create Video mode

The **Create Video** tab is the entry point for mode-specific production. Every mode explains the source it expects and the package it will produce before the user starts. Available modes also show a concrete **From this → To this** example using a real reviewed input and finished local output. From a completed Prompt video or Long Video to Shorts result, choose **Use as mode showcase** to replace that example without copying media outside `REELIO_DATA_DIR`.

| Mode | Availability | Expected result |
| --- | --- | --- |
| Message Conversation | Available | One reviewed fictional 9:16 phone conversation with deterministic timing, optional message sounds or voices, thumbnail, transcript, captions, project data, and publishing copy |
| Prompt to Video | Available | One reviewed 9:16 narrated video with captions, thumbnail, clean master, transcript, and publishing copy |
| Long Video to Shorts | Available | Several complete publishable packages with original editorial thumbnail titles, 1.5-second title-card openings, reviewed cuts, narrator voice-over, translation, captions, clean masters, transcripts, branding, and platform copy |
| Sports Highlights | Planned | A narrated highlight reel built from licensed footage, with approved events, original-audio mixing, captions, and thumbnail |
| Documentary & Case Recap | Planned | A sourced documentary-style reel with an approved script, safe visuals, narration, citations, and publishing copy |

Message Conversation includes a Story Starter before AI drafting. Creators can write their own premise, assemble one locally from relationship/genre/situation/ending choices without consuming tokens, or explicitly request three editable AI pitch cards. If no text provider is available—or pitch generation fails—Reelio supplies curated local story starters rather than inserting a generic conversation. A selected pitch can suggest fictional participant names and roles, but it never generates, approves, or renders the conversation until the creator separately submits the reviewed story direction.

Long Video to Shorts accepts a local upload or a supported public HTTPS URL. A URL import starts video download and caption inspection independently; a missing caption track does not discard a successfully imported video. The analysis job prefers supplied or embedded captions. Otherwise, it transcribes with Gemini 3.5 Flash-Lite using a compact audio-only copy, validates every timed cue, and deletes the Gemini File API upload afterward. The timed transcript—not the source video—is then sent to Flash-Lite to rank complete moments with a setup and payoff. Set `REELIO_STT_PROVIDER=local` to use faster-whisper for transcription when a GPU worker is available.

After the user approves the highlights, each selected moment follows the full production path independently: its reviewed transcript becomes an editable narration script, speech and subtitles are translated to the selected languages, the selected narrator and voice engine synthesize a timed voice-over, low source ambience can be retained beneath the narrator, captions and Brand Kit treatment are applied, and Reelio generates a thumbnail, clean master, transcript, metadata, and platform-specific publishing copy. Gemini writes a fresh moment-specific editorial title rather than copying the source-video title, channel name, filename, or a transcript sentence. It also writes a separate two-to-three-sentence publishing description that summarizes the whole selected moment and its payoff instead of reusing the opening hook or first script line. The titled thumbnail then opens the final short for 1.5 seconds before the excerpt, while narration, source audio, and subtitle timing move together after it. Every result is promoted to a normal reviewable video job so the existing approval and parallel publishing workflow applies to each short.

Titles and descriptions follow the transcript language selected for production. When that language differs from the source language, Prompt to Video, Quick Create, Automation, Long Video to Shorts, and every workflow using the shared renderer produce bilingual metadata and platform copy with the localized version first, followed by a blank line and the source-language version.

The user reviews every candidate before rendering: selection, order, thumbnail title, opening hook, source in/out points, and left/center/right/fit vertical framing are editable. Rendering produces one reusable MP4 and one titled JPG thumbnail per approved candidate, plus a JSON manifest. Captions and the active Brand Kit can be applied independently. Analysis and rendering use durable Tools jobs, so progress, stop, failure, output reuse, and worker-restart recovery follow the same contracts as other media operations.

Creative remix edits are separate from transcription and remain off by default. Before enabling mirroring or short fade transitions, the user must confirm that they own or are licensed to edit and publish the source, then separately approve the remix choices. These edits are production controls—not a method for bypassing copyright detection, moderation, attribution, or platform rules.

### Prompt to Video with script approval

Prompt to Video reuses the reviewed four-step production workflow: prepare the brief, choose one of ten script structures, generate and edit the English master script, select one of four narrator personalities, choose production settings, then review and create the video. AI theme generation is optional: **Open storyboard without AI** groups the approved script locally and immediately loads stock, custom-video, and motion choices without calling the text provider or consuming theme-generation tokens. Maya, Theo, Nova, and Ellis each map to distinct Kokoro, VoxCPM2, and Gemini voices with their own tone, character, sample line, and pace. VoxCPM2 creates and reuses a separate persona reference for each selected language, calibrated from narration in that language rather than an English line. Provider-level voice values do not replace those mappings unless `REELIO_BRAND_VOICE_OVERRIDE=true` is explicitly enabled for a single custom brand voice.

Generating the Prompt to Video draft uses the same research, angle-planning, drafting, and fact-editing pipeline described above. The UI identifies the additional AI passes before generation. Once approved, that exact script is passed directly into the renderer and is not researched or regenerated again. Before review, Reelio groups the script into editable visual story themes and searches every configured stock provider independently. Pexels and Pixabay results are merged and ranked by relevance, portrait fit, media type, quality, and provider diversity. Each unique search is requested once per results page with a larger candidate pool, then media is allocated without repeating a clip across storyboard themes—even when several themes use exactly the same search phrase. **Show different clips** advances to the next provider page instead of replaying the cached first six results. If either provider has no key, times out, returns an error, or returns no usable matches, the other provider continues without failing the storyboard. Every theme must have exactly one approved visual:

- A licensed Pexels or Pixabay video or photo
- A custom video uploaded from the user's device
- A motion background generated locally by Reelio

Every stock result displays its provider. Search responses are cached locally for 24 hours, and only the asset approved by the user is downloaded for rendering. Reelio retains its provider, creator, source URL, and license in the project metadata.

Choose **Choose your video** inside a theme to upload and preview a custom clip. The upload immediately becomes that theme's approved selection. If you temporarily choose stock footage or a motion background, click the saved custom-video tile to select it again; use the pencil control in its top-right corner only when you want to replace the file. Refreshing stock results does not remove custom selections. During rendering, Reelio crops, loops, or samples the selected clip to fill the theme's timeline slots; it does not replace an approved custom clip with stock footage or motion. The finished downloadable video therefore uses the exact local video selected for that theme.

Custom storyboard files are uploaded directly to the loopback-only worker and stored under `REELIO_DATA_DIR/tool-inputs/`. They are not sent to Pexels or an AI provider. If a referenced file is missing when the job is submitted or starts rendering, Reelio stops with a clear error and asks the user to choose it again.

### Manage the local video library

The Video Library is organized by creation mode. **All modes** shows a separate list for Prompt to Video, Long Video to Shorts, Quick Create, and Automation; selecting one mode scopes both the list and search to that workflow. Every item keeps its thumbnail, originating prompt, URL or upload, reusable output, review state, and publishing status together. Long Video to Shorts results are grouped under their original source video. Each source row expands into its generated shorts, and every short uses the same video-row treatment and publishing actions as a Prompt to Video result.

Completed, queued, and failed Prompt and Quick Create jobs remain available locally for preview, retry, download, and publishing. Every completed Long Video to Shorts result appears as its own first-class library job with its titled thumbnail, mode, originating URL or upload, narrator, language treatment, reusable assets, review state, publishing eligibility, and per-platform publishing status. Opening the creation mode starts with a fresh source form; completed batches are revisited from the Library instead of being restored into a new session.

When Reelio finds completed Long Video to Shorts outputs created before full publishing treatment was introduced, it safely promotes them into normal Library job records on worker startup. The promoted record links or copies the existing final video and thumbnail into its own generated package, recovers the matching transcript and caption segment when available, prepends the titled thumbnail without altering the immutable tool output, adds deterministic publishing metadata, and leaves the original tool output intact. These older shorts therefore use the same Library row, review, deletion, and publishing workflow as newly generated Prompt and Long Video packages.

![Reelio video library](screenshots/video_list_page.png)

### Review the finished video

Preview the rendered reel, inspect its retention preflight, download the final output, or create another language version.

![Reelio video details](screenshots/video_details_page_overview.png)

### Inspect every deliverable

The detail workspace separates the overview, transcript, subtitles, downloadable assets, and publishing controls.

<details>
<summary>More video-detail screenshots</summary>

#### Overview

![Video package overview](screenshots/video_details_overview_section.png)

#### Transcript

![Generated transcript](screenshots/video_details_transcript_section.png)

#### Subtitles

![Generated subtitles](screenshots/video_details_subtitles_section.png)

#### Assets

![Downloadable video assets](screenshots/video_details_assets_section.png)

#### Publishing

![Publishing workflow](screenshots/video_details_page_publishing.png)

</details>

### Configure providers locally

API keys and publishing credentials are entered in Settings. Reelio writes them to a private, Git-ignored `.env.local` file and applies them to the running worker immediately.

![Reelio settings](screenshots/setting_page.png)

### Apply a local Brand Kit

The **Brand Kit** workspace replaces the old Brand assets placeholder with a production preset. Set the brand name, primary and accent colors, display font, caption style, default narrator, logo position and opacity, writing voice, CTA, social handle, and website. Upload a logo, intro, outro, and music bed with inline previews.

Brand uploads are validated with FFprobe and stored only under `REELIO_DATA_DIR/brand-assets/`. Replacing or removing an active asset does not rewrite old files. Every new Quick Create, Prompt to Video, or opted-in Long Video to Shorts render receives an immutable snapshot of the active kit, so later edits cannot change a queued render. Disable the kit to create an unbranded video without deleting any settings.

The renderer uses the snapshot for:

- Script voice direction, while factual boundaries and approved Prompt to Video scripts remain authoritative
- Brand colors in fallback motion backgrounds, thumbnails, and subtitles
- A language-safe caption font override for supported scripts
- Logo watermark, intro and outro visual overlays
- A normalized, voice-ducked custom music bed
- A warm procedural music bed with soft noise-based percussion when no custom music is configured
- CTA, social handle, website, and brand tags in publishing copy and metadata

Video Synthesis includes a separate **Apply active Brand Kit** option. It snapshots the same kit, preserves translated-audio timing, burns brand-styled subtitles, adds visual assets, and mixes the music bed.

### Run modular media tools

The **Tools** tab exposes each stage as an independent job:

| Tool | Inputs | Outputs |
| --- | --- | --- |
| Chop | Video | Overlapping MP4 clips; defaults to 180 seconds with a 5-second overlap |
| Download video from link | Public video webpage or direct-media URL | Local reusable video from a supported, non-DRM source |
| Generate audio | Video | WAV or M4A audio |
| Extract subtitle track | Video with embedded text subtitles | SRT and transcript without speech recognition |
| Extract captions from link | Supported public link and caption language code | Existing manual or automatic captions as SRT and transcript |
| Find short highlights | Long video | Timed transcript, ranked editable highlight analysis, source SRT, and transcript |
| Render reviewed shorts | Long video and highlight analysis | One vertical MP4 per approved highlight plus a render manifest |
| Generate subtitle | Audio or video | Timed SRT subtitles and a plain transcript; Gemini Flash-Lite is the initial hosted provider, with faster-whisper available as an explicit local route |
| Translate | SRT or VTT subtitles | Translated SRT with the original cue timings |
| Speech synthesis | Translated SRT or VTT | Timed narration audio and a timing manifest |
| Video synthesis | Video, translated audio, translated subtitles | Final MP4 with optional burned captions and optional active Brand Kit |

File-based tools accept a new local file. Link tools use an isolated local `yt-dlp` runtime with browser-request compatibility and accept normal public video webpages—such as supported YouTube, Facebook, Vimeo, TikTok, X, or Instagram pages—as well as direct media URLs. The webpage does not need to expose an MP4 link. These tools require a public HTTPS URL but do not require platform OAuth or an ML model. Caption extraction inspects the available tracks and downloads one best matching manual track, falling back to one automatic track; it does not request every language variant. Login-protected, DRM-protected, private, playlist, and unsupported links are rejected. A source can still temporarily rate-limit requests; Reelio reports that briefly and asks the user to wait before retrying. Use link tools only for media you have permission to save. Later stages can select an output from a completed tool job, so downloaded video or extracted SRT captions can flow directly into Chop, Generate audio, Speech synthesis, or Video synthesis.

Tool jobs are durable and accept multiple submissions. By default, up to two FFmpeg/media jobs run together while one model-heavy job runs at a time. Additional jobs remain queued and resume after a worker restart.

### Automate recurring videos and a content calendar

The **Automations** workspace has two separate production flows:

- **Quick Automation** is cron-based. A pipeline runs on its saved cron expression and IANA timezone. Every occurrence first creates a fresh **AI Suggested Idea** or source-grounded **AI Latest News** brief, then generates the complete video. **Generate now** is a manual override that follows the same fresh-brief workflow. Only one run from the same Quick pipeline may be active at once.
- **Content Calendar** follows explicit dated entries. A pipeline has a start date, end date, selected weekdays, and one to eight posting times per selected day. One pipeline can therefore plan several posts per day, and different colored pipelines can occupy the same day independently. Each entry keeps its own brief state, production state, and exact video-job link.

Both flows store their durable pipeline, calendar, run, and publishing state under `REELIO_DATA_DIR` and reload enabled schedules after a worker restart. Pipelines can be edited, paused, resumed, or deleted. Deleting one stops its future work and removes unneeded calendar plans, but preserves every video job it already created.

Suggested Idea and Latest News are AI features and require a Gemini or OpenRouter API key in Settings; grounded Latest News requires Gemini Search. Calendar creation itself uses no model tokens. The calendar displays pending slots first, then asks for explicit confirmation with the exact number of briefs before bulk generation. Briefs are generated serially, saved per entry, and avoid recently used angles from the same pipeline. If a dated entry becomes due before its brief was planned, Reelio generates that one brief as part of the run.

The default **Wait for review** policy renders the complete package and leaves it in Library for human approval. **Publish automatically** is an explicit opt-in: it requires at least one destination, validates every selected account when the pipeline is enabled and again when it runs, approves only the successfully rendered package, and records per-platform publishing results. A disconnected or expired account blocks the run with a visible error instead of silently dropping an upload.

Manual and automatic multi-platform publishing starts every selected connector in parallel. YouTube upload or verification, TikTok inbox processing, and Meta processing proceed independently; one slow or failed destination does not prevent another upload from starting or erase its successful result.

Other local applications can still submit an agent-directed job through `POST /agent-trigger`. The worker remains bound to loopback; this is a local API trigger, not a public unauthenticated webhook.

## Requirements

- macOS
- Node.js 22.13 or newer
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/) for the isolated local voice runtimes
- Enough free disk space for the optional local speech models and generated videos

FFmpeg and FFprobe are installed through the project dependencies.

## Quick start

```bash
git clone https://github.com/nainglynndw/Reelio.git
cd Reelio
npm install
npm run kokoro:setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), go to **Settings**, enter the provider keys you want to use, and press **Save settings**.

You do not need to copy or manually edit `.env.example` for the default local setup. The Settings page creates `.env.local` automatically. Changes take effect immediately and persist across worker restarts.

For multilingual local narration, install VoxCPM2 separately:

```bash
npm run voxcpm2:setup
```

Generate subtitle uses Gemini 3.5 Flash-Lite by default and clearly discloses that a normalized audio-only copy is sent to Google. Add a Gemini API key in Settings before running it.

To use local or future self-hosted speech-to-text instead, set `REELIO_STT_PROVIDER=local` and install faster-whisper:

```bash
npm run stt:setup
```

The selected Whisper model downloads on its first local transcription.

For public-link video and caption tools, install the model-free local downloader:

```bash
npm run webmedia:setup
```

## Provider options

| Provider | Purpose | Required? |
| --- | --- | --- |
| Google Gemini | Primary script generation, hosted Flash-Lite transcription, translation, grounded news, optional TTS | Recommended |
| Kokoro | Local English narration | Installed locally |
| VoxCPM2 | Local multilingual narration | Optional local setup |
| OpenRouter | Hosted text fallback when Gemini is unavailable | Optional |
| Pexels | Licensed stock video search | Optional |
| Pixabay | Licensed stock video and image fallback | Optional |

Configure Pexels and Pixabay independently in Settings. Reelio uses either provider by itself or combines both when both keys are present. Without a hosted text key, Reelio can still use its built-in English idea and script fallback. Without either stock provider, every Prompt to Video theme can still use a custom local video or an original motion background.

## Publishing

Publishing is opt-in and requires explicit approval from the video-detail screen.

| Destination | Current behavior |
| --- | --- |
| YouTube Shorts | OAuth connection and direct upload |
| TikTok | OAuth connection and delivery to the creator's TikTok inbox |
| Facebook Reels | Direct Page upload using a Page access token |
| Instagram Reels | Direct Professional-account publishing; requires a public HTTPS media URL |

The current Facebook setup uses a manually supplied Page token. Tokens generated directly through Graph API Explorer may expire quickly. Durable Facebook OAuth and long-lived token handling are tracked in [Facebook authentication follow-up](docs/FACEBOOK_AUTH_FOLLOWUP.md).

## Production run

```bash
npm run production
```

This runs the production preflight, builds the web app, and starts both the web studio and loopback-only media worker. Keep the terminal window open while Reelio is running.

Verify a running installation with:

```bash
npm run healthcheck
```

## Local data and security

- The media worker binds to `127.0.0.1` by default.
- Browser origins are restricted by `REELIO_ALLOWED_ORIGINS`.
- Credentials are written to `.env.local` with owner-only file permissions and never stored in browser storage.
- `.env.local`, generated media, local models, state, build output, and worker logs are ignored by Git.
- Project state, generated media, tool inputs, custom storyboard videos, and versioned Brand Kit uploads live under `.reelio/` by default.
- `state.backup.json` is maintained automatically for recovery.
- Request bodies, provider requests, and media processes use bounded limits and timeouts.

Credentials in `.env.local` are protected by filesystem permissions but are not encrypted with macOS Keychain.

## Configuration

Most users should configure credentials through Settings. `.env.example` documents advanced overrides for ports, paths, timeouts, model selection, redirect URLs, the local data directory, and the shared upload-size limit used by Tools and custom storyboard videos.

To move the production library:

```bash
REELIO_DATA_DIR=/path/to/library npm run production
```

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the web app and local worker with development reload |
| `npm run build` | Build the production web app |
| `npm run production` | Run preflight, build, and start production services |
| `npm run lint` | Run ESLint |
| `npm test` | Build and run the Node test suite |
| `npm run check` | Run lint and tests |
| `npm run healthcheck` | Check the running web app and worker |
| `npm run kokoro:setup` | Install the local Kokoro runtime and model |
| `npm run voxcpm2:setup` | Install the local VoxCPM2 runtime and model |
| `npm run stt:setup` | Install the optional local/self-hosted faster-whisper transcription runtime |
| `npm run webmedia:setup` | Install the isolated model-free public-link downloader |

The browser connects to the worker at [http://localhost:8788](http://localhost:8788) by default so the local HttpOnly session cookie remains same-site. Health endpoints are `/health` and `/ready`; authentication endpoints are `/auth/session`, `/auth/register`, `/auth/login`, and `/auth/logout`. Workflow endpoints such as `/script-draft`, `/jobs`, `/tool-jobs`, `/automations`, and `/agent-trigger` require both an authenticated session and the matching subscription entitlement.

### Custom storyboard video contract

The browser uploads a custom video with `POST /tool-inputs`, using the raw file as the request body and these headers:

```text
Content-Type: video/mp4
X-File-Name: opening-scene.mp4
```

The worker returns a durable local input ID. Prompt to Video includes that reference in the matching `/jobs` storyboard selection:

```json
{
  "themeIndex": 0,
  "mode": "custom",
  "uploadId": "123e4567-e89b-42d3-a456-426614174000",
  "fileName": "opening-scene.mp4"
}
```

`uploadId` is the only storage reference accepted from the client; arbitrary file paths are never accepted. `fileName` is display metadata. The worker validates the reference at submission and resolves it from local durable state again when the queued job starts. Stock selections require approved provider-specific hosts, while custom selections can only resolve files already stored by `/tool-inputs`.

Stock selections use the same `media` mode with an explicit provider:

```json
{
  "themeIndex": 1,
  "mode": "media",
  "provider": "pixabay",
  "mediaId": "pixabay-v125",
  "mediaType": "video",
  "mediaUrl": "https://cdn.pixabay.com/video/example_medium.mp4",
  "sourceUrl": "https://pixabay.com/videos/id-125/",
  "creator": "Pixabay Creator",
  "query": "focused person working"
}
```

The worker accepts only provider-specific Pexels and Pixabay media/source hosts. A selected provider asset renders without needing that provider's key again because Reelio preserves and validates the approved media reference.

## Validate before contributing

```bash
npm run check
```

Do not commit `.env.local`, `.reelio/`, generated videos, downloaded models, or provider credentials.
