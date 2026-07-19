# Reelio 1.0

Production-ready, local-first AI knowledge reel studio for macOS.

## First-time setup

```bash
npm install
cp .env.example .env.local
npm run kokoro:setup
npm run preflight
```

Add the provider credentials you intend to use to `.env.local`. Secrets remain in the worker process and are never sent to browser storage.

## Production run

```bash
npm run production
```

Open `http://localhost:3000`. This runs a validated production build and the loopback-only media worker. Keep the terminal window open while Reelio is running.

To verify a running installation:

```bash
npm run healthcheck
```

For development with live reload, use `npm run dev`.

## What works

- AI idea suggestions with an offline studio fallback.
- Real 1080×1920 FFmpeg rendering.
- Multiple short stock or motion clips stitched into one clean master.
- Selectable narration engines: local Kokoro or Gemini for English, and local VoxCPM2 or Gemini for non-English speech; matching-language transcript; independently selectable subtitles, SRT, and burned high-contrast captions.
- Original category-curated intro sting, narration-ducked background music, and ending lift with no licensed samples or cloud music generation.
- Durable local job history and downloadable modular assets.
- Crash-safe state writes, backup recovery, interrupted-job resume, and failed-job retry.
- Seekable HTTP range streaming for final and clean video previews.
- Cron schedules and manual, webhook-ready, or AI-agent triggers.
- Credential-driven YouTube, TikTok inbox, Facebook Page, and Instagram Professional connectors.
- Explicit review approval before any external publishing request.

Generated media and job state are kept under `.reelio/` by default and are ignored by Git. Set `REELIO_DATA_DIR` to move the production library to another writable folder. `state.backup.json` is maintained automatically; back up the whole data directory to preserve projects and generated media.

## Providers

Google Gemini is the primary text path. `gemini-3.5-flash` generates and edits the English master script and translates speech/transcript and subtitle cues. Add `GEMINI_API_KEY` from Google AI Studio in Settings.

English narration defaults to local Kokoro-82M v1.0 through ONNX, with Gemini TTS as an option. Non-English narration defaults to local OpenBMB/VoxCPM2, with Gemini TTS as an option for its supported languages. Both paths generate cue-by-cue audio for subtitle synchronization. Gemini Burmese pacing defaults to `0.94×`, a small increase from the previous setting. Run `npm run kokoro:setup` and `npm run voxcpm2:setup` once to install the local engines under `.reelio/`.

Without a hosted text key, English videos can use the built-in script/idea library; translated subtitles require Gemini or OpenRouter. Without Pexels, Reelio creates original motion backgrounds.

Publishing never guesses credentials. Missing or unapproved platform integrations return a per-platform `needs_credentials` or export status while keeping successful destinations independent.

YouTube can be connected from **Settings → Publishing accounts → YouTube Shorts → Set up**. Reelio guides the user through enabling YouTube Data API v3, configuring Google OAuth, creating a Web application client, and authorizing the channel. OAuth client credentials and the refresh token are stored only in the local `.env.local` file.

TikTok can be connected from **Settings → Publishing accounts → TikTok → Set up**. Reelio implements TikTok Desktop Login Kit with state validation and PKCE, securely refreshes user tokens, verifies the connected profile, and uses Content Posting Upload API to send a draft to the creator's TikTok inbox. The creator completes editing and publishing in TikTok.

Instagram API publishing requires `PUBLIC_MEDIA_BASE_URL` to expose the final video through an HTTPS URL reachable by Meta. Without it, download the final MP4 and upload manually. YouTube defaults to `private`; change `YOUTUBE_PRIVACY` only after testing your channel workflow.

## Operating safeguards

- The media API binds only to `127.0.0.1`.
- Browser origins are restricted by `REELIO_ALLOWED_ORIGINS`.
- Request bodies, provider calls, and media processes have bounded limits.
- A completed render must be approved in **Video detail → Publishing** before uploads.
- Review generated facts, licenses, captions, and each platform's current monetization policy before approval.
- Scheduled workflows generate reviewable jobs; they do not bypass approval.

## Validation

```bash
npm run check
```

The service API is available at `http://127.0.0.1:8788`. Health routes are `/health` and `/ready`; workflow routes include `/jobs`, `/automations`, and `/agent-trigger`.
