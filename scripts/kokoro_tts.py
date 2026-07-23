import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def resolve_voice(kokoro, manifest):
    """Blend voice style vectors when a blend is configured; fall back to the single voice name."""
    blend = manifest.get("voiceBlend")
    if not blend:
        return manifest["voice"]
    try:
        style = None
        for entry in blend:
            vector = kokoro.get_voice_style(entry["name"])
            weighted = vector * float(entry["weight"])
            style = weighted if style is None else style + weighted
        return style if style is not None else manifest["voice"]
    except Exception:
        # Any API/shape mismatch (older kokoro-onnx, unknown voice) safely uses the single voice.
        return manifest["voice"]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: kokoro_tts.py manifest.json")
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    kokoro = Kokoro(manifest["model"], manifest["voices"])
    voice = resolve_voice(kokoro, manifest)
    for cue in manifest["cues"]:
        samples, sample_rate = kokoro.create(
            cue["text"],
            voice=voice,
            speed=float(manifest["speed"]),
            lang=manifest["language"],
        )
        sf.write(cue["output"], samples, sample_rate)


if __name__ == "__main__":
    main()

