#!/usr/bin/env python3
"""Validate a private ACE-Step request asset and write the CLI TOML config.

The request JSON is downloaded from an authenticated GitHub draft release. This
script deliberately prints no creative prompt/lyrics so public Actions logs do
not expose unreleased content.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def require_text(data: dict, key: str, max_len: int) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"Invalid private task payload: {key} is required")
    value = value.strip()
    if len(value) > max_len:
        raise SystemExit(f"Invalid private task payload: {key} exceeds {max_len} characters")
    return value


def toml_string(value: str) -> str:
    # JSON basic-string escaping is compatible with TOML basic strings for the
    # characters used in our validated UTF-8 prompt/lyrics payload.
    return json.dumps(value, ensure_ascii=False)


def write_config(request_path: Path, output_path: Path) -> None:
    data = json.loads(request_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("Invalid private task payload: expected JSON object")

    caption = require_text(data, "caption", 1200)
    title = require_text(data, "title", 120)
    instrumental = bool(data.get("instrumental", False))
    lyrics = "[Instrumental]" if instrumental else require_text(data, "lyrics", 7000)
    language = str(data.get("language", "es")).strip().lower()
    if language not in {"es", "en"}:
        raise SystemExit("Invalid private task payload: language must be es or en")

    try:
        duration = int(data.get("durationSeconds", 30))
    except (TypeError, ValueError):
        raise SystemExit("Invalid private task payload: durationSeconds must be an integer")
    max_duration = int(os.environ.get("ACE_STEP_MAX_DURATION_SECONDS", "30"))
    if duration < 10 or duration > max_duration:
        raise SystemExit(
            f"Invalid private task payload: durationSeconds must be 10..{max_duration}"
        )

    try:
        seed = int(data.get("seed", 9323))
    except (TypeError, ValueError):
        raise SystemExit("Invalid private task payload: seed must be an integer")
    if seed < 0 or seed > 2_147_483_647:
        raise SystemExit("Invalid private task payload: seed out of range")

    config = f'''project_root = "."
config_path = "acestep-v15-turbo"
checkpoint_dir = "checkpoints"
backend = "pt"
device = "cpu"
offload_to_cpu = false
offload_dit_to_cpu = false
save_dir = "output"
audio_format = "wav"
caption = {toml_string(caption)}
lyrics = {toml_string(lyrics)}
instrumental = {str(instrumental).lower()}
vocal_language = {toml_string(language)}
task_type = "text2music"
duration = {duration}
inference_steps = 8
seed = {seed}
use_random_seed = false
thinking = false
use_cot_metas = false
use_cot_caption = false
use_cot_lyrics = false
use_cot_language = false
batch_size = 1
'''
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(config, encoding="utf-8")

    # Only non-sensitive metadata is emitted.
    print(f"Validated ACE-Step private task: title_length={len(title)} duration={duration}s instrumental={instrumental}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: write_ace_step_config.py REQUEST_JSON OUTPUT_TOML")
    write_config(Path(sys.argv[1]), Path(sys.argv[2]))
