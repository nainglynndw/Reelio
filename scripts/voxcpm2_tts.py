import json
import inspect
import random
import sys

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
    voice_reference = None

    for index, cue in enumerate(manifest["cues"]):
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        generation = {
            "text": f"{prefix if index == 0 else ''}{cue['text']}",
            "cfg_value": float(manifest.get("cfgValue", 2.0)),
            "inference_timesteps": int(manifest.get("inferenceTimesteps", 10)),
        }
        if voice_reference:
            generation["reference_wav_path"] = voice_reference
        if supports_seed:
            generation["seed"] = seed
        waveform = model.generate(**generation)
        sf.write(cue["output"], waveform, sample_rate)
        if voice_reference is None:
            voice_reference = cue["output"]


if __name__ == "__main__":
    main()
