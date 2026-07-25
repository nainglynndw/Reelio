import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: transcribe_audio.py manifest.json")
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    Path(manifest["modelDir"]).mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        manifest["model"],
        device=manifest.get("device", "auto"),
        compute_type=manifest.get("computeType", "default"),
        download_root=manifest["modelDir"],
    )
    cues, info = transcribe_cues(model, manifest, vad_filter=True)
    fallback_without_vad = False
    if not cues:
        # VAD is intentionally strict for normal speech, but it can reject singing,
        # heavily mixed dialogue, and other voiced audio. Retry once without it.
        cues, info = transcribe_cues(model, manifest, vad_filter=False)
        fallback_without_vad = bool(cues)
    result = {
        "language": info.language,
        "languageProbability": round(info.language_probability, 4),
        "cues": cues,
        "text": " ".join(cue["text"] for cue in cues),
        "fallbackWithoutVad": fallback_without_vad,
    }
    Path(manifest["output"]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def transcribe_cues(model, manifest, vad_filter):
    segments, info = model.transcribe(
        manifest["input"],
        language=manifest.get("language"),
        vad_filter=vad_filter,
        beam_size=5,
        condition_on_previous_text=vad_filter,
        no_speech_threshold=0.6 if vad_filter else 0.9,
    )
    cues = [
        {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    return cues, info


if __name__ == "__main__":
    main()
