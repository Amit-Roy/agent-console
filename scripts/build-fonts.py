#!/usr/bin/env python3
"""Build public/fonts/*.woff2 from the unmodified masters in fonts-src/ (issue #406).

Restricts variable axes (no glyph subsetting) and writes deterministic woff2.
Setup: uv run --with-requirements scripts/fonts-requirements.txt scripts/build-fonts.py
   or: python3 -m venv /tmp/fv && /tmp/fv/bin/pip install -r scripts/fonts-requirements.txt
"""
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts-src"
OUT = ROOT / "public" / "fonts"

# Weights in use: 380 (--fw-text), 400, 500, 600, 700. Keep style.css @font-face ranges equal to these.
# seconds since 1904-01-01 (sfnt epoch): 2024-01-01 UTC
FIXED_STAMP = 3786825600

LIMITS = {
    "inter": {"wght": (400, 700)},
    "jetbrains-mono": {"wght": (400, 700)},
    # opsz pinned at 18 (conversation text renders at 18-26px).
    "newsreader": {"wght": (300, 700), "opsz": 18},
}


def limits_for(name: str) -> dict:
    for prefix, axes in LIMITS.items():
        if name.startswith(prefix):
            return axes
    raise SystemExit(f"no axis limits for {name}")


def build(src: Path) -> None:
    font = TTFont(src, recalcTimestamp=False)
    font = instancer.instantiateVariableFont(font, limits_for(src.name), inplace=False)
    # fixed timestamps so repeated builds are byte-identical
    font["head"].created = FIXED_STAMP
    font["head"].modified = FIXED_STAMP
    font.flavor = "woff2"
    font.recalcTimestamp = False
    dest = OUT / src.name
    font.save(dest)
    print(f"{src.name}: {src.stat().st_size} -> {dest.stat().st_size}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for src in sorted(SRC.glob("*.woff2")):
        build(src)
    return 0


if __name__ == "__main__":
    sys.exit(main())
