# AI cost per full run — measured

Every number below was captured by intercepting the live Gemini HTTP calls during **three complete
`renderJob` runs** on 2026-07-26, using the real prompts, the real brief from job `bc8b8f91`, and the
configured `gemini-3.5-flash` key. Nothing here is estimated except where explicitly marked.

Measurement method: `globalThis.fetch` was wrapped to record `usageMetadata` (text calls) and `usage`
(the TTS `interactions` endpoint) for every request, then each call was attributed to a pipeline
stage by fingerprinting its system instruction. `REELIO_DATA_DIR` was redirected to a scratch
directory so the project tree stayed clean.

---

## 1. Rate card

From <https://ai.google.dev/gemini-api/docs/pricing>, paid tier, USD per 1M tokens, retrieved
2026-07-26. **Re-verify before pricing anything commercially — these change.**

| Model | Input | Output | Notes |
|---|---|---|---|
| `gemini-3.5-flash` *(current)* | $1.50 | $9.00 | **thinking tokens bill as output** |
| `gemini-3-flash-preview` | $0.50 | $3.00 | thinking bills as output |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | thinking bills as output |
| `gemini-3.1-pro-preview` | $2.00 | $12.00 | ≤200k prompt |
| `gemini-3.1-flash-tts-preview` | $1.00 (text) | $20.00 (audio) | current TTS model |

Google Search grounding: 5,000 prompts/month free (shared across Gemini 3 models), then
**$14 per 1,000 queries** = $0.014/query. One run issues exactly 1 grounded query.

---

## 2. Every AI call in a full run

Averaged over the runs in which each stage fired. `think` = thinking tokens, billed at the output
rate. Latency is wall-clock per call.

| # | Stage | Calls/run | Input | Think | Output | Audio | `thinkingLevel` | Latency |
|---|---|---|---|---|---|---|---|---|
| 1 | Research dossier (grounded search) | 1 | 963 | 3,042 | 674 | — | `high` | 40.4 s |
| 2 | Angle plan | 1 | 1,802 | 1,139 | 430 | — | `medium` | 9.5 s |
| 3 | Script writer | 1 | 2,685 | **7,008** | 286 | — | `high` | 33.8 s |
| 4 | Script editor | 1 | 2,893 | **6,316** | 293 | — | `high` | 29.5 s |
| 5 | Script expander | 0 | — | — | — | — | `medium` | conditional — **did not fire** |
| 6 | Visual theme plan | 1 | 583 | 940 | 356 | — | `low` | 5.8 s |
| 7 | Publishing copy (4 platforms) | 1 | 604 | 1,837 | 1,190 | — | `low` | 12.1 s |
| 8 | Translation batch (5 cues each) | 0 or 7 | 210 | **1,622** | 185 | — | `low` | 7.5 s |
| 9 | TTS utterance | 4–10 | 164 | 0 | 0 | 656 | — | 16.8 s |

Stage 5 not firing is the word-rate fix working — the old 2.45–2.75 words/sec floor triggered the
expansion pass on most runs. Stage 8 only fires for non-English narration.

---

## 3. Cost per run

| Scenario | Wall | Text in | Text think | Text out | Audio | Text $ | TTS $ | Search $ | **Total** |
|---|---|---|---|---|---|---|---|---|---|
| English + Kokoro *(local voice)* | 264 s | 9,531 | 22,598 | 2,959 | 0 | $0.2443 | $0.0000 | $0.0140 | **$0.2583** |
| English + Gemini TTS | 328 s | 9,583 | 19,668 | 3,003 | 3,797 | $0.2184 | $0.0769 | $0.0140 | **$0.3094** |
| Burmese + Gemini TTS | 434 s | 10,945 | 29,929 | 5,016 | 5,386 | $0.3309 | $0.1090 | $0.0140 | **$0.4539** |

Search is shown billed. Within the 5,000/month free allowance it is $0, which is the first ~5,000
renders each month.

Run-to-run variance on thinking tokens is real — the script writer measured 7,481 / 7,863 / 5,681
across the three runs. Treat totals as ±15%.

---

## 4. The dominant cost is thinking tokens

| Scenario | Thinking cost | Share of text cost | Share of whole run |
|---|---|---|---|
| English + Kokoro | $0.2034 | 83% | **79%** |
| English + Gemini TTS | $0.1770 | 81% | **57%** |
| Burmese + Gemini TTS | $0.2694 | 81% | **59%** |

A run generates roughly **20,000–30,000 thinking tokens against only 3,000–5,000 tokens of actual
delivered text** — about 7 thinking tokens per useful output token, all billed at $9.00/1M.

Worst offenders:

- **Script writer + editor: ~13,300 thinking tokens = $0.12/run**, the single largest line item. Both run at `thinkingLevel: "high"`.
- **Translation: 1,622 thinking tokens per batch of five short sentences**, despite already being set to `"low"`. Seven batches = 11,351 tokens = $0.10 on a Burmese run. Translation is close to mechanical; this is almost pure waste.
- **Research dossier: 3,042 thinking tokens** at `"high"`, on top of the search query fee.

---

## 5. Model choice is the biggest lever

Same measured token counts, different model. TTS and search held constant.

| Scenario | `3.5-flash` *(now)* | `3-flash-preview` | `3.1-flash-lite` | `3.1-pro-preview` |
|---|---|---|---|---|
| English + Kokoro | $0.2583 | $0.0954 **−63%** | $0.0547 **−79%** | $0.3397 |
| English + Gemini TTS | $0.3094 | $0.1637 **−47%** | $0.1273 **−59%** | $0.3822 |
| Burmese + Gemini TTS | $0.4539 | $0.2333 **−49%** | $0.1782 **−61%** | $0.5642 |

`gemini-3.5-flash` at $1.50/$9.00 is a premium tier. `gemini-3-flash-preview` at $0.50/$3.00 is a
straight 3× reduction on the same token profile. **This is worth an A/B before any infrastructure
work** — quality has to be re-verified per stage, but nothing else on this page moves the number
as far for as little effort.

Stacking order of savings, cheapest to implement first:

1. Drop `thinkingLevel` on translation to `minimal` — near-zero quality risk, saves ~$0.10/Burmese run.
2. Move the text chain to `gemini-3-flash-preview` — saves ~$0.15/run, needs quality A/B.
3. Reduce writer/editor from `high` to `medium` — saves an estimated $0.04–0.06/run, needs quality A/B (rhythm and ordering are the things to re-measure).
4. Cache the research dossier per topic — repeat briefs on the same subject re-pay $0.014 + 3,042 thinking tokens every time.

---

## 6. Non-AI cost per run

Measured on the English + Kokoro run via `/usr/bin/time -l`:

| Resource | Measured | Note |
|---|---|---|
| CPU | **485 CPU-seconds** (472 user + 13 sys) | 264 s wall — ffmpeg parallelises |
| Peak memory | **3.55 GB RSS** | sizes your container; matters on memory-backed filesystems |
| Job directory | 375 MB (EN) / 605 MB (MY) | includes scratch |
| Scratch clips | 240 MB / 316 MB | deletable after render |
| Deliverable | **34 MB** (EN) / 77 MB (MY) | `final.mp4`, what you store and serve |

At typical serverless rates (~$0.000024/vCPU-s, ~$0.0000025/GiB-s) that is roughly **$0.012–0.015 of
compute per render**.

> **Correction to earlier guidance.** I previously asserted that ffmpeg CPU dominates COGS and that AI
> was "cents." The measurement says the opposite: **AI is ~20× the compute cost** at the current model
> choice — $0.31 of Gemini against ~$0.014 of CPU. The conclusion that renders should be the metered
> unit still holds, but the reason is that every render carries AI cost, not that CPU is expensive.

---

## 7. What this means for the tier plan

**Your "manual, no AI, cheap/unlimited" tier is more viable than I first said.** A manual render with
a user-written script and Kokoro voice costs only compute:

| Tier composition | AI cost | Compute | Total |
|---|---|---|---|
| Manual script + Kokoro + manual themes/copy | $0.00 | ~$0.014 | **~$0.014** |
| Manual script + Kokoro, but AI themes + publishing copy | $0.041 | ~$0.014 | **~$0.055** |
| Full AI + Kokoro | $0.258 | ~$0.014 | **~$0.272** |
| Full AI + Gemini TTS | $0.309 | ~$0.014 | **~$0.323** |
| Full AI + Gemini TTS, Burmese | $0.454 | ~$0.014 | **~$0.468** |

So the tier boundary that matters is **whether the AI text chain runs**, and secondarily which voice
engine. A genuinely cheap high-volume tier is possible — but only if it also skips the theme plan and
publishing copy, which are AI calls that fire even when the script is user-supplied. Note it is still
not free: storage and egress on a 34–77 MB deliverable per render are real, and unbounded volume on a
fixed price is still unbounded cost.

Gross-margin sanity check at $29/month with 50 renders included:

| Model / voice | COGS for 50 renders | Gross margin |
|---|---|---|
| `3.5-flash` + Gemini TTS | $15.47 | 47% |
| `3.5-flash` + Kokoro | $12.92 | 55% |
| `3-flash-preview` + Gemini TTS | $8.19 | **72%** |
| `3-flash-preview` + Kokoro | $4.77 | **84%** |
| Burmese, `3.5-flash` + Gemini TTS | $22.70 | 22% |

Two conclusions. **Burmese costs ~1.5× an English run** (longer translation chain, denser audio) — if
SEA languages are the wedge, they need either a higher price point or a cheaper model, because 22%
gross margin does not fund a business. And **the model swap is worth more than any pricing-page
change** — it moves margin from 47% to 72% without touching the product.

---

## 8. Scaling ratios for other durations

Derived from the measured runs, for projecting other video lengths:

| Ratio | English | Burmese |
|---|---|---|
| Audio tokens per second of video | 42.2 | 59.8 |
| TTS utterances per 90 s | 10 | 4 |
| Translation batches per 90 s | 0 | 7 |

The text chain (stages 1–4, 6–7) is **near-constant regardless of video length** — it scales with
brief size and target word count, not duration. TTS and translation scale linearly with narration
length. So a 30-second video is *not* a third of the cost: expect roughly 70% of a 90-second run.

---

## 9. Reproducing this

Harness: `measure-run.mjs` (fetch interception + stage attribution) and `calc.mjs` (cost model) were
written to the session scratchpad, not committed. To re-run after changing models or prompts, port
them into a `scripts/` tool and invoke as:

```
node measure-run.mjs <english|burmese> <kokoro|gemini|voxcpm2>
node calc.mjs
```

Both read `.reelio/secrets.env` directly and write per-call JSON so token counts can be diffed
between prompt revisions.

**Open items not measured here:** VoxCPM2 on CUDA with `optimize=True` (the GPU-pool crossover
calculation), egress cost at real traffic, and Gemini TTS pricing stability while
`gemini-3.1-flash-tts-preview` remains a preview model.
