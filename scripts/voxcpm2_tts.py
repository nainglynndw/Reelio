import json
import inspect
import os
import random
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from voxcpm import VoxCPM


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: voxcpm2_tts.py <manifest.json>")
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    device = manifest.get("device", "auto")
    model = VoxCPM.from_pretrained(
        manifest["model"],
        load_denoiser=False,
        optimize=device.startswith("cuda"),
        device=device,
    )
    description = manifest.get("voiceDescription", "").strip()
    prefix = f"({description})" if description else ""
    sample_rate = model.tts_model.sample_rate
    supports_seed = "seed" in inspect.signature(model._generate).parameters
    seed = int(manifest.get("seed", 42))
    persona_reference = Path(manifest["personaReference"])
    persona_reference_transcript = Path(manifest["personaReferenceTranscript"])
    requested_reference_text = manifest["personaReferenceText"].strip()
    persona_reference.parent.mkdir(parents=True, exist_ok=True)

    if persona_reference.exists() and persona_reference_transcript.exists():
        persona_reference_text = persona_reference_transcript.read_text(encoding="utf-8").strip()
    else:
        persona_reference_text = requested_reference_text
        set_seed(seed)
        reference_generation = {
            "text": f"{prefix}{persona_reference_text}",
            "cfg_value": float(manifest.get("cfgValue", 2.0)),
            "inference_timesteps": int(manifest.get("inferenceTimesteps", 10)),
        }
        if supports_seed:
            reference_generation["seed"] = seed
        waveform = model.generate(**reference_generation)
        temporary_reference = persona_reference.with_name(f".{persona_reference.name}.{os.getpid()}.tmp.wav")
        temporary_transcript = persona_reference_transcript.with_name(f".{persona_reference_transcript.name}.{os.getpid()}.tmp")
        sf.write(temporary_reference, waveform, sample_rate)
        temporary_transcript.write_text(f"{persona_reference_text}\n", encoding="utf-8")
        os.replace(temporary_reference, persona_reference)
        os.replace(temporary_transcript, persona_reference_transcript)

    for index, cue in enumerate(manifest["cues"]):
        cue_seed = seed + index + 1
        set_seed(cue_seed)
        generation = {
            # The reference already carries the persona. Keep target speech pure so an
            # English voice-design instruction cannot leak into Burmese or other languages.
            "text": cue["text"],
            "prompt_wav_path": str(persona_reference),
            "prompt_text": persona_reference_text,
            "reference_wav_path": str(persona_reference),
            "cfg_value": float(manifest.get("cfgValue", 2.0)),
            "inference_timesteps": int(manifest.get("inferenceTimesteps", 10)),
        }
        if supports_seed:
            generation["seed"] = cue_seed
        waveform = model.generate(**generation)
        sf.write(cue["output"], waveform, sample_rate)


def set_seed(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


if __name__ == "__main__":
    main()
