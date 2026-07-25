# Reelio

Reelio is a local-first AI studio for turning an idea into a finished vertical video package. It writes the script, finds or generates visuals, creates narration, builds subtitles, renders a real 1080×1920 video, and prepares platform-specific publishing copy.

![Reelio create-video workspace](screenshots/create_video_page.png)

## Highlights

- Generate research-backed scripts from a prompt, a suggested idea, or grounded current-news research.
- Choose Quick Create for the existing all-in-one form or Guided Create to review the exact script before rendering.
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
- Keep projects, generated media, credentials, and job history on your Mac.

## Product tour

### Quick Create a video package

Choose the topic, duration, speech language, subtitle language, voice engine, narrator personality, and target platforms. Reelio can also suggest an idea or research recent news.

When Gemini is configured, an unapproved script is generated through a quality pipeline: Reelio searches for grounded evidence, builds a concrete research dossier, plans a topic-specific hook and sequence of story beats, drafts with high thinking, then fact-edits against the original brief and evidence. Supported names, dates, quantities, examples, mechanisms, and caveats are retained instead of being generalized away. OpenRouter-only setups use the same planning and writing prompts but safely fall back to the reviewed brief when Gemini Search is unavailable. These extra passes improve specificity but use more API tokens and can take longer.

![Create a Reelio video package](screenshots/create_video_page.png)

### Guided Create with script approval

Guided Create keeps the existing creator intact while offering a separate four-step path: prepare the brief, choose one of ten script structures, generate and edit the English master script, select one of four narrator personalities, choose production settings, then review and create the video. AI theme generation is optional: **Open storyboard without AI** groups the approved script locally and immediately loads stock, custom-video, and motion choices without calling the text provider or consuming theme-generation tokens. Maya, Theo, Nova, and Ellis each map to distinct Kokoro, VoxCPM2, and Gemini voices with their own tone, character, sample line, and pace. VoxCPM2 creates and reuses a separate persona reference for each selected language, calibrated from narration in that language rather than an English line. Provider-level voice values do not replace those mappings unless `REELIO_BRAND_VOICE_OVERRIDE=true` is explicitly enabled for a single custom brand voice.

Generating the Guided draft uses the same research, angle-planning, drafting, and fact-editing pipeline described above. The UI identifies the additional AI passes before generation. Once approved, that exact script is passed directly into the renderer and is not researched or regenerated again. Before review, Reelio groups the script into editable visual story themes and searches every configured stock provider independently. Pexels and Pixabay results are merged and ranked by relevance, portrait fit, media type, quality, and provider diversity. Each unique search is requested once per results page with a larger candidate pool, then media is allocated without repeating a clip across storyboard themes—even when several themes use exactly the same search phrase. **Show different clips** advances to the next provider page instead of replaying the cached first six results. If either provider has no key, times out, returns an error, or returns no usable matches, the other provider continues without failing the storyboard. Every theme must have exactly one approved visual:

- A licensed Pexels or Pixabay video or photo
- A custom video uploaded from the user's device
- A motion background generated locally by Reelio

Every stock result displays its provider. Search responses are cached locally for 24 hours, and only the asset approved by the user is downloaded for rendering. Reelio retains its provider, creator, source URL, and license in the project metadata.

Choose **Choose your video** inside a theme to upload and preview a custom clip. The upload immediately becomes that theme's approved selection. If you temporarily choose stock footage or a motion background, click the saved custom-video tile to select it again; use the pencil control in its top-right corner only when you want to replace the file. Refreshing stock results does not remove custom selections. During rendering, Reelio crops, loops, or samples the selected clip to fill the theme's timeline slots; it does not replace an approved custom clip with stock footage or motion. The finished downloadable video therefore uses the exact local video selected for that theme.

Custom storyboard files are uploaded directly to the loopback-only worker and stored under `REELIO_DATA_DIR/tool-inputs/`. They are not sent to Pexels or an AI provider. If a referenced file is missing when the job is submitted or starts rendering, Reelio stops with a clear error and asks the user to choose it again.

### Manage the local video library

Completed, queued, and failed jobs remain available locally for preview, retry, download, and publishing.

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

Brand uploads are validated with FFprobe and stored only under `REELIO_DATA_DIR/brand-assets/`. Replacing or removing an active asset does not rewrite old files. Every new Quick Create or Guided Create job receives an immutable snapshot of the active kit, so later edits cannot change a queued render. Disable the kit to create an unbranded video without deleting any settings.

The renderer uses the snapshot for:

- Script voice direction, while factual boundaries and approved Guided scripts remain authoritative
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
| Generate subtitle | Audio or video | Timed SRT subtitles and a plain transcript; retries without speech-only filtering when voiced music or heavily mixed audio yields no cues |
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

For local speech-to-text in the Tools tab, install faster-whisper separately:

```bash
npm run stt:setup
```

The selected Whisper model downloads on its first transcription.

For public-link video and caption tools, install the model-free local downloader:

```bash
npm run webmedia:setup
```

## Provider options

| Provider | Purpose | Required? |
| --- | --- | --- |
| Google Gemini | Primary script generation, translation, grounded news, optional TTS | Recommended |
| Kokoro | Local English narration | Installed locally |
| VoxCPM2 | Local multilingual narration | Optional local setup |
| OpenRouter | Hosted text fallback when Gemini is unavailable | Optional |
| Pexels | Licensed stock video search | Optional |
| Pixabay | Licensed stock video and image fallback | Optional |

Configure Pexels and Pixabay independently in Settings. Reelio uses either provider by itself or combines both when both keys are present. Without a hosted text key, Reelio can still use its built-in English idea and script fallback. Without either stock provider, every Guided Create theme can still use a custom local video or an original motion background.

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
| `npm run stt:setup` | Install the local faster-whisper transcription runtime |
| `npm run webmedia:setup` | Install the isolated model-free public-link downloader |

The worker API defaults to [http://127.0.0.1:8788](http://127.0.0.1:8788). Health endpoints are `/health` and `/ready`; workflow endpoints include `/script-draft`, `/visual-themes`, `/visual-candidates`, `/jobs`, `/tool-jobs`, `/tool-inputs`, `/automations`, and `/agent-trigger`.

### Custom storyboard video contract

The browser uploads a custom video with `POST /tool-inputs`, using the raw file as the request body and these headers:

```text
Content-Type: video/mp4
X-File-Name: opening-scene.mp4
```

The worker returns a durable local input ID. Guided Create includes that reference in the matching `/jobs` storyboard selection:

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
