#!/usr/bin/env python3
"""Build the dependency-free Acode plugin with stable archive metadata."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
with ZipFile(root / "public/acode-plugin.zip", "w", compression=ZIP_DEFLATED) as archive:
    for name in ("plugin.json", "main.js", "readme.md"):
        entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o644 << 16
        archive.writestr(entry, (root / "acode-plugin" / name).read_bytes())
print("Built public/acode-plugin.zip")
