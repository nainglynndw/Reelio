import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: kokoro_tts.py manifest.json")
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    kokoro = Kokoro(manifest["model"], manifest["voices"])
    for cue in manifest["cues"]:
        samples, sample_rate = kokoro.create(
            cue["text"],
            voice=manifest["voice"],
            speed=float(manifest["speed"]),
            lang=manifest["language"],
        )
        sf.write(cue["output"], samples, sample_rate)


if __name__ == "__main__":
    main()

