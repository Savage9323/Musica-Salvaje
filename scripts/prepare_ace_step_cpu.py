#!/usr/bin/env python3
"""Patch a pinned ACE-Step checkout to use CPU PyTorch on Linux x86_64.

This intentionally fails if the pinned upstream packaging changes. The patch is
applied only inside disposable GitHub Actions checkouts; no ACE-Step source is
vendored into Música Salvaje.
"""

from __future__ import annotations

from pathlib import Path
import sys


def patch_checkout(root: Path) -> None:
    path = root / "pyproject.toml"
    if not path.is_file():
        raise SystemExit(f"ACE-Step pyproject.toml not found at {path}")

    text = path.read_text(encoding="utf-8")
    replacements = {
        '"torch==2.10.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"':
            '"torch==2.10.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
        '"torchvision==0.25.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"':
            '"torchvision==0.25.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
        '"torchaudio==2.10.0+cu128; sys_platform == \'linux\' and platform_machine == \'x86_64\'"':
            '"torchaudio==2.10.0+cpu; sys_platform == \'linux\' and platform_machine == \'x86_64\'"',
        '    "nano-vllm; sys_platform != \'darwin\' or platform_machine != \'arm64\'",\n': "",
    }
    for old, new in replacements.items():
        if old not in text:
            raise SystemExit(f"Pinned ACE-Step packaging changed; missing expected text: {old}")
        text = text.replace(old, new)

    index_anchor = '[[tool.uv.index]]\nname = "pytorch-cu130"'
    if index_anchor not in text:
        raise SystemExit("Pinned ACE-Step packaging changed; cu130 index anchor missing")
    cpu_index = (
        '[[tool.uv.index]]\n'
        'name = "pytorch-cpu"\n'
        'url = "https://download.pytorch.org/whl/cpu"\n'
        'explicit = true\n\n'
    )
    text = text.replace(index_anchor, cpu_index + index_anchor, 1)

    shared_source = (
        '{ index = "pytorch-cu128", marker = "sys_platform == \'win32\' or '
        '(sys_platform == \'linux\' and platform_machine == \'x86_64\')" }'
    )
    if text.count(shared_source) != 3:
        raise SystemExit(
            f"Expected three shared cu128 source entries, found {text.count(shared_source)}"
        )
    split_source = (
        '{ index = "pytorch-cu128", marker = "sys_platform == \'win32\'" },\n'
        '    { index = "pytorch-cpu", marker = "sys_platform == \'linux\' and '
        'platform_machine == \'x86_64\'" }'
    )
    text = text.replace(shared_source, split_source)
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    checkout = Path(sys.argv[1] if len(sys.argv) > 1 else "ace-step")
    patch_checkout(checkout)
